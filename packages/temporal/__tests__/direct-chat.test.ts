/**
 * Tests for Direct Chat Workflow Types and Configuration
 *
 * Tests the workflow types, input validation, and configuration.
 * Full workflow integration tests require Temporal's test server.
 *
 * Run with: pnpm --filter @repo/temporal test
 */

import { describe, expect, it } from "vitest";
import type {
	DirectChatToolCall,
	DirectChatWorkflowConfirmation,
	DirectChatWorkflowInput,
	DirectChatWorkflowOutput,
} from "../src/types";

describe("Direct Chat Workflow Types", () => {
	describe("DirectChatWorkflowInput", () => {
		it("should accept valid input with all required fields", () => {
			const input: DirectChatWorkflowInput = {
				executionId: "test-execution-1",
				message: "Hello, how are you?",
				history: [],
				userId: "user-123",
			};

			expect(input.executionId).toBe("test-execution-1");
			expect(input.message).toBe("Hello, how are you?");
			expect(input.userId).toBe("user-123");
		});

		it("should accept input with optional fields", () => {
			const input: DirectChatWorkflowInput = {
				executionId: "test-execution-2",
				message: "Test message",
				history: [
					{ role: "user", content: "Previous message" },
					{ role: "assistant", content: "Previous response" },
				],
				userId: "user-123",
				organizationId: "org-456",
				reasoningMode: "balanced",
				enabledMcpConfigIds: ["config-1", "config-2"],
				ragContext: "Some document context...",
				chatId: "chat-123",
			};

			expect(input.organizationId).toBe("org-456");
			expect(input.reasoningMode).toBe("balanced");
			expect(input.enabledMcpConfigIds).toHaveLength(2);
			expect(input.ragContext).toBe("Some document context...");
		});

		it("should accept input with attached document IDs", () => {
			const input: DirectChatWorkflowInput = {
				executionId: "test-execution-3",
				message: "What is in my document?",
				history: [],
				userId: "user-123",
				organizationId: "org-456",
				chatId: "chat-789",
				attachedDocumentIds: ["doc-1", "doc-2", "doc-3"],
			};

			expect(input.attachedDocumentIds).toHaveLength(3);
			expect(input.attachedDocumentIds).toContain("doc-1");
			expect(input.attachedDocumentIds).toContain("doc-2");
			expect(input.attachedDocumentIds).toContain("doc-3");
		});

		it("should handle empty attached document IDs", () => {
			const input: DirectChatWorkflowInput = {
				executionId: "test-execution-4",
				message: "No documents attached",
				history: [],
				userId: "user-123",
				attachedDocumentIds: [],
			};

			expect(input.attachedDocumentIds).toHaveLength(0);
		});
	});

	describe("DirectChatWorkflowOutput", () => {
		it("should represent successful response without tools", () => {
			const output: DirectChatWorkflowOutput = {
				success: true,
				responseText: "Hello! How can I help you today?",
				durationMs: 1500,
			};

			expect(output.success).toBe(true);
			expect(output.responseText).toBeDefined();
			expect(output.durationMs).toBeGreaterThan(0);
		});

		it("should represent response with tool calls", () => {
			const toolCalls: DirectChatToolCall[] = [
				{
					id: "call-1",
					name: "fizzy_get_boards",
					args: { account_slug: "test" },
					result: JSON.stringify([{ id: "1", name: "Board 1" }]),
					serverName: "fizzy-mcp",
					status: "complete",
				},
			];

			const output: DirectChatWorkflowOutput = {
				success: true,
				responseText: "I found 1 board.",
				toolCalls,
				durationMs: 2500,
			};

			expect(output.toolCalls).toHaveLength(1);
			expect(output.toolCalls?.[0].name).toBe("fizzy_get_boards");
			expect(output.toolCalls?.[0].serverName).toBe("fizzy-mcp");
		});

		it("should represent pending confirmation", () => {
			const confirmation: DirectChatWorkflowConfirmation = {
				workflowId: "workflow-123",
				workflowName: "Send Slack Notification",
				message: "Please confirm sending this notification",
			};

			const output: DirectChatWorkflowOutput = {
				success: true,
				pendingConfirmation: confirmation,
				durationMs: 500,
			};

			expect(output.pendingConfirmation).toBeDefined();
			expect(output.pendingConfirmation?.workflowId).toBe("workflow-123");
		});

		it("should represent failed execution", () => {
			const output: DirectChatWorkflowOutput = {
				success: false,
				error: "AI Gateway not configured",
				durationMs: 100,
			};

			expect(output.success).toBe(false);
			expect(output.error).toContain("AI Gateway");
		});
	});

	describe("DirectChatToolCall", () => {
		it("should represent MCP tool call with result", () => {
			const toolCall: DirectChatToolCall = {
				id: "call-abc123",
				name: "search_documentation",
				args: { query: "how to use RAG" },
				result: "Found 5 relevant documents...",
				serverName: "docs-mcp",
				status: "complete",
			};

			expect(toolCall.id).toBeDefined();
			expect(toolCall.name).toBe("search_documentation");
			expect(toolCall.args.query).toBe("how to use RAG");
			expect(toolCall.result).toBeDefined();
		});

		it("should represent workflow tool call", () => {
			const toolCall: DirectChatToolCall = {
				id: "call-xyz789",
				name: "list_workflows",
				args: {},
				result: JSON.stringify([
					{ id: "wf-1", name: "Daily Report" },
					{ id: "wf-2", name: "Slack Notification" },
				]),
				status: "complete",
			};

			expect(toolCall.name).toBe("list_workflows");
			expect(toolCall.serverName).toBeUndefined();
		});
	});
});
