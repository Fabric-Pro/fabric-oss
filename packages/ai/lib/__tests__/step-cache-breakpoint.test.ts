/**
 * Unit tests for the rolling Anthropic cache breakpoint that an AI SDK
 * multi-step call runs as its `prepareStep` (Fizzy #3094, #3098, #3099).
 *
 * Run with: pnpm --filter @repo/ai exec vitest run lib/__tests__/step-cache-breakpoint.test.ts
 */

import {
	generateText,
	isStepCount,
	jsonSchema,
	type ModelMessage,
	tool,
} from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import {
	makeAppendedStepCacheBreakpoint,
	makeStepCacheBreakpoint,
	withStepCacheBreakpoint,
} from "../prompt-cache";

const BREAKPOINT = { anthropic: { cacheControl: { type: "ephemeral" } } };

const ANTHROPIC = {
	provider: "ANTHROPIC_DIRECT",
	modelString: "claude-haiku-5-5",
	hasTools: true,
};

function toolResult(id: string, chars: number): ModelMessage {
	return {
		role: "tool",
		content: [
			{
				type: "tool-result",
				toolCallId: id,
				toolName: "project_rag_query",
				output: { type: "text", value: "x".repeat(chars) },
			},
		],
	};
}

function toolCall(id: string): ModelMessage {
	return {
		role: "assistant",
		content: [
			{
				type: "tool-call",
				toolCallId: id,
				toolName: "project_rag_query",
				input: {},
			},
		],
	};
}

function signedReasoningCall(id: string): ModelMessage {
	return {
		role: "assistant",
		content: [
			{
				type: "reasoning",
				text: "thinking",
				providerOptions: { anthropic: { signature: `sig-${id}` } },
			},
			{
				type: "tool-call",
				toolCallId: id,
				toolName: "project_rag_query",
				input: {},
			},
		],
	};
}

function stripMarker(message: ModelMessage): ModelMessage {
	if (!message.providerOptions) {
		return message;
	}
	const { providerOptions: _marker, ...rest } = message;
	return rest as ModelMessage;
}

function breakpointIndexes(
	messages: ReadonlyArray<{
		providerOptions?: { anthropic?: { cacheControl?: unknown } };
	}>,
): number[] {
	return messages.flatMap((m, i) =>
		m.providerOptions?.anthropic?.cacheControl ? [i] : [],
	);
}

describe("withStepCacheBreakpoint", () => {
	it("marks the last message of the first step", () => {
		const prepare = withStepCacheBreakpoint(() => ({}));
		const { messages } = prepare({
			messages: [{ role: "user", content: "do the step" }],
		});
		expect(messages[0].providerOptions).toEqual(BREAKPOINT);
	});

	it("keeps exactly one breakpoint, on the last message, as steps carry forward", () => {
		const prepare = withStepCacheBreakpoint(() => ({}));
		// The SDK builds the next step from the returned array plus that
		// step's response messages, so feed each result back in.
		const unmarked: ModelMessage[] = [
			{ role: "user", content: "do the step" },
		];
		let messages: ModelMessage[] = [...unmarked];
		for (let step = 1; step <= 6; step++) {
			messages = prepare({ messages }).messages;
			expect(breakpointIndexes(messages)).toEqual([messages.length - 1]);
			// Apart from the marker, the history goes out unchanged.
			expect(messages.map(stripMarker)).toEqual(unmarked);
			const round = [
				signedReasoningCall(`c${step}`),
				toolResult(`c${step}`, 100),
			];
			unmarked.push(...round);
			messages = [...messages, ...round];
		}
	});

	it("keeps other provider options when it moves the breakpoint", () => {
		const prepare = withStepCacheBreakpoint(() => ({}));
		const { messages } = prepare({
			messages: [
				{
					role: "user",
					content: "do the step",
					providerOptions: {
						anthropic: {
							cacheControl: { type: "ephemeral" },
							other: 1,
						},
						openai: { store: false },
					},
				},
				toolCall("c1"),
			],
		});
		expect(messages[0].providerOptions).toEqual({
			anthropic: { other: 1 },
			openai: { store: false },
		});
		expect(breakpointIndexes(messages)).toEqual([1]);
	});

	it("keeps the last message's other provider options when it marks it", () => {
		const prepare = withStepCacheBreakpoint(() => ({}));
		const { messages } = prepare({
			messages: [
				{
					role: "user",
					content: "do the step",
					providerOptions: {
						anthropic: { other: 1 },
						openai: { store: false },
					},
				},
			],
		});
		expect(messages[0].providerOptions).toEqual({
			anthropic: { other: 1, cacheControl: { type: "ephemeral" } },
			openai: { store: false },
		});
	});

	it("does not mutate the messages it receives", () => {
		const prepare = withStepCacheBreakpoint(() => ({}));
		const input: ModelMessage[] = [
			{ role: "user", content: "do the step" },
		];
		prepare({ messages: input });
		expect(input[0].providerOptions).toBeUndefined();
	});
});

