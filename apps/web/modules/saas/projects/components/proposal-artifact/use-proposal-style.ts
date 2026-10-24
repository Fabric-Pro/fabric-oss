"use client";

import { BRAND_FETCH_RUNNING_TTL_MS } from "@repo/utils/proposal-artifact/brand-sources";
import { parseBrandColorList } from "@saas/shared/components/BrandColorListField";
import {
	brandFetchRefetchInterval,
	websiteHost,
} from "@saas/shared/lib/brand-fetch-polling";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	type Dispatch,
	type SetStateAction,
	useEffect,
	useRef,
	useState,
} from "react";
import { getOrpcCode } from "../field-mapping/orpc-error";
import {
	type RecipientBrandDraft,
	type RecipientLogoErrorCode,
	recipientBrandDraftFrom,
	recipientBrandFieldId,
} from "../RecipientBrandFields";
import {
	type ConfirmFeedback,
	DENIED_CODES,
	type ProposalStyleDraft,
	type ProposalStyleError,
	type ProposalStyleInput,
	proposalStyleDraftFrom,
	type RecipientBrandRead,
	type SaveFeedbackState,
	type SuggestionField,
	sameDraft,
	styleErrorOf,
	suggestionViewOf,
	validateProposalStyleDraft,
} from "./proposal-style-model";
import type { FetchRequestError } from "./RecipientSuggestionArea";
import { invalidateProposalTheme } from "./use-proposal-theme";

function proposalStyleQueryKey(projectId: string, documentId: string) {
	return [
		"projects",
		"proposalArtifact",
		"style",
		projectId,
		documentId,
	] as const;
}

/**
 * The key the project settings card reads the recipient brand under, so a
 * save here refreshes it too. Restated rather than imported: that card keeps
 * it private.
 */
const recipientBrandQueryKey = (projectId: string) =>
	["projectRecipientBrand", projectId] as const;

function brandSourcesQueryKey(projectId: string, documentId: string) {
	return [
		"projects",
		"proposalArtifact",
		"brandSources",
		projectId,
		documentId,
	] as const;
}

type SaveRequest = {
	style: ProposalStyleInput | null;
	recipient: {
		/** The version the draft was read at. */
		expectedVersion: number;
		colors: string[];
		draft: RecipientBrandDraft;
		/** The website stored before this save, to tell whether it moved. */
		previousWebsite: string | null;
	} | null;
};

type SaveResult =
	| { outcome: "saved" }
	| { outcome: "invalid"; error: ProposalStyleError }
	| { outcome: "styleFailed" }
	| { outcome: "recipientFailed" }
	| { outcome: "recipientConflict" }
	| { outcome: "logoRejected"; code: RecipientLogoErrorCode };

/**
 * Whether an element is on screen. A tab panel that is `hidden` is not.
 * Without IntersectionObserver (jsdom, an old browser) it counts as shown.
 */
