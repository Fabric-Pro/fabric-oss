import { computeTodoItemKey } from "@repo/database";
import { describe, expect, it } from "vitest";
import { buildActionItemRows } from "../daily-brief/extract-meeting-insights";

describe("buildActionItemRows", () => {
	it("maps extracted items to ordered rows with null completion", () => {
		const rows = buildActionItemRows({
			extracted: [
				{ text: "Fix the chart", tentativeOwnerName: "Bob" },
				{ text: "Review SOC2 evidence", dueHint: "by Friday" },
			],
			existing: [],
		});
		// `itemKey` is asserted through the shared helper rather than as a
		// literal digest: what matters is that the row builder keys rows with
		// the SAME function the to-do binder reads them back with. A pinned hash
		// would still pass if the two drifted onto different algorithms.
		expect(rows).toEqual([
			{
				orderIndex: 0,
				text: "Fix the chart",
				itemKey: computeTodoItemKey("Fix the chart"),
				tentativeOwnerName: "Bob",
				dueHint: null,
				completedAt: null,
				completedById: null,
				sourceQuote: null,
				anchorLine: null,
			},
			{
				orderIndex: 1,
				text: "Review SOC2 evidence",
				itemKey: computeTodoItemKey("Review SOC2 evidence"),
				tentativeOwnerName: null,
				dueHint: "by Friday",
				completedAt: null,
				completedById: null,
				sourceQuote: null,
				anchorLine: null,
			},
		]);
	});

	it("carries completion over by normalized text match (case/whitespace-insensitive)", () => {
		const done = new Date("2026-07-06T10:00:00Z");
		const rows = buildActionItemRows({
			extracted: [{ text: "Fix the  Chart " }],
			existing: [
				{
					text: "fix the chart",
					completedAt: done,
					completedById: "u1",
				},
			],
		});
		expect(rows[0].completedAt).toEqual(done);
		expect(rows[0].completedById).toBe("u1");
	});

	it("does not carry completion to non-matching items", () => {
		const rows = buildActionItemRows({
			extracted: [{ text: "Entirely new item" }],
			existing: [
				{
					text: "old item",
					completedAt: new Date(),
					completedById: "u1",
				},
			],
		});
		expect(rows[0].completedAt).toBeNull();
	});
});
