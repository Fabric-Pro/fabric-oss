"use client";

import { AI_PROVIDER_NOT_CONFIGURED } from "@saas/shared/lib/ai-provider-missing";
import { orpcClient } from "@shared/lib/orpc-client";
import type { useEditor } from "@tiptap/react";
import { useTranslations } from "next-intl";
import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { useElapsedTimer } from "../../hooks/use-elapsed-timer";
import {
	isEmptyExtractionAgainstBaseline,
	isNoOpProposedContent,
} from "../../lib/confirm-noop-guards";
import type { DocumentSaveBase } from "../../lib/document-save-input";
import { describeDocumentWriteRefusal } from "../../lib/document-write-refusal";
import { getOrpcErrorData } from "../../lib/orpc-error-data";

// ─── Preview failures ─────────────────────────────────────────────────────────

/**
 * `data.code`s of a preview cut off at the model's output limit and of one
 * whose model call failed, spelled out from the `documents.updateWithContext`
 * procedure: the web bundle takes no runtime values from `@repo/api`.
 */
const CONTEXT_UPDATE_TRUNCATED = "CONTEXT_UPDATE_TRUNCATED";
const CONTEXT_UPDATE_FAILED = "CONTEXT_UPDATE_FAILED";

/**
 * The `projects.updateWithContext` key for a preview failure a person can act
 * on (Fizzy #2946), read from the error's `data.code`; `null` for any other.
 * A failed model call is said as one, not as a settings problem: sending
 * someone to settings that are already right does not get them anywhere.
 */
