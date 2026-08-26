"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import type { useEditor } from "@tiptap/react";
import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { useElapsedTimer } from "../../hooks/use-elapsed-timer";
import type { FromMarkdownOptions } from "../../lib/diff-utils";
import {
	ACCEPTANCE_CRITERIA_PRESERVED_MESSAGE,
	formatStoryContent,
	resolveStoryContentForSave,
} from "../../lib/story-content";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ContextUpdatePreview {
	hasRelevantContext: boolean;
	summary: string;
	proposedDescription: string | null;
	proposedAcceptanceCriteria: string | null;
	storyVersion: number;
}

type Phase = "idle" | "loading" | "diff" | "applying";

interface UseUpdateWithContextOptions {
	projectId: string;
	storyId: string;
	organizationId: string | null;
	editor: ReturnType<typeof useEditor> | null;
	parseContent: (markdown: string) => {
		description: string;
		acceptanceCriteria: string;
	};
	getEditorMarkdownForSave: (
		editor: ReturnType<typeof useEditor> | null,
	) => string | null;
	fromMarkdown: (markdown: string, options?: FromMarkdownOptions) => string;
	diffPartialText: (
		baseline: string,
		newText: string,
		isComplete?: boolean,
	) => string;
	onSaved: () => void;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useUpdateWithContext({
	projectId,
	storyId,
	organizationId,
	editor,
	parseContent,
	getEditorMarkdownForSave,
	fromMarkdown,
	diffPartialText,
	onSaved,
}: UseUpdateWithContextOptions) {
	const [phase, setPhase] = useState<Phase>("idle");
	const [preview, setPreview] = useState<ContextUpdatePreview | null>(null);
	const baselineRef = useRef<string>("");
	const elapsedSeconds = useElapsedTimer(phase === "loading");

	const start = useCallback(async () => {
		if (!editor) {
			return;
		}

		// Capture baseline (what the user sees now, possibly unsaved)
		const baseline = getEditorMarkdownForSave(editor);
		// Null means serialization failed — there is no baseline
		// to safely diff against or send to the server. Bail before touching
		// editor/phase state so the user can just retry.
		if (baseline === null) {
			toast.error(
				"Couldn't read the editor content — please try again or reload the page.",
			);
			return;
		}
		baselineRef.current = baseline;
		editor.setEditable(false);
		setPhase("loading");
		setPreview(null);

		// Send current editor content to the server so the AI works against
		// what the user sees, not the last-saved DB state.
		const parsed = parseContent(baseline);

		try {
			const result = await orpcClient.projects.stories.updateWithContext({
				projectId,
				storyId,
				organizationId,
				preview: true,
				currentDescription: parsed.description || "",
				currentAcceptanceCriteria: parsed.acceptanceCriteria || null,
			});

			const previewData: ContextUpdatePreview = {
				hasRelevantContext: result.hasRelevantContext,
				summary: result.summary,
				proposedDescription: result.proposedDescription ?? null,
				proposedAcceptanceCriteria:
					result.proposedAcceptanceCriteria ?? null,
				storyVersion: result.storyVersion ?? 0,
			};
			setPreview(previewData);

			if (!result.hasRelevantContext) {
				// No changes — restore and inform user
				editor.setEditable(true);
				setPhase("idle");
				toast.info(result.summary || "No relevant context found.");
				return;
			}

			// Build the proposed full document to diff against
			const proposedDoc = buildProposedDocument(
				baseline,
				previewData,
				parseContent,
			);

			// Show diff in editor — diff markers can break table structures
			// in ProseMirror, so fall back to plain proposed content on error
			const diff = diffPartialText(baseline, proposedDoc, true);
			try {
				const html = fromMarkdown(diff);
				editor.commands.setContent(html);
			} catch {
				// Table/structural error from diff markers — show proposed
				// content without diff highlighting so the user can still
				// review and confirm/reject. `proposedDoc` splices AI text into
				// the user's baseline (buildProposedDocument): any section the
				// AI didn't propose a change for still carries the user's
				// hand-authored, Turndown-shaped text — opt out.
				const plainHtml = fromMarkdown(proposedDoc, {
					repairLegacyBullets: false,
				});
				editor.commands.setContent(plainHtml);
			}
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
		storyId,
		organizationId,
		getEditorMarkdownForSave,
		diffPartialText,
		fromMarkdown,
		parseContent,
	]);

	const confirm = useCallback(async () => {
		if (!editor || !preview) {
			return;
		}

		// Strip diff tags → final clean content
		const finalContent = getEditorMarkdownForSave(editor);
		// Null means serialization failed. Persisting it would
		// write an empty/garbage description. Stay in "diff" so the review is
		// still recoverable and the user can retry or reject.
		if (finalContent === null) {
			toast.error(
				"Couldn't read the editor content — nothing was saved. Copy any unsaved work and reload the page.",
			);
			return;
		}

		setPhase("applying");
		try {
			// Guard the split against an AI rewrite that dropped the
			// `Acceptance Criteria` heading: without this, the criteria fold
			// into the description and the column is persisted as null. Source
			// the existing criteria from the pre-edit baseline.
			const existingAcceptanceCriteria = parseContent(
				baselineRef.current,
			).acceptanceCriteria;
			const parsed = resolveStoryContentForSave(
				finalContent,
				existingAcceptanceCriteria,
			);
			if (parsed.acceptanceCriteriaPreserved) {
				toast.warning(ACCEPTANCE_CRITERIA_PRESERVED_MESSAGE);
			}

			await orpcClient.projects.stories.updateWithContext({
				projectId,
				storyId,
				organizationId,
				preview: false,
				confirmedDescription: parsed.description || "",
				confirmedAcceptanceCriteria: parsed.acceptanceCriteria || null,
				storyVersion: preview.storyVersion,
			});

			// Reset state and restore editor
			setPhase("idle");
			setPreview(null);
			editor.setEditable(true);
			toast.success("Feature updated with latest context");
			onSaved();

			// Set editor to clean content (no diff highlighting). Fizzy #1987:
			// `finalContent` is the accepted merge, which carries the user's
			// own hand-authored text wherever the AI proposed no change — opt
			// out of the legacy bullet repair so those bullets aren't collapsed.
			try {
				editor.commands.setContent(
					fromMarkdown(finalContent, { repairLegacyBullets: false }),
				);
			} catch {
				// Table structure error — changes are saved, editor will
				// sync from the refetched story prop via Effect 5
			}
		} catch (err) {
			// On conflict/error, stay in diff view so user can retry or reject
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
		storyId,
		organizationId,
		getEditorMarkdownForSave,
		parseContent,
		fromMarkdown,
		onSaved,
	]);

	const reject = useCallback(() => {
		if (!editor) {
			return;
		}

		// Reset state first so the UI unblocks even if setContent throws
		setPhase("idle");
		setPreview(null);
		editor.setEditable(true);

		// Restore original content. `baselineRef.current` is stored,
		// hand-authored user content (from `getEditorMarkdownForSave`) — opt
		// out of the legacy bullet repair.
		try {
			const html = fromMarkdown(baselineRef.current, {
				repairLegacyBullets: false,
			});
			editor.commands.setContent(html);
		} catch {
			// Table structure error — editor is already editable and
			// phase is idle, so the user can continue editing manually
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Reconstruct the full proposed document by replacing description and/or
 * acceptance criteria sections from the AI preview into the baseline document.
 */
function buildProposedDocument(
	baseline: string,
	preview: ContextUpdatePreview,
	parseContent: (md: string) => {
		description: string;
		acceptanceCriteria: string;
	},
): string {
	const current = parseContent(baseline);
	return formatStoryContent({
		description: preview.proposedDescription ?? current.description,
		acceptanceCriteria:
			preview.proposedAcceptanceCriteria ?? current.acceptanceCriteria,
	});
}
