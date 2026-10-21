/**
 * Two MCP steps running at the same time on one worker must each return only
 * their own charts (Fizzy #3191). The chart tool used to keep one
 * module-level artifact list per worker process, which every step cleared at
 * its start and read at its end, so a step could return a chart another
 * organization's run had generated.
 *
 * Boundaries mocked: the AI SDK and model lookup, so the real
 * `McpToolHandler.executeWithTools` and `create_chart` tool run, and each
 * run's model turn calls `create_chart` at a point the test controls.
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

type ChartExecute = (input: unknown, options: unknown) => Promise<unknown>;
type StreamTextRequest = {
	instructions: string;
	tools: { create_chart: { execute: ChartExecute } };
};
type StepResult = { artifacts: Array<{ type: string; name: string }> };

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

function chartInput(title: string) {
	return {
		chartType: "bar",
		data: [{ status: "open" }, { status: "done" }],
		groupBy: "status",
		aggregation: "count",
		title,
	};
}

function runStep(organizationId: string) {
	return (
		new McpToolHandler() as unknown as {
			executeWithTools: (...args: unknown[]) => Promise<StepResult>;
		}
	).executeWithTools(
		{
			userId: `user-${organizationId}`,
			organizationId,
			step: { id: "step-1", description: "Chart the cards by status" },
		},
		{},
		{},
		{
			maxSteps: 5,
			systemPrompt: `SYSTEM ${organizationId}`,
			stepPrompt: "STEP",
		},
		[],
		{},
		null,
		undefined,
	);
}

function chartNames(result: StepResult) {
	return result.artifacts
		.filter((artifact) => artifact.type === "chart")
		.map((artifact) => artifact.name);
}

describe("MCP tool step charts across concurrent runs", () => {
	beforeEach(() => {
		mocks.streamText.mockReset();
		mocks.getAiModelWithSelection.mockReset();
		mocks.getAiModelWithSelection.mockResolvedValue({
			model: { id: "gpt-6.1" },
			provider: "OPENAI",
			modelString: "gpt-6.1",
		});
	});

	it("returns each run only the charts it created", async () => {
		const bStarted = deferred();
		const aCharted = deferred();
		const releaseA = deferred();

		mocks.streamText.mockImplementation((request: StreamTextRequest) => {
			const createChart = request.tools.create_chart.execute;
			const isOrgA = request.instructions === "SYSTEM org-a";
			if (!isOrgA) {
				bStarted.resolve();
			}
			return {
				stream: (async function* () {
					if (isOrgA) {
						// Chart only after run B has started its model call.
						await bStarted.promise;
						await createChart(chartInput("Org A cards"), {
							toolCallId: "chart-a",
							messages: [],
						});
						aCharted.resolve();
						// Finish only after run B has charted and returned.
						await releaseA.promise;
					} else {
						await aCharted.promise;
						await createChart(chartInput("Org B cards"), {
							toolCallId: "chart-b",
							messages: [],
						});
					}
					// The handler's stream loop ignores this part.
					yield { type: "finish-step" };
				})(),
				text: Promise.resolve("done"),
				steps: Promise.resolve([]),
			};
		});

		const runA = runStep("org-a");
		const runB = runStep("org-b");

		const resultB = await runB;
		releaseA.resolve();
		const resultA = await runA;

		expect(mocks.streamText).toHaveBeenCalledTimes(2);
		expect(chartNames(resultA)).toEqual(["Org A cards"]);
		expect(chartNames(resultB)).toEqual(["Org B cards"]);
	});
});
