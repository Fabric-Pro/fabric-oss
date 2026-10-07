/**
 * runAgentIteration — the debug dumps print a conversation's shape, not its
 * text.
 *
 * The iteration logs the last messages it sends and the tool calls it
 * returns. Company context can sit anywhere in a conversation: a search's
 * query and result, another tool's arguments, or an earlier answer that a
 * follow-up turn carries as plain text. So the dumps keep roles, part types,
 * tool names, argument counts and sizes, while the model still receives
 * everything unchanged.
 *
 * Mock set mirrors `run-agent-iteration.dropped-tool-call.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const aiStubs = vi.hoisted(() => ({
	streamTextMock: vi.fn(),
}));

vi.mock("@repo/ai", () => ({
	streamText: aiStubs.streamTextMock,
	tool: vi.fn((definition: { description?: string }) => ({
		__isAiSdkTool: true,
		description: definition?.description,
	})),
	jsonSchema: vi.fn((schema: unknown) => ({ __isJsonSchema: true, schema })),
	isStepCount: vi.fn((n: number) => ({ __stopWhen: "stepCount", n })),
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
		model: { __mockModel: true },
		provider: "ANTHROPIC_DIRECT",
		modelString: "claude-sonnet-5",
		canonicalName: "claude-sonnet-5",
	})),
}));

import {
	messagesForLog,
	type RunAgentIterationInput,
	runAgentIteration,
	toolCallsForLog,
} from "../run-agent-iteration";

const PASSAGE = "Synthetic passage about the example organization's pricing";
const EARLIER_QUERY = "earlier query about example pricing";
const NEW_QUERY = "follow-up query about example case studies";
const OTHER_TOOL_TEXT = "Synthetic view created for example-org";
const QUESTION = "And what about support?";
const EARLIER_ANSWER = `Per the pricing deck: ${PASSAGE}.`;
const VIEW_TITLE = "Pricing view quoting the deck";

function makeStreamResult(
	parts: Array<Record<string, unknown>>,
	finishReason = "tool-calls",
) {
	return {
		stream: (async function* () {
			for (const part of parts) {
				yield part;
			}
		})(),
		usage: Promise.resolve({ inputTokens: 10, outputTokens: 5 }),
		finishReason: Promise.resolve(finishReason),
	};
}

type History = RunAgentIterationInput["conversationHistory"];

/** A follow-up turn: the earlier answer quotes the passage as plain text. */
const FOLLOW_UP_HISTORY: History = [
	{
		role: "user",
		content: "What does the example organization charge?",
		timestamp: "2026-10-04T23:58:00.000Z",
	},
	{
		role: "assistant",
		content: EARLIER_ANSWER,
		timestamp: "2026-10-04T23:59:00.000Z",
	},
	{
		role: "user",
		content: QUESTION,
		timestamp: "2026-10-05T00:00:00.000Z",
	},
];

/** A turn that searched: the call's query and both tools' results. */
const SEARCHED_HISTORY: History = [
	{
		role: "user",
		content: QUESTION,
		timestamp: "2026-10-05T00:00:00.000Z",
	},
	{
		role: "assistant",
		content: "",
		toolCalls: [
			{
				id: "tc-company",
				name: "search_company_context",
				args: { query: EARLIER_QUERY },
			},
			{ id: "tc-view", name: "create_view", args: { title: "Plan" } },
		],
		timestamp: "2026-10-05T00:00:01.000Z",
	},
	{
		role: "tool",
		toolCallId: "tc-company",
		content: JSON.stringify({
			sources: ["Pricing deck"],
			context: PASSAGE,
		}),
		timestamp: "2026-10-05T00:00:02.000Z",
	},
	{
		role: "tool",
		toolCallId: "tc-view",
		content: JSON.stringify({ result: OTHER_TOOL_TEXT }),
		timestamp: "2026-10-05T00:00:03.000Z",
	},
];

function buildInput(conversationHistory: History): RunAgentIterationInput {
	return {
		conversationHistory,
		availableTools: {
			create_view: {
				description: "Create an Excalidraw view.",
				inputSchema: { type: "object", properties: {} },
			},
			search_company_context: {
				description: "Search the organization's company context.",
				inputSchema: { type: "object", properties: {} },
			},
		},
		systemPrompt: "You are a helpful agent.",
		userId: "user-1",
		organizationId: "org-1",
		executionId: "exec-1",
		iteration: 2,
	};
}

/** Everything the iteration wrote to the console, as one string. */
function consoleOutput(spies: ReturnType<typeof vi.spyOn>[]): string {
	return spies
		.flatMap((spy) => spy.mock.calls.flat())
		.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg)))
		.join("\n");
}

let consoleSpies: ReturnType<typeof vi.spyOn>[] = [];

