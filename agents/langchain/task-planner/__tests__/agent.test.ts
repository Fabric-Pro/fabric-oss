/**
 * Unit tests for Enhanced Task Planner Agent
 */
import { describe, expect, it, vi } from "vitest";

// Mock the ChatOpenAI class
vi.mock("@langchain/openai", () => ({
	ChatOpenAI: vi.fn().mockImplementation(() => ({
		invoke: vi.fn(),
		bindTools: vi.fn().mockReturnThis(),
	})),
}));

// Import after mocks
import { graphMetadata, TaskPlannerState, taskPlannerGraph } from "../agent";
import type {
	DecomposedTask,
	DependencyGraph,
	ExecutionPlan,
	RiskAnalysis,
} from "../types";

describe("Task Planner Agent", () => {
	describe("Graph Metadata", () => {
		it("should have correct metadata", () => {
			expect(graphMetadata.name).toBe("task_planner");
			expect(graphMetadata.version).toBe("2.0.0");
			expect(graphMetadata.supportsPredictiveUpdates).toBe(true);
		});

		it("should include all required capabilities", () => {
			const requiredCapabilities = [
				"task-planning",
				"task-decomposition",
				"risk-analysis",
				"dependency-graph",
				"execution-planning",
				"ag-ui-protocol",
			];

			requiredCapabilities.forEach((cap) => {
				expect(graphMetadata.capabilities).toContain(cap);
			});
		});
	});

	describe("Graph Structure", () => {
		it("should have compiled graph", () => {
			expect(taskPlannerGraph).toBeDefined();
		});

		it("should have all required nodes", () => {
			// The compiled graph should have the node structure
			const nodes = taskPlannerGraph.nodes;
			expect(nodes).toBeDefined();
		});
	});

	describe("State Annotation", () => {
		it("should have required state fields", () => {
			// Test that state annotation has the right structure
			expect(TaskPlannerState).toBeDefined();
		});
	});
});

describe("Task Decomposition Logic", () => {
	describe("DecomposedTask validation", () => {
		it("should validate task structure", () => {
			const validTask: DecomposedTask = {
				id: "TASK-001",
				title: "Test task",
				description: "Test description",
				type: "Backend",
				estimate: 2,
				complexity: "low",
				riskScore: 20,
				riskFactors: [],
				dependencies: [],
				blockedBy: [],
				parallelizable: true,
				subtasks: [],
				acceptanceCriteria: ["Done when tests pass"],
				technicalApproach: ["Write tests first"],
				filesToModify: ["test.ts"],
			};

			expect(validTask.id).toMatch(/^TASK-\d+$/);
			expect(validTask.estimate).toBeGreaterThan(0);
			expect(validTask.estimate).toBeLessThanOrEqual(8);
			expect(validTask.riskScore).toBeGreaterThanOrEqual(0);
			expect(validTask.riskScore).toBeLessThanOrEqual(100);
		});

		it("should calculate total estimate from subtasks", () => {
			const tasks: DecomposedTask[] = [
				createMockTask("TASK-001", 2),
				createMockTask("TASK-002", 3),
				createMockTask("TASK-003", 4),
			];

			const totalEstimate = tasks.reduce((sum, t) => sum + t.estimate, 0);
			expect(totalEstimate).toBe(9);
		});
	});

	describe("Risk scoring", () => {
		it("should calculate overall risk score", () => {
			const riskAnalysis: RiskAnalysis = {
				overallScore: 0,
				factors: [
					{
						id: "R1",
						category: "technical",
						description: "Complex",
						severity: "high",
						probability: 0.8,
						impact: 80,
						affectedTasks: [],
					},
					{
						id: "R2",
						category: "timeline",
						description: "Tight",
						severity: "medium",
						probability: 0.5,
						impact: 50,
						affectedTasks: [],
					},
				],
				mitigations: [],
				recommendations: [],
			};

			// Calculate weighted score: (0.8*80 + 0.5*50) / 2 = (64 + 25) / 2 = 44.5
			const weightedScore =
				riskAnalysis.factors.reduce((sum, f) => {
					return sum + f.probability * f.impact;
				}, 0) / riskAnalysis.factors.length;

			expect(weightedScore).toBe(44.5);
		});

		it("should identify high-risk tasks", () => {
			const tasks: DecomposedTask[] = [
				createMockTask("TASK-001", 2, 80),
				createMockTask("TASK-002", 3, 30),
				createMockTask("TASK-003", 4, 75),
			];

			const highRiskTasks = tasks.filter((t) => t.riskScore > 70);
			expect(highRiskTasks).toHaveLength(2);
		});
	});

	describe("Dependency graph", () => {
		it("should identify critical path", () => {
			const graph: DependencyGraph = {
				nodes: [
					{ id: "T1", label: "Task 1", level: 0, type: "Backend" },
					{ id: "T2", label: "Task 2", level: 1, type: "Backend" },
					{ id: "T3", label: "Task 3", level: 1, type: "Frontend" },
					{ id: "T4", label: "Task 4", level: 2, type: "Testing" },
				],
				edges: [
					{ from: "T1", to: "T2", type: "blocks" },
					{ from: "T1", to: "T3", type: "blocks" },
					{ from: "T2", to: "T4", type: "blocks" },
				],
				criticalPath: ["T1", "T2", "T4"],
				totalCriticalPathDuration: 8,
			};

			expect(graph.criticalPath).toHaveLength(3);
			expect(graph.criticalPath[0]).toBe("T1");
		});

		it("should calculate parallelization factor", () => {
			const plan: ExecutionPlan = {
				phases: [
					{
						id: "P1",
						name: "Phase 1",
						tasks: ["T1"],
						duration: 2,
						dependencies: [],
					},
					{
						id: "P2",
						name: "Phase 2",
						tasks: ["T2", "T3"],
						duration: 3,
						dependencies: ["P1"],
					},
					{
						id: "P3",
						name: "Phase 3",
						tasks: ["T4"],
						duration: 2,
						dependencies: ["P2"],
					},
				],
				totalDuration: 10, // Sum of all task durations
				parallelDuration: 7, // Sum of phase durations
				parallelizationFactor: 0.7,
				recommendedTeamSize: 2,
			};

			expect(plan.parallelizationFactor).toBe(0.7);
			expect(plan.parallelDuration).toBeLessThan(plan.totalDuration);
		});
	});
});

// Helper function to create mock tasks
function createMockTask(
	id: string,
	estimate: number,
	riskScore = 30,
): DecomposedTask {
	return {
		id,
		title: `Task ${id}`,
		description: "Mock task",
		type: "Backend",
		estimate,
		complexity: estimate > 4 ? "high" : estimate > 2 ? "medium" : "low",
		riskScore,
		riskFactors: [],
		dependencies: [],
		blockedBy: [],
		parallelizable: true,
		subtasks: [],
		acceptanceCriteria: [],
		technicalApproach: [],
		filesToModify: [],
	};
}
