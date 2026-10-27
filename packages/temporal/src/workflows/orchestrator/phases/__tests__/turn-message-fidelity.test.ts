import { createHash } from "node:crypto";
import { streamText as sdkStreamText } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const activities = new Map<string, ReturnType<typeof vi.fn>>();
	return {
		stub: (name: string) => {
			const existing = activities.get(name);
			if (existing) {
				return existing;
			}
			const fn = vi.fn();
			activities.set(name, fn);
			return fn;
		},
		resetAll: () => {
			for (const fn of activities.values()) {
				fn.mockReset();
			}
		},
		off: new Set<string>(),
		stream: vi.fn(),
		findMany: vi.fn(),
		download: vi.fn(),
		warn: vi.fn(),
		model: undefined as unknown,
	};
});
vi.mock("@temporalio/workflow", () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
	patched: vi.fn((id: string) => !mocks.off.has(id)),
	proxyActivities: vi.fn(
		() => new Proxy({}, { get: (_, name) => mocks.stub(String(name)) }),
	),
	workflowInfo: vi.fn(() => ({
		startTime: new Date(),
		runId: "example-run",
		unsafe: { isReplaying: false },
	})),
	startChild: vi.fn(),
	ParentClosePolicy: { ABANDON: "ABANDON" },
}));
vi.mock("@temporalio/activity", () => ({ heartbeat: vi.fn() }));
vi.mock("@repo/ai", async () => {
	const sdk = await import("ai");
	return {
		streamText: mocks.stream,
		tool: sdk.tool,
		jsonSchema: sdk.jsonSchema,
		isStepCount: sdk.isStepCount,
	};
});
vi.mock("@repo/ai/capabilities", () => ({
	getModelCapabilities: () => ({ vision: true }),
}));
vi.mock("@repo/ai/limits", () => ({ classifyLimitError: () => null }));
vi.mock("@repo/ai/skills", () => ({
	listAvailableSkills: async () => [],
	createSkillTools: () => ({}),
	buildSkillsSystemBlock: () => "",
}));
vi.mock("../../../../lib/redis-publisher", () => ({
	publishExecutionEvent: vi.fn(),
}));
vi.mock("../../../../activities/orchestrator/utils", () => ({
	getAiModelWithSelection: async () => ({
		model: mocks.model ?? { modelId: "gpt-5.5" },
		provider: "OPENAI",
		modelString: "gpt-5.5",
		planSpentApiBilling: () => undefined,
	}),
}));
vi.mock("@repo/database", () => ({
	db: { chatDocument: { findMany: mocks.findMany } },
}));
vi.mock("@repo/storage", () => ({ downloadFile: mocks.download }));
vi.mock("@repo/config", () => ({
	config: {
		storage: { bucketNames: { chatDocuments: "example-documents" } },
	},
}));
vi.mock("@repo/logs", () => ({ logger: { warn: mocks.warn } }));

import {
	type RunAgentIterationInput,
	runAgentIteration,
} from "../../../../activities/orchestrator/execution/run-agent-iteration";
import {
	boundedHistoryV2Decision,
	estimateIterationInputTokens,
} from "../../advisor-history-retention";
import { createInitialState, type IterativeMessage } from "../../types";
import { executeIterativePhase } from "../iterative-execution";
import { buildSynthesisHistory } from "../synthesis-history";
import { installDefaultStubs } from "./advisor-scenario-harness";

const PATCH = "orch-keep-turn-messages-v1";
const at = "2026-01-01T00:00:00Z";
const call = (id: string, name = "search_tools") => ({
	type: "tool-call",
	toolCallId: id,
	toolName: name,
	input: { query: id },
});
const text = (value: string) => ({
	type: "text-delta",
	id: "example-text",
	text: value,
});
const docs = ["example-a", "example-b"].map((id) => ({
	id,
	filename: `${id}.png`,
	mimeType: "image/png",
	s3Path: id,
}));
const hash = (bytes: number[]) =>
	createHash("sha256").update(new Uint8Array(bytes)).digest("hex");
const reference = (documentId: string, bytes: number[]) => ({
	documentId,
	contentHash: hash(bytes),
	mimeType: "image/png",
	transformationVersion: "original-v1",
});

