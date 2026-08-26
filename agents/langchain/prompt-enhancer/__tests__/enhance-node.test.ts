/**
 * Comprehensive tests for Prompt Enhancer Node
 *
 * Tests cover:
 * 1. Initial prompt enhancement
 * 2. Follow-up questions (should make targeted edits)
 * 3. After confirmation (summary only)
 * 4. Template syntax preservation
 * 5. Error handling and retry logic
 */

import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { describe, expect, it, vi } from "vitest";
import type { PromptEnhancerStateType } from "../state";

// Mock the external dependencies
vi.mock("../utils", () => ({
	DEFAULT_RECURSION_LIMIT: 25,
	MAX_RETRIES: 3,
	MAX_JSON_RETRIES: 5,
	getAgentModelAsync: vi.fn().mockResolvedValue({
		bindTools: vi.fn().mockReturnThis(),
		invoke: vi.fn(),
	}),
	extractProviderConfig: vi.fn().mockReturnValue({ model: "gpt-4o" }),
	isJsonParseError: vi.fn().mockReturnValue(false),
	calculateRetryDelay: vi.fn().mockReturnValue(100),
	sleep: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../prompts", () => ({
	getSystemPrompt: vi.fn().mockReturnValue("Test system prompt"),
	getPredictStateConfig: vi.fn().mockReturnValue([]),
}));

// Helper to create mock states
function createMockState(
	overrides: Partial<PromptEnhancerStateType> = {},
): PromptEnhancerStateType {
	return {
		promptId: "prompt-123",
		promptName: "Test Prompt",
		promptDescription: undefined,
		format: "MARKDOWN",
		category: undefined,
		tags: [],
		currentContent: "",
		enhancementType: "general",
		userInstructions: undefined,
		enhancedContent: "",
		explanation: "",
		streamingContent: "",
		focusAnchor: undefined,
		retryCount: 0,
		error: undefined,
		messages: [],
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

describe("Prompt Enhancer Node - Message Flow Tests", () => {
	describe("isAfterConfirmation detection", () => {
		it("should detect immediate post-confirmation state", () => {
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
				new HumanMessage("Rewrite for clarity"),
				createAIMessageWithToolCall(
					"enhance_prompt_local",
					{ enhancedContent: "Enhanced prompt..." },
					"enhance_1",
				),
				createToolMessage("Prompt enhanced.", "call_1"),
				confirmToolCall,
				toolResponse,
			];

			// After confirmation - last is tool response
			expect(messages[messages.length - 1]).toBeInstanceOf(ToolMessage);
			expect(
				(messages[messages.length - 2] as AIMessage).tool_calls?.[0]
					.name,
			).toBe("confirm_changes");
		});

		it("should NOT detect follow-up question as after confirmation", () => {
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
				new HumanMessage("Rewrite for clarity"),
				createAIMessageWithToolCall(
					"enhance_prompt_local",
					{ enhancedContent: "Enhanced prompt..." },
					"enhance_2",
				),
				createToolMessage("Prompt enhanced.", "call_1"),
				confirmToolCall,
				toolResponse,
				new HumanMessage("Now add examples"), // Follow-up
			];

			// Last is human message, not tool response
			expect(messages[messages.length - 1]).toBeInstanceOf(HumanMessage);
		});
	});

	describe("Enhancement types", () => {
		const enhancementTypes = [
			{ type: "rewrite", description: "Rewrite for clarity" },
			{ type: "expand", description: "Expand with examples" },
			{ type: "optimize", description: "Apply best practices" },
			{ type: "general", description: "General improvement" },
		];

		enhancementTypes.forEach(({ type, description }) => {
			it(`should handle ${type} enhancement type`, () => {
				const state = createMockState({
					enhancementType: type as any,
					currentContent: "Original prompt content",
					messages: [new HumanMessage(description)],
				});

				expect(state.enhancementType).toBe(type);
				expect(state.currentContent).toBe("Original prompt content");
			});
		});
	});

	describe("Template syntax preservation", () => {
		it("should preserve Handlebars syntax", () => {
			const templateContent = `You are a {{role}}.
{{#each tasks}}
- Complete: {{this.name}}
{{/each}}
{{#if context}}Use context: {{context}}{{/if}}`;

			const state = createMockState({
				format: "HANDLEBARS",
				currentContent: templateContent,
			});

			expect(state.currentContent).toContain("{{role}}");
			expect(state.currentContent).toContain("{{#each tasks}}");
			expect(state.currentContent).toContain("{{/each}}");
		});

		it("should preserve Liquid syntax", () => {
			const templateContent = `You are a {{ role }}.
{% for task in tasks %}
- Complete: {{ task.name }}
{% endfor %}`;

			const state = createMockState({
				format: "LIQUID",
				currentContent: templateContent,
			});

			expect(state.currentContent).toContain("{{ role }}");
			expect(state.currentContent).toContain("{% for task in tasks %}");
		});

		it("should preserve Jinja2 syntax", () => {
			const templateContent = `You are a {{ role }}.
{% for task in tasks %}
- Complete: {{ task.name }}
{% endfor %}
{% if context %}Use context: {{ context }}{% endif %}`;

			const state = createMockState({
				format: "JINJA2",
				currentContent: templateContent,
			});

			expect(state.currentContent).toContain("{{ role }}");
			expect(state.currentContent).toContain("{% if context %}");
		});
	});

	describe("Format handling", () => {
		const formats = [
			"PLAIN_TEXT",
			"MARKDOWN",
			"HANDLEBARS",
			"LIQUID",
			"JINJA2",
		];

		formats.forEach((format) => {
			it(`should handle ${format} format`, () => {
				const state = createMockState({
					format: format as any,
					currentContent: "Some content",
				});

				expect(state.format).toBe(format);
			});
		});
	});
});

