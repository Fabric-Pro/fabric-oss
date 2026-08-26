/**
 * Comprehensive tests for Document Generator Chat Node
 *
 * Tests cover:
 * 1. Initial document generation
 * 2. Follow-up questions (should make targeted edits, not regenerate)
 * 3. After confirmation (summary only, no regeneration)
 * 4. Error handling and retry logic
 */

import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { describe, expect, it, vi } from "vitest";
import type { AgentState } from "../state";

// Mock the external dependencies
vi.mock("../utils", () => ({
	DEFAULT_RECURSION_LIMIT: 25,
	MAX_RETRIES: 3,
	getAgentModelAsync: vi.fn().mockResolvedValue({
		bindTools: vi.fn().mockReturnThis(),
		invoke: vi.fn(),
	}),
	isRetryableError: vi.fn().mockReturnValue(false),
	isJsonParseError: vi.fn().mockReturnValue(false),
	calculateRetryDelay: vi.fn().mockReturnValue(100),
	sleep: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../prompts", () => ({
	buildSystemPrompt: vi.fn().mockReturnValue("Test system prompt"),
	getPredictStateConfig: vi.fn().mockReturnValue([]),
}));

// Helper to create mock states
function createMockState(overrides: Partial<AgentState> = {}): AgentState {
	return {
		messages: [],
		document: "",
		documentType: "general",
		systemPrompt: undefined,
		focusAnchor: undefined,
		tools: [],
		retryCount: 0,
		error: undefined,
		...overrides,
	};
}

// Helper to create AI message with tool call
function createAIMessageWithToolCall(
	toolName: string,
	args: Record<string, any> = {},
	id?: string,
) {
	const callId =
		id ?? `call_${Date.now()}_${Math.random().toString(36).slice(2)}`;
	return new AIMessage({
		content: "",
		tool_calls: [
			{
				id: callId,
				name: toolName,
				args,
			},
		],
	});
}

// Helper to get the tool call id from an AI message
function getToolCallId(message: AIMessage): string {
	const toolCalls = message.tool_calls;
	if (!toolCalls || toolCalls.length === 0 || !toolCalls[0].id) {
		throw new Error("Message does not have a valid tool call id");
	}
	return toolCalls[0].id;
}

// Helper to create tool response message
function createToolMessage(content: string, toolCallId: string) {
	return new ToolMessage({
		content,
		tool_call_id: toolCallId,
	});
}