function stream(parts: unknown[]) {
	return {
		stream: (async function* () {
			for (const part of parts) {
				yield part;
			}
		})(),
		usage: Promise.resolve({ inputTokens: 10, outputTokens: 5 }),
		finishReason: Promise.resolve(
			parts.some((p) => (p as { type: string }).type === "tool-call")
				? "tool-calls"
				: "stop",
		),
	};
}

async function run(
	options: {
		ids?: string[];
		parts?: unknown[][];
		oldActivity?: boolean;
		maxIterations?: number;
		cancelled?: () => boolean;
		approve?: boolean;
		sdk?: boolean;
		history?: Array<{ role: "user" | "assistant"; content: string }>;
	} = {},
) {
	const requests: Array<{
		messages: Array<{ role: string; content: unknown }>;
		toolChoice?: unknown;
	}> = [];
	const inputs: RunAgentIterationInput[] = [];
	const results: unknown[] = [];
	const providerRequests: Array<
		Parameters<MockLanguageModelV4["doStream"]>[0]
	> = [];
	const rounds = options.parts ?? [
		[
			text("I will compare both sources."),
			call("example-1"),
			call("example-2"),
		],
		[text("The sources agree."), call("example-3")],
		[text("Here is the answer.")],
	];
	if (options.sdk) {
		mocks.model = new MockLanguageModelV4({
			doStream: async (request) => {
				providerRequests.push(request);
				const parts = rounds[providerRequests.length - 1] as Array<{
					type: string;
					text?: string;
					toolCallId?: string;
					toolName?: string;
					input?: unknown;
				}>;
				const chunks: unknown[] = [
					{ type: "stream-start", warnings: [] },
				];
				parts.forEach((part, index) => {
					if (part.type === "text-delta") {
						chunks.push(
							{ type: "text-start", id: `example-text-${index}` },
							{
								type: "text-delta",
								id: `example-text-${index}`,
								delta: part.text,
							},
							{ type: "text-end", id: `example-text-${index}` },
						);
					} else {
						chunks.push({
							...part,
							input: JSON.stringify(part.input),
						});
					}
				});
				chunks.push({
					type: "finish",
					finishReason: {
						unified: parts.some((part) => part.type === "tool-call")
							? "tool-calls"
							: "stop",
						raw: undefined,
					},
					usage: {
						inputTokens: {
							total: 10,
							noCache: 10,
							cacheRead: 0,
							cacheWrite: 0,
						},
						outputTokens: { total: 5, text: 5, reasoning: 0 },
					},
				});
				return {
					stream: simulateReadableStream({ chunks: chunks as never }),
				};
			},
		});
	}
	mocks.stream.mockImplementation((req) => {
		requests.push(
			structuredClone({
				messages: req.messages,
				toolChoice: req.toolChoice,
			}),
		);
		if (options.sdk) {
			return sdkStreamText(req);
		}
		return stream(rounds[requests.length - 1]);
	});
	mocks
		.stub("runAgentIteration")
		.mockImplementation(async (input: RunAgentIterationInput) => {
			inputs.push(structuredClone(input));
			const result = await runAgentIteration(input);
			results.push(structuredClone(result));
			if (options.oldActivity) {
				const {
					assistantParts: _,
					imageAttachmentUpdates: __,
					...legacy
				} = result as typeof result & {
					assistantParts?: unknown;
					imageAttachmentUpdates?: unknown;
				};
				return legacy;
			}
			return result;
		});
	const input = {
		executionId: "example-execution",
		message: "Compare the attached diagrams.",
		userId: "example-user",
		organizationId: "example-org",
		attachedDocumentIds: options.ids,
		history: options.history ?? [],
		executionMode: "iterative" as const,
	};
	const state = createInitialState(input);
	state.enrichedMessage = input.message;
	state.enrichedSystemPrompt = "You are an Advisor.";
	const result = await executeIterativePhase(
		state,
		input,
		{
			maxIterations: options.maxIterations ?? 8,
			maxTotalTokens: 100_000,
		} as never,
		{} as never,
		vi.fn(),
		vi.fn(async () => ({ approved: options.approve ?? true })),
		options.cancelled ?? (() => false),
	);
	return { requests, providerRequests, inputs, results, state, result };
}

