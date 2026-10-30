"use client";

import {
	type DocumentAiReviewDescriptor,
	SCOPED_REVISION_REFUSAL_CODES,
} from "@repo/utils/proposal-artifact/scoped-revision-codes";
import {
	buildSectionMap,
	findSection,
} from "@repo/utils/proposal-artifact/section-hash";
import {
	locateSectionTarget,
	spliceSectionBody,
} from "@repo/utils/proposal-artifact/section-splice";
import { orpcClient } from "@shared/lib/orpc-client";
import type { useEditor } from "@tiptap/react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { DocumentSaveBase } from "../../lib/document-save-input";
import { getOrpcErrorData } from "../../lib/orpc-error-data";

/**
 * A finding-driven revision of one section of a client-document Proposal's
 * Main, reviewed in the editor (Fizzy #2946).
 *
 * Asked for by the Internal Analysis ("Apply recommendation"): the editor's
 * save is flushed first, so the server revises the body the editor holds;
 * `projects.proposalArtifact.reviseSection` answers with the section's new
 * own lines, which are spliced into the editor's current body and shown as
 * a diff, under a proposal review the room hears of, the editor read-only.
 * Accept saves through the editor's held AI accept with the `FINDING`
 * descriptor; Reject puts back the body from before the review. The accept
 * is bound to the base the revision read, so the candidate is dropped when
 * that base or the editor's body moved while it was drafted — an edit
 * elsewhere included, whose accept the server would refuse: the editor
 * holds its own typing and autosave meanwhile, but not a collaborator's.
 *
 * Every request is answered once through `onSettled`.
 */

export interface SectionRevisionRequest {
	/** New per request: a request with an id already seen is not run again. */
	id: string;
	runId: string;
	findingId: string;
}

export type SectionRevisionResult =
	| "accepted"
	| "rejected"
	| "refused"
	| "failed";

export interface SectionRevisionOutcome {
	id: string;
	result: SectionRevisionResult;
	/**
	 * Why it was refused or failed: a `reviseSection` status, a scoped
	 * revision refusal code of the save, or one of the editor's own codes
	 * (`SECTION_CHANGED_MEANWHILE`, `NO_BASE`, `SAVE_FAILED`, `HELD_ELSEWHERE`,
	 * `EDITOR_BUSY`, `NO_CHANGE`, `INTERRUPTED`). Each has its reason under
	 * `projects.proposalArtifact.revision.reasons`.
	 */
	code?: string;
}

/** What the editor's save of an accepted revision answered. */
export type SectionRevisionAcceptAnswer =
	/** Saved. */
	| { kind: "saved" }
	/**
	 * Refused by the accept-time check: the editor put the body from before
	 * the review back and offered the refused text to copy.
	 */
	| { kind: "refused"; code: string }
	/** Not saved for another reason, said by the editor's save. */
	| { kind: "notSaved"; code?: string };

/** The editor's codes for a revision it could not start or show. */
export const SECTION_REVISION_EDITOR_CODES = {
	SECTION_CHANGED_MEANWHILE: "SECTION_CHANGED_MEANWHILE",
	NO_BASE: "NO_BASE",
	SAVE_FAILED: "SAVE_FAILED",
	HELD_ELSEWHERE: "HELD_ELSEWHERE",
	EDITOR_BUSY: "EDITOR_BUSY",
	NO_CHANGE: "NO_CHANGE",
	INTERRUPTED: "INTERRUPTED",
} as const;

/**
 * `reviseSection` statuses that answer the request as refused: the revision
 * ran, or could not apply to this body. The others (no provider, no bound
 * prompt, the rate limit) say the revision could not run at all.
 */
const REFUSED_STATUSES: ReadonlySet<string> = new Set([
	"STALE",
	"SECTION_NOT_FOUND",
	"FINDING_SECTION_CHANGED",
	"INVALID_CANDIDATE",
	"RESPONSE_ECHOED",
]);

