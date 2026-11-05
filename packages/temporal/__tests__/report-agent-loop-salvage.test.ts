import { createUsageLoggingMiddleware } from "@repo/ai/lib/usage-logging-middleware";
import { wrapLanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { beforeEach, describe, expect, it, vi } from "vitest";

let meterScriptedTurns = false;
const streamTextMock = vi.fn();
const usageRows = vi.hoisted(() => vi.fn());
const summaryMock = vi.hoisted(() =>
	vi.fn(
		async (
			_input: import("../src/activities/orchestrator/execution/summarize-tool-result").SummarizeToolResultInput,
		) => "summary",
	),
);
vi.mock(
	"../src/activities/orchestrator/execution/summarize-tool-result",
	() => ({ summarizeLargeToolResult: summaryMock }),
);
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
	logAiUsageAsync: usageRows,
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

import { getAIModelWithMetadata } from "@repo/ai";
import { getCachedMcpClientForConfig } from "@repo/mcp";
import { heartbeat } from "@temporalio/activity";
import { REPORT_CARD_PAYLOAD_MAX_BYTES } from "../src/activities/template-instance/gathered-data-budget";
import {
	executeAgentDataGatheringLoop,
	withToolTimeout,
} from "../src/activities/template-instance/report-agent-loop";

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

	// Build `stream` parts based on turn content
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
	// text-channel rejections) but reads content from `stream`, not this promise.
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
		// AI SDK 7 renamed StreamTextResult.fullStream to `stream`.
		stream: makeFullStream(),
		finishReason: finishReasonPromise,
		usage: usagePromise,
	};
}