beforeEach(() => {
	installDefaultStubs(mocks);
	mocks.findMany.mockReset().mockResolvedValue(docs);
	mocks.download.mockReset().mockImplementation(async (path: string) => ({
		data: Buffer.from(path === "example-b" ? [2, 3] : [1]),
	}));
	mocks.warn.mockClear();
	mocks.stream.mockReset();
	mocks.model = undefined;
});

describe("Advisor response and image fidelity", () => {
	it("carries one response with text and two calls followed by ordered results into the next request", async () => {
		const { requests, inputs, results, result } = await run();
		expect(result.success).toBe(true);
		expect(results[0]).toMatchObject({
			assistantParts: [
				{ type: "text", text: "I will compare both sources." },
				{ type: "tool-call", toolCallId: "example-1" },
				{ type: "tool-call", toolCallId: "example-2" },
			],
		});
		expect(inputs[1].conversationHistory.map((m) => m.role)).toEqual([
			"user",
			"assistant",
			"tool",
			"tool",
		]);
		expect(requests[1].messages[1]).toEqual({
			role: "assistant",
			content: [
				{ type: "text", text: "I will compare both sources." },
				{
					type: "tool-call",
					toolCallId: "example-1",
					toolName: "search_tools",
					input: { query: "example-1" },
				},
				{
					type: "tool-call",
					toolCallId: "example-2",
					toolName: "search_tools",
					input: { query: "example-2" },
				},
			],
		});
		expect(
			inputs[1].conversationHistory.slice(2).map((m) => m.toolCallId),
		).toEqual(["example-1", "example-2"]);
		expect(requests[2].messages.slice(0, 4)).toEqual(requests[1].messages);
		mocks.off.add(PATCH);
		mocks.off.add("orch-keep-turn-images-v1");
		const legacy = await run({ ids: ["example-a"] });
		expect(legacy.inputs[0]).not.toHaveProperty("preserveTurnMessages");
		expect(legacy.inputs[0]).not.toHaveProperty("preserveTurnImages");
		expect(legacy.inputs[0].conversationHistory[0]).not.toHaveProperty(
			"imageAttachmentDocumentIds",
		);
		expect(legacy.results[0]).not.toHaveProperty("assistantParts");
		expect(legacy.results[0]).not.toHaveProperty("imageAttachmentUpdates");
		expect(legacy.inputs[1].conversationHistory.map((m) => m.role)).toEqual(
			["user", "assistant", "tool", "assistant", "tool"],
		);
	});

	it("expands ordered immutable image references on the source user message in three rounds", async () => {
		const { requests, inputs, result } = await run({
			ids: ["example-b", "example-a"],
		});
		expect(result.success).toBe(true);
		const original = requests[0].messages[0];
		expect(original.content).toEqual([
			{ type: "text", text: "Compare the attached diagrams." },
			{
				type: "file",
				data: new Uint8Array([2, 3]),
				mediaType: "image/png",
			},
			{ type: "file", data: new Uint8Array([1]), mediaType: "image/png" },
		]);
		for (const request of requests) {
			expect(JSON.stringify(request.messages[0])).toBe(
				JSON.stringify(original),
			);
		}
		expect(inputs[1].conversationHistory[0]).toMatchObject({
			imageAttachments: [
				reference("example-b", [2, 3]),
				reference("example-a", [1]),
			],
		});
		expect(mocks.findMany).toHaveBeenCalledWith(
			expect.objectContaining({ orderBy: { id: "asc" } }),
		);
		const prior = Object.assign(
			{ role: "user" as const, content: "Earlier turn" },
			{
				imageAttachments:
					inputs[1].conversationHistory[0].imageAttachments,
			},
		);
		const fresh = await run({ history: [prior] });
		expect(fresh.inputs[0].conversationHistory[0]).not.toHaveProperty(
			"imageAttachments",
		);
		for (const request of fresh.requests) {
			expect(request.messages[0].content).toBe("Earlier turn");
			expect(request.messages[1].content).toBe(
				"Compare the attached diagrams.",
			);
		}
	});

	it.each(["changed", "deleted"])(
		"drops a %s image after capture and keeps answering",
		async (change) => {
			mocks.findMany.mockImplementation(async () =>
				mocks.findMany.mock.calls.length === 1 || change === "changed"
					? docs
					: docs.slice(1),
			);
			mocks.download.mockImplementation(async (path: string) => ({
				data: Buffer.from(
					path === "example-b"
						? [2, 3]
						: mocks.findMany.mock.calls.length > 1
							? [9]
							: [1],
				),
			}));
			const { requests, inputs, result } = await run({
				ids: ["example-a", "example-b"],
			});
			expect(result.success).toBe(true);
			for (const request of requests.slice(1)) {
				expect(request.messages[0].content).toEqual([
					{ type: "text", text: "Compare the attached diagrams." },
					{
						type: "file",
						data: new Uint8Array([2, 3]),
						mediaType: "image/png",
					},
				]);
			}
			expect(inputs[2].conversationHistory[0]).toMatchObject({
				imageAttachments: [reference("example-b", [2, 3])],
			});
			expect(mocks.warn).toHaveBeenCalledWith(
				expect.stringContaining("VisionAttachments"),
				expect.objectContaining({
					documentId: "example-a",
					reason: change === "changed" ? "hash_mismatch" : "missing",
				}),
			);
		},
	);

	it("keeps text interleaved with calls in provider order", async () => {
		const { requests } = await run({
			parts: [
				[
					text("First."),
					call("example-1"),
					text("Then."),
					call("example-2"),
				],
				[text("Done.")],
			],
		});
		expect(
			(requests[1].messages[1].content as Array<{ type: string }>).map(
				(p) => p.type,
			),
		).toEqual(["text", "tool-call", "text", "tool-call"]);
	});

	it("resolves a reused call ID against its own response", async () => {
		const history: IterativeMessage[] = [
			{ role: "user", content: "Example", timestamp: at },
			{
				role: "assistant",
				content: "First",
				toolCalls: [
					{ id: "example-call", name: "first_tool", args: {} },
				],
				timestamp: at,
			},
			{
				role: "tool",
				content: "first result",
				toolCallId: "example-call",
				timestamp: at,
			},
			{
				role: "assistant",
				content: "Second",
				toolCalls: [
					{ id: "example-call", name: "second_tool", args: {} },
				],
				timestamp: at,
			},
			{
				role: "tool",
				content: "second result",
				toolCallId: "example-call",
				timestamp: at,
			},
		];
		mocks.stream.mockImplementation(() => stream([text("Done.")]));
		await runAgentIteration({
			conversationHistory: history,
			availableTools: {},
			systemPrompt: "Example",
			userId: "example-user",
			executionId: "example-execution",
			iteration: 3,
			preserveTurnMessages: true,
		} as RunAgentIterationInput);
		const request = mocks.stream.mock.calls[0][0];
		expect(request.messages[2].content[0].toolName).toBe("first_tool");
		expect(request.messages[4].content[0].toolName).toBe("second_tool");
	});
});

