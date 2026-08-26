/**
 * Nodes Module Tests
 *
 * Tests for the enhance node functionality.
 */

import {
	AIMessage,
	HumanMessage,
	SystemMessage,
} from "@langchain/core/messages";
import { Command, END } from "@langchain/langgraph";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the dependencies before importing the node
vi.mock("../utils", () => ({
	DEFAULT_RECURSION_LIMIT: 25,
	getAgentModelAsync: vi.fn(() =>
		Promise.resolve({
			bindTools: vi.fn(() => ({
				invoke: vi.fn(),
			})),
		}),
	),
	extractProviderConfig: vi.fn(() => ({
		apiKey: "test-key",
		model: "test-model",
		baseUrl: "https://test.com",
	})),
}));

vi.mock("@repo/agent-tools", () => ({
	ENHANCE_PROMPT_TOOL: {
		name: "enhance_prompt_local",
		description: "Enhance a prompt",
		schema: {},
	},
}));

import { enhanceNode } from "../nodes";
import type { PromptEnhancerStateType } from "../state";
import { getAgentModelAsync } from "../utils";

describe("enhanceNode", () => {
	const mockInvoke = vi.fn();
	const mockBindTools = vi.fn(() => ({
		invoke: mockInvoke,
	}));

	beforeEach(() => {
		vi.clearAllMocks();
		(getAgentModelAsync as ReturnType<typeof vi.fn>).mockResolvedValue({
			bindTools: mockBindTools,
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	const createMockState = (
		overrides: Partial<PromptEnhancerStateType> = {},
	): PromptEnhancerStateType => ({
		promptId: "test-prompt-id",
		promptName: "Test Prompt",
		promptDescription: undefined,
		format: "MARKDOWN",
		category: undefined,
		tags: [],
		currentContent: "Original prompt content",
		enhancementType: "general",
		userInstructions: undefined,
		enhancedContent: "",
		explanation: "",
		streamingContent: "",
		focusAnchor: undefined,
		retryCount: 0,
		error: undefined,
		messages: [new HumanMessage("Please improve this prompt")],
		...overrides,
	});

	describe("basic functionality", () => {
		it("should be a function", () => {
			expect(typeof enhanceNode).toBe("function");
		});

		it("should accept state and config parameters", () => {
			expect(enhanceNode.length).toBe(2);
		});
	});

	describe("model invocation", () => {
		it("should create a model", async () => {
			mockInvoke.mockResolvedValue(new AIMessage("Enhanced response"));
			const state = createMockState();

			await enhanceNode(state, {});

			expect(getAgentModelAsync).toHaveBeenCalled();
		});

		it("should bind tools to the model", async () => {
			mockInvoke.mockResolvedValue(new AIMessage("Response"));
			const state = createMockState();

			await enhanceNode(state, {});

			expect(mockBindTools).toHaveBeenCalled();
		});

		it("should invoke the model with messages", async () => {
			mockInvoke.mockResolvedValue(new AIMessage("Response"));
			const state = createMockState();

			await enhanceNode(state, {});

			expect(mockInvoke).toHaveBeenCalled();
			const invokeArgs = mockInvoke.mock.calls[0];
			expect(invokeArgs[0]).toHaveLength(2); // system + user message
			expect(invokeArgs[0][0]).toBeInstanceOf(SystemMessage);
		});

		it("should pass config to model invocation", async () => {
			mockInvoke.mockResolvedValue(new AIMessage("Response"));
			const state = createMockState();
			const config = { metadata: { test: true } };

			await enhanceNode(state, config);

			expect(mockInvoke).toHaveBeenCalled();
			const invokeArgs = mockInvoke.mock.calls[0];
			expect(invokeArgs[1]).toBeDefined();
		});
	});

	describe("tool call handling", () => {
		it("should handle enhance_prompt_local tool call", async () => {
			const toolCallResponse = new AIMessage({
				content: "",
				tool_calls: [
					{
						id: "call-1",
						name: "enhance_prompt_local",
						args: {
							enhancedContent: "Enhanced prompt content",
							focusAnchor: "## Section",
						},
					},
				],
			});
			mockInvoke.mockResolvedValue(toolCallResponse);
			const state = createMockState();

			const result = await enhanceNode(state, {});

			expect(result).toBeInstanceOf(Command);
			expect(result.update).toHaveProperty(
				"enhancedContent",
				"Enhanced prompt content",
			);
			expect(result.update).toHaveProperty("focusAnchor", "## Section");
			expect(result.goto).toContain(END);
		});

		it("should update streamingContent with enhanced content", async () => {
			const toolCallResponse = new AIMessage({
				content: "",
				tool_calls: [
					{
						id: "call-1",
						name: "enhance_prompt_local",
						args: {
							enhancedContent: "Streaming enhanced content",
						},
					},
				],
			});
			mockInvoke.mockResolvedValue(toolCallResponse);
			const state = createMockState();

			const result = await enhanceNode(state, {});

			expect(result.update).toHaveProperty(
				"streamingContent",
				"Streaming enhanced content",
			);
		});

		it("should handle tool call without focusAnchor", async () => {
			const toolCallResponse = new AIMessage({
				content: "",
				tool_calls: [
					{
						id: "call-1",
						name: "enhance_prompt_local",
						args: {
							enhancedContent: "Enhanced content only",
						},
					},
				],
			});
			mockInvoke.mockResolvedValue(toolCallResponse);
			const state = createMockState();

			const result = await enhanceNode(state, {});

			expect(result.update).toHaveProperty(
				"enhancedContent",
				"Enhanced content only",
			);
			expect(
				(result.update as Record<string, unknown>).focusAnchor,
			).toBeUndefined();
		});

		it("should add confirm_changes tool call after enhancement", async () => {
			const toolCallResponse = new AIMessage({
				content: "",
				tool_calls: [
					{
						id: "call-1",
						name: "enhance_prompt_local",
						args: {
							enhancedContent: "Enhanced",
						},
					},
				],
			});
			mockInvoke.mockResolvedValue(toolCallResponse);
			const state = createMockState();

			const result = await enhanceNode(state, {});

			const messages = (result.update as Record<string, unknown>)
				.messages as unknown[];
			const lastMessage = messages[messages.length - 1] as {
				tool_calls: { function: { name: string } }[];
			};
			expect(lastMessage.tool_calls).toBeDefined();
			expect(lastMessage.tool_calls[0].function.name).toBe(
				"confirm_changes",
			);
		});
	});

	describe("fallback handling", () => {
		it("should handle response without tool calls", async () => {
			mockInvoke.mockResolvedValue(new AIMessage("Just a text response"));
			const state = createMockState();

			const result = await enhanceNode(state, {});

			expect(result).toBeInstanceOf(Command);
			expect(result.goto).toContain(END);
			expect(
				(result.update as Record<string, unknown>).messages,
			).toBeDefined();
		});

		it("should preserve messages in fallback", async () => {
			mockInvoke.mockResolvedValue(new AIMessage("Text response"));
			const state = createMockState({
				messages: [new HumanMessage("Original message")],
			});

			const result = await enhanceNode(state, {});

			expect(
				(
					(result.update as Record<string, unknown>)
						.messages as unknown[]
				).length,
			).toBeGreaterThan(1);
		});
	});

	describe("config handling", () => {
		it("should handle undefined config", async () => {
			mockInvoke.mockResolvedValue(new AIMessage("Response"));
			const state = createMockState();

			// Should not throw
			await expect(
				enhanceNode(state, undefined as any),
			).resolves.toBeDefined();
		});

		it("should set predict_state metadata", async () => {
			mockInvoke.mockResolvedValue(new AIMessage("Response"));
			const state = createMockState();
			const config = {};

			await enhanceNode(state, config);

			const invokeArgs = mockInvoke.mock.calls[0];
			expect(invokeArgs[1].metadata.predict_state).toBeDefined();
		});

		it("should preserve existing metadata", async () => {
			mockInvoke.mockResolvedValue(new AIMessage("Response"));
			const state = createMockState();
			const config = { metadata: { existingKey: "value" } };

			await enhanceNode(state, config);

			const invokeArgs = mockInvoke.mock.calls[0];
			expect(invokeArgs[1].metadata.existingKey).toBe("value");
			expect(invokeArgs[1].metadata.predict_state).toBeDefined();
		});
	});

	describe("state processing", () => {
		it("should use currentContent in system prompt", async () => {
			mockInvoke.mockResolvedValue(new AIMessage("Response"));
			const state = createMockState({
				currentContent: "Specific content to enhance",
			});

			await enhanceNode(state, {});

			const invokeArgs = mockInvoke.mock.calls[0];
			const systemMessage = invokeArgs[0][0];
			expect(systemMessage.content).toContain(
				"Specific content to enhance",
			);
		});

		it("should handle empty currentContent", async () => {
			mockInvoke.mockResolvedValue(new AIMessage("Response"));
			const state = createMockState({
				currentContent: "",
			});

			await enhanceNode(state, {});

			const invokeArgs = mockInvoke.mock.calls[0];
			const systemMessage = invokeArgs[0][0];
			// Empty content means no "Current prompt:" section is added
			expect(systemMessage.content).not.toContain("Current prompt:");
		});
	});
});

describe("Node exports", () => {
	it("should export enhanceNode", () => {
		expect(enhanceNode).toBeDefined();
	});
});
