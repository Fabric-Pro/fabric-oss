"use client";

import { ORPCError } from "@orpc/client";
import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import type {
	ContextSourceAdded,
	ContextSourceSubmitAdapter,
	LinkSourceSubmission,
} from "../lib/submit-adapter";
import {
	type BulkSubmitResult,
	type BulkUrlsMode,
	describeUnusableProviders,
	isProviderNotConfiguredError,
	knowledgeBaseCategoryErrors,
	knowledgeBaseCategoryPayload,
	type ProviderNotConfiguredData,
	parseBulkUrlLines,
	pickPreferredProvider,
	sourceMetadataPayload,
	type UploadStatus,
	URL_BULK_MAX_LINES,
	URL_BULK_SUCCESS_AUTOCLOSE_MS,
	URL_MAX_PAGES_DEFAULT,
	type UrlSourceFormValues,
	type UrlSourceProviderName,
	urlSourceFormSchema,
} from "../lib/url-source";

/** The Link form as it opens, and as `reset` leaves it. */
const DEFAULT_URL_SOURCE_FORM_VALUES: UrlSourceFormValues = {
	url: "",
	label: "",
	scope: "SINGLE_PAGE",
	maxPages: URL_MAX_PAGES_DEFAULT,
	refreshMode: "ONCE",
	// No default category, deliberately: a pre-selected one would be a guess
	// recorded as an answer.
	knowledgeBaseSourceCategory: undefined,
	knowledgeBaseSourceCategoryOther: "",
};

interface UseUrlSourceFormOptions {
	adapter: ContextSourceSubmitAdapter;
	/** The hosting dialog is open; the provider pre-flight runs only then. */
	open: boolean;
	/** The organization whose search providers scrape the link (null: personal). */
	organizationId: string | null;
	organizationSlug: string | null;
	/**
	 * The viewer can connect search providers here. Saving one takes an
	 * organization admin or owner, so for anyone else the notice asks for an
	 * admin instead of linking to settings they cannot change.
	 */
	canManageSearchProviders: boolean;
	/**
	 * A link must be classified before it is saved. The project readiness
	 * checklist is the only consumer of that classification, so only a project
	 * owner running it turns this on; off, the category field is absent and
	 * the payload never carries one.
	 */
	requireKnowledgeBaseCategory: boolean;
	/**
	 * Offer the Live refresh cadence. Live is honored only where retrieval
	 * re-fetches the page on each AI run, which the project task agent does
	 * (`rag-context.ts`) and company context retrieval does not; an owner
	 * that cannot honor it turns this off so Live is never offered there.
	 */
	allowLiveRefresh: boolean;
	/** Fires once per link that was accepted — N times for N pasted URLs. */
	onSourceAdded?: (added: ContextSourceAdded) => void;
	/** Nothing left to review: close and reset the dialog. */
	onComplete: () => void;
}

/**
 * What the search-provider pre-flight knows, which drives the notice and the
 * submit gate:
 *   - `checking`: the first answer is still on its way.
 *   - `failed`: the request failed, with no earlier answer that lets a link
 *     through. That says nothing about configuration, so it never blocks
 *     submit; the server checks again and answers with a typed code.
 *   - `unchecked`: the viewer may not list the providers (a project guest is
 *     not an organization member). The server decides on submit.
 *   - `missing`: no enabled provider with a key can read pages.
 *   - `ready`: one can.
 */
type UrlSourcePreflightStatus =
	| "checking"
	| "failed"
	| "unchecked"
	| "missing"
	| "ready";

/**
 * The status for what the pre-flight query holds. A cached "ready" outlives
 * a failed refetch: the server re-checks on submit anyway. A cached
 * "missing" does not, because it would keep blocking submit for a provider
 * connected since, with nothing to retry. With no answer yet, a refetch
 * resets the query to pending and clears its error, so a "Try again" the
 * viewer is waiting on keeps the failure showing; a re-read on reopen or
 * focus starts over at "checking".
 */
function preflightStatusOf(
	query: {
		data: { hasAnyScrapeCapable: boolean } | null | undefined;
		isError: boolean;
	},
	retrying: boolean,
): UrlSourcePreflightStatus {
	if (query.data === undefined) {
		return query.isError || retrying ? "failed" : "checking";
	}
	if (query.data === null) {
		return "unchecked";
	}
	if (query.data.hasAnyScrapeCapable) {
		return "ready";
	}
	return query.isError ? "failed" : "missing";
}

