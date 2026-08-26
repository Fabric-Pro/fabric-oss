/**
 * Unit tests for Task Planner Utils Module
 */

import { describe, expect, it, vi } from "vitest";
import type { TaskPlannerStateType } from "../state";
import {
	createModel,
	generateFallbackDocument,
	MAX_RETRIES,
	RETRY_DELAY_MS,
	withRetry,
} from "../utils";

describe("Utils Module", () => {
	describe("createModel", () => {
		it("should be a function", () => {
			expect(typeof createModel).toBe("function");
		});
	});

	describe("withRetry", () => {
		it("should return result on success", async () => {
			const fn = vi.fn().mockResolvedValue("success");
			const result = await withRetry(fn);
			expect(result).toBe("success");
			expect(fn).toHaveBeenCalledTimes(1);
		});

		it("should retry on JSON parse error", async () => {
			const fn = vi
				.fn()
				.mockRejectedValueOnce(new Error("Invalid JSON"))
				.mockResolvedValue("success");

			const result = await withRetry(fn, 3, 0);
			expect(result).toBe("success");
			expect(fn).toHaveBeenCalledTimes(2);
		});

		it("should retry on network error", async () => {
			const fn = vi
				.fn()
				.mockRejectedValueOnce(new Error("timeout"))
				.mockResolvedValue("success");

			const result = await withRetry(fn, 3, 0);
			expect(result).toBe("success");
			expect(fn).toHaveBeenCalledTimes(2);
		});

		it("should throw after max retries", async () => {
			const fn = vi.fn().mockRejectedValue(new Error("timeout"));

			await expect(withRetry(fn, 2, 0)).rejects.toThrow("timeout");
			expect(fn).toHaveBeenCalledTimes(3); // Initial + 2 retries
		});

		it("should not retry non-retryable errors", async () => {
			const fn = vi.fn().mockRejectedValue(new Error("Other error"));

			await expect(withRetry(fn)).rejects.toThrow("Other error");
			expect(fn).toHaveBeenCalledTimes(1);
		});
	});

	describe("Constants", () => {
		it("should have MAX_RETRIES defined", () => {
			expect(MAX_RETRIES).toBe(3);
		});

		it("should have RETRY_DELAY_MS defined", () => {
			expect(RETRY_DELAY_MS).toBe(1000);
		});
	});

	describe("generateFallbackDocument", () => {
		it("should generate a document with project name", () => {
			const state = createTestState({
				projectName: "Test Project",
			});

			const doc = generateFallbackDocument(state);
			expect(doc).toContain("Test Project");
		});

		it("should include task breakdown section", () => {
			const state = createTestState({
				projectName: "Test Project",
				decomposedTasks: [
					{
						id: "TASK-001",
						parentId: undefined,
						title: "Test Task",
						description: "A test task",
						type: "Backend",
						estimate: 4,
						complexity: "medium",
						riskScore: 30,
						riskFactors: [],
						dependencies: [],
						blockedBy: [],
						parallelizable: true,
						acceptanceCriteria: ["Criterion 1"],
						technicalApproach: ["Step 1"],
						filesToModify: ["test.ts"],
						subtasks: [],
					},
				],
			});

			const doc = generateFallbackDocument(state);
			expect(doc).toContain("TASK-001");
			expect(doc).toContain("Test Task");
			expect(doc).toContain("4 hours");
		});

		it("should include risk assessment section", () => {
			const state = createTestState({
				projectName: "Test Project",
				riskAnalysis: {
					overallScore: 45,
					factors: [
						{
							id: "RISK-001",
							category: "technical",
							description: "Test risk",
							severity: "medium",
							probability: 0.5,
							impact: 50,
							affectedTasks: ["TASK-001"],
						},
					],
					mitigations: [],
					recommendations: ["Test recommendation"],
				},
			});

			const doc = generateFallbackDocument(state);
			expect(doc).toContain("45/100");
			expect(doc).toContain("Test risk");
			expect(doc).toContain("Test recommendation");
		});

		it("should include execution plan section", () => {
			const state = createTestState({
				projectName: "Test Project",
				executionPlan: {
					phases: [
						{
							id: "PHASE-1",
							name: "Phase 1",
							tasks: ["TASK-001"],
							duration: 8,
							dependencies: [],
						},
					],
					totalDuration: 8,
					parallelDuration: 8,
					parallelizationFactor: 1,
					recommendedTeamSize: 2,
				},
			});

			const doc = generateFallbackDocument(state);
			expect(doc).toContain("Phase 1");
			expect(doc).toContain("8 hours");
		});
	});
});

/**
 * Create a minimal test state
 */
function createTestState(
	overrides: Partial<TaskPlannerStateType> = {},
): TaskPlannerStateType {
	return {
		messages: [],
		projectName: "Test Project",
		projectDescription: undefined,
		userStory: "Test story",
		techStack: undefined,
		systemPrompt: undefined,
		tools: [],
		document: undefined,
		focusAnchor: undefined,
		decomposedTasks: [],
		riskAnalysis: undefined,
		dependencyGraph: undefined,
		executionPlan: undefined,
		currentStage: undefined,
		error: undefined,
		retryCount: 0,
		...overrides,
	};
}
