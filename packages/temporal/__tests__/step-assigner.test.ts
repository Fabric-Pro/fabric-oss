/**
 * Step Assigner Tests
 *
 * Tests for the step-assigner module that assigns the optimal executor
 * (MCP tool, agent, workflow) to each step based on capability matching.
 *
 * CRITICAL REGRESSION TESTS:
 * - Tool selection must prioritize exact matches over partial word matches
 * - e.g., "youtube transcript" should match fabric_youtube_transcript, NOT fabric_youtube_metadata
 */

import { describe, expect, it } from "vitest";
import {
	analyzeStepRequirements,
	assignStepExecutor,
	assignStepExecutors,
	CAPABILITY_PRIORITY,
	type CapabilityType,
} from "../src/activities/orchestrator/planning/step-assigner";
import type {
	Capability,
	CapabilityMatch,
	TaskStep,
} from "../src/activities/orchestrator/types";

// Helper to create a mock TaskStep
function createMockStep(
	id: string,
	description: string,
	overrides: Partial<TaskStep> = {},
): TaskStep {
	return {
		id,
		description,
		type: "api", // Valid TaskType
		status: "pending",
		order: 1,
		inputs: {},
		outputs: {},
		...overrides,
	};
}

// Helper to create a mock CapabilityMatch
function createMockCapabilityMatch(
	id: string,
	name: string,
	description: string,
	type: CapabilityType = "mcp_tool",
	score = 0.8,
	matchedNeeds: string[] = [],
): CapabilityMatch {
	return {
		capability: {
			id,
			name,
			description,
			type: type as "agent" | "mcp_tool" | "workflow" | "integration",
			skills: [],
			inputTypes: [],
			outputTypes: [],
			parameters: {},
			requiresApproval: false,
			riskLevel: "low",
			isAvailable: true,
			healthStatus: "healthy",
		} as Capability,
		score,
		matchedNeeds,
		suggestedUse: `Use ${name} for this task`,
	};
}

