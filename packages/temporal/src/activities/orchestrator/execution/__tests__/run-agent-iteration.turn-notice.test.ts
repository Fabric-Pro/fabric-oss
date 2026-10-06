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
		},
		{
			role: "tool",
			content: JSON.stringify({ messages: [] }),
			toolCallId: "call-1",
			timestamp: "2026-10-05T00:00:02Z",
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
	instructions: string;
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
		expect(call.instructions).toBe("You are the project Advisor.");
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
