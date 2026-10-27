import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { beforeEach, expect, it, vi } from "vitest";

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

import { InvalidToolInputError, NoSuchToolError } from "ai";

import { CALL_TOOL_DEFINITIONS } from "../../../../workflows/orchestrator/advisor-call-tool";
import { repairAdvisorToolCall } from "../repair-advisor-tool-call";
import { runAgentIteration } from "../run-agent-iteration";

beforeEach(() => vi.clearAllMocks());
async function round(
	name: string,
	input = '{"limit":"100"}',
	mode = true,
	overrides: Partial<
		import("../run-agent-iteration").RunAgentIterationInput
	> = {},
) {
	const base = new MockLanguageModelV4({
		modelId: "example-model",
		doStream: async () => ({
			stream: simulateReadableStream({
				chunks: [
					{
						type: "tool-call",
						toolCallId: "example-id",
						toolName: name,
						input,
						providerMetadata: {
							example: { signature: "example-signature" },
						},
					},
					{
						type: "finish",
						finishReason: {
							unified: "tool-calls",
							raw: "tool-calls",
						},
						usage: {
							inputTokens: {
								total: 10,
								noCache: 10,
								cacheRead: 0,
								cacheWrite: 0,
							},
							outputTokens: { total: 10, text: 0, reasoning: 0 },
						},
					},
				],
			}),
		}),
	});
	stubs.select.mockResolvedValue({
		model: base,
		provider: "OPENAI_DIRECT",
		modelString: "example-model",
		canonicalName: "example-model",
		planSpentApiBilling: () => undefined,
	});
	return runAgentIteration({
		conversationHistory: [
			{
				role: "user",
				content: "Read examples",
				timestamp: "2026-01-01T00:00:00Z",
			},
		],
		availableTools: CALL_TOOL_DEFINITIONS,
		systemPrompt: "Read",
		userId: "example-user",
		organizationId: "example-org",
		executionId: "example-execution",
		iteration: 2,
		...overrides,
		...(mode
			? {
					callToolMode: true as const,
					admittedWrapperTargets: ["example_read"],
				}
			: {}),
	});
}
it("repairs an admitted native call through the SDK into the wrapper", async () => {
	expect(await round("example_read")).toMatchObject({
		type: "tool_calls",
		toolCalls: [
			{
				id: "example-id",
				name: "call_tool",
				args: { name: "example_read", arguments: { limit: "100" } },
				providerMetadata: {
					example: { signature: "example-signature" },
				},
			},
		],
	});
});
it("repairs blank input as an empty object", async () => {
	expect(await round("example_read", "")).toMatchObject({
		type: "tool_calls",
		toolCalls: [{ name: "call_tool", args: { arguments: {} } }],
	});
});
it.each([
	["example_not_admitted", "{}", true],
	["example_read", "{bad", true],
	["example_read", "[]", true],
	["example_read", "{}", false],
])("retains the SDK failure for %s, %s, mode %s", async (name, input, mode) => {
	expect(
		await round(name as string, input as string, mode as boolean),
	).toMatchObject({ type: "stream_error" });
	expect(stubs.select).toHaveBeenCalledTimes(1);
});
it.each(["forced", "suppressed", "not_offered", "invalid_input"])(
	"declines repair when %s",
	async (reason) => {
		const repair = repairAdvisorToolCall({
			admitted: ["example_read"],
			suppressed: reason === "suppressed" ? ["example_read"] : [],
			forced: reason === "forced",
		});
		const result = await repair({
			toolCall: {
				type: "tool-call",
				toolCallId: "example-id",
				toolName: "example_read",
				input: "{}",
			},
			tools: reason === "not_offered" ? {} : { call_tool: {} },
			error:
				reason === "invalid_input"
					? new InvalidToolInputError({
							toolName: "example_read",
							toolInput: "{}",
							cause: new Error("example"),
						})
					: new NoSuchToolError({ toolName: "example_read" }),
		} as never);
		expect(result).toBeNull();
	},
);
it("reports the normalized set actually offered, including suppression", async () => {
	const result = await round("example_read");
	expect(Object.keys(result.offeredToolDefinitions ?? {})).toEqual([
		"get_tool_schema",
		"call_tool",
	]);
});

it("reports snapshot skill tools and excludes suppressed native names", async () => {
	const result = await round("load_skill", '{"slug":"example"}', true, {
		suppressedToolNames: ["get_tool_schema"],
		answerSnapshot: {
			version: 1,
			skills: {
				status: "loaded",
				tools: {
					load_skill: {
						description: "Load skill",
						inputSchema: {
							type: "object",
							properties: { slug: { type: "string" } },
							required: ["slug"],
						},
					},
				},
				descriptors: [],
				systemBlock: "Example skills",
			},
			model: {},
		} as never,
	});
	expect(result).toMatchObject({
		type: "tool_calls",
		toolCalls: [{ name: "load_skill", args: { slug: "example" } }],
	});
	expect(result.offeredToolDefinitions).toHaveProperty("load_skill");
	expect(result.offeredToolDefinitions).not.toHaveProperty("get_tool_schema");
});

it("keeps the SDK failure when a frame tool choice is forced", async () => {
	const result = await round("example_read", "{}", true, {
		conversationHistory: [
			{
				role: "user",
				content:
					"Build me an interactive dashboard for the team metrics.",
				timestamp: "2026-01-01",
			},
		],
		availableTools: {
			...CALL_TOOL_DEFINITIONS,
			fabric_create_frame: {
				description: "Create frame",
				inputSchema: { type: "object", properties: {} },
			},
		},
	});
	expect(result.type).toBe("stream_error");
});
