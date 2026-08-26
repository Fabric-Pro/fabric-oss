/**
 * Unit tests for Task Planner Types
 */
import { describe, expect, it } from "vitest";
import type {
	Complexity,
	DecomposedTask,
	DependencyGraph,
	Mitigation,
	RiskAnalysis,
	RiskCategory,
	RiskFactor,
	RiskSeverity,
	TaskType,
} from "../types";

describe("Task Planner Types", () => {
	describe("DecomposedTask", () => {
		it("should create a valid decomposed task", () => {
			const task: DecomposedTask = {
				id: "TASK-001",
				parentId: undefined,
				title: "Implement user authentication",
				description: "Add login/logout functionality with JWT",
				type: "Backend" as TaskType,
				estimate: 4,
				complexity: "medium" as Complexity,
				riskScore: 35,
				riskFactors: [
					"New library integration",
					"Security considerations",
				],
				dependencies: [],
				blockedBy: [],
				parallelizable: true,
				subtasks: [],
				acceptanceCriteria: [
					"User can log in",
					"User can log out",
					"JWT is properly validated",
				],
				technicalApproach: [
					"Set up JWT library",
					"Create auth endpoints",
					"Add middleware",
				],
				filesToModify: ["src/auth/login.ts", "src/middleware/auth.ts"],
			};

			expect(task.id).toBe("TASK-001");
			expect(task.complexity).toBe("medium");
			expect(task.riskScore).toBe(35);
			expect(task.riskFactors).toHaveLength(2);
			expect(task.parallelizable).toBe(true);
		});

		it("should support hierarchical subtasks", () => {
			const parentTask: DecomposedTask = {
				id: "TASK-001",
				title: "User Management",
				description: "Complete user management system",
				type: "Backend" as TaskType,
				estimate: 8,
				complexity: "high" as Complexity,
				riskScore: 50,
				riskFactors: [],
				dependencies: [],
				blockedBy: [],
				parallelizable: false,
				subtasks: [
					{
						id: "TASK-001-A",
						parentId: "TASK-001",
						title: "User registration",
						description: "Implement user registration",
						type: "Backend" as TaskType,
						estimate: 3,
						complexity: "medium" as Complexity,
						riskScore: 30,
						riskFactors: [],
						dependencies: [],
						blockedBy: [],
						parallelizable: true,
						subtasks: [],
						acceptanceCriteria: [],
						technicalApproach: [],
						filesToModify: [],
					},
				],
				acceptanceCriteria: [],
				technicalApproach: [],
				filesToModify: [],
			};

			expect(parentTask.subtasks).toHaveLength(1);
			expect(parentTask.subtasks[0].parentId).toBe("TASK-001");
		});
	});

	describe("RiskAnalysis", () => {
		it("should create a valid risk analysis", () => {
			const riskFactor: RiskFactor = {
				id: "RISK-001",
				category: "technical" as RiskCategory,
				description: "Complex integration with legacy system",
				severity: "high" as RiskSeverity,
				probability: 0.6,
				impact: 70,
				affectedTasks: ["TASK-001", "TASK-002"],
			};

			const mitigation: Mitigation = {
				riskId: "RISK-001",
				strategy: "Create adapter layer to isolate legacy dependencies",
				effort: 8,
				effectiveness: 0.8,
			};

			const riskAnalysis: RiskAnalysis = {
				overallScore: 55,
				factors: [riskFactor],
				mitigations: [mitigation],
				recommendations: [
					"Start with POC to validate integration approach",
					"Allocate buffer time for unexpected issues",
				],
			};

			expect(riskAnalysis.overallScore).toBe(55);
			expect(riskAnalysis.factors).toHaveLength(1);
			expect(riskAnalysis.factors[0].severity).toBe("high");
			expect(riskAnalysis.mitigations[0].effectiveness).toBe(0.8);
		});

		it("should support all risk categories", () => {
			const categories: RiskCategory[] = [
				"technical",
				"resource",
				"timeline",
				"dependency",
				"unknown",
			];

			categories.forEach((category) => {
				const factor: RiskFactor = {
					id: `RISK-${category}`,
					category,
					description: `${category} risk`,
					severity: "medium",
					probability: 0.5,
					impact: 50,
					affectedTasks: [],
				};
				expect(factor.category).toBe(category);
			});
		});
	});

	describe("DependencyGraph", () => {
		it("should create a valid dependency graph", () => {
			const graph: DependencyGraph = {
				nodes: [
					{
						id: "TASK-001",
						label: "Setup database",
						level: 0,
						type: "Database" as TaskType,
					},
					{
						id: "TASK-002",
						label: "Create API",
						level: 1,
						type: "Backend" as TaskType,
					},
					{
						id: "TASK-003",
						label: "Build UI",
						level: 2,
						type: "Frontend" as TaskType,
					},
				],
				edges: [
					{ from: "TASK-001", to: "TASK-002", type: "blocks" },
					{ from: "TASK-002", to: "TASK-003", type: "blocks" },
				],
				criticalPath: ["TASK-001", "TASK-002", "TASK-003"],
				totalCriticalPathDuration: 12,
			};

			expect(graph.nodes).toHaveLength(3);
			expect(graph.edges).toHaveLength(2);
			expect(graph.criticalPath).toHaveLength(3);
			expect(graph.totalCriticalPathDuration).toBe(12);
		});
	});
});
