/**
 * Graph-structure validation: the checks that run before a workflow is
 * published or executed, beyond the node ceiling covered by its sibling.
 *
 * The split between error and warning is the load-bearing part. An error stops
 * a publish; a warning does not. A cycle is an error because execution walks
 * the graph node by node with no visit cap, so a cycle is an unbounded run. A
 * condition branch left unwired is only a warning, because half-wiring one is
 * a normal intermediate state while authoring.
 *
 * The diamond case guards the cycle detector against the opposite failure:
 * `detectCycles` shares one `visited` set across roots, so a node reachable by
 * two paths is seen twice and must not be mistaken for a back edge.
 */

import { describe, expect, it } from "vitest";
import { validateWorkflowBeforeExecution } from "../workflow-validation";

function node(id: string, type = "http-request") {
	return {
		id,
		type,
		data: { label: id, config: {} },
		position: { x: 0, y: 0 },
	};
}

function edge(source: string, target: string, sourceHandle?: string) {
	return { id: `${source}->${target}`, source, target, sourceHandle };
}

describe("edges must reference real nodes", () => {
	it("rejects an edge whose source does not exist", () => {
		const result = validateWorkflowBeforeExecution(
			[node("a"), node("b")],
			[edge("ghost", "b")],
		);

		expect(result.valid).toBe(false);
		expect(result.errors.join(" ")).toContain("ghost");
	});

	it("rejects an edge whose target does not exist", () => {
		const result = validateWorkflowBeforeExecution(
			[node("a"), node("b")],
			[edge("a", "ghost")],
		);

		expect(result.valid).toBe(false);
		expect(result.errors.join(" ")).toContain("ghost");
	});

	it("treats an edge into a placeholder node as dangling", () => {
		// Placeholders are filtered out before the edge check, so an edge that
		// still points at one is a stale edge rather than a valid connection.
		const result = validateWorkflowBeforeExecution(
			[node("a"), { ...node("add-1"), type: "add" }],
			[edge("a", "add-1")],
		);

		expect(result.valid).toBe(false);
	});
});

describe("cycles", () => {
	it("rejects a two-node cycle", () => {
		const result = validateWorkflowBeforeExecution(
			[node("a"), node("b")],
			[edge("a", "b"), edge("b", "a")],
		);

		expect(result.valid).toBe(false);
		expect(result.errors.join(" ")).toContain("cycle");
	});

	it("rejects a self-loop", () => {
		const result = validateWorkflowBeforeExecution(
			[node("a")],
			[edge("a", "a")],
		);

		expect(result.valid).toBe(false);
		expect(result.errors.join(" ")).toContain("cycle");
	});

	it("rejects a cycle that no entry node leads into", () => {
		// b -> c -> b is unreachable from a; iterating every unvisited node is
		// what catches it.
		const result = validateWorkflowBeforeExecution(
			[node("a"), node("b"), node("c")],
			[edge("b", "c"), edge("c", "b")],
		);

		expect(result.valid).toBe(false);
		expect(result.errors.join(" ")).toContain("cycle");
	});

	it("accepts a diamond, where one node is reached by two paths", () => {
		const result = validateWorkflowBeforeExecution(
			[node("a"), node("b"), node("c"), node("d")],
			[edge("a", "b"), edge("a", "c"), edge("b", "d"), edge("c", "d")],
		);

		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
	});
});

describe("connectivity", () => {
	it("warns about a node wired to nothing, without failing the graph", () => {
		const result = validateWorkflowBeforeExecution(
			[node("a"), node("b"), node("orphan")],
			[edge("a", "b")],
		);

		expect(result.valid).toBe(true);
		expect(result.warnings.join(" ")).toContain("orphan");
	});

	it("says nothing about connectivity when there are no edges at all", () => {
		// A single-step workflow, or one still being laid out, is not an error.
		const result = validateWorkflowBeforeExecution([node("a")], []);

		expect(result.valid).toBe(true);
		expect(result.warnings).toEqual([]);
	});
});

describe("condition branches", () => {
	it("warns when a condition has neither branch wired", () => {
		const result = validateWorkflowBeforeExecution(
			[node("a"), node("cond", "condition")],
			[edge("a", "cond")],
		);

		expect(result.valid).toBe(true);
		expect(result.warnings.join(" ")).toContain("no outgoing edges");
	});

	it("warns when only the false branch is wired", () => {
		const result = validateWorkflowBeforeExecution(
			[node("a"), node("cond", "condition"), node("b")],
			[edge("a", "cond"), edge("cond", "b", "false")],
		);

		expect(result.valid).toBe(true);
		expect(result.warnings.join(" ")).toContain('no "true" branch');
	});

	it("warns when only the true branch is wired", () => {
		const result = validateWorkflowBeforeExecution(
			[node("a"), node("cond", "condition"), node("b")],
			[edge("a", "cond"), edge("cond", "b", "true")],
		);

		expect(result.valid).toBe(true);
		expect(result.warnings.join(" ")).toContain('no "false" branch');
	});

	it("stays quiet when both branches are wired", () => {
		const result = validateWorkflowBeforeExecution(
			[node("a"), node("cond", "condition"), node("b"), node("c")],
			[
				edge("a", "cond"),
				edge("cond", "b", "true"),
				edge("cond", "c", "false"),
			],
		);

		expect(result.valid).toBe(true);
		expect(result.warnings).toEqual([]);
	});
});