function previewFailureKey(
	error: unknown,
): "aiProviderMissing" | "documentTooLarge" | "modelCallFailed" | null {
	switch (getOrpcErrorData(error).code) {
		case AI_PROVIDER_NOT_CONFIGURED:
			return "aiProviderMissing";
		case CONTEXT_UPDATE_TRUNCATED:
			return "documentTooLarge";
		case CONTEXT_UPDATE_FAILED:
			return "modelCallFailed";
		default:
			return null;
	}
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DocumentContextUpdatePreview {
	hasRelevantContext: boolean;
	summary: string;
	needsHumanResolution: boolean;
	proposedContent: string | null;
	documentVersion: number;
}

type Phase = "idle" | "loading" | "diff" | "applying";

interface UseUpdateDocumentWithContextOptions {
	projectId: string;
	documentId: string;
	organizationId: string | null;
	editor: ReturnType<typeof useEditor> | null;
	/** Extract clean markdown (diff tags stripped) from the editor. */
	getEditorMarkdownForSave: (
		editor: ReturnType<typeof useEditor> | null,
	) => string | null;
	/** Convert markdown (possibly with diff wrappers) to tiptap-compatible HTML. */
	fromMarkdown: (markdown: string) => string;
	/** Produce `<ins>`/`<del>` diff markers between two markdown strings. */
	diffPartialText: (
		baseline: string,
		newText: string,
		isComplete?: boolean,
	) => string;
	/** Called after a confirm is saved, with the version the server answered. */
	onSaved: (documentVersion: number) => void;
	/**
	 * The base an editor save names right now (Fizzy #2946): the saved body
	 * the editor's content descends from, `null`/`undefined` when saves name
	 * none, or `"unavailable"` while a collaborative room has no stamp yet.
	 * Read when the preview starts and sent with the confirm, so a confirm is
	 * refused when the document changed since the preview was drafted.
	 */
	resolveBase?: () => DocumentSaveBase | null | undefined | "unavailable";
	/**
	 * Whether another editor in a collaborative room reviews an assistant
	 * proposal right now (Fizzy #2946). The room holds that proposal, so
	 * nothing of this update goes into the editor meanwhile: a preview that
	 * answers then is dropped, a confirm or reject waits, and the editor is
	 * not unlocked — its own rule unlocks it once that review is answered.
	 */
	heldElsewhere?: () => boolean;
	/** Called right before the preview's diff goes into the editor. */
	beforePreview?: () => void;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useUpdateDocumentWithContext({
	projectId,
	documentId,
	organizationId,
	editor,
	getEditorMarkdownForSave,
	fromMarkdown,
	diffPartialText,
	onSaved,
	resolveBase,
	heldElsewhere,
	beforePreview,
}: UseUpdateDocumentWithContextOptions) {
	// Everything this hook says is in the reader's locale, a refused confirm
	// included: never the server's English (Fizzy #2946).
	const t = useTranslations("projects.updateWithContext");
	const tRefusal = useTranslations("projects.documentWriteRefusal");
	const [phase, setPhase] = useState<Phase>("idle");
	const [preview, setPreview] = useState<DocumentContextUpdatePreview | null>(
		null,
	);
	const baselineRef = useRef<string>("");
	// The base of the body the preview is drafted from, captured with it.
	const previewBaseRef = useRef<DocumentSaveBase | null>(null);
	const elapsedSeconds = useElapsedTimer(phase === "loading");
	// Read when they are needed, not when the callbacks were made.
	const heldElsewhereRef = useRef(heldElsewhere);
	heldElsewhereRef.current = heldElsewhere;
	const beforePreviewRef = useRef(beforePreview);
	beforePreviewRef.current = beforePreview;
	const isHeldElsewhere = useCallback(
		() => heldElsewhereRef.current?.() === true,
		[],
	);
	// Counts preview requests (Fizzy #2946). A request withdrawn, or one a
	// later request replaced, is stale: its answer touches neither the
	// hook's state nor the editor.
	const requestRef = useRef(0);
	// Whether a confirm is being saved right now, read when it is asked —
	// not from a render that may predate it (Fizzy #2946).
	const applyingRef = useRef(false);
	const isApplyingNow = useCallback(() => applyingRef.current, []);

	const start = useCallback(async () => {
		if (!editor) {
			return;
		}
		// Unlocked again unless another editor's review holds it now.
		const unlock = () => {
			if (!isHeldElsewhere()) {
				editor.setEditable(true);
			}
		};
		if (isHeldElsewhere()) {
			toast.info(t("heldElsewhere"));
			return;
		}

		const baseline = getEditorMarkdownForSave(editor);
		// Null means serialization failed — there is no baseline
		// to safely diff against or send to the server. Bail before touching
		// editor/phase state so the user can just retry.
		if (baseline === null) {
			toast.error(t("readFailed"));
			return;
		}
		// The confirm names the base the preview was drafted from. A room
		// without a stamp yet has none to name, and a confirm without one
		// could write over a body saved since: try again once it has one.
		const base = resolveBase?.();
		if (base === "unavailable") {
			toast.info(t("syncing"));
			return;
		}
		const request = ++requestRef.current;
		const stale = () => request !== requestRef.current;
		previewBaseRef.current = base ?? null;
		baselineRef.current = baseline;
		// Lock the editor while the preview RPC is in flight so mid-review
		// typing isn't silently overwritten by the setContent that builds the
		// diff from baselineRef. Unlocked again before showing the diff so
		// DiffReviewBar's arrow navigation (focus + scrollIntoView) works.
		editor.setEditable(false);
		setPhase("loading");
		setPreview(null);

		try {
			const result =
				await orpcClient.projects.documents.updateWithContext({
					projectId,
					id: documentId,
					organizationId,
					preview: true,
					currentContent: baseline,
				});
			if (stale()) {
				return;
			}

			const previewData: DocumentContextUpdatePreview = {
				hasRelevantContext: result.hasRelevantContext,
				summary: result.summary,
				needsHumanResolution: result.needsHumanResolution,
				proposedContent: result.proposedContent ?? null,
				documentVersion: result.documentVersion ?? 0,
			};
			setPreview(previewData);

			const proposedContent = previewData.proposedContent;
			// No-op gate (belt-and-suspenders under the server-side check): the
			// preview is a no-op when there's no relevant context, no proposed
			// content, or the proposed content is normalized-identical to the
			// baseline. Never enter the diff phase for a save that would no-op.
			// The inline `!proposedContent` clause also narrows it to a non-null
			// string for the diff below.
			if (
				!result.hasRelevantContext ||
				!proposedContent ||
				isNoOpProposedContent(proposedContent, baseline)
			) {
				unlock();
				setPhase("idle");
				toast.info(result.summary || t("noUpdates"));
				return;
			}

			// Another editor's review began while this preview was drafted
			// (Fizzy #2946): the room holds that proposal now, and this one
			// was drafted from the body before it. It is dropped, not kept
			// for later, and said so; the update can be asked for again once
			// that review is answered.
			if (isHeldElsewhere()) {
				setPhase("idle");
				setPreview(null);
				toast.info(t("heldElsewhere"));
				return;
			}
			// The body changed while the preview was drafted — in a room, a
			// colleague's edit reached this editor meanwhile (Fizzy #2946).
			// The preview, drafted from the body before, would replace that
			// edit, and a confirm would save without it: it is dropped the
			// same way, and the update can be asked for again.
			if (getEditorMarkdownForSave(editor) !== baseline) {
				unlock();
				setPhase("idle");
				setPreview(null);
				toast.info(t("changedMeanwhile"));
				return;
			}

			// Show diff in the editor. Diff markers can break ProseMirror tables,
			// so fall back to plain proposed content if fromMarkdown throws.
			const diff = diffPartialText(baseline, proposedContent, true);
			beforePreviewRef.current?.();
			try {
				editor.commands.setContent(fromMarkdown(diff));
			} catch {
				editor.commands.setContent(fromMarkdown(proposedContent));
			}
			unlock();
			setPhase("diff");
		} catch (err) {
			if (stale()) {
				return;
			}
			unlock();
			setPhase("idle");
			// No AI provider, a document too large for the model's output, or
			// a model call that failed is said with what resolves it. A
			// preview writes nothing, so any other failure is a failure to
			// draft, not to change the document.
			const failureKey = previewFailureKey(err);
			const refusal = describeDocumentWriteRefusal(err, tRefusal);
			toast.error(
				failureKey !== null
					? t(failureKey)
					: refusal.kind === "failed"
						? t("previewFailed")
						: refusal.message,
			);
		}
	}, [
		editor,
		projectId,
		documentId,
		organizationId,
		getEditorMarkdownForSave,
		fromMarkdown,
		diffPartialText,
		resolveBase,
		isHeldElsewhere,
		t,
		tRefusal,
	]);

	const confirm = useCallback(async () => {
		if (!editor || !preview) {
			return;
		}
		// Not while another editor reviews a proposal: the review stays open.
		if (isHeldElsewhere()) {
			toast.info(t("heldElsewhere"));
			return;
		}

		const finalContent = getEditorMarkdownForSave(editor);

		// Null means serialization failed outright (distinct from
		// a genuinely empty document, which is "" and a legitimate save).
		// Persisting null would write an empty document. Keep the review
		// recoverable (stay in "diff") and surface an actionable error.
		if (finalContent === null) {
			toast.error(t("confirmReadFailed"));
			return;
		}

		// Never persist an extraction that came back empty against a non-empty
		// baseline: even a legitimate "" read here would silently wipe the
		// document on save. Keep the review recoverable (stay in "diff") and
		// surface an actionable error.
		if (
			isEmptyExtractionAgainstBaseline(finalContent, baselineRef.current)
		) {
			toast.error(t("confirmReadFailed"));
			return;
		}

		setPhase("applying");
		applyingRef.current = true;
		const base = previewBaseRef.current;
		try {
			const response =
				await orpcClient.projects.documents.updateWithContext({
					projectId,
					id: documentId,
					organizationId,
					preview: false,
					confirmedContent: finalContent,
					documentVersion: preview.documentVersion,
					...(base
						? {
								expectedVersion: base.version,
								expectedContentHash: base.contentHash,
							}
						: {}),
				});

			setPhase("idle");
			setPreview(null);
			// The server's summary of a confirm is fixed English, so the
			// reader's own sentence is shown instead.
			if (response.applied === false) {
				toast.info(t("notApplied"));
			} else {
				toast.success(
					t("applied", { version: response.documentVersion }),
				);
			}
			onSaved(response.documentVersion);

			// Replace the diff view with the clean final content.
			try {
				editor.commands.setContent(fromMarkdown(finalContent));
			} catch {
				// Structural error from tiptap — the save still succeeded; the
				// cache refetch above will re-sync the editor on next render.
			}
		} catch (err) {
			// A run writing the document, a save since the preview, or a page
			// too old to name its base: each is said in the reader's words,
			// and the review stays open.
			setPhase("diff");
			toast.error(describeDocumentWriteRefusal(err, tRefusal).message);
		} finally {
			applyingRef.current = false;
		}
	}, [
		editor,
		preview,
		projectId,
		documentId,
		organizationId,
		getEditorMarkdownForSave,
		fromMarkdown,
		onSaved,
		isHeldElsewhere,
		t,
		tRefusal,
	]);

	const reject = useCallback(() => {
		if (!editor) {
			return;
		}
		// Nor a reject, which puts the body from before it back over the
		// room — and the proposal under review there.
		if (isHeldElsewhere()) {
			toast.info(t("heldElsewhere"));
			return;
		}

		setPhase("idle");
		setPreview(null);

		try {
			editor.commands.setContent(fromMarkdown(baselineRef.current));
		} catch {
			// Table structure error — phase is already idle so the user can
			// continue manually.
		}
	}, [editor, fromMarkdown, isHeldElsewhere, t]);

	// Another editor's review, begun at the same moment as this one, holds
	// over it (Fizzy #2946): this one withdraws without writing the editor —
	// the room holds that review's proposal, which putting this one's
	// baseline back would replace. A confirm already being saved goes on.
	const withdraw = useCallback(() => {
		if (phase === "applying") {
			return;
		}
		// A preview still being drafted is withdrawn with it.
		requestRef.current += 1;
		setPhase("idle");
		setPreview(null);
	}, [phase]);

	// This review holds over another begun at the same moment, whose editor
	// wrote into the room before it withdrew (Fizzy #2946): the room gets
	// this one's again — its diff while it shows one, the body it is drafted
	// from while it drafts.
	const reassert = useCallback(() => {
		if (!editor) {
			return;
		}
		const proposed = preview?.proposedContent;
		try {
			if (phase === "diff" && proposed) {
				editor.commands.setContent(
					fromMarkdown(
						diffPartialText(baselineRef.current, proposed, true),
					),
				);
			} else if (phase === "loading") {
				editor.commands.setContent(fromMarkdown(baselineRef.current));
			}
		} catch {
			// Table structure error — as for the preview itself.
		}
	}, [editor, phase, preview, fromMarkdown, diffPartialText]);

	// Time-based stage heuristic — the server doesn't emit progress, so we
	// approximate from elapsed time. RAG fetch + live-integration fetch
	// typically complete within ~3 s; the AI pass dominates the rest.
	const loadingStage =
		phase === "loading"
			? elapsedSeconds < 3
				? t("loadingStage.scanning")
				: t("loadingStage.drafting")
			: null;

	return {
		start,
		confirm,
		reject,
		withdraw,
		reassert,
		isApplyingNow,
		preview,
		isActive: phase !== "idle",
		isLoading: phase === "loading",
		showingDiff: phase === "diff" || phase === "applying",
		isApplying: phase === "applying",
		loadingStage,
		elapsedSeconds,
	};
}
