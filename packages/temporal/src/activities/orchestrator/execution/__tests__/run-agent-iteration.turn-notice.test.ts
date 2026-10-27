/**
 * runAgentIteration — the per-call `turnNotice`.
 *
 * The workflow keeps the system prompt byte-identical across a turn and sends
 * the notes that change within it (budget warning, generated-image rule) as
 * `turnNotice`. The activity must send it as one final user message of this
 * call only: not in `instructions`, not anywhere else in the messages, not
 * written back into the conversation history, not under a vision splice, and
 * never read as the user's request by the frame-forcing heuristic.
 *
 * Mock set mirrors `run-agent-iteration.suppression.test.ts`, plus the vision
 * hooks so the splice runs for real against a vision-capable model.
 */

import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const stubs = vi.hoisted(() => ({
	streamTextMock: vi.fn(),
	resolveImageAttachments: vi.fn(),
}));

vi.mock("@repo/ai", () => ({
	streamText: stubs.streamTextMock,
	tool: vi.fn((definition: { description?: string }) => ({
		__isAiSdkTool: true,
		description: definition?.description,
	})),
	jsonSchema: vi.fn((schema: unknown) => ({ __isJsonSchema: true, schema })),
	isStepCount: vi.fn((n: number) => ({ __stopWhen: "stepCount", n })),
}));

vi.mock("@repo/ai/capabilities", () => ({
	getModelCapabilities: vi.fn(() => ({ vision: true })),
}));

vi.mock("@repo/ai/limits", () => ({
	classifyLimitError: vi.fn(() => null),
}));

vi.mock("@repo/ai/skills", () => ({
	listAvailableSkills: vi.fn(async () => []),
	createSkillTools: vi.fn(() => ({})),
	buildSkillsSystemBlock: vi.fn(() => ""),
}));

vi.mock("@temporalio/activity", () => ({
	heartbeat: vi.fn(),
}));

vi.mock("../../../../lib/redis-publisher", () => ({
	publishExecutionEvent: vi.fn(),
}));

vi.mock("../../utils", () => ({
	getAiModelWithSelection: vi.fn(async () => ({
		model: { __mockModel: true, modelId: "claude-sonnet-5" },
		provider: "ANTHROPIC_DIRECT",
		modelString: "claude-sonnet-5",
		canonicalName: "claude-sonnet-5",
	})),
}));

vi.mock("../vision-image-attachments", async (importOriginal) => ({
	...(await importOriginal<typeof import("../vision-image-attachments")>()),
	resolveImageAttachments: stubs.resolveImageAttachments,
}));

import type { IterativeMessage } from "../../../../workflows/orchestrator/types";
import { getAiModelWithSelection } from "../../utils";
import {
	type RunAgentIterationInput,
	runAgentIteration,
} from "../run-agent-iteration";

const NOTICE =
	"[Host note: this note is from the host for this step of the turn only; it is not part of the user's message.]\n\nIMPORTANT - BUDGET WARNING: You are approaching the resource limit (~90% used).";

function makeStreamResult() {
	return {
		stream: (async function* () {})(),
		usage: Promise.resolve({ inputTokens: 1, outputTokens: 1 }),
		finishReason: Promise.resolve("stop"),
	};
}

/** A user request, an assistant tool call, and its result. */
function historyEndingInToolResult(userText: string): IterativeMessage[] {
	return [
		{ role: "user", content: userText, timestamp: "2026-10-05T00:00:00Z" },
		{
			role: "assistant",
			content: "",
			toolCalls: [
				{
					id: "call-1",
					name: "search_slack_messages",
					args: { query: "x" },
				},
			],
			timestamp: "2026-10-05T00:00:01Z",
			iteration: 1,
		},
		{
			role: "tool",
			content: JSON.stringify({ messages: [] }),
			toolCallId: "call-1",
			timestamp: "2026-10-05T00:00:02Z",
			iteration: 1,
		},
	];
}

