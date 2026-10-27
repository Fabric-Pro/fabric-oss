import {
	type DispatchBudget,
	type DispatchGuard,
	runWithDispatchGuard,
} from "@repo/utils/dispatch-guard";
import {
	generateText,
	isStepCount,
	streamText,
	tool,
	wrapLanguageModel,
} from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { wrapModelWithDispatchGuard } from "../lib/dispatch-guard-middleware";
import {
	createRequestObservationMiddleware,
	observeModelRequests,
} from "../lib/request-observation";
import { createTextToolCallRecoveryMiddleware } from "../lib/text-tool-call-middleware";
import { wrapModelWithTurnBudget } from "../lib/turn-budget-middleware";
import { createUsageLoggingMiddleware } from "../lib/usage-logging-middleware";

const { logAiUsageAsync, info } = vi.hoisted(() => ({
	logAiUsageAsync: vi.fn(),
	info: vi.fn(),
}));
vi.mock("@repo/database", () => ({ logAiUsageAsync }));
vi.mock("@repo/logs", () => ({
	logger: { info, warn: vi.fn(), error: vi.fn() },
}));

type Params = Parameters<MockLanguageModelV4["doGenerate"]>[0];
type Part = Awaited<
	ReturnType<MockLanguageModelV4["doStream"]>
>["stream"] extends ReadableStream<infer P>
	? P
	: never;
const prose =
	"I will fetch the recently updated features.\n\nFirst, I will fetch F-019.\n\n";
const call =
	'<function=fabric_get_project_feature>{ "feature": "F-019" }</function>';
