/**
 * Unit tests for Task Planner Prompts Module
 */

import { describe, expect, it } from "vitest";
import {
	getAnalyzeSystemPrompt,
	getDependencyAnalysisPrompt,
	getDocumentGenerationPrompt,
	getExecutionPlanPrompt,
	getRiskAssessmentPrompt,
} from "../prompts";

describe("Prompts Module", () => {
	describe("getAnalyzeSystemPrompt", () => {
		it("should return a non-empty analyze prompt", () => {
			const prompt = getAnalyzeSystemPrompt();
			expect(prompt).toBeTruthy();
			expect(typeof prompt).toBe("string");
			expect(prompt.length).toBeGreaterThan(100);
		});

		it("should include task decomposition instructions", () => {
			const prompt = getAnalyzeSystemPrompt();
			expect(prompt.toLowerCase()).toContain("decompos");
			expect(prompt.toLowerCase()).toContain("task");
		});

		it("should include tech stack when provided", () => {
			const prompt = getAnalyzeSystemPrompt("React, Node.js, PostgreSQL");
			expect(prompt).toContain("React, Node.js, PostgreSQL");
		});

		it("should include JSON output format instructions", () => {
			const prompt = getAnalyzeSystemPrompt();
			expect(prompt.toLowerCase()).toContain("json");
			expect(prompt).toContain("decomposedTasks");
		});

		it("should include task structure fields", () => {
			const prompt = getAnalyzeSystemPrompt();
			expect(prompt).toContain("id");
			expect(prompt).toContain("title");
			expect(prompt).toContain("estimate");
			expect(prompt).toContain("complexity");
		});
	});

	describe("getRiskAssessmentPrompt", () => {
		it("should return a non-empty risk assessment prompt", () => {
			const prompt = getRiskAssessmentPrompt();
			expect(prompt).toBeTruthy();
			expect(typeof prompt).toBe("string");
		});

		it("should include risk analysis instructions", () => {
			const prompt = getRiskAssessmentPrompt();
			expect(prompt.toLowerCase()).toContain("risk");
			expect(prompt.toLowerCase()).toContain("severity");
		});

		it("should include risk categories", () => {
			const prompt = getRiskAssessmentPrompt();
			expect(prompt.toLowerCase()).toContain("technical");
			expect(prompt.toLowerCase()).toContain("resource");
			expect(prompt.toLowerCase()).toContain("timeline");
		});

		it("should include mitigation instructions", () => {
			const prompt = getRiskAssessmentPrompt();
			expect(prompt.toLowerCase()).toContain("mitigation");
		});
	});

	describe("getDependencyAnalysisPrompt", () => {
		it("should return a non-empty dependency analysis prompt", () => {
			const prompt = getDependencyAnalysisPrompt();
			expect(prompt).toBeTruthy();
			expect(typeof prompt).toBe("string");
		});

		it("should include dependency graph instructions", () => {
			const prompt = getDependencyAnalysisPrompt();
			expect(prompt.toLowerCase()).toContain("dependency");
			expect(prompt.toLowerCase()).toContain("graph");
		});

		it("should include critical path concept", () => {
			const prompt = getDependencyAnalysisPrompt();
			expect(prompt.toLowerCase()).toContain("critical path");
		});

		it("should include node and edge structure", () => {
			const prompt = getDependencyAnalysisPrompt();
			expect(prompt).toContain("nodes");
			expect(prompt).toContain("edges");
		});
	});

	describe("getExecutionPlanPrompt", () => {
		it("should return a non-empty execution plan prompt", () => {
			const prompt = getExecutionPlanPrompt();
			expect(prompt).toBeTruthy();
			expect(typeof prompt).toBe("string");
		});

		it("should include execution planning instructions", () => {
			const prompt = getExecutionPlanPrompt();
			expect(prompt.toLowerCase()).toContain("execution");
			expect(prompt.toLowerCase()).toContain("phase");
		});

		it("should include parallelization concept", () => {
			const prompt = getExecutionPlanPrompt();
			expect(prompt.toLowerCase()).toContain("parallel");
		});

		it("should include team size recommendation", () => {
			const prompt = getExecutionPlanPrompt();
			expect(prompt.toLowerCase()).toContain("team");
		});
	});

	describe("getDocumentGenerationPrompt", () => {
		it("should return a non-empty document generation prompt", () => {
			const prompt = getDocumentGenerationPrompt();
			expect(prompt).toBeTruthy();
			expect(typeof prompt).toBe("string");
		});

		it("should include document structure", () => {
			const prompt = getDocumentGenerationPrompt();
			expect(prompt).toContain("Executive Summary");
			expect(prompt).toContain("Task Breakdown");
			expect(prompt).toContain("Risk Assessment");
		});

		it("should include tech stack when provided", () => {
			const prompt = getDocumentGenerationPrompt("TypeScript, AWS");
			expect(prompt).toContain("TypeScript, AWS");
		});

		it("should mention write_task_plan tool", () => {
			const prompt = getDocumentGenerationPrompt();
			expect(prompt).toContain("write_task_plan");
		});
	});
});