/** Reasons with copy of their own; any other code reads as `unknown`. */
const KNOWN_REASONS: ReadonlySet<string> = new Set([
	...SCOPED_REVISION_REFUSAL_CODES,
	"STALE",
	"SECTION_NOT_FOUND",
	"INVALID_CANDIDATE",
	"AI_PROVIDER_NOT_CONFIGURED",
	"PROPOSAL_PROMPT_NOT_BOUND",
	"RATE_LIMITED",
	...Object.values(SECTION_REVISION_EDITOR_CODES),
]);

/**
 * The toast id that offers a refused AI accept's text to copy, one per
 * document (Fizzy #2946). It stays until dismissed, so a later offer replaces
 * it, and the next revision dismisses it when its review is shown or it is
 * saved: the offer is about the accept before it.
 */
export function aiAcceptOfferToastId(documentId: string): string {
	return `ai-accept-offer:${documentId}`;
}

/** The `projects.proposalArtifact.revision.reasons` key for `code`. */
export function sectionRevisionReasonKey(code: string | undefined): string {
	return code && KNOWN_REASONS.has(code) ? code : "unknown";
}

type Phase = "idle" | "requesting" | "review" | "applying";

type TiptapEditor = ReturnType<typeof useEditor>;

interface UseSectionRevisionOptions {
	projectId: string;
	documentId: string;
	editor: TiptapEditor | null;
	/** The request to run; a new `id` starts it. */
	request: SectionRevisionRequest | null | undefined;
	/** Ids already run, kept across a remount of the editor. */
	seen: Set<string>;
	/** Extract clean markdown (diff tags stripped) from the editor. */
	getEditorMarkdownForSave: (editor: TiptapEditor | null) => string | null;
	fromMarkdown: (markdown: string) => string;
	diffPartialText: (
		baseline: string,
		newText: string,
		isComplete?: boolean,
	) => string;
	/** Scrolls the editor to the revised section's heading. */
	focusOnAnchor: (editor: TiptapEditor | null, anchor: string) => void;
	/**
	 * Saves what the editor holds, so the server revises that body; `false`
	 * when it could not be saved.
	 */
	flushSave: () => Promise<boolean>;
	/** The saved body the editor's content descends from, or null for none. */
	resolveBase: () => DocumentSaveBase | null;
	/**
	 * Why the editor cannot start a revision right now, as one of
	 * `SECTION_REVISION_EDITOR_CODES`, or null when it can.
	 */
	blockedReason: () => string | null;
	/** Whether another editor in the room reviews a proposal right now. */
	heldElsewhere: () => boolean;
	/** Called right before the candidate's diff goes into the editor. */
	beforePreview: () => void;
	/** Called with the request's id once its candidate is shown for review. */
	onReviewShown?: (id: string) => void;
	/**
	 * Saves the accepted revision as the editor's held AI accept; `onAnswer`
	 * is called once with what became of it.
	 */
	saveAccept: (accept: {
		content: string;
		from: string;
		aiReview: DocumentAiReviewDescriptor;
		onAnswer: (answer: SectionRevisionAcceptAnswer) => void;
	}) => void;
	onSettled?: (outcome: SectionRevisionOutcome) => void;
}

interface Candidate {
	request: SectionRevisionRequest;
	/** The editor's body the candidate was spliced into. */
	baseline: string;
	/** That body with the candidate spliced in. */
	revised: string;
	revisionToken: string;
}

