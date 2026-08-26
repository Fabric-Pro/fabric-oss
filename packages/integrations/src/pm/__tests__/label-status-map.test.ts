import { describe, expect, it } from "vitest";
import {
	applyLabelStatusMapOnPull,
	computeLabelDeltaOnPush,
	readLabelStatusMap,
} from "../label-status-map";

describe("applyLabelStatusMapOnPull", () => {
	const validStatusIds = new Set(["s-todo", "s-review", "s-done"]);

	it("returns kind: none for empty map", () => {
		expect(
			applyLabelStatusMapOnPull(
				["feature", "workflow::in-review"],
				{},
				validStatusIds,
			),
		).toEqual({
			kind: "none",
			remainingLabels: ["feature", "workflow::in-review"],
		});
	});

	it("returns kind: matched on a single match and strips the matched label", () => {
		expect(
			applyLabelStatusMapOnPull(
				["feature", "workflow::in-review", "bug"],
				{ "workflow::in-review": "s-review" },
				validStatusIds,
			),
		).toEqual({
			kind: "matched",
			statusId: "s-review",
			remainingLabels: ["feature", "bug"],
		});
	});

	it("returns kind: matched when multiple labels map to the SAME status", () => {
		// Two synonyms for the same status — not a conflict.
		const result = applyLabelStatusMapOnPull(
			["workflow::in-review", "status/review"],
			{
				"workflow::in-review": "s-review",
				"status/review": "s-review",
			},
			validStatusIds,
		);
		expect(result.kind).toBe("matched");
		if (result.kind === "matched") {
			expect(result.statusId).toBe("s-review");
		}
	});

	it("returns kind: conflict when labels map to DIFFERENT statuses", () => {
		const result = applyLabelStatusMapOnPull(
			["workflow::todo", "workflow::done"],
			{ "workflow::todo": "s-todo", "workflow::done": "s-done" },
			validStatusIds,
		);
		expect(result.kind).toBe("conflict");
		if (result.kind === "conflict") {
			expect(new Set(result.matchedStatusIds)).toEqual(
				new Set(["s-todo", "s-done"]),
			);
			expect(result.conflictingLabels).toEqual([
				"workflow::todo",
				"workflow::done",
			]);
			expect(result.remainingLabels).toEqual([
				"workflow::todo",
				"workflow::done",
			]);
		}
	});

	it("skips mappings whose target statusId is not in validStatusIds", () => {
		expect(
			applyLabelStatusMapOnPull(
				["workflow::gone"],
				{ "workflow::gone": "s-deleted" },
				validStatusIds,
			),
		).toEqual({ kind: "none", remainingLabels: ["workflow::gone"] });
	});

	it("returns kind: none when labels is empty", () => {
		expect(
			applyLabelStatusMapOnPull(
				[],
				{ "workflow::in-review": "s-review" },
				validStatusIds,
			),
		).toEqual({ kind: "none", remainingLabels: [] });
	});

	it("is case-sensitive on label keys", () => {
		expect(
			applyLabelStatusMapOnPull(
				["Workflow::In-Review"],
				{ "workflow::in-review": "s-review" },
				validStatusIds,
			),
		).toEqual({
			kind: "none",
			remainingLabels: ["Workflow::In-Review"],
		});
	});
});