function useShown(element: Element | null): boolean {
	const [shown, setShown] = useState(false);
	useEffect(() => {
		if (!element) {
			return;
		}
		if (typeof IntersectionObserver === "undefined") {
			setShown(true);
			return;
		}
		const observer = new IntersectionObserver((entries) => {
			const latest = entries[entries.length - 1];
			if (latest) {
				setShown(latest.isIntersecting);
			}
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, [element]);
	return shown;
}

/**
 * The Style tab's state (Fizzy #2946): its three reads, the drafts and their
 * saved baselines, the save, the recipient website fetch and the Confirm of
 * what it found.
 *
 * The style draft follows each newer save. The recipient draft is confirmed
 * against the version it was read at, so a newer version replaces it only
 * while it holds no edits and no upload or fetch is in flight: a background
 * read never wipes what is being typed, and its save meets the conflict
 * instead. This editor's own save, and a save that conflicted, reload it.
 */
export function useProposalStyle({
	projectId,
	documentId,
	canEdit,
	recipientIdPrefix,
}: {
	projectId: string;
	documentId: string;
	canEdit: boolean;
	/** The recipient fields' id prefix, to focus the one a Confirm filled. */
	recipientIdPrefix: string;
}) {
	const queryClient = useQueryClient();
	const styleKey = proposalStyleQueryKey(projectId, documentId);
	const recipientKey = recipientBrandQueryKey(projectId);
	const sourcesKey = brandSourcesQueryKey(projectId, documentId);

	const styleQuery = useQuery({
		queryKey: styleKey,
		queryFn: () =>
			orpcClient.projects.proposalArtifact.getStyle({
				projectId,
				documentId,
			}),
		retry: (failureCount, error) =>
			!DENIED_CODES.has(getOrpcCode(error) ?? "") && failureCount < 2,
	});
	const recipientQuery = useQuery({
		queryKey: recipientKey,
		queryFn: () => orpcClient.projects.recipientBrand.get({ projectId }),
		retry: 1,
	});
	const sourcesQuery = useQuery({
		queryKey: sourcesKey,
		queryFn: () =>
			orpcClient.projects.proposalArtifact.getBrandSources({
				projectId,
				documentId,
			}),
		retry: (failureCount, error) =>
			!DENIED_CODES.has(getOrpcCode(error) ?? "") && failureCount < 1,
		// Re-read while the recipient website fetch runs; it stops once the
		// attempt finishes or is old enough to read as timed out.
		refetchInterval: (query) =>
			brandFetchRefetchInterval(
				query.state.data?.recipient?.suggestion ?? null,
			),
	});

	const [styleDraft, setStyleDraft] = useState<ProposalStyleDraft>(() =>
		proposalStyleDraftFrom(undefined),
	);
	const [styleInitial, setStyleInitial] =
		useState<ProposalStyleDraft>(styleDraft);
	const [recipientDraft, setRecipientDraft] = useState<RecipientBrandDraft>(
		() => recipientBrandDraftFrom(null),
	);
	const [recipientInitial, setRecipientInitial] =
		useState<RecipientBrandDraft>(recipientDraft);
	// The recipient read the draft was formed from: a save is confirmed
	// against its version, and the fields remount when it changes.
	const [recipientBase, setRecipientBase] =
		useState<RecipientBrandRead | null>(null);
	const [fieldsPending, setFieldsPending] = useState(false);
	const [logoError, setLogoError] = useState<RecipientLogoErrorCode | null>(
		null,
	);
	const [feedback, setFeedback] = useState<SaveFeedbackState>({
		kind: "none",
	});
	const [confirmFeedback, setConfirmFeedback] = useState<ConfirmFeedback>({
		kind: "none",
	});
	const [fetchRequestError, setFetchRequestError] =
		useState<FetchRequestError | null>(null);
	const [rootElement, setRootElement] = useState<HTMLElement | null>(null);
	const shown = useShown(rootElement);
	// The website the fields' own Fetch last filled them from: saving it
	// needs no second, automatic fetch of the same website.
	const interactiveFetchRef = useRef<string | null>(null);
	// The field a Confirm applied, focused once the version it made renders
	// and the field can take focus.
	const pendingFocusRef = useRef<{
		field: SuggestionField;
		version: number;
	} | null>(null);
	const autoRequestedRef = useRef(false);

	// A newer saved style replaces the draft: after this editor's own save,
	// or someone else's. A refetch of the same save keeps what is typed.
	const styleData = styleQuery.data;
	const loadedStyleAt =
		styleData === undefined
			? null
			: styleData === null
				? "none"
				: new Date(styleData.updatedAt).toISOString();
	useEffect(() => {
		if (loadedStyleAt === null) {
			return;
		}
		const next = proposalStyleDraftFrom(styleData ?? undefined);
		setStyleDraft(next);
		setStyleInitial(next);
	}, [loadedStyleAt]);

	const resetRecipient = (read: RecipientBrandRead) => {
		const next = recipientBrandDraftFrom(read.recipientBrand);
		setRecipientBase(read);
		setRecipientDraft(next);
		setRecipientInitial(next);
		setLogoError(null);
		interactiveFetchRef.current = null;
	};

	const recipientRead = recipientQuery.data ?? null;
	const recipientDirty =
		recipientBase !== null && !sameDraft(recipientDraft, recipientInitial);
	useEffect(() => {
		if (!recipientRead) {
			return;
		}
		if (
			recipientBase === null ||
			(recipientRead.version !== recipientBase.version &&
				!recipientDirty &&
				!fieldsPending)
		) {
			resetRecipient(recipientRead);
		}
	}, [recipientRead?.version]);

	// The fetch runs inside the request and answers with the attempt it
	// finished, joined or recorded; either way the sources show it next.
	const requestFetchMutation = useMutation({
		mutationFn: (automatic: boolean) =>
			orpcClient.projects.recipientBrand.requestFetch({
				projectId,
				automatic,
			}),
		onSettled: () =>
			queryClient.invalidateQueries({ queryKey: sourcesKey }),
	});
	const requestFetch = (automatic: boolean) => {
		setFetchRequestError(null);
		setConfirmFeedback({ kind: "none" });
		requestFetchMutation.mutate(automatic, {
			// An automatic call is the tab's own doing: when it cannot run,
			// the fields and their own Fetch are still right there. An
			// explicit one says why it did not.
			onError: (error) => {
				if (!automatic) {
					setFetchRequestError(
						getOrpcCode(error) === "TOO_MANY_REQUESTS"
							? "rate_limited"
							: "unavailable",
					);
				}
			},
		});
	};

	const recipientEditable = canEdit && recipientRead?.canEdit === true;
	const sources = sourcesQuery.data;
	const sourcesSettled =
		sourcesQuery.isFetchedAfterMount && !sourcesQuery.isFetching;

	// Opening the tab on a recipient website nobody has fetched yet fetches
	// it once, for someone who may: a suggestion to confirm, nothing applied.
	// Only once the tab is shown, and on sources read since it mounted, so a
	// hidden tab or a cached read never starts one.
	useEffect(() => {
		if (
			autoRequestedRef.current ||
			!sources ||
			!sourcesSettled ||
			!recipientEditable ||
			!shown
		) {
			return;
		}
		autoRequestedRef.current = true;
		if (sources.recipient?.website && !sources.recipient.suggestion) {
			requestFetch(true);
		}
	}, [sources, sourcesSettled, recipientEditable, shown]);

	// A RUNNING attempt is re-read while it may still finish. Read it once
	// more just after its lifetime ends, so the timed-out state renders even
	// when no poll or other read lands after it.
	const suggestion = sources?.recipient?.suggestion ?? null;
	const runningSince =
		suggestion?.status === "RUNNING"
			? new Date(suggestion.requestedAt).getTime()
			: null;
	useEffect(() => {
		if (runningSince === null) {
			return;
		}
		const endsIn = runningSince + BRAND_FETCH_RUNNING_TTL_MS - Date.now();
		if (endsIn <= 0) {
			return;
		}
		const timer = setTimeout(() => {
			void queryClient.invalidateQueries({ queryKey: sourcesKey });
		}, endsIn + 1000);
		return () => clearTimeout(timer);
	}, [runningSince]);

	const confirmMutation = useMutation({
		mutationFn: (input: {
			field: SuggestionField;
			requestId: string;
			expectedVersion: number;
			host: string;
		}) =>
			orpcClient.projects.recipientBrand.confirmSuggestion({
				projectId,
				expectedVersion: input.expectedVersion,
				requestId: input.requestId,
				field: input.field,
			}),
		onSuccess: async (result, input) => {
			if (result.outcome === "applied") {
				pendingFocusRef.current = {
					field: input.field,
					version: result.version,
				};
				setConfirmFeedback({ kind: "applied", host: input.host });
			} else {
				setConfirmFeedback({ kind: result.outcome });
			}
			// The recipient first: its new version resets the draft and
			// remounts the fields the focus lands in.
			if (result.outcome !== "stale") {
				await queryClient.invalidateQueries({ queryKey: recipientKey });
			}
			await queryClient.invalidateQueries({ queryKey: sourcesKey });
		},
		onError: () => setConfirmFeedback({ kind: "failed" }),
		onSettled: () => {
			void invalidateProposalTheme(queryClient, projectId);
		},
	});

	const saveMutation = useMutation({
		mutationFn: async (request: SaveRequest): Promise<SaveResult> => {
			if (request.style) {
				try {
					const saved =
						await orpcClient.projects.proposalArtifact.updateStyle({
							projectId,
							documentId,
							...request.style,
						});
					queryClient.setQueryData(styleKey, saved);
					// The saved values, as the server normalized them, are the
					// new baseline — whatever their timestamp.
					const next = proposalStyleDraftFrom(saved);
					setStyleDraft(next);
					setStyleInitial(next);
				} catch (error) {
					const invalid = styleErrorOf(error);
					return invalid
						? { outcome: "invalid", error: invalid }
						: { outcome: "styleFailed" };
				}
			}
			if (request.recipient) {
				const { expectedVersion, colors, draft, previousWebsite } =
					request.recipient;
				let result: Awaited<
					ReturnType<typeof orpcClient.projects.recipientBrand.update>
				>;
				try {
					result = await orpcClient.projects.recipientBrand.update({
						projectId,
						expectedVersion,
						name: draft.name.trim() || null,
						website: draft.website.trim() || null,
						colors,
						logo:
							draft.logo.action === "replace"
								? { action: "replace", token: draft.logo.token }
								: { action: draft.logo.action },
					});
				} catch {
					return { outcome: "recipientFailed" };
				}
				if (result.outcome === "logoRejected") {
					return { outcome: "logoRejected", code: result.code };
				}
				// The marker described this draft, whatever became of it.
				const fetchedFrom = interactiveFetchRef.current;
				interactiveFetchRef.current = null;
				// Applied, or someone confirmed since this draft was read:
				// either way the newer version replaces the draft, which
				// still holds this save's edits.
				await queryClient.invalidateQueries({ queryKey: recipientKey });
				const stored =
					queryClient.getQueryData<RecipientBrandRead>(recipientKey);
				if (stored && stored.version !== expectedVersion) {
					resetRecipient(stored);
				}
				if (result.outcome === "conflict") {
					return { outcome: "recipientConflict" };
				}
				// A website that moved is fetched for a suggestion, as stored
				// (the server normalizes it), unless the fields' own Fetch just
				// filled them from that same website.
				const website = stored?.recipientBrand?.website ?? null;
				if (
					website &&
					website !== previousWebsite &&
					website !== fetchedFrom &&
					stored?.canEdit
				) {
					requestFetch(true);
				}
			}
			return { outcome: "saved" };
		},
		// Whatever part of the save landed, the Main tab's paint and the
		// sources follow it. Not awaited: the Save button need not wait for
		// the page to repaint.
		onSettled: () => {
			void invalidateProposalTheme(queryClient, projectId);
			void queryClient.invalidateQueries({ queryKey: sourcesKey });
		},
		onSuccess: (result) => {
			if (result.outcome === "logoRejected") {
				// The server discarded the refused upload; the token is spent.
				setLogoError(result.code);
				setRecipientDraft((prev) => ({
					...prev,
					logo: { action: "keep" },
				}));
				setFeedback({ kind: "none" });
				return;
			}
			setFeedback(
				result.outcome === "saved"
					? { kind: "saved" }
					: result.outcome === "invalid"
						? { kind: "invalid", error: result.error }
						: { kind: result.outcome },
			);
		},
	});
	const confirming = confirmMutation.isPending;
	const saving = saveMutation.isPending;

	// After a Confirm, focus the field it filled once the new version has
	// rendered with its values (a first colour exists only then) and the
	// field takes focus again: not while the Confirm or a save is pending,
	// when the fields are held still. The request is dropped only once the
	// focus has landed.
	useEffect(() => {
		const pending = pendingFocusRef.current;
		if (
			!pending ||
			confirming ||
			saving ||
			(recipientBase?.version ?? -1) < pending.version
		) {
			return;
		}
		const element = document.getElementById(
			recipientBrandFieldId(recipientIdPrefix, pending.field),
		);
		if (!element || element.matches(":disabled")) {
			return;
		}
		element.focus();
		if (document.activeElement === element) {
			pendingFocusRef.current = null;
		}
	}, [recipientBase, recipientDraft, confirming, saving]);

	// Any edit retires the last save's message.
	const editStyle = (patch: Partial<ProposalStyleDraft>) => {
		setStyleDraft((prev) => ({ ...prev, ...patch }));
		setFeedback({ kind: "none" });
	};
	const editRecipient: Dispatch<SetStateAction<RecipientBrandDraft>> = (
		action,
	) => {
		setRecipientDraft(action);
		setFeedback({ kind: "none" });
		setConfirmFeedback({ kind: "none" });
	};

	const styleDirty = !sameDraft(styleDraft, styleInitial);

	// The suggestion counts only for the website the recipient brand holds
	// now: right after a save moves it, the sources may still describe the
	// old one until they are read again.
	const recipientSources = sources?.recipient ?? null;
	const recipientWebsite = recipientRead?.recipientBrand?.website ?? null;
	const suggestionView = suggestionViewOf(
		recipientSources && recipientSources.website === recipientWebsite
			? recipientSources.suggestion
			: null,
		requestFetchMutation.isPending,
		new Date(),
	);
	const recipientHost =
		sources && recipientWebsite ? websiteHost(recipientWebsite) : null;

	const save = () => {
		const style = validateProposalStyleDraft(styleDraft);
		if (!style.ok) {
			setFeedback({ kind: "invalid", error: style.error });
			return;
		}
		const recipientColors = parseBrandColorList(recipientDraft.colors);
		if (recipientDirty && !recipientColors) {
			setFeedback({ kind: "invalid", error: "invalidColor" });
			return;
		}
		setFeedback({ kind: "none" });
		setConfirmFeedback({ kind: "none" });
		setLogoError(null);
		saveMutation.mutate({
			style: styleDirty ? style.value : null,
			recipient:
				recipientDirty && recipientBase && recipientColors
					? {
							expectedVersion: recipientBase.version,
							colors: recipientColors,
							draft: recipientDraft,
							previousWebsite:
								recipientBase.recipientBrand?.website ?? null,
						}
					: null,
		});
	};

	const discard = () => {
		// A focus a Confirm left waiting is not for the draft read next.
		pendingFocusRef.current = null;
		setStyleDraft(styleInitial);
		// Back to the recipient brand as it is stored now, which may be a
		// newer version than the one these edits started from.
		if (recipientRead) {
			resetRecipient(recipientRead);
		} else {
			setRecipientDraft(recipientInitial);
			setLogoError(null);
			interactiveFetchRef.current = null;
		}
		setFeedback({ kind: "none" });
	};

	const confirm = (field: SuggestionField) => {
		if (
			suggestionView.kind !== "found" ||
			!recipientRead ||
			!recipientHost ||
			fieldsPending ||
			confirming ||
			saving
		) {
			return;
		}
		pendingFocusRef.current = null;
		setConfirmFeedback({ kind: "none" });
		confirmMutation.mutate({
			field,
			requestId: suggestionView.requestId,
			// The version this editor has read, not the one the sources
			// compared the suggestion with, which may be older.
			expectedVersion: recipientRead.version,
			host: recipientHost,
		});
	};

	const fetchAgain = () => {
		if (fieldsPending) {
			return;
		}
		requestFetch(false);
	};

	return {
		styleQuery,
		recipientQuery,
		sourcesQuery,
		/** Put on the panel's root: the automatic fetch waits until it shows. */
		rootRef: setRootElement,
		styleDraft,
		editStyle,
		styleDirty,
		recipientRead,
		/** The version the recipient draft was read at; null before the first. */
		recipientBaseVersion: recipientBase?.version ?? null,
		recipientDraft,
		editRecipient,
		recipientDirty,
		recipientEditable,
		fieldsPending,
		setFieldsPending,
		logoError,
		markFetched: (website: string) => {
			interactiveFetchRef.current = website;
		},
		proposer: sources?.proposer ?? null,
		recipientSources,
		sourcesLoaded: sources !== undefined,
		suggestionView,
		recipientHost,
		fetchRequestError,
		fetchAgain,
		confirm,
		confirming,
		confirmFeedback,
		save,
		saving,
		discard,
		feedback,
		dismissFeedback: () => setFeedback({ kind: "none" }),
	};
}
