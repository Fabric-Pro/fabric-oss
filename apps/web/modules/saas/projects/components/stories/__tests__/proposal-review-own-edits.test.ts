/**
 * The proposed side of a line-by-line review holds only the update's own
 * edits: a meeting update written as a whole version of the ticket is
 * reviewed as its own text, with no model merge. (A merge of any other
 * update is held to the update by `@repo/utils/proposal-update-edits`.)
 */

import { describe, expect, it } from "vitest";
import type { ChangeItem } from "../BacklogChangeProposal";
import {
	proposedBodiesAsIs,
	type TicketBodies,
} from "../proposal-ticket-review";

// The ticket names its export limit thirteen times; the update lowers it
// once, adds a sentence and adds a criterion. The analysis could not merge
// it, so it carries no `from` and the safe-hold flag.
const LIMITS = Array.from({ length: 13 }, (_, index) =>
	index === 0
		? "- Exports are limited to 10,000 rows per file."
		: `- Rule ${index + 1}: a batch stays under 10,000 rows.`,
);
const TICKET: TicketBodies = {
	description: [
		"## Overview",
		"Supervisors export the break queue as CSV.",
		"",
		"### Limits",
		...LIMITS,
		"",
		"### Benefit Hypothesis",
		"Supervisors spend less time on exports.",
	].join("\n"),
	acceptanceCriteria:
		"1. GIVEN a supervisor  \n   WHEN they export the queue  \n   THEN a CSV downloads.",
};
const UPDATE: ChangeItem = {
	type: "feature",
	action: "update",
	existingId: "story-7",
	existingIdentifier: "F-7",
	title: { from: "Bravo", to: "Bravo" },
	description: {
		to: TICKET.description
			.replace("limited to 10,000 rows", "limited to 5,000 rows")
			.replace(
				"### Benefit Hypothesis",
				"Supervisors can schedule a nightly export.\n\n### Benefit Hypothesis",
			),
	},
	acceptanceCriteria: {
		to: `${TICKET.acceptanceCriteria}\n\n### Scheduling\n\n6. GIVEN a supervisor schedules a nightly export  \n   WHEN the schedule runs  \n   THEN the CSV is produced without manual action.`,
	},
	size: { to: "S" },
	priority: { to: "P2_MEDIUM" },
	bodyMergeFallback: true,
	reasoning: "Lower the export limit and add a nightly schedule.",
	sourceContext: "meeting_transcript",
};
const PROPOSED: TicketBodies = {
	description: UPDATE.description?.to ?? "",
	acceptanceCriteria: UPDATE.acceptanceCriteria?.to ?? "",
};

function count(text: string, figure: string): number {
	return text.split(figure).length - 1;
}

describe("proposedBodiesAsIs, for a whole version of the ticket", () => {
	it("is reviewed as its own text, without a merge", () => {
		const bodies = proposedBodiesAsIs(UPDATE, TICKET);

		expect(bodies).toEqual(PROPOSED);
		expect(count(bodies?.description ?? "", "5,000")).toBe(1);
		expect(count(bodies?.description ?? "", "10,000")).toBe(12);
	});

	it("still asks for a merge once the ticket changed since it was written", () => {
		const written = {
			...UPDATE,
			description: {
				from: "## Overview\nAn older text.",
				to: PROPOSED.description,
			},
		};

		expect(proposedBodiesAsIs(written, TICKET)).toBeNull();
	});

	it("reviews an update whose merge fell back during analysis as the ticket with its new detail appended", () => {
		// The analysis kept the ticket and appended the update's detail.
		const appended = `${TICKET.description}\n\nSupervisors can schedule a nightly export.`;
		const safeHeld: ChangeItem = {
			...UPDATE,
			description: { from: TICKET.description, to: appended },
			acceptanceCriteria: undefined,
			bodyMergeFallback: true,
		};

		expect(proposedBodiesAsIs(safeHeld, TICKET)).toEqual({
			description: appended,
			acceptanceCriteria: TICKET.acceptanceCriteria,
		});
	});
});
