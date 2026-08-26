/**
 * Unit tests for Document Generator Agent Main Module
 */

import { describe, expect, it } from "vitest";
import {
	AgentStateAnnotation,
	// Prompts
	buildSystemPrompt,
	calculateRetryDelay,
	// Nodes
	chatNode,
	// Utils
	DEFAULT_RECURSION_LIMIT,
	getAgentModel,
	getPredictStateConfig,
	graphMetadata,
	isJsonParseError,
	isRetryableError,
	MAX_RETRIES,
	predictiveStateUpdatesGraph,
	RETRY_DELAY_MS,
	sleep,
} from "../agent";

describe("Document Generator Agent Module", () => {
	describe("Graph Export", () => {
		it("should export predictiveStateUpdatesGraph", () => {
			expect(predictiveStateUpdatesGraph).toBeDefined();
		});

		it("should have invoke method", () => {
			expect(typeof predictiveStateUpdatesGraph.invoke).toBe("function");
		});

		it("should have stream method", () => {
			expect(typeof predictiveStateUpdatesGraph.stream).toBe("function");
		});
	});

	describe("Graph Metadata", () => {
		it("should export graphMetadata", () => {
			expect(graphMetadata).toBeDefined();
		});

		it("should have correct name", () => {
			expect(graphMetadata.name).toBe("document_generator");
		});

		it("should have description", () => {
			expect(graphMetadata.description).toBeTruthy();
			expect(graphMetadata.description.length).toBeGreaterThan(20);
		});

		it("should have version", () => {
			expect(graphMetadata.version).toMatch(/^\d+\.\d+\.\d+$/);
		});

		it("should have capabilities", () => {
			expect(graphMetadata.capabilities).toContain("document-generation");
			expect(graphMetadata.capabilities).toContain("document-editing");
			expect(graphMetadata.capabilities).toContain("predictive-updates");
			expect(graphMetadata.capabilities).toContain("streaming");
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
		it("should export AgentStateAnnotation", () => {
			expect(AgentStateAnnotation).toBeDefined();
		});

		it("should have spec property", () => {
			expect(AgentStateAnnotation.spec).toBeDefined();
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

		it("should export getAgentModel", () => {
			expect(typeof getAgentModel).toBe("function");
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
		it("should export buildSystemPrompt", () => {
			expect(typeof buildSystemPrompt).toBe("function");
		});

		it("should export getPredictStateConfig", () => {
			expect(typeof getPredictStateConfig).toBe("function");
		});
	});

	describe("Node Exports", () => {
		it("should export chatNode", () => {
			expect(typeof chatNode).toBe("function");
		});
	});
});
