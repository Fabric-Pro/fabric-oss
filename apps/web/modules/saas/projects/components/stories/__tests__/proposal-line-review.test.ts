import { describe, expect, it } from "vitest";
import type { SkippableField } from "../BacklogChangeDetailDialog";
import type { ChangeItem } from "../BacklogChangeProposal";
import {
	applyLineDecisions,
	lineReviewAvailability,
	rejectsEveryChange,
} from "../proposal-line-review";

const merged: ChangeItem = {
	type: "feature",
	action: "update",
	existingId: "story-1",
	existingIdentifier: "F-12",
	title: { from: "Export", to: "Export as CSV" },
	description: {
		from: "Intro\nOld step\nTail",
		to: "Intro\nNew step\nTail\nAdded",
	},
	acceptanceCriteria: { from: "- A", to: "- A\n- B" },
	reasoning: "Asked for in the release thread",
	sourceContext: "slack_messages",
	structurePreserved: true,
};

const none: ReadonlySet<SkippableField> = new Set();

describe("lineReviewAvailability", () => {
	it("offers line review for a body already merged at analysis", () => {
		expect(lineReviewAvailability(merged, "description")).toEqual({
			kind: "available",
			from: "Intro\nOld step\nTail",
			to: "Intro\nNew step\nTail\nAdded",
		});
	});

	it.each([
		["not merged yet", { structurePreserved: undefined }],
		["merge deferred to apply", { bodyMergeDeferred: true }],
		["merge held back", { bodyMergeFallback: true }],
	])("withholds it when the body is %s", (_label, extra) => {
		expect(
			lineReviewAvailability({ ...merged, ...extra }, "description"),
		).toEqual({ kind: "merged-at-apply" });
	});

	it("has nothing to review on a create or an unchanged body", () => {
		expect(
			lineReviewAvailability(
				{ ...merged, action: "create" },
				"description",
			),
		).toEqual({ kind: "unchanged" });
		expect(
			lineReviewAvailability(
				{ ...merged, acceptanceCriteria: { from: "- A", to: "- A" } },
				"acceptanceCriteria",
			),
		).toEqual({ kind: "unchanged" });
	});
});

describe("applyLineDecisions", () => {
	it("keeps the change as proposed with no rejected regions", () => {
		expect(applyLineDecisions(merged, {})).toEqual(merged);
	});

	it("writes only the accepted regions of a body", () => {
		const next = applyLineDecisions(merged, {
			description: new Set([1]),
		});

		expect(next.description).toEqual({
			from: "Intro\nOld step\nTail",
			to: "Intro\nNew step\nTail",
		});
		expect(next.acceptanceCriteria).toEqual(merged.acceptanceCriteria);
		expect(next.title).toEqual(merged.title);
	});

	it("leaves out a body whose every region was rejected", () => {
		const next = applyLineDecisions(merged, {
			acceptanceCriteria: new Set([0]),
		});

		expect(next.acceptanceCriteria).toBeUndefined();
	});

	it("ignores decisions on a body that is merged at apply", () => {
		const unmerged = { ...merged, structurePreserved: undefined };

		expect(
			applyLineDecisions(unmerged, { description: new Set([0, 1]) }),
		).toEqual(unmerged);
	});
});

describe("rejectsEveryChange", () => {
	const scalarsRejected: ReadonlySet<SkippableField> = new Set(["title"]);

	it("is true once every field or region is rejected", () => {
		expect(
			rejectsEveryChange(merged, scalarsRejected, {
				description: new Set([0, 1]),
				acceptanceCriteria: new Set([0]),
			}),
		).toBe(true);
	});

	it("is false while any region is still accepted", () => {
		expect(
			rejectsEveryChange(merged, scalarsRejected, {
				description: new Set([0]),
				acceptanceCriteria: new Set([0]),
			}),
		).toBe(false);
	});

	it("counts a whole-field rejection for a body", () => {
		expect(
			rejectsEveryChange(
				merged,
				new Set<SkippableField>([
					"title",
					"description",
					"acceptanceCriteria",
				]),
				{},
			),
		).toBe(true);
	});

	it("needs a whole-field rejection for a body merged at apply", () => {
		const unmerged = { ...merged, structurePreserved: undefined };

		expect(
			rejectsEveryChange(unmerged, scalarsRejected, {
				description: new Set([0, 1]),
				acceptanceCriteria: new Set([0]),
			}),
		).toBe(false);
	});

	it("is false for an update that moves nothing", () => {
		const still: ChangeItem = {
			...merged,
			title: { from: "Export", to: "Export" },
			description: undefined,
			acceptanceCriteria: undefined,
		};

		expect(rejectsEveryChange(still, none, {})).toBe(false);
	});
});
