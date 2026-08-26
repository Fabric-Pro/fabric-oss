/**
 * Unit tests for clarifyingQuestionPolicy — the natural-language frequency
 * policy the agent receives as readable context (spec AC6/AC7). Verifies each
 * tier produces distinct, on-message guidance referencing the tool.
 */

import { describe, expect, it, vi } from "vitest";

// useClarifyingQuestions.tsx imports CopilotKit hooks at module scope; stub them
// so we can import the pure policy helper without a React/CopilotKit runtime.
vi.mock("@copilotkit/react-core", () => ({
	useCopilotAction: vi.fn(),
	useCopilotReadable: vi.fn(),
}));

import { clarifyingQuestionPolicy } from "../useClarifyingQuestions";

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
