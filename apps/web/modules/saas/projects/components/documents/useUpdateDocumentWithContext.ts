"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import type { useEditor } from "@tiptap/react";
import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { useElapsedTimer } from "../../hooks/use-elapsed-timer";
import {
	isEmptyExtractionAgainstBaseline,
	isNoOpProposedContent,
} from "../../lib/confirm-noop-guards";

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
	onSaved: () => void;
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
}: UseUpdateDocumentWithContextOptions) {
	const [phase, setPhase] = useState<Phase>("idle");
	const [preview, setPreview] = useState<DocumentContextUpdatePreview | null>(
		null,
	);
	const baselineRef = useRef<string>("");
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
			toast.error(
				"Couldn't read the document content — please try again or reload the page.",
			);
			return;
		}
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
				toast.info(
					result.summary ||
						"No updates found — the document already reflects the latest context.",
				);
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
			const msg =
				err instanceof Error
					? err.message
					: "Failed to fetch context. Please try again.";
			toast.error(msg);
		}
	}, [
		editor,
		projectId,
		documentId,
		organizationId,
		getEditorMarkdownForSave,
		fromMarkdown,
		diffPartialText,
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
			toast.error(
				"Couldn't read the document content from the editor — nothing was saved. Copy any unsaved work and reload the page.",
			);
			return;
		}

		// Never persist an extraction that came back empty against a non-empty
		// baseline: even a legitimate "" read here would silently wipe the
		// document on save. Keep the review recoverable (stay in "diff") and
		// surface an actionable error.
		if (
			isEmptyExtractionAgainstBaseline(finalContent, baselineRef.current)
		) {
			toast.error(
				"Couldn't read the document content from the editor — nothing was saved. Copy any unsaved work and reload the page.",
			);
			return;
		}

		setPhase("applying");
		try {
			const response =
				await orpcClient.projects.documents.updateWithContext({
					projectId,
					id: documentId,
					organizationId,
					preview: false,
					confirmedContent: finalContent,
					documentVersion: preview.documentVersion,
				});

			setPhase("idle");
			setPreview(null);
			if (response.applied === false) {
				toast.info(
					response.summary ||
						"No changes were applied — the document already matches.",
				);
			} else {
				toast.success(
					`Document updated with latest context — saved as v${response.documentVersion}`,
				);
			}
			onSaved();

			// Replace the diff view with the clean final content.
			try {
				editor.commands.setContent(fromMarkdown(finalContent));
			} catch {
				// Structural error from tiptap — the save still succeeded; the
				// cache refetch above will re-sync the editor on next render.
			}
		} catch (err) {
			setPhase("diff");
			const msg =
				err instanceof Error
					? err.message
					: "Failed to apply changes. Please try again.";
			toast.error(msg);
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
				? "Scanning project context"
				: "AI reviewing and drafting updates"
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