describe("retention and compatibility", () => {
	it("keeps response notes and paired calls through a keep-and-cache reset and counts the notes", async () => {
		const { inputs } = await run();
		const group = inputs[1].conversationHistory.slice(1);
		const history: IterativeMessage[] = [inputs[1].conversationHistory[0]];
		for (let round = 1; round <= 8; round++) {
			for (const message of group) {
				history.push({
					...message,
					iteration: round,
					...(message.assistantParts
						? {
								assistantParts: message.assistantParts.map(
									(part) =>
										part.type === "tool-call"
											? {
													...part,
													toolCallId: `${part.toolCallId}-${round}`,
												}
											: part,
								),
							}
						: {}),
					...(message.toolCalls
						? {
								toolCalls: message.toolCalls.map((c) => ({
									...c,
									id: `${c.id}-${round}`,
								})),
							}
						: {}),
					...(message.toolCallId
						? {
								toolCallId: `${message.toolCallId}-${round}`,
								content: "evidence ".repeat(12_000),
								toolResultReadOnly: true as const,
							}
						: {}),
				});
			}
		}
		const request = {
			conversationHistory: history,
			systemPrompt: "Example",
			availableTools: {},
		};
		const decision = boundedHistoryV2Decision({
			request,
			iteration: 20,
			allowance: 100_000_000,
			spent: 0,
			finalizationReserve: 8_000,
		});
		expect(decision.action).toBe("reset");
		expect(decision.pruned).toBeGreaterThan(0);
		for (const message of decision.history.filter(
			(m) => m.role === "assistant",
		)) {
			expect(message.content).toBe("I will compare both sources.");
			expect(message.toolCalls).toHaveLength(2);
			for (const call of message.toolCalls ?? []) {
				expect(
					decision.history.filter((m) => m.toolCallId === call.id),
				).toHaveLength(1);
			}
		}
		const withoutNotes = {
			...request,
			conversationHistory: history.map((m) =>
				m.role === "assistant"
					? { ...m, content: "", assistantParts: [] }
					: m,
			),
		};
		expect(estimateIterationInputTokens(request)).toBeGreaterThan(
			estimateIterationInputTokens(withoutNotes),
		);
	});

	it("groups results safely when an older activity omits optional fields", async () => {
		const { inputs, result } = await run({
			oldActivity: true,
			ids: ["example-a"],
		});
		expect(result.success).toBe(true);
		expect(inputs[1].conversationHistory.map((m) => m.role)).toEqual([
			"user",
			"assistant",
			"tool",
			"tool",
		]);
		expect(inputs[1].conversationHistory[1].content).toBe("");
		expect(
			inputs[1].conversationHistory[0].imageAttachmentDocumentIds,
		).toBeUndefined();
		expect(inputs[1].conversationHistory[0].imageAttachments).toEqual([]);
	});

	it("keeps a cancelled batch paired with its notes before the phase exits", async () => {
		const { state, result } = await run({
			cancelled: () =>
				mocks.stub("searchAvailableTools").mock.calls.length >= 1,
		});
		expect(result.success).toBe(false);
		const history = state.iterativeConversationHistory;
		expect(history.map((m) => m.role)).toEqual([
			"user",
			"assistant",
			"tool",
			"tool",
		]);
		expect(history[1].content).toBe("I will compare both sources.");
		expect(history.slice(2).map((m) => m.toolCallId)).toEqual([
			"example-1",
			"example-2",
		]);
		expect(history[3].content).toContain("outcome unknown");
	});

	it("keeps an image on its source beside a later instruction and backs off frame forcing after creation", async () => {
		const history: IterativeMessage[] = [
			{
				role: "user",
				content: "Build a frame",
				timestamp: at,
				imageAttachments: [reference("example-a", [1])],
			} as IterativeMessage,
			{
				role: "assistant",
				content: "I will build it.",
				toolCalls: [
					{
						id: "example-frame",
						name: "fabric_create_frame",
						args: {},
					},
				],
				timestamp: at,
			},
			{
				role: "tool",
				content: JSON.stringify({ frameId: "example-frame" }),
				toolCallId: "example-frame",
				timestamp: at,
			},
			{ role: "user", content: "Finish the frame", timestamp: at },
		];
		mocks.stream.mockImplementation(() => stream([text("Done.")]));
		await runAgentIteration({
			conversationHistory: history,
			availableTools: {
				fabric_create_frame: {
					description: "Create",
					inputSchema: { type: "object" },
				},
			},
			systemPrompt: "Example",
			userId: "example-user",
			organizationId: "example-org",
			executionId: "example-execution",
			iteration: 2,
			preserveTurnImages: true,
		} as RunAgentIterationInput);
		const request = mocks.stream.mock.calls[0][0];
		expect(request.toolChoice).toBe("auto");
		expect(request.messages[0].content).toEqual([
			{ type: "text", text: "Build a frame" },
			{ type: "file", data: new Uint8Array([1]), mediaType: "image/png" },
		]);
		expect(request.messages[3].content).toBe("Finish the frame");
	});

	it("preserves the source user message and response text in bounded synthesis", () => {
		const note = "Notes from the model. ".repeat(300);
		const source = {
			role: "user",
			content: "Original request. ".repeat(600),
			timestamp: at,
			imageAttachments: [reference("example-a", [1])],
		} as IterativeMessage;
		const response = {
			role: "assistant",
			content: note,
			assistantParts: [
				{ type: "text", text: note },
				{ type: "tool-call", toolCallId: "example-a" },
			],
			toolCalls: [{ id: "example-a", name: "read", args: {} }],
			timestamp: at,
		} as IterativeMessage;
		const history = [
			source,
			response,
			{
				role: "tool",
				content: "Result",
				toolCallId: "example-a",
				timestamp: at,
			} as IterativeMessage,
		];
		const compacted = buildSynthesisHistory(history, true);
		expect(compacted[0]).toEqual(source);
		expect(compacted[1]).toEqual(response);
	});
});

