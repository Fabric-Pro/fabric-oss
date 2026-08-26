import { describe, expect, it } from "vitest";
import {
	buildDefaultAgentSuggestions,
	canReviewAgentSuggestions,
	mergeAgentSuggestions,
} from "../agent-suggestions";

describe("agent suggestion helpers", () => {
	it("builds baseline suggestions for incomplete agents", () => {
		const suggestions = buildDefaultAgentSuggestions({
			id: "agent_123",
			description: null,
			status: "ERROR",
			deploymentUrl: null,
			lastHealthCheck: null,
			conversationCount: 0,
		});

		expect(suggestions.map((suggestion) => suggestion.key)).toEqual(
			expect.arrayContaining([
				"description",
				"deployment",
				"status",
				"healthcheck",
				"adoption",
			]),
		);
	});

	it("keeps persisted review state over generated defaults", () => {
		const merged = mergeAgentSuggestions({
			generated: buildDefaultAgentSuggestions({
				id: "agent_123",
				description: null,
				status: "ACTIVE",
				deploymentUrl: null,
				lastHealthCheck: null,
			}),
			persisted: [
				{
					id: "suggestion_1",
					agentId: "agent_123",
					key: "description",
					userId: "user_123",
					organizationId: null,
					kind: "INSTRUCTIONS",
					title: "Add a clearer description",
					description: "Persisted state",
					state: "APPROVED",
					source: "generated",
					createdAt: new Date("2026-03-09T00:00:00.000Z"),
					updatedAt: new Date("2026-03-09T00:05:00.000Z"),
				},
			] as any,
		});

		expect(
			merged.find((suggestion) => suggestion.key === "description")
				?.state,
		).toBe("approved");
	});

	it("restricts system-agent review to global admins", () => {
		expect(
			canReviewAgentSuggestions({
				agent: {
					id: "agent_123",
					scope: "SYSTEM",
				} as any,
				userId: "user_123",
				userRole: "admin",
			}),
		).toBe(true);
		expect(
			canReviewAgentSuggestions({
				agent: {
					id: "agent_123",
					scope: "SYSTEM",
				} as any,
				userId: "user_123",
				userRole: "user",
			}),
		).toBe(false);
	});
});
