import { describe, expect, it } from "vitest";
import {
	buildAgentBuilderSuggestions,
	getSuggestedDescription,
	getSuggestedSystemPrompt,
} from "../builder-suggestions";

describe("builder suggestions", () => {
	it("returns draft actions for incomplete agents", () => {
		const suggestions = buildAgentBuilderSuggestions({
			displayName: "Release reviewer",
			description: "",
			systemPrompt: "",
			knowledgeSourceCount: 0,
			capabilityCount: 0,
			hasPreviewed: false,
		});

		expect(suggestions.map((suggestion) => suggestion.action)).toEqual(
			expect.arrayContaining([
				"seed-description",
				"seed-system-prompt",
				"open-capabilities",
				"review-knowledge",
			]),
		);
	});

	it("hides preview guidance after a test run", () => {
		const suggestions = buildAgentBuilderSuggestions({
			displayName: "Research agent",
			description: "Helps summarize internal docs",
			systemPrompt: "You are a researcher.",
			knowledgeSourceCount: 1,
			capabilityCount: 2,
			hasPreviewed: true,
		});

		expect(
			suggestions.some(
				(suggestion) => suggestion.action === "open-preview",
			),
		).toBe(false);
	});

	it("creates reusable starter copy", () => {
		expect(getSuggestedDescription("Planner")).toContain("Planner");
		expect(getSuggestedSystemPrompt("Planner")).toContain(
			"You are Planner.",
		);
	});
});