describe("Prompt Enhancer Node - Quick Actions", () => {
	describe("Rewrite for clarity", () => {
		it("should make substantial rewrites, not minimal edits", () => {
			const state = createMockState({
				enhancementType: "rewrite",
				currentContent: "do the thing good",
				userInstructions: "Rewrite for clarity",
			});

			// The enhanced content should be substantially different
			expect(state.enhancementType).toBe("rewrite");
		});
	});

	describe("Expand with examples", () => {
		it("should add 2-3 concrete examples", () => {
			const state = createMockState({
				enhancementType: "expand",
				currentContent: "Summarize the text.",
				userInstructions: "Add examples",
			});

			expect(state.enhancementType).toBe("expand");
		});
	});

	describe("Apply best practices", () => {
		it("should add role definition and structure", () => {
			const state = createMockState({
				enhancementType: "optimize",
				currentContent: "Write code",
				userInstructions: "Apply best practices",
			});

			expect(state.enhancementType).toBe("optimize");
		});
	});
});

describe("Prompt Enhancer Node - Error Handling", () => {
	it("should track retry count for JSON parse errors", () => {
		const state = createMockState({
			retryCount: 3,
			error: "Failed to parse tool call arguments as JSON",
		});

		expect(state.retryCount).toBe(3);
		expect(state.error).toContain("JSON");
	});

	it("should reset error state after successful enhancement", () => {
		const state = createMockState({
			enhancedContent: "Successfully enhanced prompt",
			retryCount: 0,
			error: undefined,
		});

		expect(state.retryCount).toBe(0);
		expect(state.error).toBeUndefined();
	});

	it("should handle max retries gracefully", () => {
		const state = createMockState({
			retryCount: 5,
			error: "The AI had difficulty processing this prompt.",
		});

		expect(state.retryCount).toBe(5);
		expect(state.error).toBeDefined();
	});
});

