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
import {
	type DiffOutcomeAudit,
	useDiffOutcomeStamp,
} from "../hooks/use-diff-outcome-stamp";
import type { DiffViewMode } from "../lib/diff-view-modes";
import {
	acceptChange,
	findDiffRanges,
	rejectChange,
} from "../lib/editor-diff-marks";

interface DiffReviewBarProps {
	editor: Editor | null;
	/**
	 * Accept / reject the whole pending diff. A handler that answers a
	 * proposal says what it answered with — an Accept that could not apply
	 * the proposal answers `false` — and that is the outcome stamped (see
	 * `outcomeAudit`); one that says nothing has nothing stamped.
	 */
	onAcceptAll: () => unknown;
	onRejectAll: () => unknown;
	/** Called before a per-change transaction so the parent can suppress auto-save */
	onBeforeChange?: () => void;
	/** Called after a per-change transaction so the parent can re-enable auto-save */
	onAfterChange?: () => void;
	/**
	 * Diff-outcome audit context. When provided, every accept / reject
	 * (per-change, or bulk with the outcome its handler answered)
	 * additionally fires `agents.conversations.recordDiffOutcome` so the
	 * History drawer's outcome chip reflects what the user did. All three fields
	 * MUST be present together; passing only some is treated as "no
	 * audit context" (skipped) so callers can opt in atomically.
	 *
	 * The audit mutation NEVER blocks the user's accept/reject flow — on
	 * failure we surface a quiet sonner toast but the editor's diff state
	 * is already the source of truth.
	 */
	outcomeAudit?: DiffOutcomeAudit;
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

	// The outcome is stamped fire-and-forget AFTER the editor's diff
	// transaction succeeds (see `useDiffOutcomeStamp`).
	const stampDiffOutcome = useDiffOutcomeStamp();
	const recordOutcome = useCallback(
		(outcome: "accepted" | "rejected") =>
			stampDiffOutcome(outcomeAudit, outcome),
		[outcomeAudit, stampDiffOutcome],
	);

	const ranges = useMemo(() => {
		if (!editor) {
			return [];
		}
		// revision dependency forces re-computation
		void revision;
		return findDiffRanges(editor.state.doc);
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
		const freshRanges = findDiffRanges(editor.state.doc);
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
		const freshRanges = findDiffRanges(editor.state.doc);
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
	// audit fires AFTER the parent handler completes, with what it answered
	// (Fizzy #2946): stamped "accepted", an Accept that applied nothing read
	// as applied, and one with no proposal left to answer stamped one all
	// the same. We don't await the parent because it may be sync (and the
	// audit MUST NOT block).
	const stampAnswered = useCallback(
		(answered: unknown) => {
			if (typeof answered === "boolean") {
				void recordOutcome(answered ? "accepted" : "rejected");
			}
		},
		[recordOutcome],
	);
	const handleAcceptAll = useCallback(() => {
		stampAnswered(onAcceptAll());
	}, [onAcceptAll, stampAnswered]);

	const handleRejectAll = useCallback(() => {
		stampAnswered(onRejectAll());
	}, [onRejectAll, stampAnswered]);

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
					<span className="text-emerald-700 dark:text-emerald-400">
						+{additions} added
					</span>
				)}
				{deletions > 0 && (
					<span className="text-red-700 dark:text-red-400">
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
								className="h-7 gap-1 text-xs text-emerald-700 hover:bg-emerald-50 dark:text-emerald-400 dark:hover:bg-emerald-950"
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
								className="h-7 gap-1 text-xs text-red-700 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950"
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