it("keeps the selected eight images and the budget note stable on later rounds", async () => {
	const many = Array.from({ length: 9 }, (_, index) => ({
		id: `example-${index}`,
		filename: `example-${index}.png`,
		mimeType: "image/png",
		s3Path: `example-${index}`,
	}));
	mocks.findMany.mockResolvedValue(many);
	const { requests, inputs } = await run({ ids: many.map((doc) => doc.id) });
	const source = requests[0].messages[0];
	expect(
		(source.content as Array<{ type: string }>).filter(
			(p) => p.type === "file",
		),
	).toHaveLength(8);
	expect(JSON.stringify(source)).toContain("not shown");
	for (const request of requests.slice(1)) {
		expect(request.messages[0]).toEqual(source);
	}
	expect(inputs[1].conversationHistory[0].imageAttachments).toHaveLength(8);
});

it("keeps images and response notes in synthesis without a turn ledger", async () => {
	const { requests, inputs, result } = await run({
		ids: ["example-a"],
		maxIterations: 2,
		parts: [
			[
				text("I will compare both sources."),
				call("example-1"),
				call("example-2"),
			],
			[text("The comparison is complete. ".repeat(20))],
		],
	});
	expect(result.success).toBe(true);
	expect(inputs[1].availableTools).toEqual({});
	expect(inputs[1].budgetAttemptKind).toBeUndefined();
	expect(inputs[1].turnScope).toBeUndefined();
	expect(requests[1].messages[0]).toEqual(requests[0].messages[0]);
	expect(
		(
			requests[1].messages[1].content as Array<{
				type: string;
				text?: string;
			}>
		)[0],
	).toEqual({ type: "text", text: "I will compare both sources." });
});

