import { describe, expect, it } from "vitest";
import {
	buildDefaultAgentSuggestions,
	mergeSuggestionStates,
} from "../suggestions";

describe("agent suggestions", () => {
	it("builds heuristics for incomplete agents", () => {
		const suggestions = buildDefaultAgentSuggestions({
			id: "agent-1",
			displayName: "Agent One",
			description: "",
			status: "ERROR",
			deploymentUrl: null,
			conversationCount: 0,
		});

		expect(suggestions.length).toBeGreaterThanOrEqual(4);
		expect(suggestions.some((s) => s.kind === "instructions")).toBe(true);
		expect(suggestions.some((s) => s.kind === "reliability")).toBe(true);
	});

	it("merges user state changes without removing suggestions", () => {
		const initial = buildDefaultAgentSuggestions({
			id: "agent-2",
			displayName: "Agent Two",
			status: "ACTIVE",
			description: "",
			conversationCount: 0,
		});

		const updated = mergeSuggestionStates(initial, [
			{ id: initial[0]?.id, state: "approved" },
		]);

		expect(updated[0]?.state).toBe("approved");
		expect(updated).toHaveLength(initial.length);
	});
});
