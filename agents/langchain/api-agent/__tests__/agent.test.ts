/**
 * Unit tests for API Agent Main Module
 */

import { describe, expect, it } from "vitest";
import {
	ApiAgentState,
	// Nodes
	analyzeTaskNode,
	apiAgentGraph,
	executeOpenAPITool,
	executeToolNode,
	// Utils
	extractTask,
	formatResponseNode,
	formatToolSummary,
	getAgentModel,
	// Prompts
	getAnalyzeTaskSystemPrompt,
	getAnalyzeTaskUserPrompt,
	getFormatResponseSystemPrompt,
	getFormatResponseUserPrompt,
	graphMetadata,
	loadOpenAPITools,
} from "../agent";

describe("API Agent Module", () => {
	describe("Graph Export", () => {
		it("should export apiAgentGraph", () => {
			expect(apiAgentGraph).toBeDefined();
		});

		it("should have invoke method", () => {
			expect(typeof apiAgentGraph.invoke).toBe("function");
		});

		it("should have stream method", () => {
			expect(typeof apiAgentGraph.stream).toBe("function");
		});
	});

	describe("Graph Metadata", () => {
		it("should export graphMetadata", () => {
			expect(graphMetadata).toBeDefined();
		});

		it("should have correct name", () => {
			expect(graphMetadata.name).toBe("api_agent");
		});

		it("should have description", () => {
			expect(graphMetadata.description).toBeTruthy();
			expect(graphMetadata.description.length).toBeGreaterThan(20);
		});

		it("should have version", () => {
			expect(graphMetadata.version).toMatch(/^\d+\.\d+\.\d+$/);
		});

		it("should have capabilities", () => {
			expect(graphMetadata.capabilities).toContain("openapi");
			expect(graphMetadata.capabilities).toContain("api-execution");
			expect(graphMetadata.capabilities).toContain("ag-ui-protocol");
			expect(graphMetadata.capabilities).toContain("a2a-protocol");
		});

		it("should have protocols", () => {
			expect(graphMetadata.protocols).toContain("a2a");
			expect(graphMetadata.protocols).toContain("ag-ui");
		});

		it("should define supportsPredictiveUpdates", () => {
			expect(graphMetadata.supportsPredictiveUpdates).toBe(false);
		});
	});

	describe("State Export", () => {
		it("should export ApiAgentState", () => {
			expect(ApiAgentState).toBeDefined();
		});

		it("should have spec property", () => {
			expect(ApiAgentState.spec).toBeDefined();
		});
	});

	describe("Utility Exports", () => {
		it("should export extractTask", () => {
			expect(typeof extractTask).toBe("function");
		});

		it("should export getAgentModel", () => {
			expect(typeof getAgentModel).toBe("function");
		});

		it("should export loadOpenAPITools", () => {
			expect(typeof loadOpenAPITools).toBe("function");
		});

		it("should export executeOpenAPITool", () => {
			expect(typeof executeOpenAPITool).toBe("function");
		});

		it("should export formatToolSummary", () => {
			expect(typeof formatToolSummary).toBe("function");
		});
	});

	describe("Prompt Exports", () => {
		it("should export getAnalyzeTaskSystemPrompt", () => {
			expect(typeof getAnalyzeTaskSystemPrompt).toBe("function");
		});

		it("should export getAnalyzeTaskUserPrompt", () => {
			expect(typeof getAnalyzeTaskUserPrompt).toBe("function");
		});

		it("should export getFormatResponseSystemPrompt", () => {
			expect(typeof getFormatResponseSystemPrompt).toBe("function");
		});

		it("should export getFormatResponseUserPrompt", () => {
			expect(typeof getFormatResponseUserPrompt).toBe("function");
		});
	});

	describe("Node Exports", () => {
		it("should export analyzeTaskNode", () => {
			expect(typeof analyzeTaskNode).toBe("function");
		});

		it("should export executeToolNode", () => {
			expect(typeof executeToolNode).toBe("function");
		});

		it("should export formatResponseNode", () => {
			expect(typeof formatResponseNode).toBe("function");
		});
	});
});
