/**
 * A generated branch must not point back at its own condition.
 *
 * Observed against the live generator on staging: "branch on whether the
 * response status is 200" produced `condition_1 -> condition_1` on both the
 * true and the false handle. The graph saved fine, and then every run was
 * refused by the API's own cycle check — "Workflow contains a cycle" — so the
 * commonest way to ask for a branch produced a workflow that could never
 * execute.
 *
 * The prompt now tells the model a branch must target a different node, but a
 * prompt is a request. This is the part that holds.
 */

import { describe, expect, it } from "vitest";
import { dropSelfEdges } from "../generate-from-prompt";

/** The shape the live model produced when asked for a branch. */
const generatedEdges = [
	{ id: "e1", source: "trigger_1", target: "http_1" },
	{ id: "e2", source: "http_1", target: "condition_1" },
	{
		id: "e3",
		source: "condition_1",
		target: "condition_1",
		sourceHandle: "true",
	},
	{
		id: "e4",
		source: "condition_1",
		target: "condition_1",
		sourceHandle: "false",
	},
];

describe("dropSelfEdges", () => {
	it("removes both branch edges that loop back on the condition", () => {
		const { edges, dropped } = dropSelfEdges(generatedEdges);

		expect(dropped).toBe(2);
		expect(edges.map((e) => e.id)).toEqual(["e1", "e2"]);
	});

	it("leaves a graph with nowhere to loop untouched", () => {
		const straight = generatedEdges.slice(0, 2);
		const { edges, dropped } = dropSelfEdges(straight);

		expect(dropped).toBe(0);
		expect(edges).toEqual(straight);
	});

	it("keeps two edges between the same pair of distinct nodes", () => {
		// A condition wired to two different destinations is the correct shape
		// and must survive.
		const branching = [
			{ id: "t", source: "cond", target: "slack", sourceHandle: "true" },
			{ id: "f", source: "cond", target: "email", sourceHandle: "false" },
		];

		expect(dropSelfEdges(branching).dropped).toBe(0);
	});

	it("survives a model that returns no edges at all", () => {
		expect(dropSelfEdges(undefined)).toEqual({ edges: [], dropped: 0 });
		expect(dropSelfEdges([])).toEqual({ edges: [], dropped: 0 });
	});

	it("does not choke on a malformed edge", () => {
		const messy = [
			{ id: "ok", source: "a", target: "b" },
			{ id: "no-source", target: "b" },
		];

		expect(dropSelfEdges(messy).dropped).toBe(0);
	});
});