function buildInput(
	overrides: Partial<RunAgentIterationInput> = {},
): RunAgentIterationInput {
	return {
		conversationHistory: historyEndingInToolResult("When is the launch?"),
		availableTools: {
			search_slack_messages: {
				description: "Search Slack.",
				inputSchema: { type: "object", properties: {} },
			},
			fabric_create_slideshow: {
				description: "Create a slideshow.",
				inputSchema: { type: "object", properties: {} },
			},
		},
		systemPrompt: "You are the project Advisor.",
		userId: "user-1",
		organizationId: "org-1",
		executionId: "exec-1",
		iteration: 2,
		...overrides,
	};
}

interface StreamCall {
	instructions:
		| string
		| import("ai").ModelMessage
		| import("ai").ModelMessage[];
	messages: Array<{ role: string; content: unknown }>;
	toolChoice?: unknown;
}

async function streamCallFor(
	input: RunAgentIterationInput,
): Promise<StreamCall> {
	await runAgentIteration(input);
	expect(stubs.streamTextMock).toHaveBeenCalledTimes(1);
	return stubs.streamTextMock.mock.calls[0][0] as StreamCall;
}

function occurrences(call: StreamCall, text: string): number {
	return call.messages.filter((m) => JSON.stringify(m.content).includes(text))
		.length;
}

beforeEach(() => {
	vi.clearAllMocks();
	stubs.streamTextMock.mockImplementation(() => makeStreamResult());
	stubs.resolveImageAttachments.mockResolvedValue([]);
});

describe("runAgentIteration — turnNotice", () => {
	it("sends the notice as the final user message, after the tool result, and nowhere else", async () => {
		const input = buildInput({ turnNotice: NOTICE });
		const call = await streamCallFor(input);

		expect(call.messages.map((m) => m.role)).toEqual([
			"user",
			"assistant",
			"tool",
			"user",
		]);
		expect(call.messages.at(-1)).toEqual({ role: "user", content: NOTICE });
		expect(occurrences(call, "BUDGET WARNING")).toBe(1);
		expect(call.instructions).toMatchObject({
			role: "system",
			content: "You are the project Advisor.",
			providerOptions: CACHE_BREAKPOINT,
		});
		// Never written into the conversation history it was handed.
		expect(input.conversationHistory).toHaveLength(3);
		expect(JSON.stringify(input.conversationHistory)).not.toContain(
			"BUDGET WARNING",
		);
	});

	it("adds no message when there is no notice", async () => {
		const call = await streamCallFor(buildInput());
		expect(call.messages.map((m) => m.role)).toEqual([
			"user",
			"assistant",
			"tool",
		]);
	});

	it("is not read as the user's request by the frame-forcing heuristic", async () => {
		// Control: the same words from the user do force the slideshow tool.
		const forced = await streamCallFor(
			buildInput({
				conversationHistory: historyEndingInToolResult(
					"Build a slide deck about the launch.",
				),
			}),
		);
		expect(forced.toolChoice).toEqual({
			type: "tool",
			toolName: "fabric_create_slideshow",
		});

		vi.clearAllMocks();
		stubs.streamTextMock.mockImplementation(() => makeStreamResult());
		const call = await streamCallFor(
			buildInput({
				turnNotice: `${NOTICE}\n\nBuild a slide deck about the launch.`,
			}),
		);
		expect(call.toolChoice).toBe("auto");
	});

	it("leaves the attached images on the user's message, not on the notice", async () => {
		stubs.resolveImageAttachments.mockResolvedValue([
			{
				filename: "sketch.png",
				mediaType: "image/png",
				bytes: new Uint8Array([1, 2, 3]),
			},
		]);
		const call = await streamCallFor(
			buildInput({
				conversationHistory: [
					{
						role: "user",
						content: "What is in the sketch?",
						timestamp: "2026-10-05T00:00:00Z",
					},
				],
				iteration: 1,
				attachedDocumentIds: ["doc-1"],
				turnNotice: NOTICE,
			}),
		);
		expect(call.messages).toHaveLength(2);
		const [request, notice] = call.messages;
		expect(request.content).toEqual([
			{ type: "text", text: "What is in the sketch?" },
			{
				type: "file",
				data: new Uint8Array([1, 2, 3]),
				mediaType: "image/png",
			},
		]);
		expect(notice).toEqual({ role: "user", content: NOTICE });
	});
});

