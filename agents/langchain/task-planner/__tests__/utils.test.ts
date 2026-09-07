/**
 * Unit tests for Task Planner Utils Module
 */

import { describe, expect, it } from "vitest";
import type { TaskPlannerStateType } from "../state";
import { createModel, generateFallbackDocument } from "../utils";

describe("Utils Module", () => {
	describe("createModel", () => {
		it("should be a function", () => {
			expect(typeof createModel).toBe("function");
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
