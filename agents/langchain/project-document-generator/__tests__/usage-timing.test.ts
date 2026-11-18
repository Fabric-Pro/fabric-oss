import { expect, it, vi } from "vitest";
import {
	conversationIdForUsage,
	firstTokenTiming,
} from "../nodes/usage-timing";

it("validates thread identity and preserves explicit usage precedence", () => {
	for (const thread_id of [
		null,
		123,
		"short",
		"example.invalid",
		"x".repeat(129),
		["example-thread"],
	])
		expect(
			conversationIdForUsage({ configurable: { thread_id } }),
		).toBeUndefined();
	expect(
		conversationIdForUsage({
			configurable: { thread_id: "example-thread" },
		}),
	).toBe("example-thread");
	expect(
		conversationIdForUsage({
			configurable: {
				thread_id: "example-thread",
				usage_conversation_id: "example-explicit",
			},
		}),
	).toBeUndefined();
});
it("captures the first output independently per call and omits absent callbacks", async () => {
	const clock = vi.spyOn(Date, "now").mockReturnValue(120);
	try {
		const a = firstTokenTiming(100),
			b = firstTokenTiming(100),
			c = firstTokenTiming(100);
		const ca = a.config({}).callbacks as any[];
		await ca[0].handleLLMNewToken("Example");
		clock.mockReturnValue(155);
		await ca[0].handleLLMNewToken("again");
		await (b.config({}).callbacks as any[])[0].handleLLMNewToken("Example");
		expect(a.firstTokenMs).toBe(20);
		expect(b.firstTokenMs).toBe(55);
		expect(c.firstTokenMs).toBeUndefined();
	} finally {
		clock.mockRestore();
	}
});

import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessageChunk, HumanMessage } from "@langchain/core/messages";
import {
	END,
	MessagesAnnotation,
	START,
	StateGraph,
} from "@langchain/langgraph";

class ExampleStreamingModel extends BaseChatModel {
	_llmType() {
		return "example-streaming";
	}
	async _generate(): Promise<any> {
		throw new Error("Expected streaming");
	}
	async *_streamResponseChunks(_messages: any, _options: any, manager: any) {
		const message = new AIMessageChunk({
			content: "",
			tool_call_chunks: [
				{
					name: "example_tool",
					args: "{}",
					id: "example-call",
					index: 0,
				},
			],
		});
		await manager?.handleLLMNewToken(
			"",
			undefined,
			undefined,
			undefined,
			undefined,
			{ chunk: { text: "", message } },
		);
		yield { text: "", message };
	}
}
it("invoke under graph messages streaming delivers an empty tool token callback", async () => {
	const timing = firstTokenTiming(Date.now());
	const model = new ExampleStreamingModel({});
	const graph = new StateGraph(MessagesAnnotation)
		.addNode("chat", async (state, config) => ({
			messages: [
				await model.invoke(state.messages, timing.config(config)),
			],
		}))
		.addEdge(START, "chat")
		.addEdge("chat", END)
		.compile();
	for await (const _chunk of await graph.stream(
		{ messages: [new HumanMessage("example")] },
		{ streamMode: "messages" },
	)) {
		/* consume */
	}
	expect(timing.firstTokenMs).toEqual(expect.any(Number));
});

// Callback fields follow convertResponsesDeltaToChatGenerationChunk in
// @langchain/openai/dist/converters/responses.js and
// _makeMessageChunkFromAnthropicEvent in @langchain/anthropic/dist/utils/message_outputs.js.
const providerChunks = [
	{
		name: "Responses response.created",
		output: false,
		token: "",
		message: {
			content: [],
			tool_call_chunks: [],
			additional_kwargs: {},
			response_metadata: {
				model_provider: "openai",
				id: "example-response",
				model_name: "example-model",
				model: "example-model",
			},
			id: "example-response",
		},
	},
	{
		name: "Responses text delta",
		output: true,
		token: "Example",
		message: {
			content: [{ type: "text", text: "Example", index: 0 }],
			tool_call_chunks: [],
			additional_kwargs: {},
			response_metadata: { model_provider: "openai" },
		},
	},
	{
		name: "Responses argument delta",
		output: true,
		token: "",
		message: {
			content: [],
			tool_call_chunks: [
				{ type: "tool_call_chunk", args: '{"query":', index: 0 },
			],
			additional_kwargs: {},
			response_metadata: { model_provider: "openai" },
		},
	},
	{
		name: "Responses reasoning delta",
		output: true,
		token: "",
		message: {
			content: [
				{ type: "reasoning", reasoning: "Example thought", index: 0 },
			],
			tool_call_chunks: [],
			additional_kwargs: {
				reasoning: {
					type: "reasoning",
					summary: [
						{
							text: "Example thought",
							type: "summary_text",
							index: 0,
						},
					],
				},
			},
			response_metadata: { model_provider: "openai" },
		},
	},
	{
		name: "Anthropic message_start",
		output: false,
		token: "",
		message: {
			content: [],
			additional_kwargs: {
				type: "message",
				role: "assistant",
				model: "example-model",
			},
			id: "example-message",
			response_metadata: { model_provider: "anthropic", usage: {} },
		},
	},
	{
		name: "Anthropic text delta",
		output: true,
		token: "Example",
		message: {
			content: [{ index: 0, type: "text", text: "Example" }],
			response_metadata: { model_provider: "anthropic" },
		},
	},
	{
		name: "Anthropic coerced text delta",
		output: true,
		token: "Example",
		message: { content: "Example" },
	},
	{
		name: "Anthropic input_json_delta",
		output: true,
		token: '{"query":',
		message: {
			content: [
				{ index: 0, input: '{"query":', type: "input_json_delta" },
			],
			response_metadata: { model_provider: "anthropic" },
			additional_kwargs: {},
			tool_call_chunks: [{ index: 0, args: '{"query":' }],
		},
	},
	{
		name: "Anthropic thinking delta",
		output: true,
		token: "",
		message: {
			content: [
				{ index: 0, type: "thinking", thinking: "Example thought" },
			],
			response_metadata: { model_provider: "anthropic" },
		},
	},
	{
		name: "Anthropic signature delta",
		output: false,
		token: "",
		message: {
			content: [
				{ index: 0, type: "thinking", signature: "example-signature" },
			],
			response_metadata: { model_provider: "anthropic" },
		},
	},
];
it.each(providerChunks)(
	"counts output rather than acknowledgement for $name",
	async ({ output, token, message }) => {
		const clock = vi.spyOn(Date, "now").mockReturnValue(120);
		try {
			const timing = firstTokenTiming(100);
			const handler = (timing.config({}).callbacks as any[])[0];
			await handler.handleLLMNewToken(
				token,
				undefined,
				undefined,
				undefined,
				undefined,
				{ chunk: { text: token, message } },
			);
			expect(timing.firstTokenMs).toBe(output ? 20 : undefined);
			clock.mockReturnValue(175);
			await handler.handleLLMNewToken("Example generated text");
			expect(timing.firstTokenMs).toBe(output ? 20 : 75);
		} finally {
			clock.mockRestore();
		}
	},
);
it("omits a duration when the wall clock moves behind the origin", async () => {
	const clock = vi.spyOn(Date, "now").mockReturnValue(90);
	try {
		const timing = firstTokenTiming(100);
		await (timing.config({}).callbacks as any[])[0].handleLLMNewToken(
			"Example",
		);
		expect(timing.firstTokenMs).toBeUndefined();
	} finally {
		clock.mockRestore();
	}
});
