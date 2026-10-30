/**
 * Unit tests for clarifyingQuestionPolicy — the natural-language frequency
 * policy the agent receives as readable context (spec AC6/AC7). Verifies each
 * tier produces distinct, on-message guidance referencing the tool.
 */

import {
	askClarifyingQuestionAction,
	clarifyingQuestionPolicy as sharedClarifyingQuestionPolicy,
} from "@repo/utils/editor-frontend-actions";
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// useClarifyingQuestions.tsx imports CopilotKit hooks at module scope; stub them
// so we can import the pure policy helper without a React/CopilotKit runtime.
const { registeredActions, libraryPolicy } = vi.hoisted(() => ({
	registeredActions: [] as Array<{
		name: string;
		description?: string;
		parameters?: unknown;
	}>,
	libraryPolicy: { value: undefined as string | undefined },
}));
vi.mock("@copilotkit/react-core", () => ({
	useCopilotAction: (action: (typeof registeredActions)[number]) => {
		registeredActions.push(action);
	},
	useCopilotReadable: vi.fn(),
}));
vi.mock("@tanstack/react-query", () => ({
	useQuery: () => ({ data: { policy: libraryPolicy.value } }),
}));
vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		prompts: {
			agents: { clarifyingPolicy: { queryOptions: () => ({}) } },
		},
	},
}));

import {
	clarifyingQuestionPolicy,
	useClarifyingQuestions,
} from "../useClarifyingQuestions";

describe("clarifyingQuestionPolicy", () => {
	it("MINIMAL tells the agent to ask rarely / only when blocked", () => {
		const text = clarifyingQuestionPolicy("MINIMAL");
		expect(text).toContain("MINIMAL");
		expect(text.toLowerCase()).toContain("only call");
		expect(text).toContain("ask_clarifying_question");
	});

	it("BALANCED ties asking to material ambiguity", () => {
		const text = clarifyingQuestionPolicy("BALANCED");
		expect(text).toContain("BALANCED");
		expect(text.toLowerCase()).toContain("material ambiguity");
		expect(text).toContain("ask_clarifying_question");
	});

	it("THOROUGH allows proactive, multiple questions", () => {
		const text = clarifyingQuestionPolicy("THOROUGH");
		expect(text).toContain("THOROUGH");
		expect(text.toLowerCase()).toContain("proactively");
		expect(text).toContain("3");
	});

	it("produces a distinct policy per tier", () => {
		const minimal = clarifyingQuestionPolicy("MINIMAL");
		const balanced = clarifyingQuestionPolicy("BALANCED");
		const thorough = clarifyingQuestionPolicy("THOROUGH");
		expect(new Set([minimal, balanced, thorough]).size).toBe(3);
	});
});

describe("useClarifyingQuestions registration", () => {
	function registeredClarifyingAction() {
		const action = registeredActions.at(-1);
		expect(action?.name).toBe("ask_clarifying_question");
		return action;
	}

	it("re-exports the shared built-in policy", () => {
		expect(clarifyingQuestionPolicy).toBe(sharedClarifyingQuestionPolicy);
	});

	it("registers the shared definition with the tier's built-in policy", () => {
		libraryPolicy.value = undefined;
		renderHook(() => useClarifyingQuestions({ frequency: "MINIMAL" }));

		const expected = askClarifyingQuestionAction(
			clarifyingQuestionPolicy("MINIMAL"),
		);
		const action = registeredClarifyingAction();
		expect(action?.description).toBe(expected.description);
		expect(action?.parameters).toEqual(expected.parameters);
	});

	it("registers the shared definition with the Prompt Library's policy", () => {
		libraryPolicy.value = "  Ask only about the budget.  ";
		renderHook(() => useClarifyingQuestions({ frequency: "THOROUGH" }));

		expect(registeredClarifyingAction()?.description).toBe(
			askClarifyingQuestionAction("Ask only about the budget.")
				.description,
		);
	});
});