const offered: Params["tools"] = [
	{
		type: "function",
		name: "fabric_get_project_feature",
		inputSchema: { type: "object" },
	},
];
const params: Params = {
	prompt: [],
	tools: offered,
	toolChoice: { type: "auto" },
};
const usage = {
	inputTokens: { total: 100, noCache: 25, cacheRead: 60, cacheWrite: 15 },
	outputTokens: { total: 30, text: 20, reasoning: 10 },
};
const finish: Part = {
	type: "finish",
	finishReason: { unified: "stop", raw: "stop" },
	usage,
	providerMetadata: { example: { marker: true } },
};
const native = {
	type: "tool-call" as const,
	toolCallId: "native",
	toolName: "fabric_get_project_feature",
	input: '{"feature":"F-020"}',
};
const tools = {
	fabric_get_project_feature: tool({
		inputSchema: z.object({ feature: z.string() }),
	}),
};
function streamParts(chunks: Part[]): ReadableStream<Part> {
	return simulateReadableStream({ chunks });
}
function parts(text: string): Part[] {
	return [
		{ type: "text-start", id: "t" },
		...Array.from(text, (delta) => ({
			type: "text-delta" as const,
			id: "t",
			delta,
		})),
		{ type: "text-end", id: "t" },
		finish,
	];
}
function base(text: string, extra: Part[] = []) {
	return new MockLanguageModelV4({
		modelId: "example-model",
		doGenerate: async () => ({
			content: [
				{ type: "text", text },
				...extra.filter((p) => p.type === "tool-call"),
			],
			finishReason: { unified: "stop", raw: "stop" },
			usage,
			warnings: [],
			request: { body: "example-request" },
			providerMetadata: { example: { marker: true } },
		}),
		doStream: async () => ({
			stream: streamParts([
				...parts(text).slice(0, -1),
				...extra,
				finish,
			]),
			request: { body: "example-request" },
		}),
	});
}
function recovered(model: MockLanguageModelV4) {
	return wrapLanguageModel({
		model,
		middleware: createTextToolCallRecoveryMiddleware(),
	});
}
async function collect(model: ReturnType<typeof recovered>, options = params) {
	const result = await model.doStream(options);
	const out: Part[] = [];
	for await (const part of result.stream) {
		out.push(part);
	}
	return out;
}
function textOf(out: Part[]) {
	return out
		.filter((p) => p.type === "text-delta")
		.map((p) => p.delta)
		.join("");
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("text tool call recovery", () => {
	it.each([1, 2])(
		"generate recovers %i calls in order and preserves prose and accounting",
		async (count) => {
			const model = base(
				prose +
					call +
					(count === 2 ? call.replace("F-019", "F-020") : ""),
			);
			const result = await recovered(model).doGenerate(params);
			expect(
				result.content
					.filter((p) => p.type === "text")
					.map((p) => p.text)
					.join(""),
			).toBe(prose);
			const calls = result.content.filter((p) => p.type === "tool-call");
			expect(calls.map((p) => [p.toolName, JSON.parse(p.input)])).toEqual(
				Array.from({ length: count }, (_, i) => [
					"fabric_get_project_feature",
					{ feature: `F-0${19 + i}` },
				]),
			);
			expect(new Set(calls.map((p) => p.toolCallId)).size).toBe(count);
			expect(result.finishReason).toEqual({
				unified: "tool-calls",
				raw: "stop",
			});
			expect(result.usage).toBe(usage);
			expect(result.request).toEqual({ body: "example-request" });
			expect(result.providerMetadata).toEqual({
				example: { marker: true },
			});
			expect(info).toHaveBeenCalledTimes(count);
			for (const [event, fields] of info.mock.calls) {
				expect(event).toBe("ai.text_tool_call.recovered");
				expect(fields).toEqual({
					toolName: "fabric_get_project_feature",
					modelId: "example-model",
					count,
					droppedCharacters: 0,
				});
			}
			expect(model.doGenerateCalls[0]).toEqual(params);
		},
	);

	const negative = [
		[
			"unknown name",
			call.replace("fabric_get_project_feature", "unknown"),
			params,
			[],
		],
		[
			"invalid JSON",
			"<function=fabric_get_project_feature>{bad}</function>",
			params,
			[],
		],
		[
			"array",
			"<function=fabric_get_project_feature>[]</function>",
			params,
			[],
		],
		[
			"null",
			"<function=fabric_get_project_feature>null</function>",
			params,
			[],
		],
		[
			"tool choice none",
			call,
			{ ...params, toolChoice: { type: "none" } },
			[],
		],
		["no tools", call, { prompt: [] }, []],
		["empty tools", call, { ...params, tools: [] }, []],
		["native call", call, params, [native]],
		[
			"ordinary prose",
			"An example <function=not_offered>{}</function> is text.",
			params,
			[],
		],
		["case mismatch", call.replace("fabric_get", "FABRIC_get"), params, []],
	] as const;
	it.each(negative)(
		"generate leaves %s unchanged",
		async (_name, text, options, extra) => {
			const model = base(text, [...extra]);
			const original = await model.doGenerate(options as Params);
			const result = await recovered(model).doGenerate(options as Params);
			expect(result).toEqual(original);
			expect(info).not.toHaveBeenCalled();
		},
	);
	it.each(negative)(
		"stream leaves %s unchanged across character deltas",
		async (_name, text, options, extra) => {
			const out = await collect(
				recovered(base(text, [...extra])),
				options as Params,
			);
			expect(textOf(out)).toBe(text);
			expect(out.filter((p) => p.type === "tool-call")).toEqual(extra);
			expect(out.at(-1)).toEqual(finish);
			expect(info).not.toHaveBeenCalled();
		},
	);
	it.each([1, 2])(
		"stream recovers %i calls across split tags and JSON",
		async (count) => {
			const out = await collect(
				recovered(
					base(
						prose +
							call +
							(count === 2 ? call.replace("F-019", "F-020") : ""),
					),
				),
			);
			expect(textOf(out)).toBe(prose);
			const calls = out.filter((p) => p.type === "tool-call");
			expect(calls).toHaveLength(count);
			expect(calls.map((p) => [p.toolName, JSON.parse(p.input)])).toEqual(
				Array.from({ length: count }, (_, i) => [
					"fabric_get_project_feature",
					{ feature: `F-0${19 + i}` },
				]),
			);
			expect(new Set(calls.map((p) => p.toolCallId)).size).toBe(count);
			expect(
				out.filter((p) => p.type === "tool-input-start"),
			).toHaveLength(count);
			expect(out.filter((p) => p.type === "tool-input-end")).toHaveLength(
				count,
			);
			expect(out.at(-1)).toEqual({
				...finish,
				finishReason: { unified: "tool-calls", raw: "stop" },
			});
			expect(info).toHaveBeenCalledTimes(count);
		},
	);
	it.each([
		"<",
		"<func",
		"<function=",
		'<function=fabric_get_project_feature>{"feature":',
	])("flushes an incomplete pattern %s", async (suffix) => {
		const out = await collect(recovered(base(prose + suffix)));
		expect(textOf(out)).toBe(prose + suffix);
		expect(out.filter((p) => p.type === "tool-call")).toEqual([]);
	});
	it("forwards plain deltas before reading the next delta", async () => {
		let reads = 0;
		const model = recovered(
			new MockLanguageModelV4({
				doStream: async () => ({
					stream: new ReadableStream<Part>(
						{
							pull(c) {
								reads++;
								if (reads <= 3) {
									c.enqueue({
										type: "text-delta",
										id: "t",
										delta: `plain ${reads}`,
									});
								} else {
									c.close();
								}
							},
						},
						{ highWaterMark: 0 },
					),
				}),
			}),
		);
		const reader = (await model.doStream(params)).stream.getReader();
		for (let i = 1; i <= 3; i++) {
			expect((await reader.read()).value).toEqual({
				type: "text-delta",
				id: "t",
				delta: `plain ${i}`,
			});
			await Promise.resolve();
			expect(reads).toBe(i);
		}
		await reader.cancel();
	});
	it("releases a rejected prefix before reading more text", async () => {
		let reads = 0;
		const model = recovered(
			new MockLanguageModelV4({
				doStream: async () => ({
					stream: new ReadableStream<Part>(
						{
							pull(c) {
								const deltas = [
									"<func",
									"tion=unknown>",
									"tail",
								];
								c.enqueue({
									type: "text-delta",
									id: "t",
									delta: deltas[reads++],
								});
							},
						},
						{ highWaterMark: 0 },
					),
				}),
			}),
		);
		const reader = (await model.doStream(params)).stream.getReader();
		let text = "";
		while (text.length < "<function=unknown>".length) {
			text += ((await reader.read()).value as { delta: string }).delta;
		}
		expect(text).toBe("<function=unknown>");
		expect(reads).toBe(2);
		await reader.cancel();
	});
	it("keeps a native call arriving after a recoverable call authoritative", async () => {
		const text = `${prose}${call}\nInvented tool output.`;
		const out = await collect(recovered(base(text, [native])));
		expect(textOf(out)).toBe(text);
		expect(out.filter((p) => p.type === "tool-call")).toEqual([native]);
		expect(info).not.toHaveBeenCalled();
	});

	it.each(["generate", "stream"])(
		"%s usage logging keeps token and cache counts",
		async (mode) => {
			for (const repair of [false, true]) {
				const model = wrapLanguageModel({
					model: repair ? recovered(base(call)) : base(call),
					middleware: createUsageLoggingMiddleware({
						userId: "example-user",
						organizationId: "example-org",
						provider: "OPENAI_DIRECT",
						providerModelId: "example-model",
						taskType: "COMPLEX",
					}),
				});
				if (mode === "generate") {
					await generateText({ model, prompt: "go", tools });
				} else {
					const result = streamText({ model, prompt: "go", tools });
					for await (const _ of result.stream) {
						/* drain */
					}
				}
			}
			expect(logAiUsageAsync).toHaveBeenCalledTimes(2);
			for (const [row] of logAiUsageAsync.mock.calls) {
				expect(row).toMatchObject({
					inputTokens: 100,
					outputTokens: 30,
					totalTokens: 130,
					cachedInputTokens: 60,
					cacheCreationInputTokens: 15,
					reasoningTokens: 10,
				});
			}
		},
	);
});

it("releases rejected text before another partial candidate in the same delta", async () => {
	let reads = 0;
	const model = recovered(
		new MockLanguageModelV4({
			doStream: async () => ({
				stream: new ReadableStream<Part>(
					{
						pull(c) {
							const deltas = [
								"<wrong> safe <func",
								"tion=fabric_get_project_feature>{}</function>",
							];
							if (reads === deltas.length) {
								c.close();
								return;
							}
							c.enqueue({
								type: "text-delta",
								id: "t",
								delta: deltas[reads++],
							});
						},
					},
					{ highWaterMark: 0 },
				),
			}),
		}),
	);
	const reader = (await model.doStream(params)).stream.getReader();
	expect((await reader.read()).value).toEqual({
		type: "text-delta",
		id: "t",
		delta: "<wrong> safe ",
	});
	expect(reads).toBe(1);
	await reader.cancel();
});

it("flushes an incomplete pattern when the source closes without finish", async () => {
	const model = recovered(
		new MockLanguageModelV4({
			doStream: async () => ({
				stream: streamParts([
					{
						type: "text-delta" as const,
						id: "t",
						delta: "before <function=",
					},
				]),
			}),
		}),
	);
	expect(textOf(await collect(model))).toBe("before <function=");
});

it.each(["generate", "stream"])(
	"%s parses nested objects, escaped strings and closing-tag literals inside JSON",
	async (mode) => {
		const input = {
			feature: 'F-019 </function> " example',
			nested: { array: [1, { enabled: true }] },
		};
		const model = recovered(
			base(
				`before <function=fabric_get_project_feature> \n${JSON.stringify(input)} \t</function> after`,
			),
		);
		if (mode === "generate") {
			const result = await model.doGenerate(params);
			expect(
				result.content
					.filter((p) => p.type === "text")
					.map((p) => p.text)
					.join(""),
			).toBe("before ");
			expect(
				result.content
					.filter((p) => p.type === "tool-call")
					.map((p) => JSON.parse(p.input)),
			).toEqual([input]);
		} else {
			const out = await collect(model);
			expect(textOf(out)).toBe("before ");
			expect(
				out
					.filter((p) => p.type === "tool-call")
					.map((p) => JSON.parse(p.input)),
			).toEqual([input]);
		}
	},
);

it.each(["generate", "stream"])(
	"%s recovery keeps the ledger and request observations unchanged",
	async (mode) => {
		const snapshots = [];
		for (const repair of [false, true]) {
			const reserve = vi.fn<DispatchBudget["reserve"]>(async () => ({
				attemptId: "example-attempt",
				outputCap: 100,
			}));
			const settle = vi.fn<DispatchBudget["settle"]>(async () => {});
			const budget: DispatchBudget = {
				reserve,
				settle,
				markUnknown: vi.fn(),
				release: vi.fn(),
			};
			const guard: DispatchGuard = {
				key: "example-turn",
				assertDispatchable: async () => {},
				abortSignal: () => undefined,
				rethrowIfStopped: () => {},
				budget,
			};
			const provider = base(prose + call);
			const observed = wrapLanguageModel({
				model: provider,
				middleware: createRequestObservationMiddleware("example"),
			});
			const model = wrapModelWithDispatchGuard(
				wrapModelWithTurnBudget(
					repair
						? wrapLanguageModel({
								model: observed,
								middleware:
									createTextToolCallRecoveryMiddleware(),
							})
						: observed,
					{ enforcesOutputCap: true },
				),
			);
			const observation = await runWithDispatchGuard(guard, () =>
				observeModelRequests(
					{
						iteration: 2,
						activityAttempt: 1,
						activityIdHash: "example-hash",
					},
					async () => {
						if (mode === "generate") {
							await generateText({
								model,
								prompt: "Fetch a feature",
								tools,
								maxOutputTokens: 100,
							});
						} else {
							const result = streamText({
								model,
								prompt: "Fetch a feature",
								tools,
								maxOutputTokens: 100,
							});
							for await (const _ of result.stream) {
								/* drain */
							}
						}
					},
				),
			);
			expect(observation.requests).toHaveLength(1);
			expect(reserve).toHaveBeenCalledTimes(1);
			expect(settle).toHaveBeenCalledWith("example-attempt", {
				inputTokens: 100,
				outputTokens: 30,
				cacheReadTokens: 60,
			});
			expect(budget.markUnknown).not.toHaveBeenCalled();
			snapshots.push({
				reserve: reserve.mock.calls,
				settle: settle.mock.calls,
				requests: observation.requests,
				params:
					mode === "generate"
						? provider.doGenerateCalls
						: provider.doStreamCalls,
			});
		}
		expect(snapshots[1]).toEqual(snapshots[0]);
	},
);

it.each(["generate", "stream"])(
	"%s leaves a provider-run tool name as text",
	async (mode) => {
		const options: Params = {
			...params,
			tools: [
				{
					type: "provider",
					id: "example.lookup",
					name: "fabric_get_project_feature",
					args: {},
				},
			],
		};
		const model = recovered(base(call));
		if (mode === "generate") {
			const result = await model.doGenerate(options);
			expect(
				result.content.filter((p) => p.type === "tool-call"),
			).toHaveLength(0);
			expect(result.content).toEqual([{ type: "text", text: call }]);
		} else {
			const out = await collect(model, options);
			expect(out.filter((p) => p.type === "tool-call")).toHaveLength(0);
			expect(textOf(out)).toBe(call);
		}
		expect(info).not.toHaveBeenCalled();
	},
);

it("allows cancellation while draining a flushed partial pattern after source closure", async () => {
	const model = recovered(
		new MockLanguageModelV4({
			doStream: async () => ({
				stream: streamParts([
					{ type: "text-delta" as const, id: "t", delta: "<func" },
					{ type: "text-delta" as const, id: "t", delta: "tion=" },
				]),
			}),
		}),
	);
	const reader = (await model.doStream(params)).stream.getReader();
	expect((await reader.read()).value).toMatchObject({ delta: "<func" });
	await expect(reader.cancel()).resolves.toBeUndefined();
});

const quotedCases = [
	[
		"backtick fence",
		`Here is the format:\n\n\`\`\`\n${call}\n\`\`\`\n\nThat is all.`,
	],
	[
		"tilde fence",
		`Here is the format:\n\n~~~~text\n${call}\n~~~~\n\nThat is all.`,
	],
	["inline code", `Inline: \`${call}\` was printed.`],
	[
		"double backticks containing a single backtick",
		`Inline: \`\`a \` then ${call}\`\` was printed.`,
	],
	["unclosed inline code", `Inline: \`${call} was printed.`],
	[
		"long fence with a shorter run inside",
		`\`\`\`\`text\n\`\`\`\n${call}\n\`\`\`\``,
	],
	["opposite fence marker inside", `~~~\n\`\`\`\n${call}\n~~~`],
] as const;
it.each(
	quotedCases.flatMap(([label, text]) =>
		["generate", "stream"].map((mode) => [mode, label, text] as const),
	),
)("%s leaves %s quoted candidates unchanged", async (mode, label, text) => {
	const model = recovered(base(text));
	if (mode === "generate") {
		const result = await model.doGenerate(params);
		expect(result.content, label).toEqual([{ type: "text", text }]);
		expect(result.finishReason.unified, label).toBe("stop");
	} else {
		const out = await collect(model);
		expect(textOf(out), label).toBe(text);
		expect(
			out.filter((p) => p.type === "tool-call"),
			label,
		).toEqual([]);
		expect(out.at(-1), label).toEqual(finish);
	}
	expect(info).not.toHaveBeenCalled();
});

const closedQuotes = [
	["backtick fence", `\`\`\`\n${call}\n\`\`\`\n`],
	["tilde fence", `~~~\n${call}\n~~~\n`],
	["inline span", `\`${call}\` then `],
	["double-backtick span", `\`\`a \` ${call}\`\` then `],
	["blank line after unclosed span", `\`${call}\n \t\n`],
];
it.each(
	closedQuotes.flatMap(([label, prefix]) =>
		["generate", "stream"].map((mode) => [mode, label, prefix] as const),
	),
)("%s recovers a real call after %s", async (mode, label, prefix) => {
	const model = recovered(base(prefix + call.replace("F-019", "F-020")));
	if (mode === "generate") {
		const result = await model.doGenerate(params);
		expect(
			result.content
				.filter((p) => p.type === "text")
				.map((p) => p.text)
				.join(""),
			label,
		).toBe(prefix);
		expect(
			result.content
				.filter((p) => p.type === "tool-call")
				.map((p) => JSON.parse(p.input)),
			label,
		).toEqual([{ feature: "F-020" }]);
	} else {
		const out = await collect(model);
		expect(textOf(out), label).toBe(prefix);
		expect(
			out
				.filter((p) => p.type === "tool-call")
				.map((p) => JSON.parse(p.input)),
			label,
		).toEqual([{ feature: "F-020" }]);
	}
});

it("streams a fenced candidate split across deltas without losing fence state", async () => {
	const deltas = [
		"Here is code:\n",
		"`",
		"``\n",
		"\n",
		"<func",
		"tion=fabric_get_project_feature>",
		'{"feature":',
		'"F-019"}',
		"</function>",
		"\n```\n",
		"End.",
	];
	const model = recovered(
		new MockLanguageModelV4({
			doStream: async () => ({
				stream: streamParts([
					{ type: "text-start", id: "t" },
					...deltas.map((delta) => ({
						type: "text-delta" as const,
						id: "t",
						delta,
					})),
					{ type: "text-end", id: "t" },
					finish,
				]),
			}),
		}),
	);
	const out = await collect(model);
	expect(textOf(out)).toBe(deltas.join(""));
	expect(out.filter((p) => p.type === "tool-call")).toEqual([]);
});

it.each(
	[1, 2].flatMap((count) =>
		["generate", "stream"].map((mode) => [mode, count] as const),
	),
)(
	"%s drops text after the last of %i calls and logs its size",
	async (mode, count) => {
		info.mockClear();
		const between = "\nPreparing the next feature.\n";
		const tail = "\nInvented tool output.\n";
		const text =
			prose +
			call +
			(count === 2 ? between + call.replace("F-019", "F-020") : "") +
			tail;
		const expected = prose + (count === 2 ? between : "");
		const model = recovered(base(text));
		if (mode === "generate") {
			const result = await model.doGenerate(params);
			expect(
				result.content
					.filter((p) => p.type === "text")
					.map((p) => p.text)
					.join(""),
			).toBe(expected);
			expect(
				result.content.filter((p) => p.type === "tool-call"),
			).toHaveLength(count);
		} else {
			const out = await collect(model);
			expect(textOf(out)).toBe(expected);
			expect(out.filter((p) => p.type === "tool-call")).toHaveLength(
				count,
			);
		}
		expect(info).toHaveBeenCalledTimes(count);
		for (const [event, fields] of info.mock.calls) {
			expect(event).toBe("ai.text_tool_call.recovered");
			expect(fields).toEqual({
				toolName: "fabric_get_project_feature",
				modelId: "example-model",
				count,
				droppedCharacters: tail.length,
			});
		}
	},
);

it.each(["generate", "stream"])(
	"%s recovers only the forced function name",
	async (mode) => {
		const forced = "example_forced_lookup";
		const options: Params = {
			...params,
			tools: [
				...(offered ?? []),
				{
					type: "function",
					name: forced,
					inputSchema: { type: "object" },
				},
			],
			toolChoice: { type: "tool", toolName: forced },
		};
		const prefix = `${prose + call}\n`;
		const model = recovered(
			base(prefix + call.replace("fabric_get_project_feature", forced)),
		);
		if (mode === "generate") {
			const result = await model.doGenerate(options);
			expect(
				result.content
					.filter((p) => p.type === "text")
					.map((p) => p.text)
					.join(""),
			).toBe(prefix);
			expect(
				result.content
					.filter((p) => p.type === "tool-call")
					.map((p) => p.toolName),
			).toEqual([forced]);
		} else {
			const out = await collect(model, options);
			expect(textOf(out)).toBe(prefix);
			expect(
				out
					.filter((p) => p.type === "tool-call")
					.map((p) => p.toolName),
			).toEqual([forced]);
		}
	},
);

it.each(["generate", "stream"])(
	"Direct-style %s sends recovered content and the matching tool result in its second request",
	async (mode) => {
		const requests: Params[] = [];
		const text = `${prose + call}Invented result.`;
		const model = new MockLanguageModelV4({
			doGenerate: async (options) => {
				requests.push(options);
				return {
					content: [
						{
							type: "text",
							text: requests.length === 1 ? text : "Done.",
						},
					],
					finishReason: { unified: "stop", raw: "stop" },
					usage,
					warnings: [],
				};
			},
			doStream: async (options) => {
				requests.push(options);
				return {
					stream: streamParts(
						parts(requests.length === 1 ? text : "Done."),
					),
				};
			},
		});
		const execute = vi.fn(async (_input: { feature: string }) => ({
			title: "Example feature",
		}));
		const options = {
			model: recovered(model),
			prompt: "Fetch a feature",
			tools: {
				fabric_get_project_feature: tool({
					inputSchema: z.object({ feature: z.string() }),
					execute,
				}),
			},
			stopWhen: isStepCount(2),
		};
		const result =
			mode === "stream"
				? streamText(options)
				: await generateText(options);
		const shown: string[] = [];
		if ("stream" in result) {
			for await (const part of result.stream) {
				if (part.type === "text-delta") {
					shown.push(part.text);
				}
			}
		}
		const steps = await result.steps;
		const id = steps[0].toolCalls[0].toolCallId;
		expect(requests).toHaveLength(2);
		expect(requests[1].prompt.slice(-2)).toMatchObject([
			{
				role: "assistant",
				content: [
					{ type: "text", text: prose },
					{
						type: "tool-call",
						toolCallId: id,
						toolName: "fabric_get_project_feature",
						input: { feature: "F-019" },
					},
				],
			},
			{
				role: "tool",
				content: [
					{
						type: "tool-result",
						toolCallId: id,
						toolName: "fabric_get_project_feature",
						output: {
							type: "json",
							value: { title: "Example feature" },
						},
					},
				],
			},
		]);
		expect(execute).toHaveBeenCalledWith(
			{ feature: "F-019" },
			expect.objectContaining({ toolCallId: id }),
		);
		expect(steps).toHaveLength(2);
		if (mode === "stream") {
			expect(shown.join("")).toBe(`${prose}Done.`);
		} else {
			expect(steps.map((step) => step.text).join("")).toBe(
				`${prose}Done.`,
			);
		}
	},
);

it.each(["generate", "stream"])(
	"%s leaves a non-forced name unchanged when the forced name was not offered",
	async (mode) => {
		const options: Params = {
			...params,
			toolChoice: { type: "tool", toolName: "example_missing" },
		};
		const model = recovered(base(call));
		if (mode === "generate") {
			expect((await model.doGenerate(options)).content).toEqual([
				{ type: "text", text: call },
			]);
		} else {
			expect(textOf(await collect(model, options))).toBe(call);
		}
		expect(info).not.toHaveBeenCalled();
	},
);

it.each(["generate", "stream"])(
	"%s drops trailing text across text blocks while retaining text between calls",
	async (mode) => {
		const segments = [
			prose + call,
			"\nBetween calls.\n",
			`${call.replace("F-019", "F-020")}Invented.`,
			" More invented text.",
		];
		const model = recovered(
			new MockLanguageModelV4({
				doGenerate: async () => ({
					content: segments.map((text) => ({ type: "text", text })),
					finishReason: { unified: "stop", raw: "stop" },
					usage,
					warnings: [],
				}),
				doStream: async () => ({
					stream: streamParts([
						...segments.flatMap((text, i) => [
							{ type: "text-start" as const, id: `t${i}` },
							{
								type: "text-delta" as const,
								id: `t${i}`,
								delta: text,
							},
							{ type: "text-end" as const, id: `t${i}` },
						]),
						finish,
					]),
				}),
			}),
		);
		if (mode === "generate") {
			const result = await model.doGenerate(params);
			expect(
				result.content
					.filter((p) => p.type === "text")
					.map((p) => p.text)
					.join(""),
			).toBe(prose + segments[1]);
			expect(
				result.content.filter((p) => p.type === "tool-call"),
			).toHaveLength(2);
		} else {
			const out = await collect(model);
			expect(textOf(out)).toBe(prose + segments[1]);
			expect(out.filter((p) => p.type === "tool-call")).toHaveLength(2);
		}
		for (const [, fields] of info.mock.calls) {
			expect(fields.droppedCharacters).toBe(
				"Invented. More invented text.".length,
			);
		}
	},
);

const nonBareFenceLines = [
	["backtick info string", `\`\`\`markdown\n\`\`\`json\n${call}\n\`\`\`\n`],
	["tilde info string", `~~~markdown\n~~~json\n${call}\n~~~\n`],
	[
		"info string after whitespace",
		`\`\`\`markdown\n\`\`\` \tjson\n${call}\n\`\`\` \t\r\n`,
	],
	[
		"candidate on the potential closing line",
		`\`\`\`markdown\n\`\`\` ${call}\n\`\`\`\n`,
	],
] as const;
const listFencePrefixes = [
	["dash", "- ", 2],
	["asterisk", "* ", 2],
	["plus", "+ ", 2],
	["ordered", "1. ", 3],
	["indented dash", "   - ", 5],
	["indented ordered", "  12. ", 6],
] as const;
const fenceLineCases = [
	...nonBareFenceLines,
	...listFencePrefixes.map(([label, marker, indent]) => {
		const padding = " ".repeat(indent);
		return [
			`${label} list fence`,
			`${marker}\`\`\`json\n${padding}example\n\n${padding}${call}\n${padding}\`\`\`\n`,
		] as const;
	}),
];
it.each(
	fenceLineCases.flatMap(([label, prefix]) =>
		["generate", "stream"].flatMap((mode) =>
			[false, true].map((after) => [mode, label, after, prefix] as const),
		),
	),
)(
	"%s handles %s with a real call after the block=%s",
	async (mode, _label, after, prefix) => {
		const beforeCall = after ? `${prefix}\nNow fetching.\n\n` : prefix;
		const text = beforeCall + (after ? call.replace("F-019", "F-020") : "");
		const model = recovered(base(text));
		if (mode === "generate") {
			const result = await model.doGenerate(params);
			expect(
				result.content
					.filter((p) => p.type === "text")
					.map((p) => p.text)
					.join(""),
			).toBe(beforeCall);
			expect(
				result.content
					.filter((p) => p.type === "tool-call")
					.map((p) => JSON.parse(p.input)),
			).toEqual(after ? [{ feature: "F-020" }] : []);
			expect(result.finishReason.unified).toBe(
				after ? "tool-calls" : "stop",
			);
		} else {
			// base splits the text into individual characters, including the fence and list markers.
			const out = await collect(model);
			expect(textOf(out)).toBe(beforeCall);
			expect(
				out
					.filter((p) => p.type === "tool-call")
					.map((p) => JSON.parse(p.input)),
			).toEqual(after ? [{ feature: "F-020" }] : []);
			expect(out.at(-1)).toEqual(
				after
					? {
							...finish,
							finishReason: {
								unified: "tool-calls",
								raw: "stop",
							},
						}
					: finish,
			);
		}
		if (!after) {
			expect(info).not.toHaveBeenCalled();
		}
	},
);

it.each(["generate", "stream"])(
	"%s recovers a call in four-space indented text because indented blocks are not tracked",
	async (mode) => {
		const prefix = "Example:\n\n    ";
		const model = recovered(base(prefix + call));
		if (mode === "generate") {
			const result = await model.doGenerate(params);
			expect(
				result.content
					.filter((p) => p.type === "text")
					.map((p) => p.text)
					.join(""),
			).toBe(prefix);
			expect(
				result.content
					.filter((p) => p.type === "tool-call")
					.map((p) => JSON.parse(p.input)),
			).toEqual([{ feature: "F-019" }]);
		} else {
			const out = await collect(model);
			expect(textOf(out)).toBe(prefix);
			expect(
				out
					.filter((p) => p.type === "tool-call")
					.map((p) => JSON.parse(p.input)),
			).toEqual([{ feature: "F-019" }]);
		}
	},
);
