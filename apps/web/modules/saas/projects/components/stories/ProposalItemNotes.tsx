"use client";

/**
 * Short notes on one inbox proposal item, shared by its row and its detail
 * dialog: the target ticket changed after the proposal was made, or the item
 * was re-routed to update a ticket and so has no summary of its changes yet.
 */

import { AlertTriangleIcon } from "lucide-react";

const TARGET_CHANGED_MESSAGE =
	"This ticket changed after the proposal was made. The change will be merged into the current ticket.";

/** Why line-by-line review is off for an item whose ticket changed. */
export const LINE_REVIEW_TARGET_CHANGED =
	"Line-by-line review is off: the lines were compared with an older version of the ticket. Apply all changes to merge them into the current one.";

export function TargetChangedNote() {
	return (
		<p className="mt-2 flex items-start gap-1.5 text-amber-700 text-xs dark:text-amber-400">
			<AlertTriangleIcon
				aria-hidden="true"
				className="mt-0.5 size-3.5 shrink-0"
			/>
			{TARGET_CHANGED_MESSAGE}
		</p>
	);
}

/** In place of the update summary of an item re-routed to a ticket. */
export function MergedOnApplyNote() {
	return (
		<p className="mt-2 rounded-md border bg-muted/30 p-3 text-muted-foreground text-xs">
			The proposal is merged into the ticket when applied; the changes are
			listed after apply.
		</p>
	);
}
