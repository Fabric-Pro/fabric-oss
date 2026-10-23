import { guardToolsAgainstRepeatedCalls } from "@repo/agent-types/repeated-tool-call-guard";
import { isStepCount, jsonSchema, streamText, tool } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import {
	prepareAgentTools,
	withAgentToolRuntime,
} from "../../shared/agent-tool-runtime";

const USAGE = {
	inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 5, text: 5, reasoning: 0 },
};
const ANSWER = "The project has one source.";
const OUTPUT = { sources: [{ id: "example-source", name: "Example source" }] };
type Prompt = MockLanguageModelV4["doStreamCalls"][number]["prompt"];

function toolResults(prompt: Prompt) {
	return prompt.flatMap((message) =>
		message.role === "tool"
			? message.content.filter((part) => part.type === "tool-result")
			: [],
	);
}

function isNotice(output: { type: string; value?: unknown } | undefined) {
	return (
		output?.type === "text" &&
		typeof output.value === "string" &&
		output.value.includes("same result") &&
		output.value.includes("same arguments")
	);
}

function response(
	call: number,
	project?: string,
): Awaited<ReturnType<MockLanguageModelV4["doStream"]>> {
	return {
		stream: simulateReadableStream({
			chunks: [
				{ type: "stream-start", warnings: [] },
				...(project
					? [
							{
								type: "tool-call" as const,
								toolCallId: `call-${call}`,
								toolName: "list_sources",
								input: JSON.stringify({ project }),
							},
						]
					: [
							{ type: "text-start" as const, id: "answer" },
							{
								type: "text-delta" as const,
								id: "answer",
								delta: ANSWER,
							},
							{ type: "text-end" as const, id: "answer" },
						]),
				{
					type: "finish",
					finishReason: {
						unified: project ? "tool-calls" : "stop",
						raw: undefined,
					},
					usage: USAGE,
				},
			],
		}),
	};
}

function sourceTools() {
	return {
		list_sources: tool({
			description: "List project sources",
			inputSchema: jsonSchema<{ project: string }>({
				type: "object",
				properties: { project: { type: "string" } },
				required: ["project"],
				additionalProperties: false,
			}),
			execute: async () => OUTPUT,
		}),
	};
}

describe("repeated tool call guard with streamText", () => {
	it("answers in three steps with its only tool still offered", async () => {
		const tools = sourceTools();
		guardToolsAgainstRepeatedCalls(tools);
		let calls = 0;
		const model = new MockLanguageModelV4({
			doStream: async ({ prompt }) => {
				calls += 1;
				return response(
					calls,
					isNotice(toolResults(prompt).at(-1)?.output)
						? undefined
						: "example-project-a",
				);
			},
		});
		const result = streamText({
			model,
			tools,
			prompt: "List the project sources and answer.",
			stopWhen: isStepCount(10),
		});
		await result.consumeStream();

		expect(await result.steps).toHaveLength(3);
		expect(await result.text).toBe(ANSWER);
		expect(model.doStreamCalls).toHaveLength(3);
		for (const request of model.doStreamCalls) {
			expect(request.tools).toEqual([
				expect.objectContaining({ name: "list_sources" }),
			]);
		}
		const outputs = toolResults(model.doStreamCalls[2].prompt);
		expect(outputs[0]).toMatchObject({
			toolCallId: "call-1",
			output: { type: "json", value: OUTPUT },
		});
		expect(outputs[1].toolCallId).toBe("call-2");
		expect(isNotice(outputs[1].output)).toBe(true);
		expect((await result.steps)[1].toolResults[0].output).toBe(OUTPUT);
	});
});

describe("repeated tool call guard input changes", () => {
	it("returns the full result for input B after a repeat on input A", async () => {
		const tools = sourceTools();
		guardToolsAgainstRepeatedCalls(tools);
		let calls = 0;
		const model = new MockLanguageModelV4({
			doStream: async ({ prompt }) => {
				calls += 1;
				const results = toolResults(prompt);
				const last = results.at(-1);
				return response(
					calls,
					last?.toolCallId === "call-3"
						? undefined
						: isNotice(last?.output)
							? "example-project-b"
							: "example-project-a",
				);
			},
		});
		const result = streamText({
			model,
			tools,
			prompt: "List sources for both projects.",
			stopWhen: isStepCount(10),
		});
		await result.consumeStream();

		expect(await result.steps).toHaveLength(4);
		expect(await result.text).toBe(ANSWER);
		const results = toolResults(model.doStreamCalls[3].prompt);
		expect(isNotice(results[1].output)).toBe(true);
		expect(results[2]).toMatchObject({
			toolCallId: "call-3",
			output: { type: "json", value: OUTPUT },
		});
		expect((await result.steps)[2].toolCalls[0].input).toEqual({
			project: "example-project-b",
		});
		for (const request of model.doStreamCalls) {
			expect(request.tools).toEqual([
				expect.objectContaining({ name: "list_sources" }),
			]);
		}
	});
});

