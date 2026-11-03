/**
 * The Sidekick's runtime protocol: its props, and the one mapping from the
 * run's AG-UI conversation to the AI SDK messages the panel renders and the
 * engine sends the model.
 *
 *   - consecutive assistant and tool messages are one assistant message,
 *     with the first assistant message's id, a `step-start` opening each
 *     model step the message ids name (text after a tool call stays in its
 *     step; an id naming no step is a step of its own), its text, and each
 *     tool call carrying its result (`input-available` while unanswered,
 *     `output-error` for a result marked with `TOOL_ERROR_METADATA`);
 *   - a user message's content parts become its text;
 *   - system, developer, reasoning and activity messages are left out;
 *   - `entityType` defaults to "registered"; a form snapshot is required.
 */
import type { Message, ToolCall } from "@ag-ui/client";
import {
	sidekickRunPropsSchema,
	sidekickUiMessages,
	TOOL_ERROR_METADATA,
} from "@saas/agents/lib/sidekick-runtime-protocol";
import { describe, expect, it } from "vitest";

const USER: Message = {
	id: "user-1",
	role: "user",
	content: "Help me improve this agent",
};

describe("sidekickUiMessages", () => {
	it("retains explicit step metadata for history and clears it at the next user turn", () => {
		const model = { id: "example-served", viaPlan: false };
		const messages = sidekickUiMessages([
			USER,
			{
				id: "run-1:s0:m0",
				role: "assistant",
				content: "Answer",
				metadata: { model },
			},
			{ id: "user-2", role: "user", content: "Next" },
			{
				id: "run-2:s0:m0",
				role: "assistant",
				content: "Old answer",
				metadata: { model: { id: "example-configured" } },
			},
		]);
		expect(messages[1].metadata).toEqual({ model });
		expect(messages[3].metadata).toBeUndefined();
	});
	it("deduplicates models in text order and ignores tool-only step attribution", () => {
		const plan = {
			id: "example-plan",
			provider: "OPENAI_CHATGPT_PLAN",
			viaPlan: true,
		};
		const api = {
			id: "example-api",
			provider: "OPENAI_DIRECT",
			viaPlan: false,
		};
		const [, reply] = sidekickUiMessages([
			USER,
			{
				id: "run:s0:m0",
				role: "assistant",
				content: "Checking",
				metadata: { model: plan },
			},
			{
				id: "run:s1:m1",
				role: "assistant",
				content: "Answer",
				metadata: { model: api },
			},
			{
				id: "run:s2:m2",
				role: "assistant",
				content: "More",
				metadata: { model: plan },
			},
			{
				id: "run:s3:m3",
				role: "assistant",
				content: "",
				metadata: {
					model: { id: "example-tool-only", viaPlan: false },
				},
			},
		]);
		expect(reply.metadata).toEqual({ model: plan, models: [plan, api] });
	});
	it("groups a reply's steps into one assistant message, each tool call with its result", () => {
		const messages = sidekickUiMessages([
			USER,
			{
				id: "run-1:s0:m0",
				role: "assistant",
				content: "Adding a tool.",
				toolCalls: [
					{
						id: "call-1",
						type: "function",
						function: {
							name: "suggest_tools",
							arguments: '{"suggestions":[{"toolId":"web"}]}',
						},
					},
				],
			},
			{
				id: "call-1:result",
				role: "tool",
				toolCallId: "call-1",
				content: ":agent_suggestion[]{sId=suggestion-1 kind=tools}",
			},
			{ id: "run-1:s1:m1", role: "assistant", content: "Done." },
		]);

		expect(messages).toEqual([
			{
				id: "user-1",
				role: "user",
				parts: [{ type: "text", text: "Help me improve this agent" }],
			},
			{
				id: "run-1:s0:m0",
				role: "assistant",
				parts: [
					{ type: "step-start" },
					{ type: "text", text: "Adding a tool." },
					{
						type: "tool-suggest_tools",
						toolCallId: "call-1",
						state: "output-available",
						input: { suggestions: [{ toolId: "web" }] },
						output: ":agent_suggestion[]{sId=suggestion-1 kind=tools}",
					},
					{ type: "step-start" },
					{ type: "text", text: "Done." },
				],
			},
		]);
	});

	it("keeps text written after a tool call in its step, where the client put the call's result between them", () => {
		const call = (id: string): ToolCall => ({
			id,
			type: "function",
			function: { name: "suggest_tools", arguments: "{}" },
		});

		const [, reply] = sidekickUiMessages([
			USER,
			{
				id: "run-1:s0:m0",
				role: "assistant",
				content: "Adding a tool.",
				toolCalls: [call("call-1")],
			},
			{
				id: "call-1:result",
				role: "tool",
				toolCallId: "call-1",
				content: "first",
			},
			{
				id: "run-1:s0:m1",
				role: "assistant",
				content: "And removing one.",
				toolCalls: [call("call-2")],
			},
			{
				id: "call-2:result",
				role: "tool",
				toolCallId: "call-2",
				content: "second",
			},
			{ id: "run-1:s1:m2", role: "assistant", content: "Both changed." },
		]);

		expect(reply?.parts.map((part) => part.type)).toEqual([
			"step-start",
			"text",
			"tool-suggest_tools",
			"text",
			"tool-suggest_tools",
			"step-start",
			"text",
		]);
	});

	it("opens a step for each assistant message whose id names no step", () => {
		const [, reply] = sidekickUiMessages([
			USER,
			{ id: "assistant-1", role: "assistant", content: "One." },
			{ id: "assistant-2", role: "assistant", content: "Two." },
		]);

		expect(reply?.parts).toEqual([
			{ type: "step-start" },
			{ type: "text", text: "One." },
			{ type: "step-start" },
			{ type: "text", text: "Two." },
		]);
	});

	it("takes a user message's text from its content parts", () => {
		const [message] = sidekickUiMessages([
			{
				id: "user-1",
				role: "user",
				content: [
					{ type: "text", text: "Rename " },
					{ type: "text", text: "the agent" },
				],
			},
		]);

		expect(message?.parts).toEqual([
			{ type: "text", text: "Rename the agent" },
		]);
	});

	it("leaves out system, developer, reasoning and activity messages", () => {
		const messages = sidekickUiMessages([
			{ id: "system-1", role: "system", content: "Be brief." },
			{ id: "developer-1", role: "developer", content: "Debug." },
			USER,
			{ id: "reasoning-1", role: "reasoning", content: "Hmm." },
			{
				id: "activity-1",
				role: "activity",
				activityType: "progress",
				content: { step: 1 },
			},
			{ id: "run-1:m0", role: "assistant", content: "Sure." },
		]);

		expect(messages.map((message) => message.id)).toEqual([
			"user-1",
			"run-1:m0",
		]);
		expect(JSON.stringify(messages)).not.toMatch(
			/Be brief|Debug|Hmm|progress/,
		);
	});

	it("reads a tool result marked as failed back as output-error, its text as the error", () => {
		const call = (id: string): ToolCall => ({
			id,
			type: "function",
			function: {
				name: "suggest_tools",
				arguments: '{"suggestions":[]}',
			},
		});
		const [, reply] = sidekickUiMessages([
			USER,
			{
				id: "run-1:s0:m0",
				role: "assistant",
				toolCalls: [call("call-1"), call("call-2")],
			},
			{
				id: "call-1:result",
				role: "tool",
				toolCallId: "call-1",
				content: "An error occurred.",
				metadata: TOOL_ERROR_METADATA,
			},
			{
				id: "call-2:result",
				role: "tool",
				toolCallId: "call-2",
				content: "Suggested tool changes.",
				metadata: { toolError: "yes" },
			},
		]);

		expect(reply?.parts).toEqual([
			{ type: "step-start" },
			{
				type: "tool-suggest_tools",
				toolCallId: "call-1",
				state: "output-error",
				input: { suggestions: [] },
				errorText: "An error occurred.",
			},
			{
				type: "tool-suggest_tools",
				toolCallId: "call-2",
				state: "output-available",
				input: { suggestions: [] },
				output: "Suggested tool changes.",
			},
		]);
	});

	it("keeps an unanswered tool call as input-available, and raw arguments that are not JSON", () => {
		const [, reply] = sidekickUiMessages([
			USER,
			{
				id: "run-1:m0",
				role: "assistant",
				toolCalls: [
					{
						id: "call-1",
						type: "function",
						function: {
							name: "list_suggestions",
							arguments: "{oops",
						},
					},
				],
			},
		]);

		expect(reply?.parts).toEqual([
			{ type: "step-start" },
			{
				type: "tool-list_suggestions",
				toolCallId: "call-1",
				state: "input-available",
				input: "{oops",
			},
		]);
	});
});

describe("sidekickRunPropsSchema", () => {
	it("defaults entityType to registered and requires a form snapshot", () => {
		expect(
			sidekickRunPropsSchema.parse({
				agentId: "agent-1",
				formSnapshot: {},
			}),
		).toEqual({
			agentId: "agent-1",
			entityType: "registered",
			formSnapshot: {},
		});
		expect(
			sidekickRunPropsSchema.safeParse({ agentId: "agent-1" }).success,
		).toBe(false);
	});
});