describe("makeStepCacheBreakpoint", () => {
	it("puts one marker on the last message on Anthropic with tools", () => {
		const prepare = makeStepCacheBreakpoint(ANTHROPIC);
		const messages = [
			{ role: "user", content: "go" },
			toolCall("a"),
			toolResult("a", 10),
		] as ModelMessage[];
		const out = prepare?.({ messages }).messages ?? [];
		expect(out.at(-1)?.providerOptions).toEqual(BREAKPOINT);
		expect(out.filter((m) => m.providerOptions !== undefined)).toHaveLength(
			1,
		);
	});

	it("returns undefined without tools", () => {
		expect(
			makeStepCacheBreakpoint({ ...ANTHROPIC, hasTools: false }),
		).toBeUndefined();
	});

	it.each([
		["OPENAI", "gpt-6.1"],
		["AWS_BEDROCK", "anthropic.claude-sonnet-5-5"],
		["VERCEL_GATEWAY", "openai/gpt-6.1"],
	])(
		"returns undefined for %s %s, which does not take the marker",
		(provider, modelString) => {
			expect(
				makeStepCacheBreakpoint({
					provider,
					modelString,
					hasTools: true,
				}),
			).toBeUndefined();
		},
	);

	it("leaves large tool results byte-identical (no compaction)", () => {
		const messages = [
			{ role: "user", content: "go" },
			toolCall("a"),
			toolResult("a", 210_000),
			toolCall("b"),
			toolResult("b", 210_000),
		] as ModelMessage[];
		const out =
			makeStepCacheBreakpoint(ANTHROPIC)?.({ messages }).messages ?? [];
		expect(out).toHaveLength(messages.length);
		out.forEach((m, i) => {
			const { providerOptions: _p, ...rest } = m as ModelMessage & {
				providerOptions?: unknown;
			};
			expect(rest).toEqual(messages[i]);
		});
		expect(out.at(-1)?.providerOptions).toEqual(BREAKPOINT);
	});
});

