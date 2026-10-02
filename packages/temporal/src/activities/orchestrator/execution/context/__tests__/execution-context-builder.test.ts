/**
 * Guards the step rules and list-handling guidance in the execution context.
 *
 * - The no-tools fallback reuses this context with an empty tool set, so a
 *   research step must not be told to gather data with tools it lacks.
 * - A list response may hold only names or IDs, so the prompt must not tell
 *   the model that any list call is sufficient when the step needs details.
 */

import { describe, expect, it } from "vitest";
import type { ExecuteStepInput } from "../../../types";
import { buildExecutionContext } from "../execution-context-builder";

function stepInput(step: Partial<ExecuteStepInput["step"]>): ExecuteStepInput {
	return {
		step: {
			id: "step-1",
			description:
				"Collect branch protection settings for the repository",
			...step,
		} as ExecuteStepInput["step"],
		message: "Check branch protection",
		systemPrompt: "",
		variables: {},
		userId: "user-1",
		organizationId: "org-1",
		executionMode: "balanced" as ExecuteStepInput["executionMode"],
		totalSteps: 2,
		stepIndex: 1,
		previousStepResults: [],
	};
}

const TOOLS = { list_repositories: {}, get_branch_protection: {} };

describe("research step rules", () => {
	it("require fresh tool research when tools are available", () => {
		const { systemPrompt } = buildExecutionContext(
			stepInput({ type: "research" } as Partial<
				ExecuteStepInput["step"]
			>),
			TOOLS,
		);

		expect(systemPrompt).toContain(
			"You MUST use the available tools to gather NEW information",
		);
	});

	it("do not demand tool use when the step has no tools", () => {
		const { systemPrompt } = buildExecutionContext(
			stepInput({ type: "research" } as Partial<
				ExecuteStepInput["step"]
			>),
			{},
		);

		expect(systemPrompt).not.toContain("You MUST use the available tools");
		expect(systemPrompt).toContain(
			"No tools are available to gather new information.",
		);
		expect(systemPrompt).toContain(
			"Do not invent findings or claim to have used tools.",
		);
	});
});

describe("list-handling guidance", () => {
	const { systemPrompt } = buildExecutionContext(stepInput({}), TOOLS);

	it("does not treat a list response as containing every detail", () => {
		expect(systemPrompt).not.toContain(
			"that single call contains ALL the data",
		);
		expect(systemPrompt).not.toContain(
			"A single tool call that returns a list is sufficient",
		);
		expect(systemPrompt).toContain(
			"A list may contain only names or IDs; fetch any additional details this step requires",
		);
	});

	it("skips per-item calls only when one call supplies everything required", () => {
		expect(systemPrompt).toContain(
			"Skip per-item calls only when a single call supplies all required information for every item or performs all required actions",
		);
	});

	it("tells a bulk step that a list of names or IDs is not enough", () => {
		const bulk = buildExecutionContext(
			stepInput({
				description:
					"Collect branch protection settings for every repository",
			}),
			TOOLS,
		);

		expect(bulk.systemPrompt).toContain(
			"A list of item names or IDs is not sufficient when details must be fetched separately.",
		);
	});
});
