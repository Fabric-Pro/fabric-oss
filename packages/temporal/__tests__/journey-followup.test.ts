/**
 * Journey & Follow-Up Tests
 *
 * Tests for multi-turn conversation support:
 * - Journey state management
 * - Plan modification analysis
 * - Follow-up signal handling
 *
 * Run with: pnpm --filter @repo/temporal test
 */

import { beforeEach, describe, expect, it } from "vitest";

// Journey state management
import {
	applyJourneyUpdate,
	type CreateJourneyInput,
	createJourneyState,
	deserializeJourneyState,
	getConversationContext,
	getDecisionContext,
	getJourneySummary,
	type JourneyState,
	recordDecision,
	serializeJourneyState,
} from "../src/activities/orchestrator/journey";

// Plan adaptation
import {
	applyPlanModifications,
	hasModificationIndicators,
	type PlanModificationAnalysis,
	requiresConfirmation,
	validateModifiedPlan,
} from "../src/activities/orchestrator/planning/plan-adapter";

import type { TaskPlan } from "../src/workflows/orchestrator/types";

// =============================================================================
// Journey State Management Tests
// =============================================================================

describe("Journey State Management", () => {
	const createTestInput = (): CreateJourneyInput => ({
		userId: "user-123",
		organizationId: "org-456",
		message: "Create a PRD for a new feature",
		workspaceContent: "Some workspace context",
	});

	describe("createJourneyState", () => {
		it("should create a new journey state with correct defaults", () => {
			const input = createTestInput();
			const state = createJourneyState(input);

			expect(state.journeyId).toMatch(/^journey-/);
			expect(state.userId).toBe("user-123");
			expect(state.organizationId).toBe("org-456");
			expect(state.originalGoal).toBe("Create a PRD for a new feature");
			expect(state.phase).toBe("initializing");
			expect(state.metrics.totalTurns).toBe(1);
			expect(state.decisions).toEqual([]);
			expect(state.assumptions).toEqual([]);
			expect(state.blockers).toEqual([]);
			expect(state.modifications).toEqual([]);
			expect(state.conversation).toHaveLength(1);
			expect(state.conversation[0].role).toBe("user");
		});

		it("should include workspace content in context", () => {
			const input = createTestInput();
			const state = createJourneyState(input);

			expect(state.context.workspaceContent).toBe(
				"Some workspace context",
			);
		});

		it("should inherit conversation history if provided", () => {
			const input: CreateJourneyInput = {
				...createTestInput(),
				conversationHistory: [
					{
						id: "turn-1",
						role: "user",
						content: "Hello",
						timestamp: new Date(),
					},
					{
						id: "turn-2",
						role: "orchestrator",
						content: "Hi!",
						timestamp: new Date(),
					},
				],
			};
			const state = createJourneyState(input);

			expect(state.conversation).toHaveLength(2);
		});
	});

	describe("applyJourneyUpdate", () => {
		let state: JourneyState;

		beforeEach(() => {
			state = createJourneyState(createTestInput());
		});

		it("should update phase", () => {
			const updated = applyJourneyUpdate(state, {
				type: "set_phase",
				phase: "executing",
				reason: "Plan approved",
			});

			expect(updated.phase).toBe("executing");
			expect(updated.phaseHistory).toHaveLength(2);
			expect(updated.phaseHistory[1].phase).toBe("executing");
			expect(updated.phaseHistory[1].reason).toBe("Plan approved");
		});

		it("should add decisions", () => {
			const updated = applyJourneyUpdate(state, {
				type: "add_decision",
				decision: {
					id: "decision-1",
					category: "routing",
					description: "Route to document generator",
					reasoning: "User wants a PRD",
					alternatives: [],
					confidence: 0.9,
					timestamp: new Date(),
					reversible: true,
				},
			});

			expect(updated.decisions).toHaveLength(1);
			expect(updated.decisions[0].description).toBe(
				"Route to document generator",
			);
		});

		it("should add assumptions", () => {
			const updated = applyJourneyUpdate(state, {
				type: "add_assumption",
				assumption: {
					id: "assumption-1",
					description: "User wants markdown format",
					madeAt: new Date(),
					madeBy: "orchestrator",
					category: "preference",
					impactIfWrong: "Wrong document format",
				},
			});

			expect(updated.assumptions).toHaveLength(1);
		});

		it("should add and resolve blockers", () => {
			let updated = applyJourneyUpdate(state, {
				type: "add_blocker",
				blocker: {
					id: "blocker-1",
					description: "Need user approval",
					category: "approval",
					severity: "high",
					createdAt: new Date(),
					blockingSteps: ["step-1"],
					suggestedActions: ["Wait for approval"],
				},
			});

			expect(updated.blockers).toHaveLength(1);
			expect(updated.blockers[0].resolvedAt).toBeUndefined();

			updated = applyJourneyUpdate(updated, {
				type: "resolve_blocker",
				blockerId: "blocker-1",
				resolution: "User approved",
			});

			expect(updated.blockers[0].resolvedAt).toBeDefined();
			expect(updated.blockers[0].resolution).toBe("User approved");
		});

		it("should add conversation turns and increment turn count", () => {
			const updated = applyJourneyUpdate(state, {
				type: "add_conversation_turn",
				turn: {
					id: "turn-2",
					role: "orchestrator",
					content: "I'll create a PRD for you",
					timestamp: new Date(),
				},
			});

			expect(updated.conversation).toHaveLength(2);
			expect(updated.metrics.totalTurns).toBe(2);
		});

		it("should update step results and metrics", () => {
			const updated = applyJourneyUpdate(state, {
				type: "update_step_result",
				stepId: "step-1",
				result: {
					status: "completed",
					response: "Step completed",
					durationMs: 1000,
				},
			});

			expect(updated.stepResults.get("step-1")?.status).toBe("completed");
			expect(updated.metrics.stepsCompleted).toBe(1);
		});
	});

	describe("recordDecision", () => {
		it("should add a decision with all fields", () => {
			let state = createJourneyState(createTestInput());
			state = recordDecision(
				state,
				"routing",
				"Selected document-generator agent",
				"Best match for PRD creation",
				[],
				undefined,
				0.95,
			);

			expect(state.decisions).toHaveLength(1);
			expect(state.decisions[0].category).toBe("routing");
			expect(state.decisions[0].confidence).toBe(0.95);
		});
	});

	describe("serialization", () => {
		it("should serialize and deserialize journey state", () => {
			let state = createJourneyState(createTestInput());
			state = recordDecision(
				state,
				"routing",
				"Test decision",
				"Test reasoning",
			);
			state = applyJourneyUpdate(state, {
				type: "update_step_result",
				stepId: "step-1",
				result: { status: "completed" },
			});

			const serialized = serializeJourneyState(state);
			const deserialized = deserializeJourneyState(serialized);

			expect(deserialized.journeyId).toBe(state.journeyId);
			expect(deserialized.decisions).toHaveLength(1);
			expect(deserialized.stepResults.get("step-1")?.status).toBe(
				"completed",
			);
			expect(deserialized.startedAt).toBeInstanceOf(Date);
		});
	});

	describe("context formatters", () => {
		it("should format conversation context", () => {
			let state = createJourneyState(createTestInput());
			state = applyJourneyUpdate(state, {
				type: "add_conversation_turn",
				turn: {
					id: "t2",
					role: "orchestrator",
					content: "Got it!",
					timestamp: new Date(),
				},
			});

			const context = getConversationContext(state);

			expect(context).toContain("Conversation History");
			expect(context).toContain("User");
			expect(context).toContain("Assistant");
		});

		it("should format decision context", () => {
			let state = createJourneyState(createTestInput());
			state = recordDecision(
				state,
				"routing",
				"Selected agent A",
				"Best fit",
			);

			const context = getDecisionContext(state);

			expect(context).toContain("Previous Decisions");
			expect(context).toContain("Selected agent A");
		});
	});

	describe("getJourneySummary", () => {
		it("should return a concise summary", () => {
			const state = createJourneyState(createTestInput());
			const summary = getJourneySummary(state);

			expect(summary).toContain("Journey");
			expect(summary).toContain("Phase=initializing");
			expect(summary).toContain("Steps=0/0");
			expect(summary).toContain("Turns=1");
		});
	});
});

