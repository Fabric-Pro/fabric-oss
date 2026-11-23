"use client";

/**
 * The review controls of a Proposal Inbox update on its ticket page, above
 * the editor that shows its changes: what is being reviewed, the change
 * navigation and per-change accept / reject of `DiffReviewBar`, and the
 * item's decision (apply what was accepted, reject every change, or cancel
 * and apply nothing).
 */

import { summarizeProposalUpdate } from "@repo/utils/proposal-update-summary";
import type { Editor } from "@tiptap/react";
import { Button } from "@ui/components/button";
import { CheckIcon, Loader2Icon, XIcon } from "lucide-react";
import { useId, useState } from "react";
import type { DiffViewMode } from "../../lib/diff-view-modes";
import {
	acceptAllChanges,
	editorHoldsDiffMarks,
	rejectAllChanges,
} from "../../lib/editor-diff-marks";
import { DiffReviewBar } from "../DiffReviewBar";
import type { useProposalTicketReview } from "./useProposalTicketReview";

type Props = {
	review: ReturnType<typeof useProposalTicketReview>;
	editor: Editor | null;
	mode: DiffViewMode;
	onBeforeChange: () => void;
	onAfterChange: () => void;
};

export function ProposalTicketReviewBar({
	review,
	editor,
	mode,
	onBeforeChange,
	onAfterChange,
}: Props) {
	const headingId = useId();
	// Re-read the editor's marks after each per-change decision: once none
	// is left, the change navigation goes (its empty state would offer a
	// Dismiss that rejects the item) and Apply writes what was accepted.
	const [, setDecisions] = useState(0);
	const change = review.review?.change;
	if (!change) {
		return null;
	}
	const holdsMarks = editorHoldsDiffMarks(editor?.state.doc);
	// Title, priority and size are not in the editor: they apply as the
	// reviewer left them in the inbox, with a change accepted here, or once
	// every change here is answered (alone when every one was rejected).
	const otherFields = summarizeProposalUpdate({
		title: change.title,
		priority: change.priority,
		size: change.size,
	}).map((line) => line.label);
	const busy = review.isApplying;
	const unavailable = review.lineByLineUnavailable;
	// Apply stays off until it would write something, so it never rejects
	// the item: a reviewer who accepts nothing chooses Reject all.
	const canApply = review.showingDiff && review.canApply();
	const applyHintId = `${headingId}-apply-hint`;
	// Answer every mark still in the editor, as one per-change decision.
	const answerAll = (answer: (target: Editor) => boolean) => {
		if (!editor || busy) {
			return;
		}
		onBeforeChange();
		try {
			answer(editor);
		} finally {
			onAfterChange();
		}
		setDecisions((count) => count + 1);
	};
	return (
		<section
			aria-labelledby={headingId}
			data-testid="proposal-ticket-review"
			className="border-b border-border bg-card"
		>
			<div className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
				<div className="min-w-0 space-y-1">
					<p id={headingId} className="text-sm font-medium">
						Reviewing a proposed update: {change.title.to}
					</p>
					<p className="text-xs text-muted-foreground" role="status">
						{review.isMerging
							? review.mergeFailed
								? "Couldn't work out what this update changes on the ticket as it is now."
								: "Working out what this update changes on the ticket as it is now…"
							: unavailable
								? "Line-by-line review isn't available for this update: its changes can't be marked, so the editor shows the proposed text whole. Nothing here can be accepted; Reject all moves the item to Rejected."
								: "Accept or reject each change. Apply writes only the changes you accept and drops any you have not decided; Reject all moves the item to Rejected."}
					</p>
					{otherFields.length > 0 && !unavailable && (
						<p className="text-xs text-muted-foreground">
							Apply also sets, as approved in the inbox:{" "}
							{otherFields.join(", ")}
							{holdsMarks
								? ", once you accept a change or reject every change."
								: "."}
						</p>
					)}
					{review.showingDiff && !canApply && (
						<p
							id={applyHintId}
							className="text-xs text-muted-foreground"
						>
							{unavailable
								? "To apply the whole update, cancel this review and choose Apply all changes in the Proposal Inbox; or choose Reject all."
								: mode === "inline"
									? otherFields.length > 0
										? `Accept at least one change, or reject every change to apply only ${otherFields.join(", ")}; or choose Reject all.`
										: "Accept at least one change to apply it, or choose Reject all."
									: "Accept changes in the Inline view, or with Accept All, to apply them; or choose Reject all."}
						</p>
					)}
				</div>
				<div className="flex shrink-0 flex-wrap items-center gap-2">
					{review.isMerging && review.mergeFailed && (
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={review.retryMerge}
						>
							Try again
						</Button>
					)}
					<Button
						type="button"
						variant="ghost"
						size="sm"
						onClick={review.cancel}
						disabled={busy}
					>
						Cancel review
					</Button>
					{review.showingDiff && (
						<>
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={() => {
									void review.rejectAll();
								}}
								disabled={busy}
								aria-label={`Reject all changes to ${change.title.to}`}
							>
								<XIcon
									className="mr-1 size-3.5"
									aria-hidden="true"
								/>
								Reject all
							</Button>
							<Button
								type="button"
								size="sm"
								onClick={() => {
									void review.apply();
								}}
								disabled={busy || !canApply}
								aria-label={`Apply the accepted changes to ${change.title.to}`}
								aria-describedby={
									canApply ? undefined : applyHintId
								}
							>
								{busy ? (
									<Loader2Icon
										className="mr-1 size-3.5 motion-safe:animate-spin"
										aria-hidden="true"
									/>
								) : (
									<CheckIcon
										className="mr-1 size-3.5"
										aria-hidden="true"
									/>
								)}
								Apply accepted changes
							</Button>
						</>
					)}
				</div>
			</div>
			{review.showingDiff && holdsMarks && (
				<DiffReviewBar
					editor={editor}
					mode={mode}
					// Its Accept all / Reject all and their shortcuts answer
					// the marks in the editor only; the item is decided by
					// the buttons above.
					onAcceptAll={() => answerAll(acceptAllChanges)}
					onRejectAll={() => answerAll(rejectAllChanges)}
					onBeforeChange={onBeforeChange}
					onAfterChange={() => {
						onAfterChange();
						setDecisions((count) => count + 1);
					}}
				/>
			)}
		</section>
	);
}