describe("Step Assigner", () => {
	describe("analyzeStepRequirements", () => {
		it("should detect YouTube service keywords", () => {
			const step = createMockStep(
				"1",
				"Extract transcript from YouTube video",
			);
			const requirements = analyzeStepRequirements(step);

			expect(requirements.needsMcpAccess).toBe(true);
			expect(requirements.involvedServices).toContain("youtube");
			expect(requirements.involvedServices).toContain("transcript");
		});

		it("should detect browser automation keywords", () => {
			const step = createMockStep(
				"1",
				"Navigate to website and click login button",
			);
			const requirements = analyzeStepRequirements(step);

			expect(requirements.needsBrowserAutomation).toBe(true);
		});

		it("should detect read-only operations", () => {
			const readStep = createMockStep(
				"1",
				"Get the current board status",
			);
			const readRequirements = analyzeStepRequirements(readStep);
			expect(readRequirements.isReadOnly).toBe(true);

			const writeStep = createMockStep(
				"2",
				"Create a new card on the board",
			);
			const writeRequirements = analyzeStepRequirements(writeStep);
			expect(writeRequirements.isReadOnly).toBe(false);
		});
	});

	describe("assignStepExecutors - Tool Selection Priority", () => {
		/**
		 * CRITICAL REGRESSION TEST:
		 * When step mentions "youtube transcript", it should select fabric_youtube_transcript
		 * NOT fabric_youtube_metadata, even though both contain "youtube"
		 */
		it("should prioritize exact tool name match over partial word match", () => {
			const step = createMockStep(
				"1",
				"Extract the youtube transcript from this video",
			);

			const capabilities = [
				createMockCapabilityMatch(
					"fabric_youtube_transcript",
					"fabric_youtube_transcript",
					"Extract transcript from YouTube videos",
				),
				createMockCapabilityMatch(
					"fabric_youtube_metadata",
					"fabric_youtube_metadata",
					"Get metadata from YouTube videos",
				),
				createMockCapabilityMatch(
					"fabric_youtube_comments",
					"fabric_youtube_comments",
					"Get comments from YouTube videos",
				),
			];

			const [assignment] = assignStepExecutors([step], capabilities);

			// Must select fabric_youtube_transcript because "transcript" is in the step description
			expect(assignment.assignedExecutor.id).toBe(
				"fabric_youtube_transcript",
			);
		});

		it("should select metadata tool when step mentions metadata", () => {
			const step = createMockStep(
				"1",
				"Get youtube metadata for this video",
			);

			const capabilities = [
				createMockCapabilityMatch(
					"fabric_youtube_transcript",
					"fabric_youtube_transcript",
					"Extract transcript from YouTube videos",
				),
				createMockCapabilityMatch(
					"fabric_youtube_metadata",
					"fabric_youtube_metadata",
					"Get metadata from YouTube videos",
				),
			];

			const [assignment] = assignStepExecutors([step], capabilities);

			expect(assignment.assignedExecutor.id).toBe(
				"fabric_youtube_metadata",
			);
		});

		it("should select comments tool when step mentions comments", () => {
			const step = createMockStep(
				"1",
				"Get all comments from this youtube video",
			);

			const capabilities = [
				createMockCapabilityMatch(
					"fabric_youtube_transcript",
					"fabric_youtube_transcript",
					"Extract transcript from YouTube videos",
				),
				createMockCapabilityMatch(
					"fabric_youtube_comments",
					"fabric_youtube_comments",
					"Get comments from YouTube videos",
				),
			];

			const [assignment] = assignStepExecutors([step], capabilities);

			expect(assignment.assignedExecutor.id).toBe(
				"fabric_youtube_comments",
			);
		});

		/**
		 * CRITICAL REGRESSION TEST:
		 * When only "youtube" is mentioned without specific action,
		 * the tool with highest overall match score should be selected
		 */
		it("should handle ambiguous youtube references using score", () => {
			const step = createMockStep("1", "Process this youtube video");

			const capabilities = [
				createMockCapabilityMatch(
					"fabric_youtube_transcript",
					"fabric_youtube_transcript",
					"Extract transcript from YouTube videos",
					"mcp_tool",
					0.9, // Higher score
				),
				createMockCapabilityMatch(
					"fabric_youtube_metadata",
					"fabric_youtube_metadata",
					"Get metadata from YouTube videos",
					"mcp_tool",
					0.7, // Lower score
				),
			];

			const [assignment] = assignStepExecutors([step], capabilities);

			// Should still select based on match score when no discriminating words
			// Both match only on "youtube" (single word) = score 25
			// Then sorted by capability score, so transcript (0.9) wins
			expect(assignment.assignedExecutor.id).toBe(
				"fabric_youtube_transcript",
			);
		});

		it("should prioritize exact ID match in step description", () => {
			const step = createMockStep(
				"1",
				"Use fabric_youtube_metadata to get video info",
			);

			const capabilities = [
				createMockCapabilityMatch(
					"fabric_youtube_transcript",
					"fabric_youtube_transcript",
					"Extract transcript from YouTube videos",
				),
				createMockCapabilityMatch(
					"fabric_youtube_metadata",
					"fabric_youtube_metadata",
					"Get metadata from YouTube videos",
				),
			];

			const [assignment] = assignStepExecutors([step], capabilities);

			// Must select fabric_youtube_metadata because exact ID is in description
			expect(assignment.assignedExecutor.id).toBe(
				"fabric_youtube_metadata",
			);
		});
	});

	describe("assignStepExecutor - Single Step", () => {
		it("should fallback to LLM when no capabilities provided", () => {
			const step = createMockStep(
				"1",
				"Write a creative poem about coding",
			);

			// No capabilities provided - should fallback to LLM
			const capabilities: CapabilityMatch[] = [];

			const assignment = assignStepExecutor(step, capabilities);

			// Should fallback to LLM since no capabilities available
			expect(assignment.assignedExecutor.type).toBe("llm");
			expect(assignment.assignedExecutor.id).toBe("llm_fallback");
		});

		it("should respect capability type priority", () => {
			const step = createMockStep("1", "Get board status from fizzy");

			// Create capabilities with different types
			const capabilities: CapabilityMatch[] = [
				createMockCapabilityMatch(
					"fizzy_get_board",
					"fizzy_get_board",
					"Get board from Fizzy",
					"mcp_tool", // Priority 1
					0.8,
				),
				createMockCapabilityMatch(
					"fizzy_agent",
					"Fizzy Agent",
					"Agent for managing Fizzy boards",
					"agent", // Priority 3
					0.9, // Higher score but lower priority
				),
			];

			const assignment = assignStepExecutor(step, capabilities);

			// MCP tool should be selected even though agent has higher score
			expect(assignment.assignedExecutor.type).toBe("mcp_tool");
		});
	});

	describe("CAPABILITY_PRIORITY", () => {
		it("should have correct priority ordering", () => {
			expect(CAPABILITY_PRIORITY.mcp_tool).toBe(1);
			expect(CAPABILITY_PRIORITY.integration).toBe(2);
			expect(CAPABILITY_PRIORITY.agent).toBe(3);
			expect(CAPABILITY_PRIORITY.workflow).toBe(4);
			expect(CAPABILITY_PRIORITY.llm).toBe(5);
			expect(CAPABILITY_PRIORITY.web).toBe(6);
		});
	});

	describe("assignStepExecutors - KEYWORDS Matching (BM25-style)", () => {
		/**
		 * CRITICAL REGRESSION TEST:
		 * Tool descriptions can include KEYWORDS sections with user-language phrases.
		 * These should be used for deterministic matching (like BM25).
		 */
		it("should match tools using KEYWORDS from description", () => {
			const step = createMockStep(
				"1",
				"Get the transcript for this video",
			);

			// Tool with KEYWORDS section matching user language
			const transcriptTool = createMockCapabilityMatch(
				"fabric_youtube_transcript",
				"fabric_youtube_transcript",
				"Get the transcript from a YouTube video. KEYWORDS: get transcript, download transcript, youtube transcript, video transcript.",
			);

			// Tool without matching keywords
			const analyzeTool = createMockCapabilityMatch(
				"fabric_analyze_youtube",
				"fabric_analyze_youtube",
				"Analyze and summarize a YouTube video. KEYWORDS: summarize video, analyze video, video summary.",
			);

			const [assignment] = assignStepExecutors(
				[step],
				[transcriptTool, analyzeTool],
			);

			// Must select transcript tool because "get transcript" matches its KEYWORDS
			expect(assignment.assignedExecutor.id).toBe(
				"fabric_youtube_transcript",
			);
		});

		it("should match multiple keywords for higher confidence", () => {
			const step = createMockStep(
				"1",
				"Get the youtube transcript for this video",
			);

			const transcriptTool = createMockCapabilityMatch(
				"fabric_youtube_transcript",
				"fabric_youtube_transcript",
				"KEYWORDS: get transcript, download transcript, youtube transcript, video transcript.",
			);

			const metadataTool = createMockCapabilityMatch(
				"fabric_youtube_metadata",
				"fabric_youtube_metadata",
				"KEYWORDS: video info, metadata, video details.",
			);

			const [assignment] = assignStepExecutors(
				[step],
				[transcriptTool, metadataTool],
			);

			// "youtube transcript" matches both "youtube transcript" and "get transcript"
			expect(assignment.assignedExecutor.id).toBe(
				"fabric_youtube_transcript",
			);
		});
	});

	describe("assignStepExecutors - Original User Message Intent", () => {
		/**
		 * CRITICAL REGRESSION TEST:
		 * When LLM generates a step description that doesn't capture user's exact intent,
		 * the original user message should be used to select the correct tool.
		 * e.g., User says "get the transcript" but LLM generates "Extract content from video"
		 */
		it("should use original user message for intent matching when step description is vague", () => {
			// LLM generated a vague step description without "transcript"
			const step = createMockStep(
				"1",
				"Extract content from the YouTube video",
			);

			const capabilities = [
				createMockCapabilityMatch(
					"fabric_youtube_transcript",
					"fabric_youtube_transcript",
					"Extract transcript from YouTube videos",
				),
				createMockCapabilityMatch(
					"fabric_analyze_youtube",
					"fabric_analyze_youtube",
					"Analyze a YouTube video by extracting its transcript and applying a pattern",
				),
			];

			// Original user message explicitly mentioned "transcript"
			const originalUserMessage =
				"Get the transcript for this YouTube video https://youtube.com/watch?v=abc";

			const [assignment] = assignStepExecutors(
				[step],
				capabilities,
				originalUserMessage,
			);

			// Must select fabric_youtube_transcript because user explicitly asked for transcript
			expect(assignment.assignedExecutor.id).toBe(
				"fabric_youtube_transcript",
			);
		});

		it("should still work correctly without original user message", () => {
			const step = createMockStep(
				"1",
				"Extract youtube transcript from video",
			);

			const capabilities = [
				createMockCapabilityMatch(
					"fabric_youtube_transcript",
					"fabric_youtube_transcript",
					"Extract transcript from YouTube videos",
				),
				createMockCapabilityMatch(
					"fabric_analyze_youtube",
					"fabric_analyze_youtube",
					"Analyze a YouTube video",
				),
			];

			// No original user message - should still work based on step description
			const [assignment] = assignStepExecutors([step], capabilities);

			expect(assignment.assignedExecutor.id).toBe(
				"fabric_youtube_transcript",
			);
		});
	});
});
