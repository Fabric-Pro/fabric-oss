import { describe, expect, it } from "vitest";
import { shouldSearchIntegrations } from "../src/activities/orchestrator/routing/analyze-and-route";

import {
	isFallbackToolSearchStrategy,
	isStrongToolMatch,
} from "../src/lib/tool-search-confidence";

describe("tool search relevance", () => {
	it.each([
		"focused_server_fallback",
		"mentioned_server_fallback",
		"semantic_fallback_keyword",
	])("classifies %s independently of confidence", (strategy) => {
		expect(isFallbackToolSearchStrategy(strategy)).toBe(true);
		expect(
			isStrongToolMatch({
				results: [{ confidence: 1 }],
				telemetry: { strategy },
			}),
		).toBe(false);
	});
	it.each([undefined, "semantic", "keyword"])(
		"preserves non-fallback strong cutoff for %s",
		(strategy) => {
			expect(isFallbackToolSearchStrategy(strategy)).toBe(false);
			expect(
				isStrongToolMatch({
					results: [{ confidence: 0.75 }],
					telemetry: { strategy },
				}),
			).toBe(true);
			expect(
				isStrongToolMatch({
					results: [{ confidence: 0.74 }],
					telemetry: { strategy },
				}),
			).toBe(false);
		},
	);
});

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
			telemetry: { strategy: "semantic" },
			userIntent: {},
		});

		expect(result).toBe(false);
	});

	it.each([
		["focused_server_fallback", 0.8, true],
		["mentioned_server_fallback", 0.85, true],
		["semantic_fallback_keyword", 0.8, true],
		["semantic", 0.8, false],
	] as const)(
		"searches integrations for %s: %s => %s",
		(strategy, confidence, expected) => {
			const params = {
				message: "Decode this VIN",
				toolResults: [
					{
						toolName: "example_list_issues",
						serverName: "Example Jira",
						confidence,
					},
				],
				telemetry: { strategy },
				userIntent: {},
			};
			expect(shouldSearchIntegrations(params)).toBe(expected);
		},
	);

	it.each([{ requestedWorkflow: true }, { requestedMcpTools: true }])(
		"keeps explicit intent overrides with a strong match: %j",
		(userIntent) => {
			expect(
				shouldSearchIntegrations({
					message: "Decode this VIN",
					toolResults: [
						{
							toolName: "example_decode_vin",
							serverName: "Example vehicle tools",
							confidence: 0.8,
						},
					],
					telemetry: { strategy: "semantic" },
					userIntent,
				}),
			).toBe(true);
		},
	);

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
			telemetry: { strategy: "semantic" },
			userIntent: {},
		});

		expect(result).toBe(true);
	});
});