/**
 * State and submit for the Link tab — a single URL or a bulk paste — plus
 * the search-provider pre-flight that decides whether a link can be added at
 * all. Rendered by `UrlSourceTabContent`.
 */
export function useUrlSourceForm({
	adapter,
	open,
	organizationId,
	organizationSlug,
	canManageSearchProviders,
	requireKnowledgeBaseCategory,
	allowLiveRefresh,
	onSourceAdded,
	onComplete,
}: UseUrlSourceFormOptions) {
	const queryClient = useQueryClient();

	// Link tab status indicator (Crawling / Indexed / Failed).
	const [linkStatus, setLinkStatus] = useState<UploadStatus>("idle");

	// Link form state — URL Context Sources (Group 7). One state object so the
	// scope auto-detect on URL blur stays atomic with the form value the
	// submit handler reads.
	const [values, setValues] = useState<UrlSourceFormValues>(
		DEFAULT_URL_SOURCE_FORM_VALUES,
	);
	// Tracks whether the user has explicitly clicked a scope radio. Once they
	// have, we stop auto-detecting on blur so we don't fight the user.
	const [scopeUserOverridden, setScopeUserOverridden] = useState(false);
	const [errors, setErrors] = useState<
		Partial<Record<keyof UrlSourceFormValues, string>>
	>({});
	const [noticeOverride, setNoticeOverride] =
		useState<ProviderNotConfiguredData | null>(null);
	// The viewer pressed "Try again" and that re-read has not settled.
	const [preflightRetrying, setPreflightRetrying] = useState(false);

	// ── Bulk URL paste mode state (Commit 4) ─────────────────────────────
	// Mode toggle between Single URL and Multiple URLs. Default to SINGLE so
	// the form opens to the familiar single-URL UX; user opts into the paste
	// view explicitly.
	const [bulkMode, setBulkMode] = useState<BulkUrlsMode>("SINGLE");
	// Raw textarea contents. Parsed live (memoised in the tab content) so
	// the live preview, submit-enabled state, and the URL count on the
	// button stay in lock-step with what the user typed.
	const [bulkRaw, setBulkRaw] = useState("");
	// Per-URL progress + summary for the multi-URL submit. Driven by the
	// Promise.allSettled handler below; the in-dialog progress card reads
	// `submitted` / `total`, and the post-settle summary reads `results`.
	const [bulkProgress, setBulkProgress] = useState<{
		total: number;
		submitted: number;
	} | null>(null);
	const [bulkResults, setBulkResults] = useState<BulkSubmitResult[] | null>(
		null,
	);

	// Search-provider pre-flight.
	// Reads the unified search-providers table — the same rows `processLink`
	// reads server-side. Returns:
	//   - `scrapeProvider`: picked provider for SINGLE_PAGE / fallback.
	//   - `crawlProvider`: picked provider for PATH_PREFIX (Firecrawl or
	//     Cloudflare Browser Rendering).
	//   - `hasAnyScrapeCapable`: true ⇔ any enabled scrape-capable row exists (drives `preflightStatus`).
	//   - `hasCrawlCapable`: true ⇔ Firecrawl or Cloudflare is enabled (drives the
	//     PATH_PREFIX radio gate).
	//   - `disabledScrapeProviders` / `searchOnlyProviders`: what the notice
	//     names when keys are saved but none can read pages.
	// `null` when the server refuses to list the providers (see
	// `UrlSourcePreflightStatus`).
	// Re-read on every open (`staleTime: 0`) and on window focus, so a user who
	// just connected a provider, here or in another tab, is not shown the
	// notice from a cached answer.
	const providersConfigQuery = useQuery({
		queryKey: [
			"url-source-providers-preflight",
			organizationId ?? "personal",
		],
		queryFn: async () => {
			const providers = await (organizationId
				? orpcClient.searchProviders.getOrganizationProviders({
						organizationId,
					})
				: orpcClient.searchProviders.getUserProviders()
			).catch((error: unknown) => {
				if (error instanceof ORPCError && error.code === "FORBIDDEN") {
					return null;
				}
				throw error;
			});
			if (providers === null) {
				return null;
			}
			const scrapeProvider = pickPreferredProvider(providers, false);
			const crawlProvider = pickPreferredProvider(providers, true);
			return {
				hasAnyScrapeCapable: scrapeProvider !== null,
				hasCrawlCapable: crawlProvider !== null,
				scrapeProviderName: (scrapeProvider?.providerName ??
					null) as UrlSourceProviderName | null,
				crawlProviderName: (crawlProvider?.providerName ??
					null) as UrlSourceProviderName | null,
				...describeUnusableProviders(providers),
			};
		},
		staleTime: 0,
		refetchOnWindowFocus: true,
		// Only run when the dialog is open so we don't fetch eagerly on every
		// mount of the parent contexts list.
		enabled: open,
	});

	const preflight = providersConfigQuery.data;
	const preflightStatus = preflightStatusOf(
		providersConfigQuery,
		preflightRetrying,
	);
	const hasCrawlCapable = preflight?.hasCrawlCapable ?? false;
	const scrapeProviderName = preflight?.scrapeProviderName ?? null;
	const crawlProviderName = preflight?.crawlProviderName ?? null;
	const disabledScrapeProviders = preflight?.disabledScrapeProviders ?? [];
	const searchOnlyProviders = preflight?.searchOnlyProviders ?? [];

	// Pre-built settings path for the notice CTA. The org slug determines
	// the prefix per spec §9.1 — `/app/settings/search-providers` for
	// personal, `/app/{slug}/settings/search-providers` for org.
	const searchProvidersSettingsPath = useMemo(() => {
		return organizationSlug
			? `/app/${organizationSlug}/settings/search-providers`
			: "/app/settings/search-providers";
	}, [organizationSlug]);

	// If the BAD_REQUEST notice payload from the server includes its own
	// settingsPath (revoked-key case during submit), prefer that — it's
	// guaranteed to match the server's tenant-resolution. Otherwise fall back
	// to the client-derived one.
	const noticeSettingsPath =
		noticeOverride?.settingsPath ?? searchProvidersSettingsPath;

	const invalidateList = () => {
		queryClient.invalidateQueries({ queryKey: adapter.listQueryKey });
	};

	// URL source submit handler — `processLink` payload contract:
	// scope, maxPages (only for PATH_PREFIX), refreshMode. On the
	// FIRECRAWL_NOT_CONFIGURED BAD_REQUEST shape (revoked between mount and
	// submit) we surface the notice card in place of a destructive toast.
	const submitSingle = async () => {
		// Clear stale notice override so a fresh attempt doesn't keep the
		// previous error pinned.
		setNoticeOverride(null);

		// Trim before validating so trailing whitespace doesn't fail the URL
		// regex.
		const trimmed: UrlSourceFormValues = {
			...values,
			url: values.url.trim(),
			label: values.label?.trim() ?? "",
		};
		const parsed = urlSourceFormSchema.safeParse(trimmed);
		if (!parsed.success) {
			const nextErrors: Partial<
				Record<keyof UrlSourceFormValues, string>
			> = {};
			for (const issue of parsed.error.issues) {
				const key = issue.path[0] as keyof UrlSourceFormValues;
				if (key && !nextErrors[key]) {
					nextErrors[key] = issue.message;
				}
			}
			setErrors(nextErrors);
			return;
		}

		const categoryErrors = knowledgeBaseCategoryErrors(
			trimmed,
			requireKnowledgeBaseCategory,
		);
		if (categoryErrors) {
			setErrors(categoryErrors);
			return;
		}
		setErrors({});

		const link: LinkSourceSubmission = {
			url: parsed.data.url,
			...(parsed.data.label ? { label: parsed.data.label } : {}),
			scope: parsed.data.scope,
			refreshMode: parsed.data.refreshMode,
			...knowledgeBaseCategoryPayload(trimmed),
			...sourceMetadataPayload(trimmed),
		};
		// Server defaults maxPages to 100 for PATH_PREFIX, but we send it
		// explicitly when the user has typed something so the procedure
		// doesn't have to coalesce.
		if (parsed.data.scope === "PATH_PREFIX" && parsed.data.maxPages) {
			link.maxPages = parsed.data.maxPages;
		}

		try {
			setLinkStatus("processing");
			await adapter.processLink(link);
			setLinkStatus("success");
			onSourceAdded?.({
				contextType: "LINK",
				scope: parsed.data.scope,
				refreshMode: parsed.data.refreshMode,
				maxPages: link.maxPages ?? null,
			});
			toast.success("Processing started…");
			invalidateList();
			onComplete();
		} catch (error) {
			console.error("URL source add error:", error);
			setLinkStatus("error");
			if (isProviderNotConfiguredError(error)) {
				// Server says either:
				//   - no scrape provider configured at all
				//   - PATH_PREFIX requested but no crawl-capable provider
				//   - legacy FIRECRAWL_NOT_CONFIGURED (kept for back-compat)
				// In every case we surface the notice card again so the user
				// can reconfigure.
				setNoticeOverride(error.data);
				// Trigger a re-fetch so the pre-flight reflects reality on
				// next mount.
				providersConfigQuery.refetch();
				return;
			}
			const message =
				error instanceof Error && error.message
					? error.message
					: "Unknown error";
			toast.error(`Failed to add URL source: ${message}`);
		}
	};

	// Bulk URL submit (Commit 4) — fires N parallel `processLink` calls and
	// reports per-URL outcomes back through `bulkProgress` + `bulkResults`.
	// We deliberately do NOT use the single-URL payload extras
	// (label, maxPages) for individual lines — every URL in a batch shares
	// the same scope / refreshMode picked from the existing form values, and
	// each scraped title becomes that row's label server-side.
	const submitBulk = async () => {
		setNoticeOverride(null);
		const parsedLines = parseBulkUrlLines(bulkRaw);
		const validLines = parsedLines.filter((l) => l.url !== null);
		if (validLines.length === 0) {
			return;
		}
		if (validLines.length > URL_BULK_MAX_LINES) {
			return;
		}

		// The category is a shared batch setting like scope and refresh, so it
		// is required here on exactly the same terms as a single URL.
		const categoryErrors = knowledgeBaseCategoryErrors(
			values,
			requireKnowledgeBaseCategory,
		);
		if (categoryErrors) {
			setErrors(categoryErrors);
			return;
		}
		setErrors({});

		// Use the parent form's scope / maxPages / refreshMode as the shared
		// batch settings. Validate them once (the rest of the schema accepts
		// any URL — we won't pass that field through; per-line URLs come
		// from the textarea).
		const scope = values.scope;
		const refreshMode = values.refreshMode;
		const maxPages =
			scope === "PATH_PREFIX"
				? (values.maxPages ?? URL_MAX_PAGES_DEFAULT)
				: undefined;

		setLinkStatus("processing");
		setBulkResults(null);
		setBulkProgress({ total: validLines.length, submitted: 0 });

		const results: BulkSubmitResult[] = new Array(validLines.length);
		let notice: ProviderNotConfiguredData | null = null;
		await Promise.allSettled(
			validLines.map(async (line, idx) => {
				const url = line.url as string;
				const link: LinkSourceSubmission = {
					url,
					scope,
					refreshMode,
					// One classification covers the batch, the same way scope
					// and refresh already do.
					...knowledgeBaseCategoryPayload(values),
				};
				if (maxPages !== undefined) {
					link.maxPages = maxPages;
				}
				try {
					await adapter.processLink(link);
					results[idx] = { url, ok: true, error: null };
					// Mirror the single-URL branch: one report per successful
					// bulk-paste row so N pasted URLs ⇒ N reports. Failed rows
					// skip it naturally because the throwing call
					// short-circuits to `catch`.
					onSourceAdded?.({
						contextType: "LINK",
						scope,
						refreshMode,
						maxPages: link.maxPages ?? null,
					});
				} catch (error) {
					let message =
						error instanceof Error && error.message
							? error.message
							: "Failed";
					if (isProviderNotConfiguredError(error)) {
						// Capture once — same provider gate would fire for
						// every URL. We surface the notice card after settle
						// instead of repeating the error inline 50 times.
						if (notice === null) {
							notice = error.data;
						}
						// The server's message sends the viewer to settings
						// only an admin can change; the card says who can fix
						// it, so the row only says what happened.
						message =
							error.data.code === "CRAWL_PROVIDER_NOT_CONFIGURED"
								? "No connected search provider can crawl this path."
								: "No connected search provider can add this URL.";
					}
					results[idx] = { url, ok: false, error: message };
				} finally {
					setBulkProgress((prev) =>
						prev
							? { ...prev, submitted: prev.submitted + 1 }
							: prev,
					);
				}
			}),
		);

		setBulkResults(results);
		const successCount = results.filter((r) => r.ok).length;

		// Invalidate as soon as we know anything landed — before either early
		// return below. A batch that partly hit the provider gate must not
		// hide the rows that did succeed until some unrelated refetch happens.
		if (successCount > 0) {
			invalidateList();
		}

		if (notice !== null) {
			// At least one URL hit the provider gate — surface the same notice
			// card the single-URL path uses.
			setNoticeOverride(notice);
			setLinkStatus("error");
			providersConfigQuery.refetch();
			return;
		}

		if (successCount === results.length) {
			setLinkStatus("success");
		} else if (successCount === 0) {
			setLinkStatus("error");
		} else {
			// Partial success, no provider gate involved — already invalidated
			// above.
			setLinkStatus("success");
		}
	};

	// Auto-close after a fully-successful bulk submit. Gives the user
	// `URL_BULK_SUCCESS_AUTOCLOSE_MS` to read the summary, then closes the
	// dialog and resets state. Failures keep the dialog open so the user can
	// see what went wrong (per spec: summary stays visible).
	useEffect(() => {
		if (!open || bulkResults === null) {
			return;
		}
		const allOk = bulkResults.every((r) => r.ok);
		if (!allOk) {
			return;
		}
		const t = setTimeout(() => {
			onComplete();
		}, URL_BULK_SUCCESS_AUTOCLOSE_MS);
		return () => clearTimeout(t);
		// We deliberately omit `onComplete` from the deps — it's a new closure
		// every render, and re-running on it would restart the timer. The one
		// captured here only closes and resets, which is the same on any
		// render. `open` DOES belong in the guard and the deps: closing the
		// dialog for any reason (Cancel, Escape, backdrop) tears this effect
		// down and clears the pending timeout via cleanup, so a stale
		// session's timer can never reach into a dialog the user has since
		// reopened.
	}, [open, bulkResults]);

	const reset = () => {
		setLinkStatus("idle");
		setValues(DEFAULT_URL_SOURCE_FORM_VALUES);
		setScopeUserOverridden(false);
		setErrors({});
		setNoticeOverride(null);
		setBulkMode("SINGLE");
		setBulkRaw("");
		setBulkProgress(null);
		setBulkResults(null);
	};

	return {
		values,
		setValues,
		scopeUserOverridden,
		setScopeUserOverridden,
		errors,
		setErrors,
		noticeOverride,
		noticeSettingsPath,
		linkStatus,
		bulkMode,
		setBulkMode,
		bulkRaw,
		setBulkRaw,
		bulkProgress,
		bulkResults,
		requireKnowledgeBaseCategory,
		allowLiveRefresh,
		hasCrawlCapable,
		scrapeProviderName,
		crawlProviderName,
		disabledScrapeProviders,
		searchOnlyProviders,
		canManageSearchProviders,
		preflightStatus,
		/** A "Try again" on a failed pre-flight is in flight. */
		preflightRetrying,
		// Returns nothing: a returned promise would make the Button disable
		// itself while it runs, and drop keyboard focus.
		retryPreflight: () => {
			setPreflightRetrying(true);
			void providersConfigQuery
				.refetch()
				.finally(() => setPreflightRetrying(false));
		},
		/** Changes with every failed read, so a repeated failure is announced. */
		preflightFailureCount: providersConfigQuery.errorUpdateCount,
		/** Submit whichever mode is showing: the single URL or the pasted list. */
		submit: () => (bulkMode === "MULTI" ? submitBulk() : submitSingle()),
		reset,
		isLoading: linkStatus === "processing",
	};
}

export type UrlSourceForm = ReturnType<typeof useUrlSourceForm>;
