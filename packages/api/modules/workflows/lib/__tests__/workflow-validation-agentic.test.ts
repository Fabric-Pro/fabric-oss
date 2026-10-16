/**
 * An agent task's only durable output is a frame, so one that leads nowhere
 * near a Publish Frame step loses its result. That is a warning, not an error:
 * an agent whose job is the tools it calls is a legitimate graph.
 */

import { describe, expect, it } from "vitest";
import { validateWorkflowBeforeExecution } from "../workflow-validation";

function node(id: string, type: string, label = id) {
	return { id, type, data: { label, config: {} }, position: { x: 0, y: 0 } };
}

function edge(source: string, target: string) {
	return { id: `${source}->${target}`, source, target };
}

describe("agent task output", () => {
	it("is silent when a Publish Frame follows the agent task", () => {
		const result = validateWorkflowBeforeExecution(
			[
				node("t", "trigger"),
				node("a", "agent-task", "Agent Task"),
				node("p", "publish-frame"),
			],
			[edge("t", "a"), edge("a", "p")],
		);

		expect(result.valid).toBe(true);
		expect(result.warnings).toEqual([]);
	});

	it("is silent when the Publish Frame is further down the chain", () => {
		const result = validateWorkflowBeforeExecution(
			[
				node("t", "trigger"),
				node("a", "agent-task"),
				node("c", "ai-generate-text"),
				node("p", "publish-frame"),
			],
			[edge("t", "a"), edge("a", "c"), edge("c", "p")],
		);

		expect(result.warnings).toEqual([]);
	});

	it("warns, without failing, when the result goes nowhere", () => {
		const result = validateWorkflowBeforeExecution(
			[node("t", "trigger"), node("a", "agent-task", "Agent Task")],
			[edge("t", "a")],
		);

		expect(result.valid).toBe(true);
		expect(result.warnings).toEqual([
			'Agent task "Agent Task" does not lead to a Publish Frame step, so its result will not be saved.',
		]);
	});

	it("warns when the Publish Frame sits on a branch the agent does not feed", () => {
		const result = validateWorkflowBeforeExecution(
			[
				node("t", "trigger"),
				node("a", "agent-task", "Agent Task"),
				node("p", "publish-frame"),
			],
			[edge("t", "a"), edge("t", "p")],
		);

		expect(result.warnings).toContain(
			'Agent task "Agent Task" does not lead to a Publish Frame step, so its result will not be saved.',
		);
	});

	it("says nothing about graphs without an agent task", () => {
		const result = validateWorkflowBeforeExecution(
			[node("t", "trigger"), node("h", "http-request")],
			[edge("t", "h")],
		);

		expect(result.warnings).toEqual([]);
	});
});
