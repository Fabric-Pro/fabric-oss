import { beforeEach, describe, expect, it, vi } from "vitest";

const streamTextMock = vi.fn();
// Fake model handle returned to the loop. streamText is mocked, so the model
// object is never actually exercised — it only has to be a value.
const fakeAiModel = {
	model: { id: "test-model" } as unknown as object,
	metadata: {
		modelString: "anthropic:claude-test",
		provider: "anthropic",
		selectionSource: "test-fixture",
	},
	trackUsage: vi.fn(),
};
// Partial-mock @repo/ai: keep tool/jsonSchemaToZod/getCurrentDateContext real,
// fake streamText so we can script model turns, and stub model resolution so
// the loop's getAiModelWithSelection() (via getAIModelWithMetadata) returns a
// fake model without hitting the DB / a real provider.
vi.mock("@repo/ai", async (orig) => ({
	...(await orig<typeof import("@repo/ai")>()),
	streamText: (...args: unknown[]) => streamTextMock(...args),
	getAIModelWithMetadata: vi.fn(async () => fakeAiModel),
	getSystemRAGProviderConfig: vi.fn(() => undefined),
}));
vi.mock("@repo/mcp", () => ({ getCachedMcpClientForConfig: vi.fn() }));
vi.mock("@temporalio/activity", () => ({ heartbeat: vi.fn() }));
// db:{} -> loadConfigDisplayNames() catches the TypeError and falls back to {}.
// The remaining exports are required at module-load time by @repo/payments /
// @repo/ai / template-instance/index.ts, mirroring the established mock shape
// in update-instance-execution-status.test.ts.
vi.mock("@repo/database", () => ({
	db: {},
	resolveReportMcpConfig: vi.fn(async (id: string) => ({ id, name: id })),
	// Registry hook called by @repo/payments at module init.
	setAiUsageRecorder: vi.fn(),
	// Provider constants needed by @repo/ai gateway-config.ts at import time.
	GATEWAY_PROVIDERS: [
		"VERCEL_GATEWAY",
		"OPENROUTER",
		"CLOUDFLARE_AI",
	] as const,
	DIRECT_PROVIDERS: ["OPENAI_DIRECT", "ANTHROPIC_DIRECT", "GROQ"] as const,
	AI_PROVIDER_METADATA: {},
	isGatewayProvider: () => false,
	isDirectProvider: () => false,
	getProviderDisplayName: (p: string) => p,
	getProviderMetadata: () => undefined,
}));

import { getCachedMcpClientForConfig } from "@repo/mcp";
import { executeAgentDataGatheringLoop } from "../src/activities/template-instance/report-agent-loop";

const mockGetClient = vi.mocked(getCachedMcpClientForConfig);

type Turn = {
	text?: string;
	toolCalls?: Array<{
		toolCallId: string;
		toolName: string;
		input: Record<string, unknown>;
	}>;
	rejectWith?: Error;
	/** Produce a legit empty-stop: sawFinishStep=true, finishReason="stop", no content. */
	emptyStop?: boolean;
};

const noOutErr = () =>
	Object.assign(
		new Error("No output generated. Check the stream for errors."),
		{
			name: "AI_NoOutputGeneratedError",
		},
	);