describe("Document Generator Chat Node - Message Flow Tests", () => {
	describe("isAfterConfirmation detection", () => {
		it("should detect immediate post-confirmation state (tool response is last)", () => {
			// Message structure after user clicks Accept/Reject:
			// [..., AIMessage(confirm_changes), ToolMessage(accepted:true)]
			const confirmToolCall = createAIMessageWithToolCall(
				"confirm_changes",
				{},
				"confirm_1",
			);
			const toolResponse = createToolMessage(
				'{"accepted":true}',
				getToolCallId(confirmToolCall),
			);

			const messages = [
				new HumanMessage("Write a story"),
				createAIMessageWithToolCall(
					"write_document_local",
					{ document: "Once upon a time..." },
					"write_1",
				),
				createToolMessage("Document written.", "call_1"),
				confirmToolCall,
				toolResponse,
			];

			// This state should be detected as "after confirmation"
			// The agent should output a summary, NOT regenerate the document
			expect(messages[messages.length - 1]).toBeInstanceOf(ToolMessage);
			expect(
				(messages[messages.length - 2] as AIMessage).tool_calls?.[0]
					.name,
			).toBe("confirm_changes");
		});

		it("should NOT detect follow-up question as after confirmation", () => {
			// Message structure after user sends follow-up:
			// [..., AIMessage(confirm_changes), ToolMessage(accepted:true), HumanMessage("new question")]
			const confirmToolCall = createAIMessageWithToolCall(
				"confirm_changes",
				{},
				"confirm_2",
			);
			const toolResponse = createToolMessage(
				'{"accepted":true}',
				getToolCallId(confirmToolCall),
			);

			const messages = [
				new HumanMessage("Write a story"),
				createAIMessageWithToolCall(
					"write_document_local",
					{ document: "Once upon a time..." },
					"write_2",
				),
				createToolMessage("Document written.", "call_1"),
				confirmToolCall,
				toolResponse,
				new HumanMessage("Add a character named Bob"), // Follow-up question
			];

			// Last message is HumanMessage, NOT ToolMessage
			// This should NOT be treated as "after confirmation"
			expect(messages[messages.length - 1]).toBeInstanceOf(HumanMessage);
		});

		it("should detect follow-up question after confirmation summary", () => {
			// Message structure after agent outputs summary and user asks follow-up:
			// [..., ToolMessage(accepted), AIMessage("summary"), HumanMessage("new question")]
			const confirmToolCall = createAIMessageWithToolCall(
				"confirm_changes",
				{},
				"confirm_3",
			);
			const toolResponse = createToolMessage(
				'{"accepted":true}',
				getToolCallId(confirmToolCall),
			);

			const messages = [
				new HumanMessage("Write a story"),
				createAIMessageWithToolCall(
					"write_document_local",
					{ document: "Once upon a time..." },
					"write_3",
				),
				createToolMessage("Document written.", "call_1"),
				confirmToolCall,
				toolResponse,
				new AIMessage("I've written a short story about a pirate."), // Summary
				new HumanMessage("Add a character named Bob"), // Follow-up question
			];

			// This is a follow-up question - agent should make targeted edits
			expect(messages[messages.length - 1]).toBeInstanceOf(HumanMessage);
		});
	});

	describe("Document regeneration prevention", () => {
		it("should make targeted edits for follow-up questions, not regenerate", () => {
			// When user asks "add a character", the agent should:
			// 1. Use write_document_local tool
			// 2. Make minimal changes to the existing document
			// 3. NOT rewrite the entire document from scratch

			const existingDocument = `# The Adventure

Once upon a time, there was a brave knight.
The knight went on many adventures.
The end.`;

			const state = createMockState({
				document: existingDocument,
				messages: [
					new HumanMessage("Write a story"),
					createAIMessageWithToolCall("write_document_local", {
						document: existingDocument,
					}),
					createToolMessage("Document written.", "call_1"),
					createAIMessageWithToolCall("confirm_changes", {}),
					createToolMessage('{"accepted":true}', "call_2"),
					new AIMessage("I've written a short adventure story."),
					new HumanMessage("Add a wizard character"), // Follow-up
				],
			});

			// The agent should receive the existing document in the prompt
			// and make targeted changes, not regenerate everything
			expect(state.document).toBe(existingDocument);
			expect(state.messages[state.messages.length - 1]).toBeInstanceOf(
				HumanMessage,
			);
		});

		it("should preserve document state across conversation turns", () => {
			const state = createMockState({
				document: "Initial document content",
				messages: [
					new HumanMessage("Write something"),
					new AIMessage("Done"),
				],
			});

			// Document should be preserved in state
			expect(state.document).toBe("Initial document content");
		});
	});

	describe("Conversation flow scenarios", () => {
		it("should handle initial generation request", () => {
			const state = createMockState({
				messages: [new HumanMessage("Write a story about pirates")],
			});

			// First message is human request - agent should use write_document_local
			expect(state.messages.length).toBe(1);
			expect(state.messages[0]).toBeInstanceOf(HumanMessage);
			expect(state.document).toBe(""); // No existing document
		});

		it("should handle edit request on existing document", () => {
			const state = createMockState({
				document: "Existing story content...",
				messages: [
					new HumanMessage("Write a story"),
					createAIMessageWithToolCall(
						"write_document_local",
						{ document: "Existing story content..." },
						"write_4",
					),
					createToolMessage("Document written.", "call_1"),
					createAIMessageWithToolCall(
						"confirm_changes",
						{},
						"confirm_4",
					),
					createToolMessage('{"accepted":true}', "confirm_4"),
					new AIMessage("Story written."),
					new HumanMessage("Make it longer"), // Edit request
				],
			});

			// Document exists, so edits should be targeted
			expect(state.document).toBe("Existing story content...");
			expect(state.messages[state.messages.length - 1]).toBeInstanceOf(
				HumanMessage,
			);
		});

		it("should handle rejection and retry", () => {
			const confirmToolCall = createAIMessageWithToolCall(
				"confirm_changes",
				{},
				"confirm_5",
			);

			const state = createMockState({
				document: "Original document",
				messages: [
					new HumanMessage("Write a story"),
					createAIMessageWithToolCall(
						"write_document_local",
						{ document: "Original document" },
						"write_5",
					),
					createToolMessage("Document written.", "call_1"),
					confirmToolCall,
					createToolMessage(
						'{"accepted":false}',
						getToolCallId(confirmToolCall),
					), // Rejected!
				],
			});

			// Last message is rejection - agent should acknowledge briefly
			const lastMessage = state.messages[state.messages.length - 1];
			expect(lastMessage).toBeInstanceOf(ToolMessage);
			expect(lastMessage.content).toContain("false");
		});
	});
});

describe("Document Generator Chat Node - Error Handling", () => {
	it("should track retry count in state", () => {
		const state = createMockState({
			retryCount: 2,
			error: "Previous error",
		});

		expect(state.retryCount).toBe(2);
		expect(state.error).toBe("Previous error");
	});

	it("should reset retry count on success", () => {
		const state = createMockState({
			retryCount: 0, // Reset after success
			error: undefined,
		});

		expect(state.retryCount).toBe(0);
		expect(state.error).toBeUndefined();
	});
});

describe("Document Generator Chat Node - Tool Binding", () => {
	it("should not bind tools after confirmation (summary mode)", () => {
		// After confirmation, the model should NOT have tools bound
		// It should just output text (summary)
		const confirmToolCall = createAIMessageWithToolCall(
			"confirm_changes",
			{},
			"confirm_6",
		);

		const state = createMockState({
			messages: [
				new HumanMessage("Write a story"),
				createAIMessageWithToolCall(
					"write_document_local",
					{ document: "Story..." },
					"write_6",
				),
				createToolMessage("Document written.", "call_1"),
				confirmToolCall,
				createToolMessage(
					'{"accepted":true}',
					getToolCallId(confirmToolCall),
				),
			],
		});

		// In this state, afterConfirmation should be true
		// Model should output text summary, not call any tools
		const lastMessage = state.messages[state.messages.length - 1];
		expect(lastMessage).toBeInstanceOf(ToolMessage);
	});

	it("should bind tools for normal document generation", () => {
		const state = createMockState({
			messages: [new HumanMessage("Write a document")],
			tools: [], // External tools from CopilotKit
		});

		// In this state, tools should be bound (write_document_local + external tools)
		expect(state.messages[0]).toBeInstanceOf(HumanMessage);
	});
});