type ModelOutputOptions = {
	toolCallId: string;
	input: unknown;
	output: unknown;
};
type TestTool = {
	execute: (input: unknown, options?: unknown) => unknown;
	toModelOutput?: (options: ModelOutputOptions) => unknown;
};

async function call(definition: TestTool, id: string, input: unknown = {}) {
	const output = await definition.execute(input, { toolCallId: id });
	const modelOutput = await definition.toModelOutput?.({
		toolCallId: id,
		input,
		output,
	});
	return { output, modelOutput };
}

function guarded(
	execute: TestTool["execute"] = async () => OUTPUT,
	toModelOutput?: TestTool["toModelOutput"],
) {
	const tools: Record<string, TestTool> = {
		lookup: { execute, toModelOutput },
	};
	const onRepeat = vi.fn();
	guardToolsAgainstRepeatedCalls(tools, { onRepeat });
	return { tools, onRepeat };
}

describe("guardToolsAgainstRepeatedCalls", () => {
	it("substitutes only repeated model outputs and reports each repeat", async () => {
		let executions = 0;
		const { tools, onRepeat } = guarded(async () => {
			executions += 1;
			return OUTPUT;
		});
		expect((await call(tools.lookup, "first")).modelOutput).toEqual({
			type: "json",
			value: OUTPUT,
		});
		const second = await call(tools.lookup, "second");
		expect(second.output).toBe(OUTPUT);
		expect(second.modelOutput).toMatchObject({
			type: "text",
			value: expect.stringContaining("earlier lookup call"),
		});
		await call(tools.lookup, "third");
		expect(executions).toBe(3);
		expect(onRepeat.mock.calls).toEqual([
			["lookup", 1],
			["lookup", 2],
		]);
	});

	it("canonicalizes nested object keys in inputs and outputs", async () => {
		let executions = 0;
		const { tools } = guarded(async () =>
			++executions === 1
				? { a: { b: 1, c: 2 }, d: 3 }
				: { d: 3, a: { c: 2, b: 1 } },
		);
		await call(tools.lookup, "first", { a: [{ b: 1, c: 2 }], d: 3 });
		const second = await call(tools.lookup, "second", {
			d: 3,
			a: [{ c: 2, b: 1 }],
		});
		expect(
			isNotice(second.modelOutput as { type: string; value: unknown }),
		).toBe(true);
	});

	it("keeps different inputs and array order distinct", async () => {
		const { tools, onRepeat } = guarded();
		await call(tools.lookup, "first", { ids: ["a", "b"] });
		const second = await call(tools.lookup, "second", { ids: ["b", "a"] });
		expect(second.modelOutput).toEqual({ type: "json", value: OUTPUT });
		expect(onRepeat).not.toHaveBeenCalled();
	});

	it("returns changed output for the same input after a create", async () => {
		let sources = ["a"];
		const tools: Record<string, TestTool> = {
			list: { execute: async () => ({ sources: [...sources] }) },
			create: {
				execute: async () => {
					sources = [...sources, "b"];
					return { success: true };
				},
			},
		};
		guardToolsAgainstRepeatedCalls(tools);
		await call(tools.list, "first");
		await call(tools.create, "create");
		expect((await call(tools.list, "second")).modelOutput).toEqual({
			type: "json",
			value: { sources: ["a", "b"] },
		});
	});

	it.each([
		{ error: "Unavailable" },
		{ success: false, reason: "Unavailable" },
	])("counts repeated failure-shaped results: %j", async (output) => {
		const { tools } = guarded(async () => output);
		await call(tools.lookup, "first");
		expect((await call(tools.lookup, "second")).modelOutput).toMatchObject({
			type: "text",
			value: expect.stringContaining("same result"),
		});
	});

	it("delegates non-repeats to the tool's own model-output conversion", async () => {
		const toModelOutput = vi.fn(
			({ toolCallId, input, output }: ModelOutputOptions) => ({
				type: "text",
				value: JSON.stringify({ toolCallId, input, output }),
			}),
		);
		const { tools } = guarded(async () => OUTPUT, toModelOutput);
		const first = await call(tools.lookup, "first", { id: "a" });
		expect(first.modelOutput).toEqual({
			type: "text",
			value: JSON.stringify({
				toolCallId: "first",
				input: { id: "a" },
				output: OUTPUT,
			}),
		});
		expect(toModelOutput).toHaveBeenCalledWith({
			toolCallId: "first",
			input: { id: "a" },
			output: OUTPUT,
		});
		expect(
			(await call(tools.lookup, "second", { id: "a" })).modelOutput,
		).toMatchObject({
			type: "text",
			value: expect.stringContaining("same result"),
		});
		expect(toModelOutput).toHaveBeenCalledTimes(1);
	});

	it.each([
		{ output: "hello", expected: { type: "text", value: "hello" } },
		{
			output: { b: 2, a: 1 },
			expected: { type: "json", value: { b: 2, a: 1 } },
		},
		{ output: undefined, expected: { type: "json", value: null } },
		{
			output: {
				missing: undefined,
				values: [undefined],
				date: new Date("2026-01-01T00:00:00Z"),
			},
			expected: {
				type: "json",
				value: { values: [null], date: "2026-01-01T00:00:00.000Z" },
			},
		},
		{
			output: JSON.parse('{"__proto__":{"value":1}}'),
			expected: {
				type: "json",
				value: JSON.parse('{"__proto__":{"value":1}}'),
			},
		},
	])(
		"matches SDK default conversion for $output",
		async ({ output, expected }) => {
			const { tools } = guarded(async () => output);
			const actual = (await call(tools.lookup, "first")).modelOutput;
			expect(actual).toEqual(expected);
			expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
		},
	);

	it("passes streaming results through without counting them", async () => {
		const stream = (async function* () {
			yield OUTPUT;
		})();
		const { tools, onRepeat } = guarded(() => stream);
		expect(tools.lookup.execute({}, { toolCallId: "first" })).toBe(stream);
		expect(tools.lookup.execute({}, { toolCallId: "second" })).toBe(stream);
		expect(onRepeat).not.toHaveBeenCalled();
	});

	it("does not count promises resolving to streams or unserializable outputs", async () => {
		const cycle: Record<string, unknown> = {};
		cycle.self = cycle;
		for (const output of [
			cycle,
			1n,
			undefined,
			(async function* () {
				yield OUTPUT;
			})(),
		]) {
			const { tools, onRepeat } = guarded(async () => output);
			expect(
				await tools.lookup.execute({}, { toolCallId: "first" }),
			).toBe(output);
			expect(
				await tools.lookup.execute({}, { toolCallId: "second" }),
			).toBe(output);
			expect(onRepeat).not.toHaveBeenCalled();
		}
	});

	it("does not count unserializable inputs or calls without a tool-call ID", async () => {
		const { tools, onRepeat } = guarded();
		await call(tools.lookup, "first", 1n);
		await call(tools.lookup, "second", 1n);
		await tools.lookup.execute({});
		await tools.lookup.execute({});
		expect(onRepeat).not.toHaveBeenCalled();
	});

	it("keeps guard instances independent", async () => {
		const first = guarded();
		const second = guarded();
		await call(first.tools.lookup, "first");
		expect((await call(second.tools.lookup, "second")).modelOutput).toEqual(
			{ type: "json", value: OUTPUT },
		);
	});

	it("keeps tool names independent", async () => {
		const tools: Record<string, TestTool> = {
			a: { execute: async () => OUTPUT },
			b: { execute: async () => OUTPUT },
		};
		guardToolsAgainstRepeatedCalls(tools);
		await call(tools.a, "a");
		expect((await call(tools.b, "b")).modelOutput).toEqual({
			type: "json",
			value: OUTPUT,
		});
	});

	it("keeps the model-output guard through agent runtime wrapping", async () => {
		const tools: Record<string, TestTool & { inputSchema: unknown }> = {
			lookup: { execute: async () => OUTPUT, inputSchema: {} },
		};
		guardToolsAgainstRepeatedCalls(tools);
		await withAgentToolRuntime(
			{ invoke: async (invocation) => invocation.execute() },
			async () => {
				await prepareAgentTools(tools);
				await call(tools.lookup, "first");
				const second = await call(tools.lookup, "second");
				expect(second.output).toBe(OUTPUT);
				expect(second.modelOutput).toMatchObject({
					type: "text",
					value: expect.stringContaining("same result"),
				});
			},
		);
	});

	it("preserves tool definitions without an execute function", () => {
		const definition = { description: "Provider tool" };
		const tools = { provider: definition, missing: null };
		guardToolsAgainstRepeatedCalls(tools);
		expect(tools.provider).toBe(definition);
		expect(tools.missing).toBeNull();
	});
});
