import { describe, expect, it } from "vitest";
import {
	bodyEditsAgainst,
	mergeWithinUpdate,
	ownEditBodies,
	type UpdateBodies,
	type UpdateBodyEdits,
} from "../proposal-update-edits";

// A meeting update in the shape the inbox receives: the ticket names its
// export limit thirteen times, and the update lowers it once, adds a
// sentence and adds a criterion, as a whole version of each body.
const LIMITS = Array.from({ length: 13 }, (_, index) =>
	index === 0
		? "- Exports are limited to 10,000 rows per file."
		: `- Rule ${index + 1}: a batch stays under 10,000 rows.`,
);
const TICKET: UpdateBodies = {
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
const NEW_SENTENCE = "Supervisors can schedule a nightly export.";
const PROPOSED: UpdateBodies = {
	description: TICKET.description
		.replace("limited to 10,000 rows", "limited to 5,000 rows")
		.replace(
			"### Benefit Hypothesis",
			`${NEW_SENTENCE}\n\n### Benefit Hypothesis`,
		),
	acceptanceCriteria: `${TICKET.acceptanceCriteria}\n\n### Scheduling\n\n6. GIVEN a supervisor schedules a nightly export  \n   WHEN the schedule runs  \n   THEN the CSV is produced without manual action.`,
};
const WHOLE_VERSION: UpdateBodyEdits = {
	description: { to: PROPOSED.description },
	acceptanceCriteria: { to: PROPOSED.acceptanceCriteria },
};

function count(text: string, figure: string): number {
	return text.split(figure).length - 1;
}

describe("ownEditBodies", () => {
	it("writes a whole version of the ticket as it is", () => {
		const bodies = ownEditBodies(WHOLE_VERSION, TICKET);

		expect(bodies).toEqual(PROPOSED);
		expect(count(bodies?.description ?? "", "5,000")).toBe(1);
		expect(count(bodies?.description ?? "", "10,000")).toBe(12);
	});

	it("leaves a version written against older text to a merge", () => {
		const older: UpdateBodyEdits = {
			...WHOLE_VERSION,
			description: { from: "An older text.", to: PROPOSED.description },
		};

		expect(ownEditBodies(older, TICKET)).toBeNull();
	});

	it("leaves new detail to a merge", () => {
		expect(
			ownEditBodies({ description: { to: NEW_SENTENCE } }, TICKET),
		).toBeNull();
	});
});

describe("bodyEditsAgainst", () => {
	it("reads a whole version with no from as its own edits to the ticket", () => {
		expect(bodyEditsAgainst(WHOLE_VERSION, TICKET)).toEqual({
			description: { from: TICKET.description, to: PROPOSED.description },
			acceptanceCriteria: {
				from: TICKET.acceptanceCriteria,
				to: PROPOSED.acceptanceCriteria,
			},
		});
	});

	it("reads new detail with no from as the ticket with that detail appended", () => {
		expect(
			bodyEditsAgainst({ description: { to: NEW_SENTENCE } }, TICKET),
		).toEqual({
			description: {
				from: TICKET.description,
				to: `${TICKET.description}\n\n${NEW_SENTENCE}`,
			},
			acceptanceCriteria: undefined,
		});
	});

	it("keeps a body that has a from as it is", () => {
		const update: UpdateBodyEdits = {
			description: { from: "An older text.", to: NEW_SENTENCE },
		};

		expect(bodyEditsAgainst(update, TICKET).description).toBe(
			update.description,
		);
	});
});

describe("mergeWithinUpdate", () => {
	it("offers none of a merge's edits the update does not hold", () => {
		// What a model merge wrote: every limit lowered, and blocks that are
		// in neither the ticket nor the update.
		const merged: UpdateBodies = {
			description: `${PROPOSED.description.replaceAll("10,000", "5,000")}\n\n### UC2 Scheduled export\nFR6: exports run on a schedule.\n\n### Open questions\n- Which time zone?`,
			acceptanceCriteria: `${PROPOSED.acceptanceCriteria}\n\n7. GIVEN a gap in the schedule  \n   THEN it is flagged.`,
		};

		const held = mergeWithinUpdate(WHOLE_VERSION, TICKET, merged);

		expect(held?.bodies.description.trim()).toBe(PROPOSED.description);
		expect(held?.bodies.acceptanceCriteria.trim()).toBe(
			PROPOSED.acceptanceCriteria,
		);
		expect(held?.detailAppended).toBe(false);
	});

	it("never removes a line for new detail whose replacement came from elsewhere", () => {
		const detail: UpdateBodyEdits = { description: { to: NEW_SENTENCE } };
		const merged: UpdateBodies = {
			description: TICKET.description
				.replaceAll("10,000", "5,000")
				.replace(
					"### Benefit Hypothesis",
					`${NEW_SENTENCE}\n\n### Benefit Hypothesis`,
				),
			acceptanceCriteria: `${TICKET.acceptanceCriteria}\n2. GIVEN anything`,
		};

		const held = mergeWithinUpdate(detail, TICKET, merged);

		expect(count(held?.bodies.description ?? "", "10,000")).toBe(13);
		expect(count(held?.bodies.description ?? "", "5,000")).toBe(0);
		expect(held?.bodies.description).toContain(NEW_SENTENCE);
		// A body the update does not change stays as it is.
		expect(held?.bodies.acceptanceCriteria).toBe(TICKET.acceptanceCriteria);
		expect(held?.detailAppended).toBe(false);
	});

	it("keeps a line a merge deleted with nothing in its place", () => {
		const current: UpdateBodies = {
			description: "A\nB\nC",
			acceptanceCriteria: "",
		};
		const detail: UpdateBodyEdits = { description: { to: "D" } };

		const held = mergeWithinUpdate(detail, current, {
			description: "A\nC\nD",
			acceptanceCriteria: "",
		});

		expect(held?.bodies.description).toBe("A\nB\nC\nD");
	});

	it("replaces a line in place, without its old text beside it, when a merge rewrote its block only in part", () => {
		const current: UpdateBodies = {
			description: "- Exports: 10,000 rows.\n- Imports: 10,000 rows.",
			acceptanceCriteria: "",
		};
		const merged: UpdateBodies = {
			description: "- Exports: 5,000 rows.\n- Imports: 5,000 rows.",
			acceptanceCriteria: "",
		};

		const held = mergeWithinUpdate(
			{ description: { to: "- Exports: 5,000 rows." } },
			current,
			merged,
		);

		expect(held?.bodies.description).toBe(
			"- Exports: 5,000 rows.\n- Imports: 10,000 rows.",
		);
	});

	describe("a sentence of new detail inside a paragraph", () => {
		const PARAGRAPH = (limit: string, header: string) =>
			`Add an Export CSV action for supervisors. Each export is limited to ${limit} rows, and the supervisor is notified when the export is truncated. Each CSV export includes ${header}.`;
		const current: UpdateBodies = {
			description: [
				"### Overview",
				"",
				PARAGRAPH("10,000", "a header row"),
				"",
				"### Notes",
				"- Support: an export may be truncated at 10,000 rows.",
			].join("\n"),
			acceptanceCriteria: "",
		};
		const update: UpdateBodyEdits = {
			description: { to: "Each export is limited to 5,000 rows" },
		};

		it("replaces the sentence in place, without the old figure beside it or the sentence appended", () => {
			const merged: UpdateBodies = {
				description: current.description.replaceAll("10,000", "5,000"),
				acceptanceCriteria: "",
			};

			const held = mergeWithinUpdate(update, current, merged);

			expect(held?.bodies.description).toBe(
				current.description.replace(
					PARAGRAPH("10,000", "a header row"),
					PARAGRAPH("5,000", "a header row"),
				),
			);
			// The other line that names the figure is not the update's.
			expect(held?.bodies.description).toContain(
				"- Support: an export may be truncated at 10,000 rows.",
			);
			expect(count(held?.bodies.description ?? "", "5,000")).toBe(1);
			expect(held?.detailAppended).toBe(false);
		});

		it("keeps the paragraph as it was when the merge also changed words outside the update's sentence", () => {
			const merged: UpdateBodies = {
				description: current.description.replace(
					PARAGRAPH("10,000", "a header row"),
					PARAGRAPH("5,000", "two header rows"),
				),
				acceptanceCriteria: "",
			};

			const held = mergeWithinUpdate(update, current, merged);

			expect(held?.bodies.description).toBe(
				`${current.description}\n\nEach export is limited to 5,000 rows`,
			);
			expect(held?.detailAppended).toBe(true);
		});

		it("rewrites no line from a short sentence that fits every line sharing a figure", () => {
			const rules = Array.from(
				{ length: 12 },
				(_, index) => `- Rule ${index + 1}: Max 10,000 rows.`,
			).join("\n");
			const ticket: UpdateBodies = {
				description: rules,
				acceptanceCriteria: "",
			};
			const shortDetail: UpdateBodyEdits = {
				description: { to: "Note: limits changed. Max 5,000 rows." },
			};

			const held = mergeWithinUpdate(shortDetail, ticket, {
				description: rules.replaceAll("10,000", "5,000"),
				acceptanceCriteria: "",
			});

			expect(count(held?.bodies.description ?? "", "10,000")).toBe(12);
			expect(held?.bodies.description).toBe(
				`${rules}\n\nNote: limits changed. Max 5,000 rows.`,
			);
		});
	});

	it("appends the update's new detail unchanged when the merge offers none of it", () => {
		// The merge reworded the update's sentence and added a block nobody
		// proposed: neither may be written, and the sentence is not lost.
		const update: UpdateBodyEdits = {
			description: { to: NEW_SENTENCE },
			acceptanceCriteria: {
				to: "2. GIVEN a schedule  \n   THEN it runs.",
			},
		};
		const merged: UpdateBodies = {
			description: TICKET.description.replace(
				"### Benefit Hypothesis",
				"Supervisors may set up nightly exports.\n\n### UC2 Scheduled export\n\n### Benefit Hypothesis",
			),
			acceptanceCriteria: TICKET.acceptanceCriteria,
		};

		const held = mergeWithinUpdate(update, TICKET, merged);

		expect(held?.bodies.description).toBe(
			`${TICKET.description}\n\n${NEW_SENTENCE}`,
		);
		expect(held?.bodies.acceptanceCriteria).toBe(
			`${TICKET.acceptanceCriteria}\n\n2. GIVEN a schedule  \n   THEN it runs.`,
		);
		expect(held?.detailAppended).toBe(true);
	});

	it("appends all of the update's new detail to the ticket as it is when the merge fell back", () => {
		// A merge that fell back merged nothing: its callers pass the ticket.
		const update: UpdateBodyEdits = {
			description: { from: "An older text.", to: NEW_SENTENCE },
			acceptanceCriteria: {
				to: "2. GIVEN a schedule  \n   THEN it runs.",
			},
		};

		const held = mergeWithinUpdate(update, TICKET, TICKET);

		expect(held?.bodies.description).toBe(
			`${TICKET.description}\n\n${NEW_SENTENCE}`,
		);
		expect(held?.bodies.acceptanceCriteria).toBe(
			`${TICKET.acceptanceCriteria}\n\n2. GIVEN a schedule  \n   THEN it runs.`,
		);
		expect(held?.detailAppended).toBe(true);
	});

	it("keeps the body when the update adds nothing the ticket lacks", () => {
		const merged: UpdateBodies = {
			...TICKET,
			description: `${TICKET.description}\n\n### UC2 Scheduled export`,
		};

		expect(
			mergeWithinUpdate(
				{
					description: {
						to: "Supervisors export the break queue as CSV.",
					},
				},
				TICKET,
				merged,
			),
		).toBeNull();
	});
});