const CACHE_BREAKPOINT = {
	anthropic: { cacheControl: { type: "ephemeral" } },
};

function breakpointIndexes(call: StreamCall): number[] {
	return call.messages.flatMap((m, index) =>
		(m as { providerOptions?: unknown }).providerOptions === undefined
			? []
			: [index],
	);
}

describe("runAgentIteration — Anthropic prompt-cache breakpoint", () => {
	it.each([
		["ANTHROPIC_DIRECT", "claude-sonnet-5"],
		["VERCEL_GATEWAY", "anthropic/claude-sonnet-5"],
	])(
		"fingerprints stable, previous-request and rolling markers for %s",
		async (provider, modelString) => {
			vi.mocked(getAiModelWithSelection).mockResolvedValueOnce({
				model: { __mockModel: true, modelId: modelString },
				provider,
				modelString,
				canonicalName: modelString,
			} as never);
			const history = [
				{ role: "user", content: "example", timestamp: "2026-01-01" },
				...Array.from({ length: 24 }, (_, index) => ({
					role: index % 2 ? "tool" : "assistant",
					iteration: Math.floor(index / 2) + 1,
					content: "example",
					timestamp: "2026-01-01",
					...(index % 2
						? { toolCallId: `c${index - 1}` }
						: {
								toolCalls: [
									{
										id: `c${index}`,
										name: "example",
										args: {},
									},
								],
							}),
				})),
			];
			const call = await streamCallFor(
				buildInput({
					conversationHistory: history as never,
					turnNotice: NOTICE,
				}),
			);
			const { createRequestFingerprint } = await import(
				"@repo/ai/lib/request-observation"
			);
			const fp = createRequestFingerprint({
				modelId: modelString,
				route: provider,
				prompt: [
					typeof call.instructions === "string"
						? { role: "system", content: call.instructions }
						: call.instructions,
					...call.messages,
				],
			});
			expect(fp.cacheMarkers).toEqual([
				[1, 0],
				[1, 23],
				[1, 25],
			]);
			expect(call.messages.at(-1)).toEqual({
				role: "user",
				content: NOTICE,
			});
			expect(fp.cacheMarkers.length).toBeLessThanOrEqual(4);
		},
	);

	it("marks the last conversation message, not the per-call notice", async () => {
		const call = await streamCallFor(buildInput({ turnNotice: NOTICE }));

		expect(breakpointIndexes(call)).toEqual([0, 2]);
		expect(call.messages[2]).toMatchObject({
			role: "tool",
			providerOptions: CACHE_BREAKPOINT,
		});
		expect(call.messages.at(-1)).toEqual({ role: "user", content: NOTICE });
	});

	it("marks the last message when there is no notice", async () => {
		const call = await streamCallFor(buildInput());
		expect(breakpointIndexes(call)).toEqual([0, 2]);
	});

	it("does not mark the caller's conversation history", async () => {
		const input = buildInput();
		await streamCallFor(input);
		expect(JSON.stringify(input.conversationHistory)).not.toContain(
			"cacheControl",
		);
	});

	it.each([
		["OPENAI", "gpt-5.5"],
		["AWS_BEDROCK", "anthropic.claude-sonnet-5"],
		["VERCEL_GATEWAY", "openai/gpt-5.5"],
	])("sends no breakpoint for %s %s", async (provider, modelString) => {
		vi.mocked(getAiModelWithSelection).mockResolvedValueOnce({
			model: { __mockModel: true, modelId: modelString },
			provider,
			modelString,
			canonicalName: modelString,
		} as never);
		const call = await streamCallFor(buildInput({ turnNotice: NOTICE }));
		expect(breakpointIndexes(call)).toEqual([]);
	});

	it("marks the user's message after the image splice", async () => {
		stubs.resolveImageAttachments.mockResolvedValue([
			{
				filename: "sketch.png",
				mediaType: "image/png",
				bytes: new Uint8Array([1, 2, 3]),
			},
		]);
		const call = await streamCallFor(
			buildInput({
				conversationHistory: [
					{
						role: "user",
						content: "What is in the sketch?",
						timestamp: "2026-10-05T00:00:00Z",
					},
				],
				iteration: 1,
				attachedDocumentIds: ["doc-1"],
				turnNotice: NOTICE,
			}),
		);
		expect(breakpointIndexes(call)).toEqual([0]);
		expect(call.messages[0]).toMatchObject({
			providerOptions: CACHE_BREAKPOINT,
			content: expect.arrayContaining([
				expect.objectContaining({ type: "file" }),
			]),
		});
	});

	it("marks a Claude model routed through the Vercel gateway", async () => {
		vi.mocked(getAiModelWithSelection).mockResolvedValueOnce({
			model: { __mockModel: true, modelId: "anthropic/claude-sonnet-5" },
			provider: "VERCEL_GATEWAY",
			modelString: "anthropic/claude-sonnet-5",
			canonicalName: "claude-sonnet-5",
		} as never);
		const call = await streamCallFor(buildInput());
		expect(breakpointIndexes(call)).toEqual([0, 2]);
	});
});