// Script model turns in order; any extra calls (retries) default to empty.
function scriptTurns(turns: Turn[]) {
	streamTextMock.mockReset();
	for (const t of turns) {
		streamTextMock.mockImplementationOnce((options) => {
			const scripted = fakeStream(t);
			if (meterScriptedTurns) {
				const original = scripted.stream;
				scripted.stream = (async function* () {
					await options.model.doGenerate({ prompt: [] });
					yield* original;
				})();
			}
			return scripted;
		});
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

	it("keeps what the tools returned on a genuine error after a tool call", async () => {
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
		expect(out.isPartial).toBe(true);
		expect(out.gatheredData.fizzy_get_cards).toEqual([
			{ id: 1 },
			{ id: 2 },
		]);
	});

	it("rethrows a genuine error when nothing was gathered, so Temporal can retry", async () => {
		scriptTurns([{ rejectWith: new Error("rate limit exceeded (429)") }]);
		await expect(executeAgentDataGatheringLoop(input)).rejects.toThrow(
			"429",
		);
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

describe("executeAgentDataGatheringLoop — large tool results", () => {
	/** The value the model's second turn received for its one tool call. */
	function toolResultSentToModel(): Record<string, unknown> {
		const { messages } = streamTextMock.mock.calls[1][0] as {
			messages: Array<{
				role: string;
				content: Array<{ output: { value: Record<string, unknown> } }>;
			}>;
		};
		const toolMessage = messages.find((message) => message.role === "tool");
		return toolMessage!.content[0].output.value;
	}

	const scriptOneCall = (toolName: string) =>
		scriptTurns([
			{ toolCalls: [{ toolCallId: "t1", toolName, input: {} }] },
			{ text: "All data gathered." },
		]);

	it("builds a card page's context without the summarizer, keeping its pagination", async () => {
		summaryMock.mockClear();
		const cards = Array.from({ length: 200 }, (_, index) => ({
			id: `card-${index}`,
			number: index,
			title: `Card ${index}`,
			status: "published",
			description: "x".repeat(280),
			column: { id: "column-1", name: "In progress" },
		}));
		mockGetClient.mockResolvedValue(
			fakeClient({
				fizzy_get_cards: () => ({
					cards,
					page: 1,
					total_count: 611,
					has_more: true,
					next_page: 2,
				}),
			}) as any,
		);
		scriptOneCall("fizzy_get_cards");

		await executeAgentDataGatheringLoop(input);

		expect(summaryMock).not.toHaveBeenCalled();
		const value = toolResultSentToModel();
		expect(value).toMatchObject({
			_projected: true,
			page: 1,
			total_count: 611,
			has_more: true,
			next_page: 2,
		});
		const sent = value.cards as unknown[];
		expect(sent[0]).toEqual({
			id: "card-0",
			number: 0,
			title: "Card 0",
			status: "published",
			column: "In progress",
		});
		expect(sent.length + (value._omittedCards as number)).toBe(200);
		expect(JSON.stringify(sent).length).toBeLessThanOrEqual(12000);
	});

	it("still summarizes a large result with no structure to cut", async () => {
		summaryMock.mockClear();
		mockGetClient.mockResolvedValue(
			fakeClient({
				fizzy_get_report: () => "Long prose report. ".repeat(1_000),
			}) as any,
		);
		scriptOneCall("fizzy_get_report");

		await executeAgentDataGatheringLoop(input);

		expect(summaryMock).toHaveBeenCalledTimes(1);
		expect(toolResultSentToModel()).toMatchObject({
			_summarized: true,
			summary: "summary",
		});
	});

	it("cuts a large JSON list without the summarizer", async () => {
		summaryMock.mockClear();
		const tags = Array.from({ length: 200 }, (_, index) => ({
			id: `tag-${index}`,
			title: `Tag ${index}`,
			created_at: "2026-01-01T00:00:00.000Z",
			url: `https://example.com/cards?tag=${"t".repeat(40)}${index}`,
		}));
		mockGetClient.mockResolvedValue(
			fakeClient({ fizzy_get_tags: () => tags }) as any,
		);
		scriptOneCall("fizzy_get_tags");

		const out = await executeAgentDataGatheringLoop(input);

		expect(summaryMock).not.toHaveBeenCalled();
		const value = toolResultSentToModel();
		expect(value._projected).toBe(true);
		expect((value.items as unknown[])[0]).toEqual({
			id: "tag-0",
			title: "Tag 0",
		});
		// The tags the report sees are the whole list.
		expect(out.gatheredData.fizzy_get_tags).toEqual(tags);
	});

	it("cuts a single large card without the summarizer, and stores it without its HTML", async () => {
		summaryMock.mockClear();
		mockGetClient.mockResolvedValue(
			fakeClient({
				fizzy_get_card: () => ({
					id: "card-1",
					number: 1,
					title: "Example card",
					description: "x".repeat(15_000),
					description_html: `<p>${"x".repeat(25_000)}</p>`,
					column: { id: "column-1", name: "In progress" },
				}),
			}) as any,
		);
		scriptOneCall("fizzy_get_card");

		const out = await executeAgentDataGatheringLoop(input);

		expect(summaryMock).not.toHaveBeenCalled();
		const value = toolResultSentToModel();
		expect(value).toMatchObject({
			_projected: true,
			id: "card-1",
			title: "Example card",
			column: { id: "column-1", name: "In progress" },
		});
		expect(value.description_html).toBeUndefined();
		const stored = out.gatheredData.fizzy_get_cards as Array<
			Record<string, unknown>
		>;
		expect(stored[0].id).toBe("card-1");
		expect(stored[0].description_html).toBeUndefined();
	});
});

describe("executeAgentDataGatheringLoop — reading a whole board", () => {
	type Coverage = Record<string, Record<string, unknown>>;
	type Facts = Record<string, unknown>;

	const boardInput = {
		...input,
		context: { boardId: "example-board", accountSlug: "/000000" },
	};
	const cardsSchema = {
		type: "object",
		required: ["account_slug"],
		properties: {
			account_slug: { type: "string" },
			board_id: { type: "string" },
			page: { type: "integer" },
			fields: { type: "string", enum: ["summary", "full"] },
			indexed_by: { type: "string", enum: ["closed", "not_now"] },
		},
	};

	const pageOf = (
		ids: string[],
		page: number,
		hasMore: boolean,
		extra: Record<string, unknown> = {},
	) => ({
		cards: ids.map((id) => ({
			id,
			title: `Card ${id}`,
			status: "published",
			closed: extra.closed === true,
			last_active_at: "2026-11-01T00:00:00.000Z",
			created_at: "2026-10-01T00:00:00.000Z",
			column: { id: "column-1", name: "In progress" },
			assignees: [],
			tags: [],
		})),
		page,
		total_count: 5,
		has_more: hasMore,
		next_page: hasMore ? page + 1 : null,
	});

	/** Open: a, b, c over two pages. Closed: d, e on one. Not now: none. */
	const twoListings = (args: Record<string, unknown>): unknown => {
		if (args.indexed_by === "closed") {
			return pageOf(["d", "e"], 1, false, { closed: true });
		}
		if (args.indexed_by === "not_now") {
			return pageOf([], 1, false);
		}
		return args.page === 2
			? pageOf(["c"], 2, false)
			: pageOf(["a", "b"], 1, true);
	};

	function boardClient(
		listing: (args: Record<string, unknown>) => unknown,
		otherTools: Record<string, unknown> = {},
	) {
		const execute = vi.fn(async (args: Record<string, unknown>) =>
			listing(args),
		);
		const columns = vi.fn(async () => [
			{ id: "column-1", name: "In progress" },
		]);
		const tools = vi.fn(async () => ({
			fizzy_get_cards: {
				description: "Cards",
				inputSchema: cardsSchema,
				execute,
			},
			fizzy_get_columns: {
				description: "Columns",
				inputSchema: { type: "object" },
				execute: columns,
			},
			...otherTools,
		}));
		mockGetClient.mockResolvedValue({
			serverName: "Fizzy",
			client: { tools },
		} as any);
		return { execute, columns, tools };
	}

	const coverageOf = (out: { gatheredData: Record<string, unknown> }) =>
		out.gatheredData._coverage as Coverage;
	const factsOf = (out: { gatheredData: Record<string, unknown> }) =>
		out.gatheredData._board_facts as Facts;
	const instructions = () =>
		streamTextMock.mock.calls[0][0].instructions as string;

	it("reads every page of each listing with no model turn per page", async () => {
		const { execute } = boardClient(twoListings);
		vi.mocked(heartbeat).mockClear();
		scriptTurns([{ text: "DONE" }]);

		const out = await executeAgentDataGatheringLoop(boardInput);

		expect(streamTextMock).toHaveBeenCalledTimes(1);
		expect(execute).toHaveBeenCalledTimes(4);
		expect(execute.mock.calls[0][0]).toEqual({
			account_slug: "/000000",
			board_id: "example-board",
			fields: "summary",
		});
		expect(execute.mock.calls[1][0]).toMatchObject({ page: 2 });
		expect(vi.mocked(heartbeat).mock.calls.length).toBeGreaterThanOrEqual(
			4,
		);
		expect(
			(out.gatheredData.fizzy_get_cards as Array<{ id: string }>).map(
				(card) => card.id,
			),
		).toEqual(["a", "b", "c", "d", "e"]);
		expect(out.isPartial).toBe(false);
		expect(out.error).toBeUndefined();
		expect(out.toolCallCount).toBe(4);
		expect(out.toolsUsed).toEqual(["fizzy_get_cards"]);
	});

	it("records coverage per listing and counts the board before any budget", async () => {
		boardClient(twoListings);
		scriptTurns([{ text: "DONE" }]);

		const out = await executeAgentDataGatheringLoop(boardInput);

		expect(coverageOf(out).fizzy_get_cards).toMatchObject({
			pages_fetched: [1, 2],
			complete: true,
			cards_read: 3,
		});
		expect(
			coverageOf(out)["fizzy_get_cards[indexed_by=closed]"],
		).toMatchObject({ complete: true, cards_read: 2 });
		expect(factsOf(out)).toMatchObject({
			total: 5,
			open: 3,
			closed: 2,
			complete: true,
			gaps: [],
		});
	});

	it("tells the model the cards are read, with no page limit or sample wording", async () => {
		boardClient(twoListings);
		scriptTurns([{ text: "DONE" }]);

		await executeAgentDataGatheringLoop(boardInput);

		const prompt = instructions();
		expect(prompt).toContain("already read");
		expect(prompt).toContain("`fizzy_get_cards[indexed_by=closed]`");
		expect(prompt).toContain("fetch that card in full");
		expect(prompt).not.toContain("10 pages");
		expect(prompt).not.toContain("sample");
	});

	it("tells a custom prompt's model too that its text is discarded", async () => {
		boardClient(twoListings);
		scriptTurns([{ text: "DONE" }]);

		await executeAgentDataGatheringLoop({
			...boardInput,
			customSystemPrompt: "Write a detailed analysis.",
		});

		expect(instructions()).toContain(
			"Any text you write here is discarded",
		);
	});

	it("marks a failed page partial, keeps what was read and carries on", async () => {
		boardClient((args) => {
			if (args.indexed_by === undefined && args.page === 2) {
				throw new Error("upstream memory limit");
			}
			return twoListings(args);
		});
		scriptTurns([{ text: "DONE" }]);

		const out = await executeAgentDataGatheringLoop(boardInput);

		expect(out.isPartial).toBe(true);
		expect(out.error).toBeUndefined();
		expect(
			(out.gatheredData.fizzy_get_cards as Array<{ id: string }>).map(
				(card) => card.id,
			),
		).toEqual(["a", "b", "d", "e"]);
		expect(coverageOf(out).fizzy_get_cards).toMatchObject({
			complete: false,
			reason: "page 2 could not be read: upstream memory limit",
		});
		expect(
			coverageOf(out)["fizzy_get_cards[indexed_by=closed]"],
		).toMatchObject({ complete: true });
		expect(factsOf(out)).toMatchObject({ total: 4, complete: false });
		expect((factsOf(out).gaps as string[]).join()).toContain("page 2");
	});

	it("stops a listing that never ends at the runaway guard", async () => {
		const { execute } = boardClient((args) => {
			if (args.indexed_by !== undefined) {
				return pageOf([], 1, false);
			}
			const page = typeof args.page === "number" ? args.page : 1;
			return pageOf([`card-${page}`], page, true);
		});
		scriptTurns([{ text: "DONE" }]);

		const out = await executeAgentDataGatheringLoop(boardInput);

		expect(execute).toHaveBeenCalledTimes(52);
		expect(out.isPartial).toBe(true);
		expect(coverageOf(out).fizzy_get_cards).toMatchObject({
			complete: false,
			cards_read: 50,
		});
		expect(String(coverageOf(out).fizzy_get_cards.reason)).toContain(
			"50 pages",
		);
	});

	it("skips the per-column repair after a sweep", async () => {
		const { columns } = boardClient(twoListings);
		scriptTurns([{ text: "DONE" }]);

		// These cards carry no board, which is what triggers the repair.
		const out = await executeAgentDataGatheringLoop(boardInput);

		expect(columns).not.toHaveBeenCalled();
		expect(out.gatheredData._board_fix).toBeUndefined();
		expect(out.isPartial).toBe(false);
	});

	it("keeps the sweep and the error when the model then fails", async () => {
		boardClient(twoListings);
		scriptTurns([{ rejectWith: new Error("provider unavailable (503)") }]);

		const out = await executeAgentDataGatheringLoop(boardInput);

		expect(out.error).toContain("503");
		expect(out.gatheredData.fizzy_get_cards).toHaveLength(5);
		expect(factsOf(out)).toMatchObject({ total: 5, complete: true });
	});

	describe("however the model's turns end", () => {
		const endings: Array<[string, Turn[], { maxIterations?: number }]> = [
			[
				"runs out of turns",
				[
					{
						toolCalls: [
							{
								toolCallId: "t1",
								toolName: "fizzy_get_columns",
								input: {},
							},
						],
					},
				],
				{ maxIterations: 1 },
			],
			["returns an empty turn", [{ text: "", toolCalls: [] }], {}],
			[
				"fails",
				[{ rejectWith: new Error("provider unavailable (503)") }],
				{},
			],
		];

		it.each(endings)(
			"a complete read is not partial when the model %s",
			async (_name, turns, options) => {
				boardClient(twoListings);
				scriptTurns(turns);

				const out = await executeAgentDataGatheringLoop({
					...boardInput,
					...options,
				});

				expect(out.isPartial).toBe(false);
				expect(out.gatheredData.fizzy_get_cards).toHaveLength(5);
				expect(factsOf(out)).toMatchObject({
					total: 5,
					complete: true,
				});
			},
		);

		it.each(endings)(
			"a failed listing stays partial when the model %s",
			async (_name, turns, options) => {
				boardClient((args) => {
					if (args.indexed_by === undefined && args.page === 2) {
						throw new Error("upstream memory limit");
					}
					return twoListings(args);
				});
				scriptTurns(turns);

				const out = await executeAgentDataGatheringLoop({
					...boardInput,
					...options,
				});

				expect(out.isPartial).toBe(true);
				expect(factsOf(out)).toMatchObject({
					total: 4,
					complete: false,
				});
			},
		);

		it.each(endings)(
			"dropped cards stay partial when the model %s",
			async (_name, turns, options) => {
				vi.stubEnv("FABRIC_REPORT_GATHERED_DATA_MAX_BYTES", "100000");
				boardClient((args) => ({
					...pageOf([], 1, false),
					cards:
						args.indexed_by === undefined
							? Array.from({ length: 2000 }, (_, index) => ({
									id: `card-${index}`,
									title: `Card ${index} ${"t".repeat(60)}`,
								}))
							: [],
				}));
				scriptTurns(turns);

				try {
					const out = await executeAgentDataGatheringLoop({
						...boardInput,
						...options,
					});

					expect(out.isPartial).toBe(true);
					expect(
						(out.gatheredData.fizzy_get_cards as unknown[]).length,
					).toBeLessThan(2000);
					expect(factsOf(out)).toMatchObject({
						total: 2000,
						complete: true,
					});
				} finally {
					vi.unstubAllEnvs();
				}
			},
		);
	});

	it("rethrows without a model turn when the first listing's first page fails and nothing else was read", async () => {
		boardClient(() => {
			throw new Error("unauthorized");
		});
		scriptTurns([{ text: "DONE" }]);

		await expect(executeAgentDataGatheringLoop(boardInput)).rejects.toThrow(
			"unauthorized",
		);
		expect(streamTextMock).not.toHaveBeenCalled();
	});

	it("carries on when the first listing fails but another returned cards", async () => {
		boardClient((args) => {
			if (args.indexed_by === undefined) {
				throw new Error("unauthorized");
			}
			return twoListings(args);
		});
		scriptTurns([{ text: "DONE" }]);

		const out = await executeAgentDataGatheringLoop(boardInput);

		expect(streamTextMock).toHaveBeenCalledTimes(1);
		expect(out.isPartial).toBe(true);
		expect(out.gatheredData.fizzy_get_cards).toHaveLength(2);
	});

	it("says why when a later listing failed and no listing held any cards", async () => {
		boardClient((args) => {
			if (args.indexed_by === "closed") {
				throw new Error("unauthorized");
			}
			return pageOf([], 1, false);
		});
		scriptTurns([{ text: "DONE" }]);

		const out = await executeAgentDataGatheringLoop(boardInput);

		expect(out.isPartial).toBe(true);
		expect(out.error).toContain("unauthorized");
	});

	const largeBoardListing = (args: Record<string, unknown>) => {
		const ids = Array.from({ length: 400 }, (_, index) => `card-${index}`);
		const listed = args.indexed_by === undefined ? ids : [];
		return {
			...pageOf([], 1, false),
			cards: listed.map((id) => ({
				id,
				title: `Card ${id}`,
				closed: false,
				url: `https://example.com/cards/${id}`,
				description_preview: "p".repeat(200),
				column: { id: "column-1", name: "In progress" },
				assignees: [{ id: "user-1", name: "Example Person" }],
			})),
		};
	};

	it("keeps a fetched card's whole description through the merge and the budget", async () => {
		vi.stubEnv("FABRIC_REPORT_GATHERED_DATA_MAX_BYTES", "100000");
		const description = "x".repeat(3000);
		boardClient(largeBoardListing, {
			fizzy_get_card: {
				description: "Card",
				inputSchema: { type: "object" },
				execute: async () => ({
					id: "card-7",
					title: "Card card-7",
					description,
					description_html: `<p>${description}</p>`,
				}),
			},
		});
		scriptTurns([
			{
				toolCalls: [
					{
						toolCallId: "t1",
						toolName: "fizzy_get_card",
						input: { card_number: "7" },
					},
				],
			},
			{ text: "DONE" },
		]);

		try {
			const out = await executeAgentDataGatheringLoop(boardInput);
			const cards = out.gatheredData.fizzy_get_cards as Array<
				Record<string, unknown>
			>;

			expect(cards).toHaveLength(400);
			expect(cards[7].description).toBe(description);
			expect(cards[7].description_html).toBeUndefined();
			expect(cards[8].description_preview).toBeUndefined();
			expect(out.gatheredDataTruncation).toBeDefined();
			expect(out.isPartial).toBe(false);
			expect(factsOf(out)).toMatchObject({ total: 400, complete: true });
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("bounds a large board's cards for the analysis prompt, keeping every one", async () => {
		const listed = (prefix: string, count: number, closed: boolean) =>
			Array.from({ length: count }, (_, index) => ({
				id: `${prefix}-${index}`,
				number: index,
				title: `Card ${prefix} ${index} ${"t".repeat(60)}`,
				status: "published",
				closed,
				postponed: prefix === "not-now",
				created_at: "2026-01-01T00:00:00.000Z",
				last_active_at: "2026-10-01T00:00:00.000Z",
				url: `https://example.com/cards/${prefix}-${index}`,
				description_preview: "p".repeat(200),
				column: { id: "column-1", name: "In progress" },
				assignees: [{ id: "user-1", name: "Example Person" }],
				tags: ["example-tag"],
			}));
		boardClient((args) => ({
			...pageOf([], 1, false),
			cards:
				args.indexed_by === "closed"
					? listed("closed", 1548, true)
					: args.indexed_by === "not_now"
						? listed("not-now", 132, false)
						: listed("open", 659, false),
		}));
		scriptTurns([{ text: "DONE" }]);

		const out = await executeAgentDataGatheringLoop(boardInput);
		const cards = out.gatheredData.fizzy_get_cards as Array<
			Record<string, unknown>
		>;

		expect(cards).toHaveLength(2339);
		expect(JSON.stringify(cards).length).toBeLessThanOrEqual(
			REPORT_CARD_PAYLOAD_MAX_BYTES,
		);
		expect(cards[0].last_active_at).toBeDefined();
		expect(cards[659].last_active_at).toBeUndefined();
		expect(out.isPartial).toBe(false);
		expect(factsOf(out)).toMatchObject({
			total: 2339,
			open: 659,
			closed: 1548,
			postponed: 132,
			complete: true,
		});
	});

	it("keeps every card and stays complete when only the card fields had to shrink", async () => {
		vi.stubEnv("FABRIC_REPORT_GATHERED_DATA_MAX_BYTES", "100000");
		boardClient(largeBoardListing);
		scriptTurns([{ text: "DONE" }]);

		try {
			const out = await executeAgentDataGatheringLoop(boardInput);

			expect(out.gatheredData.fizzy_get_cards).toHaveLength(400);
			expect(out.gatheredDataTruncation).toBeDefined();
			expect(out.isPartial).toBe(false);
			expect(factsOf(out)).toMatchObject({ total: 400, complete: true });
		} finally {
			vi.unstubAllEnvs();
		}
	});
});

describe("executeAgentDataGatheringLoop — a listing the model starts", () => {
	const listSchema = {
		type: "object",
		properties: {
			board_id: { type: "string" },
			page: { type: "integer" },
		},
	};
	const page = (ids: string[], current: number, hasMore: boolean) => ({
		cards: ids.map((id) => ({ id })),
		page: current,
		total_count: 3,
		has_more: hasMore,
		next_page: hasMore ? current + 1 : null,
	});

	function listingClient(inputSchema: object = listSchema) {
		const execute = vi.fn(async (args: Record<string, unknown>) =>
			args.page === 2 ? page(["c"], 2, false) : page(["a", "b"], 1, true),
		);
		const tools = vi.fn(async () => ({
			fizzy_get_cards: {
				description: "Cards",
				inputSchema,
				execute,
			},
		}));
		mockGetClient.mockResolvedValue({
			serverName: "Fizzy",
			client: { tools },
		} as any);
		return { execute, tools };
	}

	const call = (toolCallId: string, callInput: Record<string, unknown>) => ({
		toolCalls: [
			{ toolCallId, toolName: "fizzy_get_cards", input: callInput },
		],
	});

	/**
	 * The value the given tool call received. Tool calls are numbered from the
	 * start of the conversation, which later turns only ever append to.
	 */
	const toolResultOf = (
		turn: number,
		toolCall: number,
	): Record<string, unknown> => {
		const { messages } = streamTextMock.mock.calls[turn][0] as {
			messages: Array<{
				role: string;
				content: Array<{ output: { value: Record<string, unknown> } }>;
			}>;
		};
		return messages.filter((message) => message.role === "tool")[toolCall]
			.content[0].output.value;
	};

	it("finishes the listing without another model turn", async () => {
		const { execute } = listingClient();
		scriptTurns([
			call("t1", { board_id: "example-board" }),
			{ text: "DONE" },
		]);

		const out = await executeAgentDataGatheringLoop(input);

		expect(streamTextMock).toHaveBeenCalledTimes(2);
		expect(execute).toHaveBeenCalledTimes(2);
		expect(out.gatheredData.fizzy_get_cards).toHaveLength(3);
		expect(out.isPartial).toBe(false);
		expect(toolResultOf(1, 0)).toMatchObject({
			has_more: false,
			next_page: null,
			_listing: { status: "complete", pages: 2, cards: 3 },
		});
		expect(
			(out.gatheredData._coverage as Record<string, unknown>)[
				"fizzy_get_cards[board_id=example-board]"
			],
		).toMatchObject({ complete: true });
		expect(out.gatheredData._board_facts).toMatchObject({
			total: 3,
			complete: true,
		});
	});

	const factsAfter = (out: { gatheredData: Record<string, unknown> }) =>
		out.gatheredData._board_facts as { complete: boolean; gaps: string[] };

	const closedSchema = {
		type: "object",
		properties: {
			page: { type: "integer" },
			indexed_by: { type: "string", enum: ["closed", "not_now"] },
		},
	};

	it("does not call one column's listing the whole board", async () => {
		listingClient();
		scriptTurns([call("t1", { column_id: "column-1" }), { text: "DONE" }]);

		const out = await executeAgentDataGatheringLoop(input);

		expect(factsAfter(out).complete).toBe(false);
		expect(factsAfter(out).gaps.join()).toContain("only filtered listings");
		// A clean finish only marks a stopped listing or lost records partial.
		expect(out.isPartial).toBe(false);
	});

	it("does not call the default listing complete when closed cards went unread", async () => {
		listingClient(closedSchema);
		scriptTurns([call("t1", {}), { text: "DONE" }]);

		const out = await executeAgentDataGatheringLoop(input);

		expect(factsAfter(out).complete).toBe(false);
		expect(factsAfter(out).gaps).toEqual([
			"fizzy_get_cards: closed cards were not read",
		]);
	});

	it("stays partial when the model runs out of turns with closed cards unread", async () => {
		listingClient(closedSchema);
		scriptTurns([call("t1", {})]);

		const out = await executeAgentDataGatheringLoop({
			...input,
			maxIterations: 1,
		});

		expect(factsAfter(out).complete).toBe(false);
		expect(out.isPartial).toBe(true);
	});

	it("calls both listings complete when the model reads them", async () => {
		listingClient(closedSchema);
		scriptTurns([
			call("t1", {}),
			call("t2", { indexed_by: "closed" }),
			{ text: "DONE" },
		]);

		const out = await executeAgentDataGatheringLoop(input);

		expect(factsAfter(out)).toMatchObject({ complete: true, gaps: [] });
	});

	it("answers a repeated request without calling the source again", async () => {
		const { execute } = listingClient();
		scriptTurns([
			call("t1", { board_id: "example-board" }),
			call("t2", { board_id: "example-board", page: 2 }),
			{ text: "DONE" },
		]);

		await executeAgentDataGatheringLoop(input);

		expect(execute).toHaveBeenCalledTimes(2);
		expect(toolResultOf(2, 1)).toMatchObject({
			_listing: { status: "complete" },
			note: expect.stringContaining("Do not request it again"),
		});
	});

	it("starts at the first page whichever page the model asks for", async () => {
		const { execute } = listingClient();
		scriptTurns([
			call("t1", { board_id: "example-board", page: 2 }),
			{ text: "DONE" },
		]);

		const out = await executeAgentDataGatheringLoop(input);

		expect(execute.mock.calls[0][0].page).toBeUndefined();
		expect(out.gatheredData.fizzy_get_cards).toHaveLength(3);
	});

	it("treats a failed first call as a tool error, not as partial coverage", async () => {
		const { execute } = listingClient();
		execute.mockRejectedValueOnce(new Error("bad argument"));
		scriptTurns([
			call("t1", { board_id: "wrong-board" }),
			call("t2", { board_id: "example-board" }),
			{ text: "DONE" },
		]);

		const out = await executeAgentDataGatheringLoop(input);

		expect(toolResultOf(1, 0).error).toContain("bad argument");
		expect(out.isPartial).toBe(false);
		expect(out.gatheredData.fizzy_get_cards).toHaveLength(3);
	});

	it("lists a server's tools once per client, however many calls it makes", async () => {
		const { tools } = listingClient();
		scriptTurns([
			call("t1", { board_id: "example-board" }),
			{ text: "DONE" },
		]);

		await executeAgentDataGatheringLoop(input);

		// Once to discover the tools, once for the run's calls.
		expect(tools).toHaveBeenCalledTimes(2);
	});
});

describe("withToolTimeout", () => {
	it("rejects and aborts when a tool does not answer in time", async () => {
		let signal: AbortSignal | undefined;
		await expect(
			withToolTimeout(
				(abortSignal) => {
					signal = abortSignal;
					return new Promise(() => {});
				},
				"example_tool",
				5,
			),
		).rejects.toThrow("example_tool did not answer");
		expect(signal?.aborted).toBe(true);
	});

	it("returns the tool's answer and leaves it unaborted", async () => {
		let signal: AbortSignal | undefined;
		await expect(
			withToolTimeout(async (abortSignal) => {
				signal = abortSignal;
				return "answer";
			}, "example_tool"),
		).resolves.toBe("answer");
		expect(signal?.aborted).toBe(false);
	});
});

it("writes report gathering and summary rows with report attribution", async () => {
	const { summarizeLargeToolResult } = await vi.importActual<
		typeof import("../src/activities/orchestrator/execution/summarize-tool-result")
	>("../src/activities/orchestrator/execution/summarize-tool-result");
	usageRows.mockClear();
	summaryMock.mockImplementationOnce(summarizeLargeToolResult);
	vi.mocked(getAIModelWithMetadata).mockImplementation(
		async (_request, context) =>
			({
				...fakeAiModel,
				model: wrapLanguageModel({
					model: new MockLanguageModelV4({
						doGenerate: async () => ({
							content: [{ type: "text", text: "Report summary" }],
							finishReason: { unified: "stop", raw: "stop" },
							usage: {
								inputTokens: {
									total: 10,
									noCache: 10,
									cacheRead: 0,
									cacheWrite: 0,
								},
								outputTokens: {
									total: 4,
									text: 4,
									reasoning: 0,
								},
							},
							warnings: [],
						}),
					}),
					middleware: createUsageLoggingMiddleware({
						...context,
						provider: "VERCEL_GATEWAY",
						providerModelId: "example-model",
					}),
				}),
			}) as any,
	);

	summaryMock.mockClear();
	mockGetClient.mockResolvedValue(
		fakeClient({
			fizzy_get_report: () => "x".repeat(120_000),
		}) as any,
	);
	scriptTurns([
		{
			toolCalls: [
				{
					toolCallId: "call-example",
					toolName: "fizzy_get_report",
					input: {},
				},
			],
		},
		{ text: "Report complete" },
	]);
	meterScriptedTurns = true;
	try {
		await executeAgentDataGatheringLoop({
			...input,
			jobType: "scheduled-report",
		});
	} finally {
		meterScriptedTurns = false;
	}
	expect(vi.mocked(getAIModelWithMetadata).mock.calls[0][1]).toMatchObject({
		featureKey: "report-generation",
	});
	expect(usageRows).toHaveBeenCalledWith(
		expect.objectContaining({
			featureKey: "report-generation",
			jobType: "scheduled-report",
			callPurpose: "result-summary-chunk",
			inputTokens: 10,
			outputTokens: 4,
		}),
	);
	expect(
		usageRows.mock.calls.map(([row]) => [row.featureKey, row.callPurpose]),
	).toEqual([
		["report-generation", "data-gathering"],
		["report-generation", "result-summary-chunk"],
		["report-generation", "result-summary-chunk"],
		["report-generation", "data-gathering"],
	]);
	expect(summaryMock).toHaveBeenCalledWith(
		expect.objectContaining({
			featureKey: "report-generation",
		}),
	);
	await summarizeLargeToolResult({
		featureKey: "chat-agent",
		toolName: "example-tool",
		toolResult: "Example result",
		userQuery: "Summarize",
		maxOutputLength: 100,
		userId: "example-user",
		organizationId: "example-org",
	});
	expect(usageRows).toHaveBeenLastCalledWith(
		expect.objectContaining({
			featureKey: "chat-agent",
			callPurpose: "result-summary-single",
		}),
	);
});
