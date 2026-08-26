"use client";

import type { Editor } from "@tiptap/react";
import { Button } from "@ui/components/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { Check, ChevronDown, ChevronUp, Keyboard, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useRecordDocumentAssistantDiffOutcome } from "../hooks/useDocumentAssistantHistory";
import type { DiffViewMode } from "../lib/diff-view-modes";

interface DiffRange {
	from: number;
	to: number;
	type: "addition" | "deletion";
}

/**
 * Scan the editor document for diff-specific marks only.
 * Uses diffInsert/diffDelete (rendered as <ins>/<del>) so that
 * ordinary italic and strikethrough formatting is never mistaken
 * for a pending AI change.
 */
function findDiffRanges(editor: Editor): DiffRange[] {
	const ranges: DiffRange[] = [];
	const { doc } = editor.state;

	doc.descendants((node, pos) => {
		if (!node.isText) {
			return;
		}
		for (const mark of node.marks) {
			if (mark.type.name === "diffInsert") {
				ranges.push({
					from: pos,
					to: pos + node.nodeSize,
					type: "addition",
				});
			} else if (mark.type.name === "diffDelete") {
				ranges.push({
					from: pos,
					to: pos + node.nodeSize,
					type: "deletion",
				});
			}
		}
	});

	// Merge adjacent ranges of the same type
	const merged: DiffRange[] = [];
	for (const range of ranges) {
		const prev = merged[merged.length - 1];
		if (prev && prev.type === range.type && prev.to === range.from) {
			prev.to = range.to;
		} else {
			merged.push({ ...range });
		}
	}

	return merged;
}

/**
 * Accept a single diff change:
 * - Addition (diffInsert / <ins>): remove the mark, keep the text
 * - Deletion (diffDelete / <del>): delete the text entirely
 */
function acceptChange(editor: Editor, range: DiffRange) {
	const { tr } = editor.state;
	if (range.type === "addition") {
		const mark = editor.schema.marks.diffInsert;
		if (mark) {
			tr.removeMark(range.from, range.to, mark);
		}
	} else {
		tr.delete(range.from, range.to);
	}
	editor.view.dispatch(tr);
}

/**
 * Reject a single diff change:
 * - Addition (diffInsert / <ins>): delete the text entirely
 * - Deletion (diffDelete / <del>): remove the mark, keep the text
 */
function rejectChange(editor: Editor, range: DiffRange) {
	const { tr } = editor.state;
	if (range.type === "addition") {
		tr.delete(range.from, range.to);
	} else {
		const mark = editor.schema.marks.diffDelete;
		if (mark) {
			tr.removeMark(range.from, range.to, mark);
		}
	}
	editor.view.dispatch(tr);
}

interface DiffReviewBarProps {
	editor: Editor | null;
	onAcceptAll: () => void;
	onRejectAll: () => void;
	/** Called before a per-change transaction so the parent can suppress auto-save */
	onBeforeChange?: () => void;
	/** Called after a per-change transaction so the parent can re-enable auto-save */
	onAfterChange?: () => void;
	/**
	 * Diff-outcome audit context (Group G — spec §3.8 FR-23). When provided,
	 * every successful accept / reject (per-change OR bulk) additionally
	 * fires `agents.conversations.recordDiffOutcome` so the History
	 * drawer's outcome chip reflects what the user did. All three fields
	 * MUST be present together; passing only some is treated as "no
	 * audit context" (skipped) so callers can opt in atomically.
	 *
	 * The audit mutation NEVER blocks the user's accept/reject flow — on
	 * failure we surface a quiet sonner toast but the editor's diff state
	 * is already the source of truth.
	 */
	outcomeAudit?: {
		conversationId: string | null;
		projectId: string;
		organizationId: string | null;
		messageId: string | null;
		toolCallId: string | null;
	};
	/**
	 * Active diff review presentation. Absent / "inline" keeps the full bar.
	 * In "sideBySide" / "fullPreview" the live editor is hidden behind read-only
	 * panes, so per-change navigation and accept/reject are suppressed and a
	 * muted hint points back to Inline; the change summary and bulk Accept All /
	 * Reject All remain (they act on the whole pending diff).
	 */
	mode?: DiffViewMode;
}