function fakeStream(turn: Turn) {
	const hasText = turn.text !== undefined && turn.text !== "";
	const hasToolCalls =
		turn.toolCalls !== undefined && turn.toolCalls.length > 0;
	const isEmpty =
		!hasText && !hasToolCalls && !turn.rejectWith && !turn.emptyStop;

	// Build fullStream parts based on turn content
	async function* makeFullStream() {
		if (turn.rejectWith) {
			// genuine error: yield nothing, resolve/reject handled via promises
			return;
		}
		if (turn.emptyStop) {
			// legit empty stop: a finish-step with finishReason "stop" but no content
			yield { type: "finish-step", finishReason: "stop" };
			return;
		}
		if (isEmpty) {
			// zero-finish-step truncation: no parts at all
			return;
		}
		if (hasText) {
			yield { type: "text-delta", text: turn.text };
			yield { type: "finish-step", finishReason: "stop" };
		} else if (hasToolCalls) {
			for (const tc of turn.toolCalls!) {
				yield {
					type: "tool-call",
					toolCallId: tc.toolCallId,
					toolName: tc.toolName,
					input: tc.input,
				};
			}
			yield { type: "finish-step", finishReason: "tool-calls" };
		}
	}

	// finishReason and usage: both reject on empty (zero-finish-step), resolve on content
	let finishReasonPromise: Promise<string | undefined>;
	let usagePromise: Promise<
		{ inputTokens: number; outputTokens: number } | undefined
	>;

	if (turn.rejectWith) {
		finishReasonPromise = Promise.reject(turn.rejectWith);
		usagePromise = Promise.reject(turn.rejectWith);
	} else if (turn.emptyStop) {
		// legit empty stop: SDK resolves with "stop" + usage
		finishReasonPromise = Promise.resolve("stop");
		usagePromise = Promise.resolve({ inputTokens: 5, outputTokens: 5 });
	} else if (isEmpty) {
		// Zero-finish-step: SDK rejects both usage and finishReason with NoOut
		finishReasonPromise = Promise.reject(noOutErr());
		usagePromise = Promise.reject(noOutErr());
	} else {
		const fr = hasText ? "stop" : "tool-calls";
		finishReasonPromise = Promise.resolve(fr);
		usagePromise = Promise.resolve({ inputTokens: 5, outputTokens: 5 });
	}

	// Attach a no-op catch to the text promise as a belt-and-suspenders guard
	// against unhandled-rejection timing on the rejectWith path. consumeStream
	// DOES observe stream.text via Promise.allSettled (to surface genuine
	// text-channel rejections) but reads content from fullStream, not this promise.
	const textPromise = (
		turn.rejectWith
			? Promise.reject(turn.rejectWith)
			: Promise.resolve(turn.text ?? "")
	) as Promise<string>;
	textPromise.catch(() => {});

	return {
		textStream: (async function* () {})(),
		text: textPromise,
		toolCalls: Promise.resolve(turn.toolCalls ?? []),
		fullStream: makeFullStream(),
		finishReason: finishReasonPromise,
		usage: usagePromise,
	};
}

// Script model turns in order; any extra calls (retries) default to empty.
function scriptTurns(turns: Turn[]) {
	streamTextMock.mockReset();
	for (const t of turns) {
		streamTextMock.mockImplementationOnce(() => fakeStream(t));
	}
	streamTextMock.mockImplementation(() =>
		fakeStream({ text: "", toolCalls: [] }),
	);
}

// Fake MCP client whose tools() exposes read-only "fizzy_get_*" tools whose
// execute() returns scripted output. Used by BOTH discovery and execution.
function fakeClient(execMap: Record<string, () => unknown>) {
	return {
		serverName: "Fizzy",
		client: {
			tools: async () =>
				Object.fromEntries(
					Object.entries(execMap).map(([name, ex]) => [
						name,
						{
							description: name,
							inputSchema: { type: "object" },
							execute: async () => ex(),
						},
					]),
				),
		},
	};
}

const input = {
	taskDescription: "Generate a board report",
	context: {},
	mcpConfigIds: ["c1"],
	providers: ["fizzy"],
	maxIterations: 15,
	userId: "u1",
	organizationId: "o1",
	executionId: "e1",
};

beforeEach(() => {
	mockGetClient.mockReset();
	mockGetClient.mockResolvedValue(
		fakeClient({ fizzy_get_cards: () => [{ id: 1 }, { id: 2 }] }) as any,
	);
});

describe("executeAgentDataGatheringLoop — empty-turn resilience", () => {
	it("salvages gathered data when the model goes empty after a tool call", async () => {
		// iter1 -> tool call; iter2 -> empty; retry -> empty => salvage
		scriptTurns([
			{
				toolCalls: [
					{
						toolCallId: "t1",
						toolName: "fizzy_get_cards",
						input: {},
					},
				],
			},
			{ text: "", toolCalls: [] },
		]);
		const out = await executeAgentDataGatheringLoop(input);
		expect(out.isPartial).toBe(true);
		expect(out.error).toBeUndefined();
		expect(Object.keys(out.gatheredData).length).toBeGreaterThan(0);
	});

	it("fails loud (no salvage) on a genuine error after a tool call", async () => {
		scriptTurns([
			{
				toolCalls: [
					{
						toolCallId: "t1",
						toolName: "fizzy_get_cards",
						input: {},
					},
				],
			},
			{ rejectWith: new Error("rate limit exceeded (429)") },
		]);
		const out = await executeAgentDataGatheringLoop(input);
		expect(out.error).toContain("429");
		expect(out.gatheredData).toEqual({}); // data discarded on genuine fault
	});

	it("returns a specific no-data error when the model is empty from the start", async () => {
		scriptTurns([{ text: "", toolCalls: [] }]); // iter1 empty + retry empty, no tools ran
		const out = await executeAgentDataGatheringLoop(input);
		expect(out.isPartial).toBe(true);
		expect(out.gatheredData).toEqual({});
		expect(out.error).toMatch(/empty response after/i);
	});

	it("completes normally when the model emits a final no-tool-call turn", async () => {
		scriptTurns([
			{
				toolCalls: [
					{
						toolCallId: "t1",
						toolName: "fizzy_get_cards",
						input: {},
					},
				],
			},
			{ text: "All data gathered." }, // final turn, no tool calls
		]);
		const out = await executeAgentDataGatheringLoop(input);
		expect(out.isPartial).toBe(false);
		expect(out.error).toBeUndefined();
		expect(Object.keys(out.gatheredData).length).toBeGreaterThan(0);
	});
});