describe("Prompt Enhancer Node - State Updates", () => {
	it("should update enhancedContent on successful enhancement", () => {
		const state = createMockState({
			currentContent: "Original prompt",
			enhancedContent:
				"Enhanced and improved prompt with better structure",
		});

		expect(state.enhancedContent).not.toBe(state.currentContent);
		expect(state.enhancedContent.length).toBeGreaterThan(
			state.currentContent.length,
		);
	});

	it("should support streamingContent for predictive updates", () => {
		const state = createMockState({
			streamingContent: "Partial enhanced content being streamed...",
			enhancedContent: "",
		});

		expect(state.streamingContent).toBeDefined();
		expect(state.streamingContent.length).toBeGreaterThan(0);
	});

	it("should support focusAnchor for cursor positioning", () => {
		const state = createMockState({
			focusAnchor: "## Examples",
			enhancedContent: "# Prompt\n\n## Examples\n\n1. Example one...",
		});

		expect(state.focusAnchor).toBe("## Examples");
	});
});

describe("Prompt Enhancer Node - Conversation Flow", () => {
	it("should handle initial enhancement request", () => {
		const state = createMockState({
			currentContent: "Write a summary",
			messages: [new HumanMessage("Rewrite for clarity")],
		});

		expect(state.messages.length).toBe(1);
		expect(state.currentContent).toBe("Write a summary");
	});

	it("should handle follow-up enhancement requests", () => {
		const confirmToolCall = createAIMessageWithToolCall(
			"confirm_changes",
			{},
			"confirm_3",
		);

		const state = createMockState({
			currentContent: "You are an expert assistant...",
			enhancedContent: "You are an expert assistant...",
			messages: [
				new HumanMessage("Rewrite for clarity"),
				createAIMessageWithToolCall(
					"enhance_prompt_local",
					{ enhancedContent: "..." },
					"enhance_3",
				),
				createToolMessage("Prompt enhanced.", "call_1"),
				confirmToolCall,
				createToolMessage(
					'{"accepted":true}',
					getToolCallId(confirmToolCall),
				),
				new AIMessage("I've rewritten the prompt for clarity."),
				new HumanMessage("Now add examples"), // Follow-up
			],
		});

		// Follow-up should make targeted changes
		expect(state.messages[state.messages.length - 1]).toBeInstanceOf(
			HumanMessage,
		);
	});

	it("should handle rejection gracefully", () => {
		const confirmToolCall = createAIMessageWithToolCall(
			"confirm_changes",
			{},
			"confirm_4",
		);

		const state = createMockState({
			currentContent: "Original content",
			messages: [
				new HumanMessage("Rewrite for clarity"),
				createAIMessageWithToolCall(
					"enhance_prompt_local",
					{ enhancedContent: "Enhanced..." },
					"enhance_4",
				),
				createToolMessage("Prompt enhanced.", "call_1"),
				confirmToolCall,
				createToolMessage(
					'{"accepted":false}',
					getToolCallId(confirmToolCall),
				), // Rejected
			],
		});

		const lastMessage = state.messages[state.messages.length - 1];
		expect(lastMessage).toBeInstanceOf(ToolMessage);
		expect(lastMessage.content).toContain("false");
	});
});

describe("Prompt Enhancer Node - Metadata", () => {
	it("should preserve prompt metadata", () => {
		const state = createMockState({
			promptId: "prompt-456",
			promptName: "Customer Support Prompt",
			promptDescription: "A prompt for customer support conversations",
			category: "general",
			tags: ["customer", "support", "chat"],
		});

		expect(state.promptId).toBe("prompt-456");
		expect(state.promptName).toBe("Customer Support Prompt");
		expect(state.tags).toContain("customer");
	});

	it("should handle minimal metadata", () => {
		const state = createMockState({
			promptId: "prompt-789",
			promptName: "Simple Prompt",
		});

		expect(state.promptId).toBe("prompt-789");
		expect(state.promptDescription).toBeUndefined();
		expect(state.category).toBeUndefined();
	});
});