describe("makeAppendedStepCacheBreakpoint", () => {
	/**
	 * The shape direct chat sends on its rolling-history path: a marked last
	 * history message, then the current turn and a variable system row.
	 */
	function callerMessages(): ModelMessage[] {
		return [
			{ role: "user", content: "earlier question" },
			{
				role: "assistant",
				content: "earlier answer",
				providerOptions: BREAKPOINT,
			},
			{ role: "user", content: "current question" },
			{ role: "system", content: "variable context" },
		];
	}

	function prepare() {
		const prepareStep = makeAppendedStepCacheBreakpoint(ANTHROPIC);
		if (!prepareStep) {
			throw new Error("expected a prepareStep for Anthropic with tools");
		}
		return prepareStep;
	}

	it("adds no marker on the first step, whose last message the caller sent", () => {
		const initialMessages = callerMessages();
		const { messages } = prepare()({
			messages: [...initialMessages],
			initialMessages,
		});
		expect(breakpointIndexes(messages)).toEqual([1]);
		messages.forEach((message, index) => {
			expect(message).toBe(initialMessages[index]);
		});
	});

	it("keeps the caller's marker and rolls exactly one more over the added rounds", () => {
		const prepareStep = prepare();
		const initialMessages = callerMessages();
		let messages: ModelMessage[] = [...initialMessages];
		for (let step = 1; step <= 6; step++) {
			messages = prepareStep({ messages, initialMessages }).messages;
			// The caller's messages go out exactly as sent, marker included.
			messages.slice(0, initialMessages.length).forEach((m, i) => {
				expect(m).toBe(initialMessages[i]);
			});
			expect(breakpointIndexes(messages)).toEqual(
				step === 1 ? [1] : [1, messages.length - 1],
			);
			// The SDK carries the returned array forward and appends the
			// step's response messages, so feed each result back in.
			messages = [
				...messages,
				signedReasoningCall(`c${step}`),
				toolResult(`c${step}`, 100),
			];
		}
	});

	it("leaves every caller marker in place, including one on the last caller message", () => {
		const prepareStep = prepare();
		const initialMessages: ModelMessage[] = [
			{ role: "user", content: "first", providerOptions: BREAKPOINT },
			{
				role: "assistant",
				content: "second",
				providerOptions: BREAKPOINT,
			},
			{ role: "user", content: "current", providerOptions: BREAKPOINT },
		];
		const first = prepareStep({
			messages: [...initialMessages],
			initialMessages,
		}).messages;
		expect(breakpointIndexes(first)).toEqual([0, 1, 2]);

		const second = prepareStep({
			messages: [...first, toolCall("a"), toolResult("a", 10)],
			initialMessages,
		}).messages;
		expect(breakpointIndexes(second)).toEqual([0, 1, 2, 4]);
	});

	it("keeps an added message's other provider options when it moves the marker off it", () => {
		const prepareStep = prepare();
		const initialMessages: ModelMessage[] = [
			{ role: "user", content: "go" },
		];
		const signed = {
			...toolResult("a", 10),
			providerOptions: {
				anthropic: { cacheControl: { type: "ephemeral" }, other: 1 },
			},
		} as ModelMessage;
		const { messages } = prepareStep({
			messages: [
				...initialMessages,
				toolCall("a"),
				signed,
				toolCall("b"),
			],
			initialMessages,
		});
		expect(messages[2].providerOptions).toEqual({
			anthropic: { other: 1 },
		});
		expect(breakpointIndexes(messages)).toEqual([3]);
	});

	it("does not mutate the messages it receives", () => {
		const initialMessages = callerMessages();
		const added = toolResult("a", 10);
		prepare()({
			messages: [...initialMessages, toolCall("a"), added],
			initialMessages,
		});
		expect(added.providerOptions).toBeUndefined();
	});

	it("returns undefined without tools", () => {
		expect(
			makeAppendedStepCacheBreakpoint({ ...ANTHROPIC, hasTools: false }),
		).toBeUndefined();
	});

	it.each([
		["OPENAI", "gpt-6.1"],
		["AWS_BEDROCK", "anthropic.claude-sonnet-5-5"],
		["VERCEL_GATEWAY", "openai/gpt-6.1"],
	])(
		"returns undefined for %s %s, which does not take the marker",
		(provider, modelString) => {
			expect(
				makeAppendedStepCacheBreakpoint({
					provider,
					modelString,
					hasTools: true,
				}),
			).toBeUndefined();
		},
	);

	it("marks the requests a real generateText tool loop sends", async () => {
		const USAGE = {
			inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
			outputTokens: { total: 1, text: 1, reasoning: 0 },
		};
		let calls = 0;
		const model = new MockLanguageModelV4({
			doGenerate: async () => {
				calls += 1;
				return calls < 3
					? {
							content: [
								{
									type: "tool-call" as const,
									toolCallId: `c${calls}`,
									toolName: "lookup",
									input: "{}",
								},
							],
							finishReason: {
								unified: "tool-calls" as const,
								raw: undefined,
							},
							usage: USAGE,
							warnings: [],
						}
					: {
							content: [{ type: "text" as const, text: "done" }],
							finishReason: {
								unified: "stop" as const,
								raw: undefined,
							},
							usage: USAGE,
							warnings: [],
						};
			},
		});

		await generateText({
			model,
			instructions: "stable instructions",
			messages: callerMessages(),
			allowSystemInMessages: true,
			tools: {
				lookup: tool({
					inputSchema: jsonSchema({ type: "object", properties: {} }),
					execute: async () => "found",
				}),
			},
			stopWhen: isStepCount(5),
			prepareStep: prepare(),
		});

		const prompts = model.doGenerateCalls.map((call) => call.prompt);
		expect(prompts).toHaveLength(3);
		// The history marker the caller placed is on every request.
		for (const prompt of prompts) {
			const marked = prompt.find(
				(message) =>
					message.role === "assistant" &&
					message.content.some(
						(part) =>
							part.type === "text" &&
							part.text === "earlier answer",
					),
			);
			expect(marked?.providerOptions).toEqual(BREAKPOINT);
		}
		// Step 1 adds nothing; each later step adds one marker on its last
		// message, and the previous step's marker is gone.
		const historyIndex = 2; // after the instructions row and "earlier question"
		expect(breakpointIndexes(prompts[0])).toEqual([historyIndex]);
		expect(breakpointIndexes(prompts[1])).toEqual([
			historyIndex,
			prompts[1].length - 1,
		]);
		expect(breakpointIndexes(prompts[2])).toEqual([
			historyIndex,
			prompts[2].length - 1,
		]);
		expect(prompts[2].at(-1)?.role).toBe("tool");
	});
});