it("returns only the successful attempt's ordered parts after a stream retry", async () => {
	mocks.stream
		.mockImplementationOnce(() =>
			stream([
				text("Discarded note."),
				{ type: "error", error: new Error("temporary stream failure") },
			]),
		)
		.mockImplementationOnce(() =>
			stream([text("Retained note."), call("example-retry")]),
		);
	const result = await runAgentIteration({
		conversationHistory: [
			{ role: "user", content: "Example", timestamp: at },
		],
		availableTools: {
			search_tools: {
				description: "Search",
				inputSchema: { type: "object" },
			},
		},
		systemPrompt: "Example",
		userId: "example-user",
		executionId: "example-execution",
		iteration: 1,
		preserveTurnMessages: true,
	} as RunAgentIterationInput);
	expect(result).toMatchObject({
		type: "tool_calls",
		assistantParts: [
			{ type: "text", text: "Retained note." },
			{ type: "tool-call", toolCallId: "example-retry" },
		],
	});
});

it("keeps a rejected call in its response with notes and ordered results", async () => {
	mocks
		.stub("createOrchestratorApprovalRequest")
		.mockResolvedValue({ approvalId: "example-approval" });
	const { inputs, result } = await run({
		approve: false,
		parts: [
			[
				text("I will remove the outdated frame and check the catalog."),
				call("example-delete", "delete_frame"),
				call("example-search"),
			],
			[text("The removal was declined.")],
		],
	});
	expect(result.success).toBe(true);
	expect(inputs[1].conversationHistory.map((m) => m.role)).toEqual([
		"user",
		"assistant",
		"tool",
		"tool",
	]);
	expect(inputs[1].conversationHistory[1].content).toBe(
		"I will remove the outdated frame and check the catalog.",
	);
	expect(inputs[1].conversationHistory[2].content).toContain(
		"rejected by user",
	);
	expect(
		inputs[1].conversationHistory.slice(2).map((m) => m.toolCallId),
	).toEqual(["example-delete", "example-search"]);
});

