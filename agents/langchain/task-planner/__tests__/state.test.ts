/**
 * Unit tests for Task Planner State Module
 */

import { describe, expect, it } from "vitest";
import { TaskPlannerState } from "../state";

describe("State Module", () => {
	describe("TaskPlannerState Annotation", () => {
		it("should be defined", () => {
			expect(TaskPlannerState).toBeDefined();
		});

		it("should have spec property for state definition", () => {
			expect(TaskPlannerState.spec).toBeDefined();
		});

		it("should define messages annotation", () => {
			expect(TaskPlannerState.spec.messages).toBeDefined();
		});

		it("should define projectName annotation", () => {
			expect(TaskPlannerState.spec.projectName).toBeDefined();
		});

		it("should define userStory annotation", () => {
			expect(TaskPlannerState.spec.userStory).toBeDefined();
		});

		it("should define techStack annotation", () => {
			expect(TaskPlannerState.spec.techStack).toBeDefined();
		});

		it("should define document annotation (AG-UI)", () => {
			expect(TaskPlannerState.spec.document).toBeDefined();
		});

		it("should define decomposedTasks annotation", () => {
			expect(TaskPlannerState.spec.decomposedTasks).toBeDefined();
		});

		it("should define riskAnalysis annotation", () => {
			expect(TaskPlannerState.spec.riskAnalysis).toBeDefined();
		});

		it("should define dependencyGraph annotation", () => {
			expect(TaskPlannerState.spec.dependencyGraph).toBeDefined();
		});

		it("should define executionPlan annotation", () => {
			expect(TaskPlannerState.spec.executionPlan).toBeDefined();
		});

		it("should define currentStage annotation", () => {
			expect(TaskPlannerState.spec.currentStage).toBeDefined();
		});

		it("should define error annotation", () => {
			expect(TaskPlannerState.spec.error).toBeDefined();
		});

		it("should define tools annotation (CopilotKit)", () => {
			expect(TaskPlannerState.spec.tools).toBeDefined();
		});
	});
});

// =============================================================================
// reasoningByTurn channel (PR 3/5 — reasoning surfacing extension)
// =============================================================================

describe("TaskPlannerState — reasoningByTurn", () => {
	// LangGraph 1.x exposes a reducer-shaped Annotation as a
	// BinaryOperatorAggregate channel whose runtime fields are `operator`
	// (the reducer fn) and `initialValueFactory` (the default fn).
	type AggregateChannel = {
		operator: (
			a: Record<number, unknown> | undefined,
			b: Record<number, unknown> | undefined,
		) => Record<number, unknown>;
		initialValueFactory: () => Record<number, unknown>;
	};

	it("declares reasoningByTurn in the state spec", () => {
		expect(TaskPlannerState.spec.reasoningByTurn).toBeDefined();
	});

	it("defaults to empty record", () => {
		const channel = TaskPlannerState.spec
			.reasoningByTurn as unknown as AggregateChannel;
		expect(channel.initialValueFactory()).toEqual({});
	});

	it("merges incoming entries with existing", () => {
		const channel = TaskPlannerState.spec
			.reasoningByTurn as unknown as AggregateChannel;
		const merged = channel.operator(
			{ 1: { text: "a", durationMs: 1, startedAt: 0, completedAt: 1 } },
			{ 2: { text: "b", durationMs: 2, startedAt: 1, completedAt: 3 } },
		);
		expect(merged).toEqual({
			1: { text: "a", durationMs: 1, startedAt: 0, completedAt: 1 },
			2: { text: "b", durationMs: 2, startedAt: 1, completedAt: 3 },
		});
	});

	it("overwrites same-key entries (mid-turn merge from generate-document)", () => {
		const channel = TaskPlannerState.spec
			.reasoningByTurn as unknown as AggregateChannel;
		const merged = channel.operator(
			{ 1: { text: "old", durationMs: 1, startedAt: 0, completedAt: 1 } },
			{ 1: { text: "new", durationMs: 2, startedAt: 0, completedAt: 2 } },
		);
		expect((merged as Record<number, { text: string }>)[1].text).toBe(
			"new",
		);
	});
});
