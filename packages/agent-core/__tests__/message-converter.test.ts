import {
	AIMessage,
	ChatMessage,
	HumanMessage,
	SystemMessage,
	ToolMessage,
} from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import {
	convertToSimpleMessages,
	getAssistantMessages,
	getLastMessageContent,
} from "../src/utils/message-converter";

const toolCalls = [{ id: "call-example", name: "example_tool", args: {} }];

function graphMessages() {
	return [
		new SystemMessage({
			content: "Help with planning.",
			id: "system-example",
		}),
		new HumanMessage({ content: "Plan this.", id: "human-example" }),
		new AIMessage({ content: "", id: "ai-example", tool_calls: toolCalls }),
		new ToolMessage({
			content: "Plan ready.",
			id: "tool-example",
			tool_call_id: "call-example",
		}),
	];
}

describe("convertToSimpleMessages", () => {
	it("preserves LangChain roles, ids and tool relationships", () => {
		expect(convertToSimpleMessages(graphMessages())).toEqual([
			{
				role: "system",
				content: "Help with planning.",
				id: "system-example",
			},
			{ role: "user", content: "Plan this.", id: "human-example" },
			{
				role: "assistant",
				content: "",
				id: "ai-example",
				tool_calls: toolCalls,
			},
			{
				role: "tool",
				content: "Plan ready.",
				id: "tool-example",
				tool_call_id: "call-example",
			},
		]);
	});

	it("prefers LangChain type methods over role and preserves their receiver", () => {
		const human = Object.assign(new HumanMessage("Hello"), {
			role: "assistant",
		});
		expect(convertToSimpleMessages([human])[0].role).toBe("user");
		expect(
			convertToSimpleMessages([
				{
					role: "assistant",
					kind: "human",
					content: "Hello",
					getType() {
						return this.kind;
					},
				},
			]),
		).toEqual([{ role: "user", content: "Hello" }]);
	});

	it("keeps a ChatMessage's custom role instead of its generic type", () => {
		expect(
			convertToSimpleMessages([new ChatMessage("Looks fine.", "critic")]),
		).toEqual([{ role: "critic", content: "Looks fine." }]);
	});

	it("keeps plain role messages and optional metadata", () => {
		const messages = [
			{ role: "user", content: "Hi", id: "plain-example" },
			{ role: "assistant", content: "", tool_calls: toolCalls },
			{ role: "tool", content: "Done", tool_call_id: "call-example" },
		];
		expect(convertToSimpleMessages(messages)).toEqual(messages);
	});

	it("joins array text parts without stringifying non-text parts", () => {
		expect(
			convertToSimpleMessages([
				new HumanMessage({
					content: [
						{ type: "text", text: "Hello " },
						{
							type: "image_url",
							image_url: "https://example.com/image.png",
						},
						{ type: "text", text: "world" },
					],
				}),
				{
					role: "assistant",
					content: ["Hello", { text: " world" }, null],
				},
			]),
		).toEqual([
			{ role: "user", content: "Hello world" },
			{ role: "assistant", content: "Hello world" },
		]);
	});

	it("omits invalid ids, empty calls and metadata on unrelated roles", () => {
		expect(
			convertToSimpleMessages([
				{
					role: "user",
					content: "Hi",
					id: 123,
					tool_calls: toolCalls,
					tool_call_id: "bad",
				},
				new AIMessage("Hello"),
				{ role: "assistant", content: "Hi", tool_calls: {} },
			]),
		).toEqual([
			{ role: "user", content: "Hi" },
			{ role: "assistant", content: "Hello" },
			{ role: "assistant", content: "Hi" },
		]);
	});

	it("keeps fallback conversion and convenience helpers usable", () => {
		expect(
			convertToSimpleMessages([null, undefined, "hello", 123]),
		).toEqual([
			{ role: "assistant", content: "" },
			{ role: "assistant", content: "" },
			{ role: "assistant", content: "hello" },
			{ role: "assistant", content: "123" },
		]);
		expect(getLastMessageContent(graphMessages())).toBe("Plan ready.");
		expect(getLastMessageContent([])).toBe("");
		expect(getAssistantMessages(graphMessages())).toEqual([
			{
				role: "assistant",
				content: "",
				id: "ai-example",
				tool_calls: toolCalls,
			},
		]);
	});
});