it.each([1, 3, 12])(
	"marks the preceding request before a round of %s separate call/result pairs",
	async (count) => {
		const history = historyEndingInToolResult("Example request").map(
			(m, i) => ({ ...m, ...(i > 0 ? { iteration: 1 } : {}) }),
		);
		for (let index = 0; index < count; index++) {
			history.push(
				{
					role: "assistant",
					content: "",
					timestamp: "2026-01-01",
					iteration: 2,
					toolCalls: [
						{ id: `new-${index}`, name: "example", args: {} },
					],
				},
				{
					role: "tool",
					content: `result-${index}`,
					toolCallId: `new-${index}`,
					timestamp: "2026-01-01",
					iteration: 2,
				},
			);
		}
		const call = await streamCallFor(
			buildInput({
				conversationHistory: history,
				iteration: 3,
				turnNotice: NOTICE,
			}),
		);
		// Conversion preserves indices: one SDK message per workflow row, followed by the notice.
		expect(call.messages).toHaveLength(history.length + 1);
		expect(
			call.messages.slice(0, history.length).map((m) => m.role),
		).toEqual(history.map((m) => m.role));
		expect(breakpointIndexes(call)).toEqual([2, history.length - 1]);
		for (let index = 0; index < count; index++) {
			expect(call.messages[3 + index * 2]).toMatchObject({
				content: [
					expect.objectContaining({ toolCallId: `new-${index}` }),
				],
			});
			expect(call.messages[4 + index * 2]).toMatchObject({
				content: [
					expect.objectContaining({ toolCallId: `new-${index}` }),
				],
			});
		}
	},
);

it("keeps the preceding-request boundary before a correction round's assistant text and user note", async () => {
	const history: IterativeMessage[] = [
		...historyEndingInToolResult("Example request").map((m, i) => ({
			...m,
			...(i > 0 ? { iteration: 1 } : {}),
		})),
		{
			role: "assistant",
			content: "Example claim",
			timestamp: "2026-01-01",
			iteration: 2,
		},
		{
			role: "user",
			content: "Example correction",
			timestamp: "2026-01-01",
			iteration: 2,
		},
	];
	const call = await streamCallFor(
		buildInput({
			conversationHistory: history,
			iteration: 3,
			turnNotice: NOTICE,
		}),
	);
	expect(call.messages).toHaveLength(6);
	expect(breakpointIndexes(call)).toEqual([2, 4]);
	expect(call.messages[3].content).toBe("Example claim");
	expect(call.messages[4].content).toBe("Example correction");
});