describe("computeLabelDeltaOnPush", () => {
	const map = {
		"workflow::todo": "s-todo",
		"workflow::in-review": "s-review",
		"status/review": "s-review",
		"workflow::done": "s-done",
	};

	it("first push for a status: addLabels has the mapped label, removeLabels empty when prev is null", () => {
		const result = computeLabelDeltaOnPush(
			null,
			"s-review",
			["feature"],
			map,
		);
		expect(new Set(result.addLabels)).toEqual(
			new Set(["workflow::in-review", "status/review"]),
		);
		expect(result.removeLabels).toEqual([]);
	});

	it("status transition strips the previous status's labels", () => {
		const result = computeLabelDeltaOnPush(
			"s-todo",
			"s-review",
			["workflow::todo", "feature"],
			map,
		);
		expect(new Set(result.addLabels)).toEqual(
			new Set(["workflow::in-review", "status/review"]),
		);
		expect(result.removeLabels).toEqual(["workflow::todo"]);
	});

	it("idempotent re-push with the same status produces empty deltas", () => {
		const result = computeLabelDeltaOnPush(
			"s-review",
			"s-review",
			["workflow::in-review", "status/review", "feature"],
			map,
		);
		expect(result.addLabels).toEqual([]);
		expect(result.removeLabels).toEqual([]);
	});

	it("doesn't re-add a label already present", () => {
		const result = computeLabelDeltaOnPush(
			"s-todo",
			"s-review",
			["workflow::todo", "workflow::in-review"],
			map,
		);
		expect(result.addLabels).toEqual(["status/review"]);
		expect(result.removeLabels).toEqual(["workflow::todo"]);
	});

	it("when statusId has no mapping, adds nothing", () => {
		const result = computeLabelDeltaOnPush(
			"s-todo",
			"s-unmapped",
			["workflow::todo"],
			map,
		);
		expect(result.addLabels).toEqual([]);
		expect(result.removeLabels).toEqual(["workflow::todo"]);
	});

	it("empty existingLabels: addLabels is the full mapped set", () => {
		const result = computeLabelDeltaOnPush(null, "s-review", [], map);
		expect(new Set(result.addLabels)).toEqual(
			new Set(["workflow::in-review", "status/review"]),
		);
		expect(result.removeLabels).toEqual([]);
	});

	it("does NOT remove a label whose mapping points to the new status (synonyms boundary)", () => {
		// Two synonyms for s-review. Transition from s-todo → s-review with
		// `status/review` already on the issue: it must NOT appear in
		// removeLabels (it maps to the new status, not the previous one),
		// and only the missing synonym should be added.
		const result = computeLabelDeltaOnPush(
			"s-todo",
			"s-review",
			["workflow::todo", "status/review", "feature"],
			map,
		);
		expect(result.addLabels).toEqual(["workflow::in-review"]);
		expect(result.removeLabels).toEqual(["workflow::todo"]);
		// Sanity: nothing in addLabels also in removeLabels.
		const conflict = result.addLabels.filter((l) =>
			result.removeLabels.includes(l),
		);
		expect(conflict).toEqual([]);
	});
});

describe("readLabelStatusMap", () => {
	it("returns an empty map for null or undefined", () => {
		expect(readLabelStatusMap(null)).toEqual({});
		expect(readLabelStatusMap(undefined)).toEqual({});
	});

	it("returns an empty map when additionalContext lacks labelStatusMap", () => {
		expect(readLabelStatusMap({ areaPath: "x" })).toEqual({});
	});

	it("returns the map when present", () => {
		expect(
			readLabelStatusMap({
				areaPath: "x",
				labelStatusMap: { "workflow::todo": "s-todo" },
			}),
		).toEqual({ "workflow::todo": "s-todo" });
	});

	it("ignores non-string entries and empty strings", () => {
		expect(
			readLabelStatusMap({
				labelStatusMap: {
					"workflow::todo": "s-todo",
					bad: 42,
					empty: "",
					"": "s-x",
				},
			}),
		).toEqual({ "workflow::todo": "s-todo" });
	});

	it("returns an empty map for non-object inputs (array, primitive, function)", () => {
		// additionalContext is a JSON column, but defensive: callers may
		// hand us anything via `unknown`. Each of these must short-circuit
		// to {} rather than throw or coerce nonsense.
		expect(readLabelStatusMap([])).toEqual({});
		expect(readLabelStatusMap(["workflow::todo", "s-todo"])).toEqual({});
		expect(readLabelStatusMap("labelStatusMap")).toEqual({});
		expect(readLabelStatusMap(42)).toEqual({});
		expect(readLabelStatusMap(true)).toEqual({});
		// labelStatusMap field present but is itself an array → reject.
		expect(
			readLabelStatusMap({
				labelStatusMap: [["workflow::todo", "s-todo"]],
			}),
		).toEqual({});
	});
});
