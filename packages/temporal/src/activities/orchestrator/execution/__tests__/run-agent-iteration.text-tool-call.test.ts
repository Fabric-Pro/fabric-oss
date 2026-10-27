import { createTextToolCallRecoveryMiddleware } from "@repo/ai/lib/text-tool-call-middleware";
import { wrapLanguageModel } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { expect, it, vi } from "vitest";

const stubs = vi.hoisted(() => ({ select: vi.fn(), publish: vi.fn() }));
// Keep the SDK tool loop and stream parsing real; replace external services.
vi.mock("@repo/ai", async () => {
	const ai = await import("ai");
	return {
		streamText: ai.streamText,
		tool: ai.tool,
		jsonSchema: ai.jsonSchema,
		isStepCount: ai.isStepCount,
	};
});
vi.mock("@repo/ai/skills", () => ({
	listAvailableSkills: async () => [],
	createSkillTools: () => ({}),
	buildSkillsSystemBlock: () => "",
}));
vi.mock("@repo/ai/limits", () => ({ classifyLimitError: () => null }));
vi.mock("@temporalio/activity", () => ({ heartbeat: vi.fn() }));
vi.mock("../../../../lib/redis-publisher", () => ({
	publishExecutionEvent: stubs.publish,
}));
vi.mock("../../utils", () => ({ getAiModelWithSelection: stubs.select }));

import { runAgentIteration } from "../run-agent-iteration";

it("Advisor recovers a round-two text call through the real SDK and hides it from published deltas", async () => {
	const prose =
		"To get the details of the five most recently updated features, I will fetch them one at a time.\n\nFirst, I will fetch F-019, an example feature.\n\n";
	const text =
		prose +
		'<function=fabric_get_project_feature>{ "feature": "F-019" }</function>';
	const base = new MockLanguageModelV4({
		modelId: "example-model",
		doStream: async () => ({
			stream: simulateReadableStream({
				chunks: [
					{ type: "text-start" as const, id: "t" },
					...Array.from(text, (delta) => ({
						type: "text-delta" as const,
						id: "t",
						delta,
					})),
					{ type: "text-end" as const, id: "t" },
					{
						type: "finish" as const,
						finishReason: { unified: "stop" as const, raw: "stop" },
						usage: {
							inputTokens: {
								total: 100,
								noCache: 100,
								cacheRead: 0,
								cacheWrite: 0,
							},
							outputTokens: { total: 30, text: 30, reasoning: 0 },
						},
					},
				],
			}),
		}),
	});
	stubs.select.mockResolvedValue({
		model: wrapLanguageModel({
			model: base,
			middleware: createTextToolCallRecoveryMiddleware(),
		}),
		provider: "OPENAI_DIRECT",
		modelString: "example-model",
		canonicalName: "example-model",
		planSpentApiBilling: () => undefined,
	});
	const result = await runAgentIteration({
		conversationHistory: [
			{
				role: "user",
				content: "Fetch the five recently updated features.",
				timestamp: "2026-01-01T00:00:00Z",
			},
			{
				role: "assistant",
				content: "",
				timestamp: "2026-01-01T00:00:01Z",
				toolCalls: [
					{
						id: "example-call",
						name: "fabric_get_project_feature",
						args: { feature: "F-018" },
					},
				],
			},
			{
				role: "tool",
				content: '{"title":"Example feature"}',
				timestamp: "2026-01-01T00:00:02Z",
				toolCallId: "example-call",
			},
		],
		availableTools: {
			fabric_get_project_feature: {
				description: "Read a feature",
				inputSchema: {
					type: "object",
					properties: { feature: { type: "string" } },
					required: ["feature"],
				},
			},
		},
		systemPrompt: "Help with the requested features.",
		userId: "example-user",
		organizationId: "example-org",
		executionId: "example-execution",
		iteration: 2,
	});
	expect(result).toMatchObject({
		type: "tool_calls",
		toolCalls: [
			{ name: "fabric_get_project_feature", args: { feature: "F-019" } },
		],
		usage: { inputTokens: 100, outputTokens: 30 },
	});
	const shown = stubs.publish.mock.calls
		.filter(([, payload]) => payload.event === "execution.text_delta")
		.map(([, payload]) => payload.data.text)
		.join("");
	expect(shown).toBe(prose);
});
