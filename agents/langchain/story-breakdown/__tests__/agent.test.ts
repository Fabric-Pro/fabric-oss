/**
 * Unit tests for Story Breakdown Agent Main Module
 */

import { describe, expect, it } from "vitest";
import {
	// Nodes
	breakdownNode,
	buildUserMessage,
	calculateRetryDelay,
	createModel,
	// Utils
	DEFAULT_RECURSION_LIMIT,
	// Prompts
	getDefaultSystemPrompt,
	getPredictStateConfig,
	graphMetadata,
	isJsonParseError,
	isRetryableError,
	MAX_RETRIES,
	RETRY_DELAY_MS,
	StoryBreakdownState,
	sleep,
	storyBreakdownGraph,
} from "../agent";

describe("Story Breakdown Agent Module", () => {
	describe("Graph Export", () => {
		it("should export storyBreakdownGraph", () => {
			expect(storyBreakdownGraph).toBeDefined();
		});

		it("should have invoke method", () => {
			expect(typeof storyBreakdownGraph.invoke).toBe("function");
		});

		it("should have stream method", () => {
			expect(typeof storyBreakdownGraph.stream).toBe("function");
		});
	});

	describe("Graph Metadata", () => {
		it("should export graphMetadata", () => {
			expect(graphMetadata).toBeDefined();
		});

		it("should have correct name", () => {
			expect(graphMetadata.name).toBe("story_breakdown");
		});

		it("should have description", () => {
			expect(graphMetadata.description).toBeTruthy();
			expect(graphMetadata.description.length).toBeGreaterThan(20);
		});

		it("should have version", () => {
			expect(graphMetadata.version).toMatch(/^\d+\.\d+\.\d+$/);
		});

		it("should have capabilities", () => {
			expect(graphMetadata.capabilities).toContain("story-breakdown");
			expect(graphMetadata.capabilities).toContain("user-stories");
			expect(graphMetadata.capabilities).toContain("agile");
			expect(graphMetadata.capabilities).toContain("predictive-updates");
			expect(graphMetadata.capabilities).toContain("ag-ui-protocol");
		});

		it("should have protocols", () => {
			expect(graphMetadata.protocols).toContain("ag-ui");
		});

		it("should support predictive updates", () => {
			expect(graphMetadata.supportsPredictiveUpdates).toBe(true);
		});
	});

	describe("State Export", () => {
		it("should export StoryBreakdownState", () => {
			expect(StoryBreakdownState).toBeDefined();
		});

		it("should have spec property", () => {
			expect(StoryBreakdownState.spec).toBeDefined();
		});
	});

	describe("Utility Exports", () => {
		it("should export DEFAULT_RECURSION_LIMIT", () => {
			expect(DEFAULT_RECURSION_LIMIT).toBe(25);
		});

		it("should export MAX_RETRIES", () => {
			expect(MAX_RETRIES).toBe(3);
		});

		it("should export RETRY_DELAY_MS", () => {
			expect(RETRY_DELAY_MS).toBe(1000);
		});

		it("should export createModel", () => {
			expect(typeof createModel).toBe("function");
		});

		it("should export isRetryableError", () => {
			expect(typeof isRetryableError).toBe("function");
		});

		it("should export isJsonParseError", () => {
			expect(typeof isJsonParseError).toBe("function");
		});

		it("should export calculateRetryDelay", () => {
			expect(typeof calculateRetryDelay).toBe("function");
		});

		it("should export sleep", () => {
			expect(typeof sleep).toBe("function");
		});
	});

	describe("Prompt Exports", () => {
		it("should export getDefaultSystemPrompt", () => {
			expect(typeof getDefaultSystemPrompt).toBe("function");
		});

		it("should export buildUserMessage", () => {
			expect(typeof buildUserMessage).toBe("function");
		});

		it("should export getPredictStateConfig", () => {
			expect(typeof getPredictStateConfig).toBe("function");
		});
	});

	describe("Node Exports", () => {
		it("should export breakdownNode", () => {
			expect(typeof breakdownNode).toBe("function");
		});
	});
});
