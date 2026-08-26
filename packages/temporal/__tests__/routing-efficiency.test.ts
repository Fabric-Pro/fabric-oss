import { describe, expect, it } from "vitest";
import { shouldSearchIntegrations } from "../src/activities/orchestrator/routing/analyze-and-route";

describe("shouldSearchIntegrations", () => {
	it("skips integration discovery when tool routing is already decisive", () => {
		const result = shouldSearchIntegrations({
			message: "Summarize the project notes into a concise update",
			toolResults: [
				{
					toolName: "workspace_rag_query",
					serverName: "Fabric AI",
					confidence: 0.91,
				},
			],
			userIntent: {},
		});

		expect(result).toBe(false);
	});

	it("still searches integrations for explicit communication/service intents", () => {
		const result = shouldSearchIntegrations({
			message: "Send a Slack message to the design team",
			toolResults: [
				{
					toolName: "workspace_rag_query",
					serverName: "Fabric AI",
					confidence: 0.91,
				},
			],
			userIntent: {},
		});

		expect(result).toBe(true);
	});
});
