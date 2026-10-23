import type { Edge, Node } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import {
	appendStep,
	hasOverlappingSteps,
	insertStepOnEdge,
	orderSteps,
	replacePlaceholder,
	STEP_SPACING_Y,
	serializeGraph,
	withReadableLayout,
} from "../graph-edits";

function step(id: string, y: number, type = "http-request", x = 0): Node {
	return { id, type, position: { x, y }, data: { label: id } };
}

function edge(
	source: string,
	target: string,
	sourceHandle: string | null = null,
): Edge {
	return { id: `${source}->${target}`, source, target, sourceHandle };
}

const placeholder: Node = {
	id: "empty-action-1",
	type: "empty-action",
	position: { x: 0, y: 0 },
	data: { label: "Action" },
};

function connections(edges: Edge[]) {
	return edges
		.map(
			(e) =>
				`${e.source}${e.sourceHandle ? `:${e.sourceHandle}` : ""}->${e.target}`,
		)
		.sort();
}

describe("insertStepOnEdge", () => {
	const graph = {
		nodes: [step("a", 0, "trigger"), step("b", 132), step("c", 264)],
		edges: [edge("a", "b"), edge("b", "c")],
	};

	it("replaces the edge with source → new step → target", () => {
		const result = insertStepOnEdge(graph, "a->b", placeholder);

		expect(result).not.toBeNull();
		expect(connections(result?.edges ?? [])).toEqual(
			["b->c", "a->empty-action-1", "empty-action-1->b"].sort(),
		);
	});

	it("puts the new step where the target was and moves the target and everything after it down one row", () => {
		const result = insertStepOnEdge(graph, "a->b", placeholder);
		const y = (id: string) =>
			result?.nodes.find((n) => n.id === id)?.position.y;

		expect(y("empty-action-1")).toBe(132);
		expect(y("a")).toBe(0);
		expect(y("b")).toBe(132 + STEP_SPACING_Y);
		expect(y("c")).toBe(264 + STEP_SPACING_Y);
	});

	it("keeps the branch a condition's edge leaves by", () => {
		const branching = {
			nodes: [step("if", 0, "condition"), step("yes", 132)],
			edges: [edge("if", "yes", "true")],
		};

		const result = insertStepOnEdge(branching, "if->yes", placeholder);

		expect(connections(result?.edges ?? [])).toEqual([
			"empty-action-1->yes",
			"if:true->empty-action-1",
		]);
	});

	it("returns null for an edge that is not there", () => {
		expect(insertStepOnEdge(graph, "missing", placeholder)).toBeNull();
	});
});

describe("replacePlaceholder", () => {
	it("moves the placeholder's connections onto the action that replaces it", () => {
		const graph = {
			nodes: [step("a", 0, "trigger"), placeholder, step("b", 264)],
			edges: [edge("a", "empty-action-1"), edge("empty-action-1", "b")],
		};

		const result = replacePlaceholder(graph, "empty-action-1", {
			id: "slack-send-1",
			type: "slack-send",
			data: { label: "Send Message" },
		});

		expect(result.nodes.map((n) => n.id)).toEqual([
			"a",
			"slack-send-1",
			"b",
		]);
		expect(result.nodes[1]).toMatchObject({
			type: "slack-send",
			position: placeholder.position,
		});
		expect(connections(result.edges)).toEqual([
			"a->slack-send-1",
			"slack-send-1->b",
		]);
	});
});

describe("appendStep", () => {
	it("places the new step one row below the last step and connects them", () => {
		const graph = {
			nodes: [step("a", 0, "trigger"), step("b", 132)],
			edges: [edge("a", "b")],
		};

		const result = appendStep(graph, placeholder);

		expect(result.nodes.at(-1)?.position).toEqual({
			x: 0,
			y: 132 + STEP_SPACING_Y,
		});
		expect(connections(result.edges)).toEqual([
			"a->b",
			"b->empty-action-1",
		]);
	});

	it("leaves a step after a condition unconnected, since either branch could lead to it", () => {
		const graph = { nodes: [step("if", 0, "condition")], edges: [] };

		expect(appendStep(graph, placeholder).edges).toEqual([]);
	});

	it("drops the empty-canvas placeholder", () => {
		const graph = {
			nodes: [
				{ ...placeholder, id: "add-node-placeholder", type: "add" },
			],
			edges: [],
		};

		expect(appendStep(graph, placeholder).nodes.map((n) => n.id)).toEqual([
			"empty-action-1",
		]);
	});
});

describe("orderSteps", () => {
	it("numbers steps along the edges from the start, not by array order", () => {
		const nodes = [step("c", 0), step("a", 500, "trigger"), step("b", 50)];
		const edges = [edge("a", "b"), edge("b", "c")];

		expect(orderSteps(nodes, edges).map((n) => n.id)).toEqual([
			"a",
			"b",
			"c",
		]);
	});

	it("leaves placeholders out", () => {
		expect(
			orderSteps([step("a", 0), placeholder], []).map((n) => n.id),
		).toEqual(["a"]);
	});
});

describe("withReadableLayout", () => {
	it("keeps a graph whose cards do not overlap where the user put it", () => {
		const nodes = [step("a", 0), step("b", 200)];

		expect(withReadableLayout(nodes, [edge("a", "b")])).toBe(nodes);
	});

	it("lays a graph placed for the old left-to-right cards out top to bottom", () => {
		const nodes = [
			step("a", 100, "trigger", 0),
			step("b", 100, "http-request", 250),
		];

		const laidOut = withReadableLayout(nodes, [edge("a", "b")]);

		expect(hasOverlappingSteps(nodes)).toBe(true);
		expect(hasOverlappingSteps(laidOut)).toBe(false);
		expect(laidOut[1].position.y - laidOut[0].position.y).toBe(
			STEP_SPACING_Y,
		);
	});
});

describe("serializeGraph", () => {
	it("keeps steps and their stored fields only", () => {
		const graph = serializeGraph({
			nodes: [
				{
					...step("a", 0),
					selected: true,
					data: { label: "a", onClick: () => {} },
				},
				placeholder,
			],
			edges: [{ ...edge("a", "b"), animated: true }],
		});

		expect(graph.nodes).toEqual([
			{
				id: "a",
				type: "http-request",
				position: { x: 0, y: 0 },
				data: { label: "a" },
			},
		]);
		expect(graph.edges).toEqual([
			{ id: "a->b", source: "a", target: "b", sourceHandle: null },
		]);
	});
});