describe("split system prompt", () => {
	it.each([1, 2])(
		"marks only reusable system text on round %i, outside history cleanup",
		async (iteration) => {
			const call = await streamCallFor(
				buildInput({
					iteration,
					systemPrompt: "Full legacy prompt",
					systemPromptParts: {
						reusable: "Reusable instructions",
						variable: "Variable memory",
					},
					conversationHistory:
						iteration === 1
							? [
									{
										role: "user",
										content: "Example question",
										timestamp: "2026-10-20T00:00:00Z",
										providerOptions: CACHE_BREAKPOINT,
									} as never,
								]
							: historyEndingInToolResult("Example question"),
				}),
			);
			expect(call.instructions).toEqual([
				{
					role: "system",
					content: "Reusable instructions",
					providerOptions: CACHE_BREAKPOINT,
				},
				{ role: "system", content: "Variable memory" },
			]);
			const count = (JSON.stringify(call).match(/cacheControl/g) ?? [])
				.length;
			expect(count).toBeLessThanOrEqual(4);
			expect(count).toBe(iteration === 1 ? 2 : 3);
		},
	);
	it("appends skills before variable text and hashes the effective reusable bytes", async () => {
		const { buildSkillsSystemBlock, listAvailableSkills } = await import(
			"@repo/ai/skills"
		);
		vi.mocked(listAvailableSkills).mockResolvedValue([
			{ name: "example-skill" },
		] as never);
		vi.mocked(buildSkillsSystemBlock).mockReturnValue("Example skills");
		const input = buildInput({
			systemPromptParts: {
				reusable: "Reusable instructions",
				variable: "Variable memory",
			},
		});
		const result = await runAgentIteration(input);
		expect(
			stubs.streamTextMock.mock.calls[0][0].instructions[0].content,
		).toBe("Reusable instructions\n\nExample skills");
		expect(result.reusableSystemHash).toBe(
			createHash("sha256")
				.update("Reusable instructions\n\nExample skills")
				.digest("hex")
				.slice(0, 16),
		);
		vi.mocked(buildSkillsSystemBlock).mockReturnValue("");
		vi.mocked(listAvailableSkills).mockResolvedValue([]);
	});
	it.each([
		"OPENAI_DIRECT",
		"CHATGPT_PLAN",
		"DATABRICKS",
		"AZURE_AI_FOUNDRY",
	])("orders the split text for %s", async (provider) => {
		vi.mocked(getAiModelWithSelection).mockResolvedValueOnce({
			model: { __mockModel: true, modelId: "example-model" },
			provider,
			modelString: "example-model",
		} as never);
		const call = await streamCallFor(
			buildInput({
				systemPromptParts: {
					reusable: "Reusable instructions",
					variable: "Variable memory",
				},
			}),
		);
		expect(call.instructions).toEqual([
			{ role: "system", content: "Reusable instructions" },
			{ role: "system", content: "Variable memory" },
		]);
	});
});

it("keeps a full legacy request when an older activity ignores the new field", async () => {
	const input = buildInput({
		systemPrompt: "Example persona\n\nExample memory\n\nExample loop tail",
		systemPromptParts: {
			reusable: "Example persona\n\nExample loop tail",
			variable: "Example memory",
		},
	});
	const { systemPromptParts: _ignored, ...oldInput } = input;
	const legacy = await streamCallFor(oldInput);
	expect(legacy.instructions).toEqual({
		role: "system",
		content: input.systemPrompt,
		providerOptions: CACHE_BREAKPOINT,
	});
});
