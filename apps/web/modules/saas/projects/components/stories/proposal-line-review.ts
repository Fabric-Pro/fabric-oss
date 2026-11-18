/**
 * Line-by-line ("Thorough") review of a proposed update: the reviewer
 * accepts or rejects each changed region of the description and acceptance
 * criteria, and only the accepted regions are applied.
 *
 * A body can be reviewed this way only when its `to` is the text apply will
 * write. That holds once analysis has already merged the update into the
 * ticket's structure (`structurePreserved`); otherwise apply merges the
 * proposed text into the ticket itself, so the lines shown here are not the
 * lines that get saved, and the field keeps its whole-field toggle.
 */

import {
	changedLineHunks,
	mergeAcceptedHunks,
	summarizeProposalUpdate,
} from "@repo/utils/proposal-update-summary";
import type { SkippableField } from "./BacklogChangeDetailDialog";
import type { ChangeItem } from "./BacklogChangeProposal";

export type LineReviewField = "description" | "acceptanceCriteria";

/** Rejected hunk ids per body field; a hunk not listed is accepted. */
export type LineDecisions = Partial<Record<LineReviewField, Set<number>>>;

const LINE_REVIEW_FIELDS: readonly LineReviewField[] = [
	"description",
	"acceptanceCriteria",
];

type LineReviewAvailability =
	| { kind: "available"; from: string; to: string }
	| { kind: "unchanged" }
	| { kind: "merged-at-apply" };

/** Whether one body field of an update can be reviewed line by line. */
export function lineReviewAvailability(
	change: ChangeItem,
	field: LineReviewField,
): LineReviewAvailability {
	const value = change[field];
	if (
		change.action !== "update" ||
		!value ||
		value.from === undefined ||
		value.from === value.to
	) {
		return { kind: "unchanged" };
	}
	if (
		change.structurePreserved !== true ||
		change.bodyMergeDeferred === true ||
		change.bodyMergeFallback === true
	) {
		return { kind: "merged-at-apply" };
	}
	return { kind: "available", from: value.from, to: value.to };
}

/** The ids of every changed region of a reviewable body field. */
function hunkIds(change: ChangeItem, field: LineReviewField): number[] {
	const availability = lineReviewAvailability(change, field);
	if (availability.kind !== "available") {
		return [];
	}
	return changedLineHunks(availability.from, availability.to).map(
		(hunk) => hunk.id,
	);
}

/**
 * The change as approved line by line: each reviewed body's `to` becomes
 * the text its accepted regions build. A body whose every region was
 * rejected is left out, the same as a rejected field. Fields that are not
 * line-reviewable, or that an earlier step removed, pass through unchanged.
 */
export function applyLineDecisions(
	change: ChangeItem,
	decisions: LineDecisions,
): ChangeItem {
	const next: ChangeItem = { ...change };
	for (const field of LINE_REVIEW_FIELDS) {
		const rejected = decisions[field];
		const availability = lineReviewAvailability(change, field);
		if (
			!rejected ||
			rejected.size === 0 ||
			availability.kind !== "available"
		) {
			continue;
		}
		const merged = mergeAcceptedHunks(
			availability.from,
			availability.to,
			rejected,
		);
		next[field] =
			merged === availability.from
				? undefined
				: { from: availability.from, to: merged };
	}
	return next;
}

/**
 * True when the reviewer rejected every change the update proposes: each
 * moved field is either rejected whole or, for a reviewable body, has every
 * region rejected. False when the update moves nothing.
 */
export function rejectsEveryChange(
	change: ChangeItem,
	skipped: ReadonlySet<SkippableField>,
	decisions: LineDecisions,
): boolean {
	const moved = summarizeProposalUpdate(change).map((line) => line.field);
	if (moved.length === 0) {
		return false;
	}
	return moved.every((field) => {
		if (skipped.has(field)) {
			return true;
		}
		if (field !== "description" && field !== "acceptanceCriteria") {
			return false;
		}
		const ids = hunkIds(change, field);
		const rejected = decisions[field];
		return (
			ids.length > 0 &&
			rejected !== undefined &&
			ids.every((id) => rejected.has(id))
		);
	});
}
