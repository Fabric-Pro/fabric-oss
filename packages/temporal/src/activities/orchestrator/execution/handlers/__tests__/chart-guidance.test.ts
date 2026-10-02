/**
 * Guards the chart guidance the orchestrator gives the model.
 *
 * - The `create_chart` description must tell the model to call the tool
 *   instead of substituting a table, and never to invent or hand-compute
 *   chart numbers.
 * - The no-tools fallback call has no `create_chart` tool, so its system
 *   instructions must say so; otherwise a step that asks for a chart gets
 *   invented data or a claimed artifact that does not exist.
 *
 * Boundaries mocked: the AI SDK and model lookup, so the real
 * `McpToolHandler.executeWithoutTools` runs and the `generateText` request
 * is captured.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	generateText: vi.fn(),
}));

vi.mock("@repo/ai", () => ({
	generateObject: vi.fn(),
	generateText: (...a: unknown[]) => mocks.generateText(...a),
	isStepCount: vi.fn(),
	NoSuchToolError: class NoSuchToolError extends Error {},
	streamText: vi.fn(),
	tool: (definition: unknown) => definition,
}));
vi.mock("@repo/mcp", () => ({
	invalidateMcpClientCache: vi.fn(),
	OAuthAuthorizationRequiredError: class OAuthAuthorizationRequiredError extends Error {},
}));
vi.mock("@temporalio/activity", () => ({ heartbeat: vi.fn() }));
vi.mock("../../../utils", () => ({
	getAiModel: vi.fn(async () => ({ id: "test-model" })),
	getToolLearningContext: vi.fn(),
	recordFailedToolCall: vi.fn(),
	recordSuccessfulToolCall: vi.fn(),
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

import { createChartTool } from "../chart-tool";
import { McpToolHandler } from "../mcp-tool-handler";

describe("create_chart description", () => {
	const description = createChartTool().description as string;

	it("tells the model to call the tool instead of substituting a table or prose", () => {
		expect(description).toContain(
			"When the user asks for a chart, call create_chart; do not substitute a Markdown table or a prose description for the chart.",
		);
	});

	it("forbids inventing or hand-computing chart data", () => {
		expect(description).toContain(
			"Never invent records or numbers. Pass the actual data received from tools without manually counting, summing, or averaging it. If the required data is missing, retrieve it first or explain why the chart cannot be created.",
		);
	});
});

describe("no-tools fallback instructions", () => {
	beforeEach(() => {
		mocks.generateText.mockReset();
		mocks.generateText.mockResolvedValue({ text: "ok" });
	});

	it("append the no-tools note to the execution system prompt", async () => {
		const handler = new McpToolHandler();
		await (
			handler as unknown as {
				executeWithoutTools: (...args: unknown[]) => Promise<unknown>;
			}
		).executeWithoutTools(
			{
				userId: "user-1",
				organizationId: "org-1",
				step: { description: "Chart the open cards per board" },
			},
			{ systemPrompt: "BASE SYSTEM PROMPT" },
			null,
			undefined,
		);

		expect(mocks.generateText).toHaveBeenCalledTimes(1);
		const { instructions } = mocks.generateText.mock.calls[0][0] as {
			instructions: string;
		};
		expect(instructions.startsWith("BASE SYSTEM PROMPT\n\n")).toBe(true);
		expect(instructions).toContain(
			"No tools are available in this step. If a chart is requested, do not invent chart data or claim to have created a chart artifact. Explain that chart creation is unavailable in this step.",
		);
	});
});