describe("executeAgentDataGatheringLoop — streamDiagnostics on AgentLoopResult", () => {
	it("(a) salvage path: streamDiagnostics present with sawFinishStep=false", async () => {
		// iter1 -> tool call; iter2 -> empty (zero-finish-step) => salvage
		scriptTurns([
			{
				toolCalls: [
					{
						toolCallId: "t1",
						toolName: "fizzy_get_cards",
						input: {},
					},
				],
			},
			{ text: "", toolCalls: [] }, // empty turn -> zero-finish-step -> retry -> empty -> salvage
		]);
		const out = await executeAgentDataGatheringLoop(input);
		expect(out.isPartial).toBe(true);
		expect(out.streamDiagnostics).toBeDefined();
		expect(out.streamDiagnostics!.sawFinishStep).toBe(false);
	});

	it("(b) complete-empty path: legit empty stop -> isPartial=false, streamDiagnostics.finishReason='stop'", async () => {
		// iter1 -> tool call; iter2 -> empty-stop (sawFinishStep=true, finishReason="stop", no content)
		// runModelIterationWithRetry treats isLegitStop=true and returns kind:"result" (not "empty")
		// The loop sees toolCalls.length===0 and enters the COMPLETE branch
		scriptTurns([
			{
				toolCalls: [
					{
						toolCallId: "t1",
						toolName: "fizzy_get_cards",
						input: {},
					},
				],
			},
			{ emptyStop: true }, // legit empty stop
		]);
		const out = await executeAgentDataGatheringLoop(input);
		expect(out.isPartial).toBe(false);
		expect(out.streamDiagnostics).toBeDefined();
		expect(out.streamDiagnostics!.finishReason).toBe("stop");
	});

	it("(c) streamDiagnostics is defined on AgentLoopResult in both salvage and complete paths", async () => {
		// Salvage path
		scriptTurns([
			{
				toolCalls: [
					{
						toolCallId: "t1",
						toolName: "fizzy_get_cards",
						input: {},
					},
				],
			},
			{ text: "", toolCalls: [] },
		]);
		const salvageOut = await executeAgentDataGatheringLoop(input);
		expect(salvageOut.streamDiagnostics).toBeDefined();

		// Complete path (with text)
		scriptTurns([
			{
				toolCalls: [
					{
						toolCallId: "t1",
						toolName: "fizzy_get_cards",
						input: {},
					},
				],
			},
			{ text: "All data gathered." },
		]);
		const completeOut = await executeAgentDataGatheringLoop(input);
		expect(completeOut.streamDiagnostics).toBeDefined();
	});

	it("(d) streamDiagnostics carries provider and modelString from model selection", async () => {
		// salvage path: iter1 -> tool call; iter2 -> empty => salvage
		scriptTurns([
			{
				toolCalls: [
					{
						toolCallId: "t1",
						toolName: "fizzy_get_cards",
						input: {},
					},
				],
			},
			{ text: "", toolCalls: [] },
		]);
		const out = await executeAgentDataGatheringLoop(input);
		expect(out.streamDiagnostics).toBeDefined();
		expect(out.streamDiagnostics!.provider).toBe("anthropic");
		expect(out.streamDiagnostics!.modelString).toBe(
			"anthropic:claude-test",
		);

		// complete path: iter1 -> tool call; iter2 -> final text
		scriptTurns([
			{
				toolCalls: [
					{
						toolCallId: "t1",
						toolName: "fizzy_get_cards",
						input: {},
					},
				],
			},
			{ text: "All data gathered." },
		]);
		const completeOut = await executeAgentDataGatheringLoop(input);
		expect(completeOut.streamDiagnostics).toBeDefined();
		expect(completeOut.streamDiagnostics!.provider).toBe("anthropic");
		expect(completeOut.streamDiagnostics!.modelString).toBe(
			"anthropic:claude-test",
		);
	});
});
