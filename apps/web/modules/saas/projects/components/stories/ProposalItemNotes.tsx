"use client";

/**
 * Short notes on one inbox proposal item, shared by its row and its detail
 * dialog: the target ticket changed after the proposal was made, the item
 * was re-routed to update a ticket and its change summary is not read yet,
 * or a Rejected item was merged into another item as its duplicate.
 */

import { AlertTriangleIcon } from "lucide-react";
import { z } from "zod";
import type { EnrichmentPreviewState } from "./enrichment-preview";

/**
 * The note a duplicate merge leaves on the Rejected row, under
 * `sourceMetadata.rejectionNote` (`MergedDuplicateNote` in the database
 * package).
 */
const mergedDuplicateNoteSchema = z.object({
	kind: z.literal("merged_duplicate"),
	intoItemTitle: z.string().optional(),
});

/**
 * Where a Rejected proposal went when it was merged into another inbox item
 * as its duplicate. Nothing for a proposal rejected any other way.
 */
export function MergedIntoNote({
	sourceMetadata,
}: {
	sourceMetadata: Record<string, unknown> | null;
}) {
	const note = mergedDuplicateNoteSchema.safeParse(
		sourceMetadata?.rejectionNote,
	);
	if (!note.success) {
		return null;
	}
	const title = note.data.intoItemTitle?.trim();
	return (
		<p className="text-xs text-muted-foreground">
			{title
				? `Merged into “${title}”`
				: "Merged into another inbox item"}
		</p>
	);
}

const TARGET_CHANGED_MESSAGE =
	"This ticket changed after the proposal was made. The change will be merged into the current ticket.";

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

/**
 * Why an item re-routed to a ticket cannot be approved yet: its merge into
 * that ticket, which its change summary is built from, is still being read
 * or could not be read. Null once the summary is shown.
 */
export function rerouteSummaryBlockedReason(
	status: EnrichmentPreviewState["status"] | undefined,
): string | null {
	switch (status) {
		case undefined:
		case "ready":
			return null;
		case "loading":
			return "Wait for the summary of what this item changes on its target ticket.";
		case "error":
			return "The summary of what this item changes could not be read. Try again before approving.";
		default: {
			const unhandled: never = status;
			return unhandled;
		}
	}
}

/**
 * Why an update cannot be applied when its target ticket is not a work item
 * in this project: the apply would hold it back.
 */
export function missingTargetBlockedReason(
	targetIdentifier: string | null | undefined,
): string {
	const target = targetIdentifier
		? `Ticket ${targetIdentifier}`
		: "Its target ticket";
	return `${target} is not a work item in this project, so this update can't be applied. Move it to Rejected instead.`;
}

/**
 * In place of the update summary of an item re-routed to a ticket, while
 * its merge into that ticket is read, or when it could not be read.
 */
export function RerouteSummaryNote({
	state,
	targetIdentifier,
}: {
	state: Exclude<EnrichmentPreviewState, { status: "ready" }>;
	targetIdentifier?: string;
}) {
	const target = targetIdentifier || "the target ticket";
	return (
		<div
			className="mt-2 rounded-md border bg-muted/30 p-3 text-muted-foreground text-xs"
			data-testid="reroute-summary-note"
		>
			{state.status === "loading" ? (
				<p>Working out what this item changes on {target}…</p>
			) : (
				<p className="flex flex-wrap items-center gap-x-2">
					Couldn't work out what this item changes on {target}.
					<button
						type="button"
						onClick={state.retry}
						className="font-medium text-primary underline-offset-2 hover:underline focus-visible:underline"
					>
						Try again
					</button>
				</p>
			)}
		</div>
	);
}
