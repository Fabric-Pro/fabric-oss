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

	const start = useCallback(async () => {
		if (!editor) {
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
				editor.setEditable(true);
				setPhase("idle");
				toast.info(result.summary || t("noUpdates"));
				return;
			}

			// Show diff in the editor. Diff markers can break ProseMirror tables,
			// so fall back to plain proposed content if fromMarkdown throws.
			const diff = diffPartialText(baseline, proposedContent, true);
			try {
				editor.commands.setContent(fromMarkdown(diff));
			} catch {
				editor.commands.setContent(fromMarkdown(proposedContent));
			}
			editor.setEditable(true);
			setPhase("diff");
		} catch (err) {
			editor.setEditable(true);
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
		t,
		tRefusal,
	]);

	const confirm = useCallback(async () => {
		if (!editor || !preview) {
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
		t,
		tRefusal,
	]);

	const reject = useCallback(() => {
		if (!editor) {
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
	}, [editor, fromMarkdown]);

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
		preview,
		isActive: phase !== "idle",
		isLoading: phase === "loading",
		showingDiff: phase === "diff" || phase === "applying",
		isApplying: phase === "applying",
		loadingStage,
		elapsedSeconds,
	};
}