export function useSectionRevision({
	projectId,
	documentId,
	editor,
	request,
	seen,
	getEditorMarkdownForSave,
	fromMarkdown,
	diffPartialText,
	focusOnAnchor,
	flushSave,
	resolveBase,
	blockedReason,
	heldElsewhere,
	beforePreview,
	onReviewShown,
	saveAccept,
	onSettled,
}: UseSectionRevisionOptions) {
	const t = useTranslations("projects.proposalArtifact.revision");
	const [phase, setPhaseState] = useState<Phase>("idle");
	// Read when it is needed, not from a render that may predate it.
	const phaseRef = useRef<Phase>("idle");
	const setPhase = useCallback((next: Phase) => {
		phaseRef.current = next;
		setPhaseState(next);
	}, []);
	const [sectionHeading, setSectionHeading] = useState<string | null>(null);
	// The request in hand, answered once; `null` once answered.
	const activeRef = useRef<SectionRevisionRequest | null>(null);
	const candidateRef = useRef<Candidate | null>(null);
	// Counts requests: a request withdrawn, or unmounted, is stale, and its
	// answer touches neither the hook's state nor the editor.
	const tokenRef = useRef(0);
	const latest = useRef({
		editor,
		getEditorMarkdownForSave,
		fromMarkdown,
		diffPartialText,
		focusOnAnchor,
		flushSave,
		resolveBase,
		blockedReason,
		heldElsewhere,
		beforePreview,
		onReviewShown,
		saveAccept,
		onSettled,
	});
	latest.current = {
		editor,
		getEditorMarkdownForSave,
		fromMarkdown,
		diffPartialText,
		focusOnAnchor,
		flushSave,
		resolveBase,
		blockedReason,
		heldElsewhere,
		beforePreview,
		onReviewShown,
		saveAccept,
		onSettled,
	};

	const reason = useCallback(
		(code: string | undefined) =>
			t(`reasons.${sectionRevisionReasonKey(code)}`),
		[t],
	);

	/**
	 * Answers `answered` once. A caller that handles the outcome says a
	 * refusal or a rejection itself, beside the finding, so the toast here
	 * says one only when nobody else will.
	 */
	const settle = useCallback(
		(
			answered: SectionRevisionRequest,
			result: SectionRevisionResult,
			code?: string,
		) => {
			if (result === "accepted") {
				toast.dismiss(aiAcceptOfferToastId(documentId));
				toast.success(t("accepted"));
			} else if (!latest.current.onSettled) {
				if (result === "refused" || result === "failed") {
					toast.error(t("notApplied", { reason: reason(code) }));
				} else {
					toast.info(t("rejected"));
				}
			}
			latest.current.onSettled?.({
				id: answered.id,
				result,
				...(code ? { code } : {}),
			});
		},
		[t, reason, documentId],
	);

	/** Ends the request in hand, if `answered` still is it. */
	const finish = useCallback(
		(
			answered: SectionRevisionRequest,
			result: SectionRevisionResult,
			code?: string,
		) => {
			if (activeRef.current !== answered) {
				return;
			}
			activeRef.current = null;
			candidateRef.current = null;
			setSectionHeading(null);
			setPhase("idle");
			settle(answered, result, code);
		},
		[setPhase, settle],
	);

	const start = useCallback(
		async (asked: SectionRevisionRequest) => {
			const ed = latest.current.editor;
			if (!ed || phaseRef.current !== "idle") {
				settle(
					asked,
					"refused",
					SECTION_REVISION_EDITOR_CODES.EDITOR_BUSY,
				);
				return;
			}
			const blocked = latest.current.blockedReason();
			if (blocked) {
				settle(asked, "refused", blocked);
				return;
			}
			const token = ++tokenRef.current;
			const stale = () => token !== tokenRef.current;
			activeRef.current = asked;
			setPhase("requesting");

			// The server revises the saved body, so what the editor holds is
			// saved first.
			const flushed = await latest.current.flushSave();
			if (stale()) {
				return;
			}
			if (!flushed) {
				finish(
					asked,
					"refused",
					SECTION_REVISION_EDITOR_CODES.SAVE_FAILED,
				);
				return;
			}
			const base = latest.current.resolveBase();
			const requestedFrom = latest.current.getEditorMarkdownForSave(ed);
			if (!base || requestedFrom === null) {
				finish(asked, "refused", SECTION_REVISION_EDITOR_CODES.NO_BASE);
				return;
			}

			let result: Awaited<
				ReturnType<
					typeof orpcClient.projects.proposalArtifact.reviseSection
				>
			>;
			try {
				result =
					await orpcClient.projects.proposalArtifact.reviseSection({
						projectId,
						documentId,
						runId: asked.runId,
						findingId: asked.findingId,
						baseVersion: base.version,
						baseContentHash: base.contentHash,
					});
			} catch (error) {
				if (stale()) {
					return;
				}
				finish(asked, "failed", getOrpcErrorData(error).code);
				return;
			}
			if (stale()) {
				return;
			}
			if (result.status !== "CANDIDATE") {
				finish(
					asked,
					REFUSED_STATUSES.has(result.status) ? "refused" : "failed",
					result.status,
				);
				return;
			}

			// Another editor's review began meanwhile: the room holds that
			// proposal, and nothing of this one goes in.
			if (latest.current.heldElsewhere()) {
				finish(
					asked,
					"refused",
					SECTION_REVISION_EDITOR_CODES.HELD_ELSEWHERE,
				);
				return;
			}
			const current = latest.current.getEditorMarkdownForSave(ed);
			if (current === null) {
				finish(asked, "failed");
				return;
			}
			// Its accept is bound to the base the revision read, and saves
			// the editor's whole body: a save that moved the base, or an edit
			// anywhere in the editor since the request, would have it
			// refused. Dropped before anything is shown instead.
			const baseNow = latest.current.resolveBase();
			if (
				!baseNow ||
				baseNow.version !== base.version ||
				baseNow.contentHash !== base.contentHash
			) {
				finish(asked, "refused", "STALE");
				return;
			}
			if (current !== requestedFrom) {
				const askedHash = findSection(
					buildSectionMap(requestedFrom),
					result.sectionKey,
				)?.proseHash;
				const currentHash = findSection(
					buildSectionMap(current),
					result.sectionKey,
				)?.proseHash;
				finish(
					asked,
					"refused",
					askedHash === undefined || askedHash !== currentHash
						? SECTION_REVISION_EDITOR_CODES.SECTION_CHANGED_MEANWHILE
						: "STALE",
				);
				return;
			}
			const revised = spliceSectionBody(
				current,
				result.sectionKey,
				result.body,
			);
			if (revised === null) {
				finish(asked, "refused", "SECTION_NOT_FOUND");
				return;
			}
			if (revised.trim() === current.trim()) {
				finish(
					asked,
					"refused",
					SECTION_REVISION_EDITOR_CODES.NO_CHANGE,
				);
				return;
			}

			candidateRef.current = {
				request: asked,
				baseline: current,
				revised,
				revisionToken: result.revisionToken,
			};
			const heading =
				locateSectionTarget(current, result.sectionKey)?.headingText ??
				null;
			setSectionHeading(heading);
			// The text of an earlier refused accept is no longer offered once
			// this review is shown. Not before: a request that ends without a
			// candidate to review leaves that offer where it is.
			toast.dismiss(aiAcceptOfferToastId(documentId));
			// The review is said in the room before its diff goes there.
			latest.current.beforePreview();
			const { fromMarkdown: render, diffPartialText: diff } =
				latest.current;
			try {
				ed.commands.setContent(render(diff(current, revised, true)));
			} catch {
				// Diff markers can break ProseMirror tables.
				ed.commands.setContent(render(revised));
			}
			ed.setEditable(false);
			setPhase("review");
			latest.current.onReviewShown?.(asked.id);
			if (heading) {
				latest.current.focusOnAnchor(ed, heading);
			}
		},
		[projectId, documentId, finish, settle, setPhase],
	);

	// A request with a new id starts once the editor exists.
	const requestId = request?.id;
	useEffect(() => {
		if (!request || !editor || seen.has(request.id)) {
			return;
		}
		seen.add(request.id);
		void start(request);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [requestId, editor]);

	// The editor going away (a closed page, a remount on a lost connection)
	// answers a request still in hand: its review went with the editor. An
	// accept whose save is in flight is not: that save still answers, and
	// says what became of it.
	useEffect(
		() => () => {
			const asked = activeRef.current;
			if (!asked || phaseRef.current === "applying") {
				return;
			}
			tokenRef.current += 1;
			activeRef.current = null;
			latest.current.onSettled?.({
				id: asked.id,
				result: "failed",
				code: SECTION_REVISION_EDITOR_CODES.INTERRUPTED,
			});
		},
		[],
	);

	const accept = useCallback(() => {
		const ed = latest.current.editor;
		const candidate = candidateRef.current;
		if (!ed || !candidate || phaseRef.current !== "review") {
			return;
		}
		if (latest.current.heldElsewhere()) {
			toast.info(reason(SECTION_REVISION_EDITOR_CODES.HELD_ELSEWHERE));
			return;
		}
		const content = latest.current.getEditorMarkdownForSave(ed);
		// A failed or empty read is never saved: the review stays open.
		if (content === null || content.trim() === "") {
			toast.error(reason(undefined));
			return;
		}
		setPhase("applying");
		const { request: asked, baseline, revisionToken } = candidate;
		latest.current.saveAccept({
			content,
			from: baseline,
			aiReview: {
				kind: "FINDING",
				runId: asked.runId,
				findingId: asked.findingId,
				revisionToken,
			},
			onAnswer: (answer) => {
				if (answer.kind === "saved") {
					finish(asked, "accepted");
				} else if (answer.kind === "refused") {
					finish(asked, "refused", answer.code);
				} else {
					finish(asked, "failed", answer.code);
				}
			},
		});
	}, [finish, reason, setPhase]);

	/** Puts the body from before the review back, and answers it rejected. */
	const reject = useCallback((): boolean => {
		const ed = latest.current.editor;
		const candidate = candidateRef.current;
		if (!candidate || phaseRef.current !== "review") {
			return false;
		}
		// Not over the room while another editor's review holds over this
		// one: the room holds that review's proposal.
		if (latest.current.heldElsewhere()) {
			toast.info(reason(SECTION_REVISION_EDITOR_CODES.HELD_ELSEWHERE));
			return false;
		}
		try {
			ed?.commands.setContent(
				latest.current.fromMarkdown(candidate.baseline),
			);
		} catch {
			// Table structure error: the review still ends.
		}
		finish(candidate.request, "rejected");
		return true;
	}, [finish, reason]);

	// Another editor's review, begun at the same moment, holds over this one
	// (Fizzy #2946): it withdraws without writing the editor. A save being
	// answered goes on.
	const withdraw = useCallback(() => {
		const asked = activeRef.current;
		if (!asked || phaseRef.current === "applying") {
			return;
		}
		tokenRef.current += 1;
		finish(asked, "refused", SECTION_REVISION_EDITOR_CODES.HELD_ELSEWHERE);
	}, [finish]);

	// This review holds over another begun at the same moment whose editor
	// wrote into the room before it withdrew: the room gets this diff again.
	const reassert = useCallback(() => {
		const ed = latest.current.editor;
		const candidate = candidateRef.current;
		if (!ed || !candidate || phaseRef.current !== "review") {
			return;
		}
		try {
			ed.commands.setContent(
				latest.current.fromMarkdown(
					latest.current.diffPartialText(
						candidate.baseline,
						candidate.revised,
						true,
					),
				),
			);
		} catch {
			// As for the preview itself.
		}
	}, []);

	const isApplyingNow = useCallback(
		() => phaseRef.current === "applying",
		[],
	);
	const isReviewingNow = useCallback(
		() => phaseRef.current === "review" || phaseRef.current === "applying",
		[],
	);

	return {
		accept,
		reject,
		withdraw,
		reassert,
		isApplyingNow,
		isReviewingNow,
		/** The body the review started from, while one is shown. */
		baseline: () => candidateRef.current?.baseline ?? null,
		sectionHeading,
		isRequesting: phase === "requesting",
		/** A candidate is shown, or its accept is being saved. */
		isReviewing: phase === "review" || phase === "applying",
		isApplying: phase === "applying",
		isActive: phase !== "idle",
	};
}
