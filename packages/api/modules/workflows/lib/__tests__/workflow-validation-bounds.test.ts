/**
 * The node ceiling exists because execution had no bound at all: the graph
 * walk is unbounded and each node activity may run for ten minutes, so a large
 * or pathological workflow could hold a worker slot indefinitely. Rejecting at
 * save/publish means the author finds out while editing rather than mid-run.
 */

import { describe, expect, it } from "vitest";
import {
	MAX_WORKFLOW_NODES,
	validateWorkflowBeforeExecution,
} from "../workflow-validation";

/** A linear chain of `count` connected nodes — a valid graph of any size. */
function chain(count: number) {
	const nodes = Array.from({ length: count }, (_, i) => ({
		id: `n${i}`,
		type: i === 0 ? "trigger" : "http-request",
		data: { config: { url: "https://example.com" } },
		position: { x: i * 100, y: 0 },
	}));
	const edges = Array.from({ length: Math.max(0, count - 1) }, (_, i) => ({
		id: `e${i}`,
		source: `n${i}`,
		target: `n${i + 1}`,
	}));
	return { nodes, edges };
}

describe("workflow node ceiling", () => {
	it("accepts a workflow at the limit", () => {
		const { nodes, edges } = chain(MAX_WORKFLOW_NODES);
		const result = validateWorkflowBeforeExecution(nodes, edges);

		expect(result.valid).toBe(true);
	});

	it("rejects a workflow above the limit", () => {
		const { nodes, edges } = chain(MAX_WORKFLOW_NODES + 1);
		const result = validateWorkflowBeforeExecution(nodes, edges);

		expect(result.valid).toBe(false);
		expect(result.errors.join(" ")).toContain(String(MAX_WORKFLOW_NODES));
	});

	it("warns before the limit is reached", () => {
		const { nodes, edges } = chain(Math.floor(MAX_WORKFLOW_NODES * 0.9));
		const result = validateWorkflowBeforeExecution(nodes, edges);

		expect(result.valid).toBe(true);
		expect(result.warnings.join(" ")).toContain("approaching the limit");
	});

	it("stays quiet for an ordinary workflow", () => {
		const { nodes, edges } = chain(5);
		const result = validateWorkflowBeforeExecution(nodes, edges);

		expect(result.valid).toBe(true);
		expect(result.warnings.filter((w) => w.includes("limit"))).toEqual([]);
	});

	it("does not count placeholder nodes toward the limit", () => {
		// `add` and `empty-action` are canvas affordances, not steps.
		const { nodes, edges } = chain(MAX_WORKFLOW_NODES);
		const withPlaceholders = [
			...nodes,
			{ id: "add-1", type: "add", data: {} },
			{ id: "empty-1", type: "empty-action", data: {} },
		];

		expect(
			validateWorkflowBeforeExecution(withPlaceholders, edges).valid,
		).toBe(true);
	});

	it("still rejects an empty workflow", () => {
		const result = validateWorkflowBeforeExecution([], []);

		expect(result.valid).toBe(false);
		expect(result.errors.join(" ")).toContain("no nodes");
	});
});