export function DiffReviewBar({
	editor,
	onAcceptAll,
	onRejectAll,
	onBeforeChange,
	onAfterChange,
	outcomeAudit,
	mode,
}: DiffReviewBarProps) {
	const t = useTranslations("tooltips.documentEditor");
	// Inline is the only mode where the live editor — and thus per-change
	// navigation / accept-reject — is visible. Side-by-side / full-preview hide
	// the editor behind read-only panes, so those controls are suppressed.
	const isInline = !mode || mode === "inline";
	const [currentIndex, setCurrentIndex] = useState(0);
	// Increment to force re-scan after per-change accept/reject
	const [revision, setRevision] = useState(0);
	const barRef = useRef<HTMLDivElement>(null);

	// Group G — spec §3.8 FR-23. The mutation fires fire-and-forget AFTER the
	// editor's diff transaction succeeds; it MUST NEVER block the user's path
	// nor roll back the editor on failure. The diff in the editor IS the
	// source of truth; the audit trail on the conversation is a nice-to-have.
	const recordDiffOutcomeMutation = useRecordDocumentAssistantDiffOutcome();

	/**
	 * Stamp acceptedAt / rejectedAt on the (messageId, toolCallId) entry in
	 * the persisted messages blob. Quiet failure path: surface a sonner
	 * `error` toast and continue. Skips entirely when the audit context is
	 * incomplete (e.g. the diff is from `useUpdateDocumentWithContext`,
	 * which is NOT a `write_document_local` tool call and is therefore
	 * out of scope for FR-23).
	 */
	const recordOutcome = useCallback(
		async (outcome: "accepted" | "rejected") => {
			if (!outcomeAudit) {
				return;
			}
			const {
				conversationId,
				projectId,
				organizationId,
				messageId,
				toolCallId,
			} = outcomeAudit;
			if (!conversationId || !messageId || !toolCallId) {
				if (process.env.NODE_ENV !== "production") {
					// eslint-disable-next-line no-console
					console.debug(
						"[DiffReviewBar] skipping recordDiffOutcome — incomplete audit context",
						{ conversationId, messageId, toolCallId },
					);
				}
				return;
			}
			try {
				await recordDiffOutcomeMutation.mutateAsync({
					conversationId,
					projectId,
					organizationId,
					messageId,
					toolCallId,
					outcome,
					at: new Date().toISOString(),
				});
			} catch {
				toast.error(
					"Couldn't record diff outcome — your accept/reject was still applied.",
				);
			}
		},
		[outcomeAudit, recordDiffOutcomeMutation],
	);

	const ranges = useMemo(() => {
		if (!editor) {
			return [];
		}
		// revision dependency forces re-computation
		void revision;
		return findDiffRanges(editor);
	}, [editor, revision, editor?.state.doc]);

	const additions = ranges.filter((r) => r.type === "addition").length;
	const deletions = ranges.filter((r) => r.type === "deletion").length;

	const scrollToRange = useCallback(
		(index: number) => {
			const range = ranges[index];
			if (!range || !editor) {
				return;
			}
			// Chain focus → selection → scroll in a single transaction
			editor
				.chain()
				.focus()
				.setTextSelection(range.from)
				.scrollIntoView()
				.run();
		},
		[editor, ranges],
	);

	const goNext = useCallback(() => {
		if (ranges.length === 0) {
			return;
		}
		const next = (currentIndex + 1) % ranges.length;
		setCurrentIndex(next);
		scrollToRange(next);
	}, [currentIndex, ranges.length, scrollToRange]);

	const goPrev = useCallback(() => {
		if (ranges.length === 0) {
			return;
		}
		const prev = (currentIndex - 1 + ranges.length) % ranges.length;
		setCurrentIndex(prev);
		scrollToRange(prev);
	}, [currentIndex, ranges.length, scrollToRange]);

	// Direct edits to the editor (typing while the bar is open) move the
	// absolute positions of every diff hunk but don't re-render this component,
	// so the memoized `ranges` array can hold pre-shift positions. Using those
	// stale positions in a `tr.delete(...)` call removes the wrong characters
	// — that's the "next approval omits characters" bug. Recompute fresh from
	// the live editor state at action time so accept/reject always operates on
	// the current positions, no matter what the user typed in between.
	const handleAcceptCurrent = useCallback(() => {
		if (!editor) {
			return;
		}
		const freshRanges = findDiffRanges(editor);
		const range = freshRanges[currentIndex];
		if (!range) {
			return;
		}
		onBeforeChange?.();
		acceptChange(editor, range);
		onAfterChange?.();
		setRevision((r) => r + 1);
		if (currentIndex >= freshRanges.length - 1) {
			setCurrentIndex(Math.max(0, freshRanges.length - 2));
		}
		// Fire-and-forget audit AFTER the editor transaction succeeds.
		void recordOutcome("accepted");
	}, [editor, currentIndex, onBeforeChange, onAfterChange, recordOutcome]);

	const handleRejectCurrent = useCallback(() => {
		if (!editor) {
			return;
		}
		const freshRanges = findDiffRanges(editor);
		const range = freshRanges[currentIndex];
		if (!range) {
			return;
		}
		onBeforeChange?.();
		rejectChange(editor, range);
		onAfterChange?.();
		setRevision((r) => r + 1);
		if (currentIndex >= freshRanges.length - 1) {
			setCurrentIndex(Math.max(0, freshRanges.length - 2));
		}
		void recordOutcome("rejected");
	}, [editor, currentIndex, onBeforeChange, onAfterChange, recordOutcome]);

	// Bulk accept / reject — wrap the parent's existing callback so the
	// audit fires AFTER the parent handler completes. We don't await the
	// parent because it may be sync (and the audit MUST NOT block).
	const handleAcceptAll = useCallback(() => {
		onAcceptAll();
		void recordOutcome("accepted");
	}, [onAcceptAll, recordOutcome]);

	const handleRejectAll = useCallback(() => {
		onRejectAll();
		void recordOutcome("rejected");
	}, [onRejectAll, recordOutcome]);

	// Keyboard shortcuts — scoped to the editor container and the bar itself.
	// Only fires when the active element is inside the editor's DOM or this bar,
	// so typing in the CopilotKit sidebar or other inputs is not intercepted.
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			const target = e.target as HTMLElement;
			const editorDom = editor?.view?.dom;
			const barDom = barRef.current;
			// Only handle shortcuts when focus is inside the editor or the bar itself
			if (!editorDom?.contains(target) && !barDom?.contains(target)) {
				return;
			}

			if (isInline && e.altKey && e.key === "ArrowDown") {
				e.preventDefault();
				goNext();
			} else if (isInline && e.altKey && e.key === "ArrowUp") {
				e.preventDefault();
				goPrev();
			} else if (isInline && e.altKey && e.key === "Enter") {
				e.preventDefault();
				handleAcceptCurrent();
			} else if (isInline && e.altKey && e.key === "Backspace") {
				e.preventDefault();
				handleRejectCurrent();
			} else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
				e.preventDefault();
				handleAcceptAll();
			} else if (e.key === "Escape") {
				e.preventDefault();
				handleRejectAll();
			}
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [
		editor,
		goNext,
		goPrev,
		handleAcceptCurrent,
		handleRejectCurrent,
		handleAcceptAll,
		handleRejectAll,
		isInline,
	]);

	// Zero diff marks while a parent still believes a review is active (e.g. a
	// preview that normalized to no changes, or a diff that got discarded on an
	// editor re-init). Rather than a dead end (a review state with no exit
	// affordance), render a compact bar with a single dismiss that exits the
	// review via the parent's reject-all path.
	if (ranges.length === 0) {
		return (
			<div
				ref={barRef}
				className="sticky top-0 z-10 flex items-center gap-3 px-4 py-2 bg-muted/50 border-b border-border text-sm backdrop-blur-sm"
			>
				<span className="text-muted-foreground">
					{t("noChangesToReview")}
				</span>
				<Button
					variant="outline"
					size="sm"
					className="h-7 gap-1 text-xs ml-auto"
					onClick={onRejectAll}
					aria-label={t("rejectAll")}
				>
					<X className="h-3.5 w-3.5" />
					{t("dismiss")}
				</Button>
			</div>
		);
	}

	return (
		<div
			ref={barRef}
			className="sticky top-0 z-10 flex items-center gap-3 px-4 py-2 bg-muted/50 border-b border-border text-sm backdrop-blur-sm"
		>
			{/* Change summary */}
			<div className="flex items-center gap-2 text-muted-foreground">
				<span className="font-medium text-foreground">
					{ranges.length} {ranges.length === 1 ? "change" : "changes"}
				</span>
				{additions > 0 && (
					<span className="text-emerald-600 dark:text-emerald-400">
						+{additions} added
					</span>
				)}
				{deletions > 0 && (
					<span className="text-red-500 dark:text-red-400">
						-{deletions} removed
					</span>
				)}
			</div>

			{/* Navigation */}
			{isInline && (
				<div className="flex items-center gap-1 ml-auto">
					<span className="text-xs text-muted-foreground mr-1">
						{ranges.length > 0 ? currentIndex + 1 : 0}/
						{ranges.length}
					</span>
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								variant="ghost"
								size="sm"
								className="h-7 w-7 p-0"
								onClick={goPrev}
								aria-label={t("diffPrevious")}
							>
								<ChevronUp className="h-4 w-4" />
							</Button>
						</TooltipTrigger>
						<TooltipContent>{t("diffPrevious")}</TooltipContent>
					</Tooltip>
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								variant="ghost"
								size="sm"
								className="h-7 w-7 p-0"
								onClick={goNext}
								aria-label={t("diffNext")}
							>
								<ChevronDown className="h-4 w-4" />
							</Button>
						</TooltipTrigger>
						<TooltipContent>{t("diffNext")}</TooltipContent>
					</Tooltip>
				</div>
			)}

			{/* Per-change actions */}
			{isInline && (
				<div className="flex items-center gap-1 border-l border-border pl-3">
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								variant="ghost"
								size="sm"
								className="h-7 gap-1 text-xs text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50 dark:text-emerald-400 dark:hover:bg-emerald-950"
								onClick={handleAcceptCurrent}
								aria-label={t("approve")}
							>
								<Check className="h-3.5 w-3.5" />
								Accept
							</Button>
						</TooltipTrigger>
						<TooltipContent>{t("approve")}</TooltipContent>
					</Tooltip>
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								variant="ghost"
								size="sm"
								className="h-7 gap-1 text-xs text-red-500 hover:text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950"
								onClick={handleRejectCurrent}
								aria-label={t("reject")}
							>
								<X className="h-3.5 w-3.5" />
								Reject
							</Button>
						</TooltipTrigger>
						<TooltipContent>{t("reject")}</TooltipContent>
					</Tooltip>
				</div>
			)}
			{!isInline && (
				<span className="ml-auto text-xs text-muted-foreground">
					{t("diffPerChangeInInlineHint")}
				</span>
			)}

			{/* Bulk actions */}
			<div className="flex items-center gap-1 border-l border-border pl-3">
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							variant="default"
							size="sm"
							className="h-7 gap-1 text-xs"
							onClick={handleAcceptAll}
							aria-label={t("approveAll")}
						>
							<Check className="h-3.5 w-3.5" />
							Accept All
						</Button>
					</TooltipTrigger>
					<TooltipContent>{t("approveAll")}</TooltipContent>
				</Tooltip>
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							variant="outline"
							size="sm"
							className="h-7 gap-1 text-xs"
							onClick={handleRejectAll}
							aria-label={t("rejectAll")}
						>
							<X className="h-3.5 w-3.5" />
							Reject All
						</Button>
					</TooltipTrigger>
					<TooltipContent>{t("rejectAll")}</TooltipContent>
				</Tooltip>
			</div>

			{/* Keyboard shortcut hint */}
			{isInline && (
				<div className="hidden lg:flex items-center gap-1 text-xs text-muted-foreground border-l border-border pl-3">
					<Keyboard className="h-3 w-3" />
					<span>Alt+Arrows navigate</span>
				</div>
			)}
		</div>
	);
}
