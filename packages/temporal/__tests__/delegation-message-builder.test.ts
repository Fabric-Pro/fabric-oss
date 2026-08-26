/**
 * Delegation Message Builder Tests
 *
 * Tests for building context-aware delegation messages for agents.
 * Run with: pnpm --filter @repo/temporal test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildDelegationMessage,
	summarizeConversationHistory,
	truncateText,
} from "../src/activities/orchestrator/delegation/message-builder";
import type { AgentCardCapabilities } from "../src/activities/orchestrator/types";

describe("truncateText", () => {
	it("should return original text if under max length", () => {
		const text = "Short text";
		const result = truncateText(text, 100);
		expect(result).toBe("Short text");
	});

	it("should truncate text and add ellipsis if over max length", () => {
		const text = "This is a longer text that should be truncated";
		const result = truncateText(text, 20);
		expect(result).toBe("This is a longer tex...");
		expect(result.length).toBe(23); // 20 + 3 for "..."
	});

	it("should handle empty string", () => {
		const result = truncateText("", 100);
		expect(result).toBe("");
	});

	it("should handle exactly max length", () => {
		const text = "Exactly20Characters!";
		const result = truncateText(text, 20);
		expect(result).toBe("Exactly20Characters!");
	});
});

describe("summarizeConversationHistory", () => {
	it("should return empty string for empty history", () => {
		const result = summarizeConversationHistory([]);
		expect(result).toBe("");
	});

	it("should return empty string for undefined/null history", () => {
		// @ts-expect-error testing edge case
		const result = summarizeConversationHistory(null);
		expect(result).toBe("");
	});

	it("should format user and assistant messages", () => {
		const history = [
			{ role: "user", content: "Hello" },
			{ role: "assistant", content: "Hi there!" },
		];
		const result = summarizeConversationHistory(history);
		expect(result).toContain("User: Hello");
		expect(result).toContain("Assistant: Hi there!");
	});

	it("should take only last N messages", () => {
		const history = [
			{ role: "user", content: "Message 1" },
			{ role: "assistant", content: "Response 1" },
			{ role: "user", content: "Message 2" },
			{ role: "assistant", content: "Response 2" },
			{ role: "user", content: "Message 3" },
			{ role: "assistant", content: "Response 3" },
			{ role: "user", content: "Message 4" },
		];
		const result = summarizeConversationHistory(history, 3);
		expect(result).not.toContain("Message 1");
		expect(result).not.toContain("Message 2");
		expect(result).toContain("Response 3");
		expect(result).toContain("Message 4");
	});

	it("should truncate long messages", () => {
		const longContent = "A".repeat(500);
		const history = [{ role: "user", content: longContent }];
		const result = summarizeConversationHistory(history);
		expect(result).toContain("...");
		expect(result.length).toBeLessThan(500);
	});

	it("should handle system role", () => {
		const history = [{ role: "system", content: "System message" }];
		const result = summarizeConversationHistory(history);
		expect(result).toContain("System: System message");
	});
});

describe("buildDelegationMessage", () => {
	// Suppress console.log during tests
	beforeEach(() => {
		vi.spyOn(console, "log").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("generalist agent delegation", () => {
		const generalistCapabilities: AgentCardCapabilities = {
			autonomousExecution: true,
			taskDecomposition: true,
			multiStepPlanning: true,
			streaming: true,
			pushNotifications: false,
			stateTransitionHistory: false,
		};

		it("should return original message for generalist agent without history", () => {
			const result = buildDelegationMessage(
				"Create a PRD for a todo app",
				generalistCapabilities,
				{},
			);
			expect(result).toBe("Create a PRD for a todo app");
		});

		it("should add conversation context for generalist agent with history", () => {
			const result = buildDelegationMessage(
				"Now add user stories",
				generalistCapabilities,
				{
					conversationHistory: [
						{
							role: "user",
							content: "Create a PRD for a todo app",
						},
						{
							role: "assistant",
							content: "I created a PRD with features...",
						},
					],
				},
			);
			expect(result).toContain("Context from previous conversation");
			expect(result).toContain("Create a PRD for a todo app");
			expect(result).toContain("Now add user stories");
		});

		it("should use complete-task delegation mode for generalist", () => {
			const result = buildDelegationMessage(
				"Build a complete app",
				generalistCapabilities,
				{
					delegationMode: "complete-task",
				},
			);
			// Generalist gets high-level message, no step-by-step instructions
			expect(result).toBe("Build a complete app");
		});
	});

	describe("specialist agent delegation", () => {
		const specialistCapabilities: AgentCardCapabilities = {
			autonomousExecution: false,
			taskDecomposition: false,
			multiStepPlanning: false,
			streaming: true,
			pushNotifications: false,
			stateTransitionHistory: false,
		};

		it("should return original message for specialist without context", () => {
			const result = buildDelegationMessage(
				"Generate a summary",
				specialistCapabilities,
				{},
			);
			expect(result).toBe("Generate a summary");
		});

		it("should add previous step results for specialist", () => {
			const result = buildDelegationMessage(
				"Now format the output",
				specialistCapabilities,
				{
					previousStepResults: [
						{
							stepId: "step-1",
							stepDescription: "Extract data",
							response: "Extracted data: {items: [1,2,3]}",
						},
					],
				},
			);
			expect(result).toContain("Previous step results");
			expect(result).toContain("Extract data");
			expect(result).toContain("Extracted data");
			expect(result).toContain("Now format the output");
		});

		it("should add variables context for specialist", () => {
			const result = buildDelegationMessage(
				"Process the data",
				specialistCapabilities,
				{
					variables: {
						projectId: "proj-123",
						userId: "user-456",
					},
				},
			);
			expect(result).toContain("Available context");
			expect(result).toContain("projectId");
			expect(result).toContain("proj-123");
		});

		it("should filter out system variables", () => {
			const result = buildDelegationMessage(
				"Process the data",
				specialistCapabilities,
				{
					variables: {
						projectId: "proj-123",
						"sys.internal": "should-not-appear",
						"sys.timestamp": 12345,
					},
				},
			);
			expect(result).toContain("projectId");
			expect(result).not.toContain("sys.internal");
			expect(result).not.toContain("sys.timestamp");
		});

		it("should limit variables to 10", () => {
			const variables: Record<string, unknown> = {};
			for (let i = 0; i < 15; i++) {
				variables[`var${i}`] = `value${i}`;
			}
			const result = buildDelegationMessage(
				"Process",
				specialistCapabilities,
				{ variables },
			);
			// Should have some variables but not all 15
			const varMatches = result.match(/var\d+/g);
			expect(varMatches).toBeTruthy();
			expect(varMatches?.length).toBeLessThanOrEqual(10);
		});
	});

	describe("undefined capabilities", () => {
		it("should handle undefined capabilities as specialist", () => {
			const result = buildDelegationMessage("Do something", undefined, {
				previousStepResults: [
					{
						stepId: "step-1",
						stepDescription: "Previous step",
						response: "Some result",
					},
				],
			});
			// Should behave as specialist (add step results)
			expect(result).toContain("Previous step results");
		});
	});

	describe("explicit delegation mode override", () => {
		const generalistCapabilities: AgentCardCapabilities = {
			autonomousExecution: true,
			taskDecomposition: true,
			multiStepPlanning: false,
			streaming: false,
			pushNotifications: false,
			stateTransitionHistory: false,
		};

		it("should respect single-step override for generalist", () => {
			const result = buildDelegationMessage(
				"Do a step",
				generalistCapabilities,
				{
					delegationMode: "single-step",
					previousStepResults: [
						{
							stepId: "step-1",
							stepDescription: "First step",
							response: "Done",
						},
					],
				},
			);
			// Should include step results even though it's a generalist
			expect(result).toContain("Previous step results");
		});
	});

	describe("truncation of step results", () => {
		const specialistCapabilities: AgentCardCapabilities = {
			autonomousExecution: false,
			taskDecomposition: false,
			multiStepPlanning: false,
			streaming: false,
			pushNotifications: false,
			stateTransitionHistory: false,
		};

		it("should truncate long step responses", () => {
			const longResponse = "X".repeat(1000);
			const result = buildDelegationMessage(
				"Next step",
				specialistCapabilities,
				{
					previousStepResults: [
						{
							stepId: "step-1",
							stepDescription: "Long result step",
							response: longResponse,
						},
					],
				},
			);
			expect(result).toContain("...");
			expect(result.length).toBeLessThan(longResponse.length);
		});
	});
});
