/**
 * One run's tool calls must not reach another run's prompt (Fizzy #3188).
 * The handler used to keep a worker-wide cache of tool arguments, keyed only
 * by tool name, and appended it to every later step's system prompt, so one
 * organization's arguments were shown to another organization's model.
 *
 * Boundaries mocked: the AI SDK and model lookup, so the real
 * `McpToolHandler.executeWithTools` runs and each `streamText` request is
 * captured.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	streamText: vi.fn(),
	getAiModelWithSelection: vi.fn(),
}));

vi.mock("@repo/ai", () => ({
	generateObject: vi.fn(),
	generateText: vi.fn(),
	isStepCount: vi.fn(),
	NoSuchToolError: class NoSuchToolError extends Error {},
	streamText: (...a: unknown[]) => mocks.streamText(...a),
	tool: (definition: unknown) => definition,
}));
vi.mock("@repo/mcp", () => ({
	invalidateMcpClientCache: vi.fn(),
	isClosedClientRefusedBeforeSend: () => false,
	OAuthAuthorizationRequiredError: class OAuthAuthorizationRequiredError extends Error {},
}));
vi.mock("@temporalio/activity", () => ({ heartbeat: vi.fn() }));
vi.mock("../../../utils", () => ({
	getAiModel: vi.fn(),
	getAiModelWithSelection: (...a: unknown[]) =>
		mocks.getAiModelWithSelection(...a),
}));
vi.mock("../../../utils/partykit-publisher", () => ({
	publishStepProgress: vi.fn(),
	publishToolComplete: vi.fn(),
	publishToolInput: vi.fn(),
	publishToolStart: vi.fn(),
}));
vi.mock("../../../../shared/read-only-gate", () => ({
	guardToolWriteForReadOnly: vi.fn(),
}));
vi.mock("../../../planning/operation-risk-detector", () => ({
	validateToolsForDestructivePatterns: vi.fn(),
}));
vi.mock("../../context/tool-loader", () => ({ loadMcpTools: vi.fn() }));

import { McpToolHandler } from "../mcp-tool-handler";

const STOP = new Error("captured streamText request");
const ORG_A_ARGS = { query: "org-a private customer", recordId: "rec-a-1" };
const toolToConfig = {
	search_records: { configId: "cfg-1", serverName: "Records" },
};

function runStep(
	handler: McpToolHandler,
	organizationId: string,
	toolCalls: Array<{ name: string; status: string }> = [],
	outputVariables: Record<string, unknown> = {},
) {
	return (
		handler as unknown as {
			executeWithTools: (...args: unknown[]) => Promise<unknown>;
		}
	).executeWithTools(
		{
			userId: `user-${organizationId}`,
			organizationId,
			step: { id: "step-1", description: "Find the record" },
		},
		{},
		toolToConfig,
		{ maxSteps: 5, systemPrompt: "SYSTEM", stepPrompt: "STEP" },
		toolCalls,
		outputVariables,
		null,
		undefined,
	);
}

describe("MCP tool step prompt across runs", () => {
	beforeEach(() => {
		mocks.streamText.mockReset();
		mocks.getAiModelWithSelection.mockReset();
		mocks.getAiModelWithSelection.mockResolvedValue({
			model: { id: "gpt-6.1" },
			provider: "OPENAI",
			modelString: "gpt-6.1",
		});
	});

	it("does not show another organization's tool arguments", async () => {
		// Run 1 (org A): one successful tool call and one failed one.
		mocks.streamText.mockImplementationOnce(() => ({
			stream: (async function* () {})(),
			text: Promise.resolve("done"),
			steps: Promise.resolve([
				{
					toolCalls: [
						{
							toolCallId: "c1",
							toolName: "search_records",
							input: ORG_A_ARGS,
						},
						{
							toolCallId: "c2",
							toolName: "search_records",
							input: { recordId: "rec-a-2" },
						},
					],
					toolResults: [
						{ toolCallId: "c1", output: { found: true } },
						{
							toolCallId: "c2",
							output: "Error: rec-a-2 not found",
						},
					],
				},
			]),
		}));
		const runOneToolCalls: Array<{ name: string; status: string }> = [];
		const runOneOutputs: Record<string, unknown> = {};
		// Only the tool-call processing matters here; later bookkeeping may
		// reject against the partial mocks, so check that run 1 got through
		// it before looking at run 2.
		await runStep(
			new McpToolHandler(),
			"org-a",
			runOneToolCalls,
			runOneOutputs,
		).catch(() => undefined);
		expect(
			runOneToolCalls.map(({ name, status }) => ({ name, status })),
		).toEqual([
			{ name: "search_records", status: "success" },
			{ name: "search_records", status: "error" },
		]);
		expect(runOneOutputs["tool.search_records"]).toMatchObject({
			value: { found: true },
		});

		// Run 2 (org B) on the same worker process.
		mocks.streamText.mockImplementationOnce(() => {
			throw STOP;
		});
		await expect(runStep(new McpToolHandler(), "org-b")).rejects.toBe(STOP);

		const instructions = mocks.streamText.mock.calls[1][0].instructions;
		expect(instructions).toBe("SYSTEM");
	});
});