// =============================================================================
// Plan Modification Tests
// =============================================================================

describe("Plan Modification", () => {
	const createTestPlan = (): TaskPlan => ({
		id: "plan-1",
		description: "Create PRD",
		riskLevel: "low",
		strategy: "agent",
		createdAt: new Date().toISOString(),
		steps: [
			{
				id: "step-1",
				description: "Research requirements",
				type: "research",
				order: 1,
				status: "complete",
				riskLevel: "low",
				requiresApproval: false,
			},
			{
				id: "step-2",
				description: "Generate document",
				type: "generate",
				order: 2,
				status: "in_progress",
				riskLevel: "low",
				requiresApproval: false,
			},
			{
				id: "step-3",
				description: "Review and finalize",
				type: "verify",
				order: 3,
				status: "pending",
				riskLevel: "low",
				requiresApproval: false,
			},
		],
	});

	describe("hasModificationIndicators", () => {
		it("should detect modification keywords", () => {
			expect(
				hasModificationIndicators("actually, change the format"),
			).toBe(true);
			expect(
				hasModificationIndicators("instead of markdown, use HTML"),
			).toBe(true);
			expect(
				hasModificationIndicators("also add a summary section"),
			).toBe(true);
			expect(hasModificationIndicators("skip the review step")).toBe(
				true,
			);
			expect(hasModificationIndicators("wait, stop that")).toBe(true);
			expect(hasModificationIndicators("modify the approach")).toBe(true);
		});

		it("should not flag regular messages", () => {
			expect(hasModificationIndicators("looks good")).toBe(false);
			expect(hasModificationIndicators("yes, proceed")).toBe(false);
			expect(hasModificationIndicators("what is the status?")).toBe(
				false,
			);
		});
	});

	describe("applyPlanModifications", () => {
		it("should return unchanged plan for none type", () => {
			const plan = createTestPlan();
			const analysis: PlanModificationAnalysis = {
				modificationType: "none",
				confidence: 1,
				reasoning: "No changes needed",
				affectedSteps: { current: false, pending: [], completed: [] },
				planChanges: {
					type: "none",
					description: "No changes",
					steps: {
						toUpdate: [],
						toInsert: [],
						toRemove: [],
						toReorder: [],
					},
				},
				executionAction: { action: "continue", reason: "Continue" },
				userResponse: {
					needed: false,
					message: "",
					confirmationRequired: false,
				},
				contextUpdate: {
					addToContext: {},
					assumptions: { add: [], invalidate: [] },
				},
			};

			const result = applyPlanModifications(plan, analysis);
			expect(result.steps).toEqual(plan.steps);
		});

		it("should update step descriptions", () => {
			const plan = createTestPlan();
			const analysis: PlanModificationAnalysis = {
				modificationType: "modification",
				confidence: 0.9,
				reasoning: "User wants different format",
				affectedSteps: {
					current: false,
					pending: ["step-2"],
					completed: [],
				},
				planChanges: {
					type: "update",
					description: "Update step 2",
					steps: {
						toUpdate: [
							{
								stepId: "step-2",
								changes: {
									description: "Generate HTML document",
								},
							},
						],
						toInsert: [],
						toRemove: [],
						toReorder: [],
					},
				},
				executionAction: {
					action: "continue",
					reason: "Continue with updated step",
				},
				userResponse: {
					needed: false,
					message: "",
					confirmationRequired: false,
				},
				contextUpdate: {
					addToContext: {},
					assumptions: { add: [], invalidate: [] },
				},
			};

			const result = applyPlanModifications(plan, analysis);
			expect(result.steps[1].description).toBe("Generate HTML document");
		});

		it("should remove steps", () => {
			const plan = createTestPlan();
			const analysis: PlanModificationAnalysis = {
				modificationType: "removal",
				confidence: 0.9,
				reasoning: "User wants to skip review",
				affectedSteps: {
					current: false,
					pending: ["step-3"],
					completed: [],
				},
				planChanges: {
					type: "remove",
					description: "Remove step 3",
					steps: {
						toUpdate: [],
						toInsert: [],
						toRemove: ["step-3"],
						toReorder: [],
					},
				},
				executionAction: {
					action: "continue",
					reason: "Skip review step",
				},
				userResponse: {
					needed: false,
					message: "",
					confirmationRequired: false,
				},
				contextUpdate: {
					addToContext: {},
					assumptions: { add: [], invalidate: [] },
				},
			};

			const result = applyPlanModifications(plan, analysis);
			expect(result.steps).toHaveLength(2);
			expect(result.steps.find((s) => s.id === "step-3")).toBeUndefined();
		});

		it("should insert new steps", () => {
			const plan = createTestPlan();
			const analysis: PlanModificationAnalysis = {
				modificationType: "addition",
				confidence: 0.9,
				reasoning: "User wants validation step",
				affectedSteps: { current: false, pending: [], completed: [] },
				planChanges: {
					type: "insert",
					description: "Add validation step",
					steps: {
						toUpdate: [],
						toInsert: [
							{
								afterStep: "step-2",
								newStep: {
									description: "Validate with stakeholders",
									type: "verify",
									riskLevel: "medium",
								},
							},
						],
						toRemove: [],
						toReorder: [],
					},
				},
				executionAction: {
					action: "continue",
					reason: "Continue with new step",
				},
				userResponse: {
					needed: false,
					message: "",
					confirmationRequired: false,
				},
				contextUpdate: {
					addToContext: {},
					assumptions: { add: [], invalidate: [] },
				},
			};

			const result = applyPlanModifications(plan, analysis);
			expect(result.steps).toHaveLength(4);
			expect(result.steps[2].description).toBe(
				"Validate with stakeholders",
			);
			expect(result.steps[2].order).toBe(3);
			expect(result.steps[3].order).toBe(4);
		});

		it("should renumber steps after modifications", () => {
			const plan = createTestPlan();
			const analysis: PlanModificationAnalysis = {
				modificationType: "removal",
				confidence: 0.9,
				reasoning: "Remove middle step",
				affectedSteps: {
					current: false,
					pending: ["step-2"],
					completed: [],
				},
				planChanges: {
					type: "remove",
					description: "Remove step 2",
					steps: {
						toUpdate: [],
						toInsert: [],
						toRemove: ["step-2"],
						toReorder: [],
					},
				},
				executionAction: { action: "continue", reason: "Continue" },
				userResponse: {
					needed: false,
					message: "",
					confirmationRequired: false,
				},
				contextUpdate: {
					addToContext: {},
					assumptions: { add: [], invalidate: [] },
				},
			};

			const result = applyPlanModifications(plan, analysis);
			expect(result.steps[0].order).toBe(1);
			expect(result.steps[1].order).toBe(2);
		});
	});

	describe("requiresConfirmation", () => {
		it("should require confirmation for pivot changes", () => {
			const analysis: PlanModificationAnalysis = {
				modificationType: "pivot",
				confidence: 0.8,
				reasoning: "Major direction change",
				affectedSteps: { current: false, pending: [], completed: [] },
				planChanges: {
					type: "replace",
					description: "Complete plan change",
					steps: {
						toUpdate: [],
						toInsert: [],
						toRemove: [],
						toReorder: [],
					},
				},
				executionAction: {
					action: "restart_from",
					fromStep: "step-1",
					reason: "Restart",
				},
				userResponse: {
					needed: true,
					message: "Confirm?",
					confirmationRequired: false,
				},
				contextUpdate: {
					addToContext: {},
					assumptions: { add: [], invalidate: [] },
				},
			};

			expect(requiresConfirmation(analysis)).toBe(true);
		});

		it("should require confirmation for multiple removals", () => {
			const analysis: PlanModificationAnalysis = {
				modificationType: "removal",
				confidence: 0.9,
				reasoning: "Remove several steps",
				affectedSteps: { current: false, pending: [], completed: [] },
				planChanges: {
					type: "remove",
					description: "Remove steps",
					steps: {
						toUpdate: [],
						toInsert: [],
						toRemove: ["s1", "s2", "s3"],
						toReorder: [],
					},
				},
				executionAction: { action: "continue", reason: "Continue" },
				userResponse: {
					needed: false,
					message: "",
					confirmationRequired: false,
				},
				contextUpdate: {
					addToContext: {},
					assumptions: { add: [], invalidate: [] },
				},
			};

			expect(requiresConfirmation(analysis)).toBe(true);
		});

		it("should require confirmation when completed steps affected", () => {
			const analysis: PlanModificationAnalysis = {
				modificationType: "modification",
				confidence: 0.9,
				reasoning: "Redo completed work",
				affectedSteps: {
					current: false,
					pending: [],
					completed: ["step-1"],
				},
				planChanges: {
					type: "update",
					description: "Update",
					steps: {
						toUpdate: [],
						toInsert: [],
						toRemove: [],
						toReorder: [],
					},
				},
				executionAction: {
					action: "restart_from",
					fromStep: "step-1",
					reason: "Redo",
				},
				userResponse: {
					needed: true,
					message: "Confirm?",
					confirmationRequired: false,
				},
				contextUpdate: {
					addToContext: {},
					assumptions: { add: [], invalidate: [] },
				},
			};

			expect(requiresConfirmation(analysis)).toBe(true);
		});

		it("should not require confirmation for simple additions", () => {
			const analysis: PlanModificationAnalysis = {
				modificationType: "addition",
				confidence: 0.9,
				reasoning: "Add one step",
				affectedSteps: { current: false, pending: [], completed: [] },
				planChanges: {
					type: "insert",
					description: "Add step",
					steps: {
						toUpdate: [],
						toInsert: [
							{
								afterStep: "step-1",
								newStep: { description: "New" },
							},
						],
						toRemove: [],
						toReorder: [],
					},
				},
				executionAction: { action: "continue", reason: "Continue" },
				userResponse: {
					needed: false,
					message: "",
					confirmationRequired: false,
				},
				contextUpdate: {
					addToContext: {},
					assumptions: { add: [], invalidate: [] },
				},
			};

			expect(requiresConfirmation(analysis)).toBe(false);
		});
	});

	describe("validateModifiedPlan", () => {
		it("should validate a correct plan", () => {
			const plan = createTestPlan();
			const result = validateModifiedPlan(plan);

			expect(result.isValid).toBe(true);
			expect(result.issues).toHaveLength(0);
		});

		it("should detect empty plan", () => {
			const plan: TaskPlan = {
				id: "plan-1",
				description: "Empty",
				riskLevel: "low",
				strategy: "agent",
				createdAt: new Date().toISOString(),
				steps: [],
			};

			const result = validateModifiedPlan(plan);
			expect(result.isValid).toBe(false);
			expect(result.issues).toContain("Plan has no steps");
		});

		it("should detect duplicate step IDs", () => {
			const plan: TaskPlan = {
				id: "plan-1",
				description: "Duplicate IDs",
				riskLevel: "low",
				strategy: "agent",
				createdAt: new Date().toISOString(),
				steps: [
					{
						id: "step-1",
						description: "A",
						type: "generate",
						order: 1,
						status: "pending",
						riskLevel: "low",
						requiresApproval: false,
					},
					{
						id: "step-1",
						description: "B",
						type: "generate",
						order: 2,
						status: "pending",
						riskLevel: "low",
						requiresApproval: false,
					},
				],
			};

			const result = validateModifiedPlan(plan);
			expect(result.isValid).toBe(false);
			expect(result.issues).toContain("Plan has duplicate step IDs");
		});
	});
});