beforeEach(() => {
	vi.clearAllMocks();
	consoleSpies = [
		vi.spyOn(console, "log").mockImplementation(() => {}),
		vi.spyOn(console, "warn").mockImplementation(() => {}),
		vi.spyOn(console, "error").mockImplementation(() => {}),
	];
});

afterEach(() => {
	for (const spy of consoleSpies) {
		spy.mockRestore();
	}
});

describe("runAgentIteration — the debug dumps", () => {
	it("print no earlier answer on a follow-up turn, while the model still gets it", async () => {
		aiStubs.streamTextMock.mockImplementationOnce(() =>
			makeStreamResult(
				[{ type: "text-delta", text: "Support is included." }],
				"stop",
			),
		);

		const result = await runAgentIteration(buildInput(FOLLOW_UP_HISTORY));

		expect(result.type).toBe("response");
		const logged = consoleOutput(consoleSpies);
		expect(logged).not.toContain(PASSAGE);
		expect(logged).not.toContain(QUESTION);
		expect(logged).toContain('"role": "assistant"');

		const sentToModel = JSON.stringify(
			aiStubs.streamTextMock.mock.calls[0][0].messages,
		);
		expect(sentToModel).toContain(PASSAGE);
		expect(sentToModel).toContain(QUESTION);
	});

	it("print no query, result or argument of any tool, while the model still gets them all", async () => {
		aiStubs.streamTextMock.mockImplementationOnce(() =>
			makeStreamResult([
				{
					type: "tool-call",
					toolCallId: "tc-next",
					toolName: "search_company_context",
					input: { query: NEW_QUERY },
				},
				{
					type: "tool-call",
					toolCallId: "tc-view-2",
					toolName: "create_view",
					input: { title: VIEW_TITLE },
				},
			]),
		);

		const result = await runAgentIteration(buildInput(SEARCHED_HISTORY));

		expect(result.type).toBe("tool_calls");
		if (result.type === "tool_calls") {
			expect(result.toolCalls.map((call) => call.args)).toEqual([
				{ query: NEW_QUERY },
				{ title: VIEW_TITLE },
			]);
		}

		const logged = consoleOutput(consoleSpies);
		for (const text of [
			PASSAGE,
			QUESTION,
			EARLIER_QUERY,
			NEW_QUERY,
			OTHER_TOOL_TEXT,
			VIEW_TITLE,
		]) {
			expect(logged).not.toContain(text);
		}
		// The dumps still say what happened.
		expect(logged).toContain('"toolName": "search_company_context"');
		expect(logged).toContain('"name": "create_view"');
		expect(logged).toContain('"argCount": 1');

		const sentToModel = JSON.stringify(
			aiStubs.streamTextMock.mock.calls[0][0].messages,
		);
		for (const text of [
			PASSAGE,
			QUESTION,
			EARLIER_QUERY,
			OTHER_TOOL_TEXT,
		]) {
			expect(sentToModel).toContain(text);
		}
	});
});

describe("messagesForLog", () => {
	it("keeps a text message's role and size", () => {
		expect(
			messagesForLog([{ role: "assistant", content: EARLIER_ANSWER }]),
		).toEqual([{ role: "assistant", chars: EARLIER_ANSWER.length }]);
	});

	it("keeps each part's type, tool name and size", () => {
		const textPart = { type: "text", text: "Looking it up." };
		const callPart = {
			type: "tool-call",
			toolCallId: "tc-company",
			toolName: "search_company_context",
			input: { query: EARLIER_QUERY },
		};

		expect(
			messagesForLog([
				{ role: "assistant", content: [textPart, callPart] },
			]),
		).toEqual([
			{
				role: "assistant",
				parts: [
					{ type: "text", chars: JSON.stringify(textPart).length },
					{
						type: "tool-call",
						toolName: "search_company_context",
						chars: JSON.stringify(callPart).length,
					},
				],
			},
		]);
	});
});

describe("toolCallsForLog", () => {
	it("keeps each call's id, name, argument count and size", () => {
		const args = { query: NEW_QUERY };

		expect(
			toolCallsForLog([
				{ id: "tc-company", name: "search_company_context", args },
			]),
		).toEqual([
			{
				id: "tc-company",
				name: "search_company_context",
				argCount: 1,
				argsChars: JSON.stringify(args).length,
			},
		]);
	});

	it("prints no argument name, since the model writes those too", () => {
		const logged = JSON.stringify(
			toolCallsForLog([
				{
					id: "tc-company",
					name: "search_company_context",
					args: { query: NEW_QUERY, [PASSAGE]: true },
				},
			]),
		);

		expect(logged).not.toContain(PASSAGE);
		expect(logged).not.toContain("query");
	});
});