it("captures paired notes, calls, results, and stable images at the mock provider in three rounds", async () => {
	const { providerRequests, result } = await run({
		sdk: true,
		ids: ["example-b", "example-a"],
	});
	expect(result.success).toBe(true);
	expect(providerRequests).toHaveLength(3);
	const prompts = providerRequests.map((request) => request.prompt);
	const users = prompts.map((prompt) =>
		prompt.find((message) => message.role === "user"),
	);
	for (const user of users) {
		expect(user).toEqual(users[0]);
	}
	expect(users[0]?.content).toEqual([
		{ type: "text", text: "Compare the attached diagrams." },
		{
			type: "file",
			data: { type: "data", data: new Uint8Array([2, 3]) },
			mediaType: "image/png",
		},
		{
			type: "file",
			data: { type: "data", data: new Uint8Array([1]) },
			mediaType: "image/png",
		},
	]);
	const second = prompts[1].filter((message) => message.role !== "system");
	expect(second.map((message) => message.role)).toEqual([
		"user",
		"assistant",
		"tool",
	]);
	expect(second[1].content).toEqual([
		{ type: "text", text: "I will compare both sources." },
		{
			type: "tool-call",
			toolCallId: "example-1",
			toolName: "search_tools",
			input: { query: "example-1" },
		},
		{
			type: "tool-call",
			toolCallId: "example-2",
			toolName: "search_tools",
			input: { query: "example-2" },
		},
	]);
	expect(
		(second[2].content as Array<{ toolCallId: string }>).map(
			(part) => part.toolCallId,
		),
	).toEqual(["example-1", "example-2"]);
	expect(
		prompts[2].filter((message) => message.role !== "system").slice(0, 3),
	).toEqual(second);
});

it.each(["download", "query"])(
	"retries a temporary %s failure after round two without replacing the stored reference",
	async (failure) => {
		mocks.findMany.mockImplementation(async () => {
			if (failure === "query" && mocks.findMany.mock.calls.length === 2) {
				throw new Error("temporary query failure");
			}
			return docs;
		});
		mocks.download.mockImplementation(async (path: string) => {
			if (
				failure === "download" &&
				mocks.findMany.mock.calls.length === 2 &&
				path === "example-a"
			) {
				throw new Error("temporary download failure");
			}
			return { data: Buffer.from(path === "example-a" ? [1] : [2, 3]) };
		});
		const { requests, inputs, result } = await run({
			ids: ["example-a", "example-b"],
		});
		expect(result.success).toBe(true);
		expect(requests[1].messages[0]).not.toEqual(requests[0].messages[0]);
		expect(inputs[2].conversationHistory[0].imageAttachments).toEqual([
			reference("example-a", [1]),
			reference("example-b", [2, 3]),
		]);
		expect(requests[2].messages[0]).toEqual(requests[0].messages[0]);
	},
);

it("retries an attachment whose initial byte capture was temporarily unavailable", async () => {
	mocks.findMany
		.mockRejectedValueOnce(new Error("temporary query failure"))
		.mockResolvedValue(docs);
	const { requests, inputs, result } = await run({
		ids: ["example-a", "example-b"],
	});
	expect(result.success).toBe(true);
	expect(inputs[1].conversationHistory[0].imageAttachmentDocumentIds).toEqual(
		["example-a", "example-b"],
	);
	expect(inputs[2].conversationHistory[0].imageAttachments).toEqual([
		reference("example-a", [1]),
		reference("example-b", [2, 3]),
	]);
	expect(requests[1].messages[0]).toEqual(requests[2].messages[0]);
});

it("omits whitespace-only blocks while preserving ordered calls and substantive text", async () => {
	const { requests } = await run({
		parts: [
			[
				text("\n\n"),
				call("example-1"),
				text("\n"),
				call("example-2"),
				text("Here is the evidence."),
			],
			[text("Done.")],
		],
	});
	expect(requests[1].messages[1].content).toEqual([
		{
			type: "tool-call",
			toolCallId: "example-1",
			toolName: "search_tools",
			input: { query: "example-1" },
		},
		{
			type: "tool-call",
			toolCallId: "example-2",
			toolName: "search_tools",
			input: { query: "example-2" },
		},
		{ type: "text", text: "Here is the evidence." },
	]);
});
