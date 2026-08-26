/**
 * Plan Adapter
 *
 * Handles adaptive plan modification during execution.
 * Enables mid-execution changes without full restart.
 *
 * Part of Improvement 3: Adaptive Plan Modification
 */

import { generateText } from "@repo/ai";
import { logger } from "@repo/logs";
import type { JourneyState, PlanModification } from "../journey/types";
import type { TaskPlan, TaskStep } from "../types";
import { getAiModel, safeParseJson } from "../utils";

/**
 * Types of plan modifications.
 */
export type ModificationType =
	| "clarification"
	| "modification"
	| "addition"
	| "removal"
	| "pivot"
	| "reorder"
	| "pause"
	| "cancel"
	| "none";

/**
 * Result of analyzing user input for plan modification.
 */
export interface PlanModificationAnalysis {
	modificationType: ModificationType;
	confidence: number;
	reasoning: string;
	affectedSteps: {
		current: boolean;
		pending: string[];
		completed: string[];
	};
	planChanges: PlanChanges;
	executionAction: ExecutionAction;
	userResponse: {
		needed: boolean;
		message: string;
		confirmationRequired: boolean;
	};
	contextUpdate: {
		addToContext: Record<string, unknown>;
		assumptions: {
			add: string[];
			invalidate: string[];
		};
	};
}

export interface PlanChanges {
	type: "none" | "update" | "insert" | "remove" | "replace" | "reorder";
	description: string;
	steps: {
		toUpdate: StepUpdate[];
		toInsert: StepInsert[];
		toRemove: string[];
		toReorder: StepReorder[];
	};
}

export interface StepUpdate {
	stepId: string;
	changes: Partial<TaskStep>;
}

export interface StepInsert {
	afterStep: string | null;
	beforeStep?: string;
	newStep: Partial<TaskStep>;
}

export interface StepReorder {
	stepId: string;
	newOrder: number;
}

export interface ExecutionAction {
	action: "continue" | "retry" | "skip" | "pause" | "abort" | "restart_from";
	fromStep?: string;
	reason: string;
}

/**
 * Analyzes user input to determine how it affects the current plan.
 */
export async function analyzePlanModification(
	userMessage: string,
	currentPlan: TaskPlan,
	journeyState: JourneyState,
	userId: string,
	organizationId?: string,
): Promise<PlanModificationAnalysis> {
	logger.info("[PlanAdapter] Analyzing plan modification", {
		messageLength: userMessage.length,
		currentStepIndex: journeyState.currentStepIndex,
		totalSteps: currentPlan.steps.length,
	});

	const model = await getAiModel(userId, organizationId);

	// Build context for the prompt
	const completedSteps = currentPlan.steps
		.slice(0, journeyState.currentStepIndex)
		.map((s) => `✓ ${s.order}. ${s.description}`)
		.join("\n");

	const currentStep = currentPlan.steps[journeyState.currentStepIndex];
	const currentStepStr = currentStep
		? `→ ${currentStep.order}. ${currentStep.description} (IN PROGRESS)`
		: "None";

	const pendingSteps = currentPlan.steps
		.slice(journeyState.currentStepIndex + 1)
		.map((s) => `○ ${s.order}. ${s.description}`)
		.join("\n");

	const systemPrompt = `You analyze user messages to determine how they affect an executing plan.

## Current Journey State

**Original Goal**: ${journeyState.originalGoal}
**Plan Status**: ${journeyState.phase}

### Completed Steps
${completedSteps || "None yet"}

### Current Step
${currentStepStr}

### Pending Steps
${pendingSteps || "None remaining"}

## Classification Rules

Classify the user's message into ONE category:

1. **clarification**: Additional context for current task, no goal change
2. **modification**: Change HOW something is done, not WHAT
3. **addition**: Add new requirements/steps without removing existing
4. **removal**: Skip or remove planned steps
5. **pivot**: Change overall direction or goal significantly
6. **reorder**: Change the sequence of steps
7. **pause**: User wants to stop and wait
8. **cancel**: User wants to abort entirely
9. **none**: No change needed (acknowledgment, question, positive feedback)

## Output Format

Respond with JSON:
{
  "modificationType": "one of the above",
  "confidence": 0.0-1.0,
  "reasoning": "Why this classification",
  "affectedSteps": {
    "current": true/false,
    "pending": ["step-ids"],
    "completed": ["step-ids if need revision"]
  },
  "planChanges": {
    "type": "none | update | insert | remove | replace | reorder",
    "description": "What changes to make",
    "steps": {
      "toUpdate": [{"stepId": "id", "changes": {"description": "new desc"}}],
      "toInsert": [{"afterStep": "step-id", "newStep": {"description": "new step", "capability": "llm"}}],
      "toRemove": ["step-ids"],
      "toReorder": [{"stepId": "id", "newOrder": 2}]
    }
  },
  "executionAction": {
    "action": "continue | retry | skip | pause | abort | restart_from",
    "fromStep": "step-id if restart",
    "reason": "Why this action"
  },
  "userResponse": {
    "needed": true/false,
    "message": "Message to show user",
    "confirmationRequired": true/false
  },
  "contextUpdate": {
    "addToContext": {"key": "value"},
    "assumptions": {
      "add": ["new assumption"],
      "invalidate": ["old assumption"]
    }
  }
}`;

	const response = await generateText({
		model,
		system: systemPrompt,
		prompt: `User message: "${userMessage}"`,
		temperature: 0.1,
	});

	const parsed = safeParseJson<PlanModificationAnalysis>(
		response.text || "{}",
		"object",
	);

	if (!parsed) {
		logger.warn(
			"[PlanAdapter] Failed to parse modification analysis, defaulting to none",
		);
		return {
			modificationType: "none",
			confidence: 0.5,
			reasoning: "Could not analyze message",
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
			executionAction: { action: "continue", reason: "Default action" },
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
	}

	logger.info("[PlanAdapter] Modification analysis complete", {
		type: parsed.modificationType,
		confidence: parsed.confidence,
		affectedSteps: parsed.affectedSteps,
	});

	return parsed;
}

/**
 * Applies plan modifications to create an updated plan.
 */
export function applyPlanModifications(
	currentPlan: TaskPlan,
	analysis: PlanModificationAnalysis,
): TaskPlan {
	if (analysis.planChanges.type === "none") {
		return currentPlan;
	}

	const { steps } = analysis.planChanges;
	let updatedSteps = [...currentPlan.steps];

	// Apply updates
	for (const update of steps.toUpdate) {
		const index = updatedSteps.findIndex((s) => s.id === update.stepId);
		if (index >= 0) {
			updatedSteps[index] = { ...updatedSteps[index], ...update.changes };
		}
	}

	// Apply removals
	if (steps.toRemove.length > 0) {
		updatedSteps = updatedSteps.filter(
			(s) => !steps.toRemove.includes(s.id),
		);
	}

	// Apply insertions
	for (const insert of steps.toInsert) {
		const newStep: TaskStep = {
			id: `step-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
			description: insert.newStep.description || "New step",
			type: insert.newStep.type || "generate",
			status: "pending",
			order: 0,
			capability: insert.newStep.capability,
			executor: insert.newStep.executor,
			riskLevel: insert.newStep.riskLevel || "low",
			requiresApproval: insert.newStep.requiresApproval || false,
			inputs: insert.newStep.inputs,
			expectedOutput: insert.newStep.expectedOutput,
		};

		if (insert.afterStep === null) {
			updatedSteps.unshift(newStep);
		} else {
			const afterIndex = updatedSteps.findIndex(
				(s) => s.id === insert.afterStep,
			);
			if (afterIndex >= 0) {
				updatedSteps.splice(afterIndex + 1, 0, newStep);
			} else {
				updatedSteps.push(newStep);
			}
		}
	}

	// Apply reordering
	if (steps.toReorder.length > 0) {
		for (const reorder of steps.toReorder) {
			const stepIndex = updatedSteps.findIndex(
				(s) => s.id === reorder.stepId,
			);
			if (stepIndex >= 0) {
				const [step] = updatedSteps.splice(stepIndex, 1);
				const insertAt = Math.min(
					reorder.newOrder - 1,
					updatedSteps.length,
				);
				updatedSteps.splice(insertAt, 0, step);
			}
		}
	}

	// Renumber steps
	updatedSteps = updatedSteps.map((step, index) => ({
		...step,
		order: index + 1,
	}));

	return {
		...currentPlan,
		steps: updatedSteps,
	};
}

/**
 * Creates a modification record for tracking.
 */
export function createModificationRecord(
	analysis: PlanModificationAnalysis,
	userMessage: string,
	previousPlan: TaskPlan,
): PlanModification {
	return {
		id: `mod-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
		type: analysis.modificationType as PlanModification["type"],
		description: analysis.planChanges.description,
		timestamp: new Date(),
		triggeredBy: "user",
		userMessage,
		affectedSteps: {
			added: analysis.planChanges.steps.toInsert.map(
				(i) => i.newStep.id || "new",
			),
			removed: analysis.planChanges.steps.toRemove,
			modified: analysis.planChanges.steps.toUpdate.map((u) => u.stepId),
			reordered: analysis.planChanges.steps.toReorder.map(
				(r) => r.stepId,
			),
		},
		previousPlanSnapshot: previousPlan,
		reasoning: analysis.reasoning,
		approved: true,
	};
}

/**
 * Determines if a modification requires user confirmation.
 */
export function requiresConfirmation(
	analysis: PlanModificationAnalysis,
): boolean {
	// Major changes require confirmation
	if (analysis.modificationType === "pivot") {
		return true;
	}
	if (analysis.planChanges.steps.toRemove.length > 2) {
		return true;
	}
	if (analysis.affectedSteps.completed.length > 0) {
		return true;
	}
	if (analysis.executionAction.action === "restart_from") {
		return true;
	}

	// High-impact changes
	const totalChanges =
		analysis.planChanges.steps.toUpdate.length +
		analysis.planChanges.steps.toInsert.length +
		analysis.planChanges.steps.toRemove.length;
	if (totalChanges > 3) {
		return true;
	}

	return analysis.userResponse.confirmationRequired;
}

/**
 * Generates a user-friendly description of plan changes.
 */
export function describePlanChanges(
	analysis: PlanModificationAnalysis,
	newPlan: TaskPlan,
): string {
	const lines: string[] = [];

	lines.push("## Plan Update");
	lines.push("");
	lines.push(`**Change Type**: ${analysis.modificationType}`);
	lines.push(`**Reason**: ${analysis.reasoning}`);
	lines.push("");

	const { steps } = analysis.planChanges;

	if (steps.toInsert.length > 0) {
		lines.push("### Added Steps");
		for (const insert of steps.toInsert) {
			lines.push(`+ ${insert.newStep.description}`);
		}
		lines.push("");
	}

	if (steps.toRemove.length > 0) {
		lines.push("### Removed Steps");
		for (const stepId of steps.toRemove) {
			lines.push(`- Step ${stepId}`);
		}
		lines.push("");
	}

	if (steps.toUpdate.length > 0) {
		lines.push("### Modified Steps");
		for (const update of steps.toUpdate) {
			lines.push(
				`~ Step ${update.stepId}: ${update.changes.description || "Updated"}`,
			);
		}
		lines.push("");
	}

	lines.push("### Updated Plan");
	for (const step of newPlan.steps) {
		const statusIcon =
			step.status === "complete"
				? "✓"
				: step.status === "in_progress"
					? "→"
					: "○";
		lines.push(`${statusIcon} ${step.order}. ${step.description}`);
	}

	return lines.join("\n");
}

/**
 * Validates that a modified plan is coherent.
 */
export function validateModifiedPlan(plan: TaskPlan): {
	isValid: boolean;
	issues: string[];
} {
	const issues: string[] = [];

	// Check for empty plan
	if (plan.steps.length === 0) {
		issues.push("Plan has no steps");
	}

	// Check for duplicate IDs
	const ids = plan.steps.map((s) => s.id);
	const uniqueIds = new Set(ids);
	if (ids.length !== uniqueIds.size) {
		issues.push("Plan has duplicate step IDs");
	}

	// Check for order continuity
	const orders = plan.steps.map((s) => s.order).sort((a, b) => a - b);
	for (let i = 0; i < orders.length; i++) {
		if (orders[i] !== i + 1) {
			issues.push(`Step ordering is not continuous at position ${i + 1}`);
			break;
		}
	}

	// Check for orphaned dependencies
	for (const step of plan.steps) {
		const inputs = step.inputs as { contextInputs?: string[] } | undefined;
		if (inputs?.contextInputs) {
			for (const dep of inputs.contextInputs) {
				if (
					!dep.includes("*") &&
					!plan.steps.some((s) => s.id === dep)
				) {
					issues.push(
						`Step ${step.id} depends on non-existent step ${dep}`,
					);
				}
			}
		}
	}

	return {
		isValid: issues.length === 0,
		issues,
	};
}

/**
 * Quick check for modification indicators in user message.
 */
export function hasModificationIndicators(message: string): boolean {
	const indicators = [
		"actually",
		"instead",
		"change",
		"modify",
		"update",
		"also add",
		"don't forget",
		"include",
		"skip",
		"remove",
		"wait",
		"stop",
		"cancel",
		"hold on",
		"pause",
	];

	const messageLower = message.toLowerCase();
	return indicators.some((ind) => messageLower.includes(ind));
}

/**
 * Activity wrapper for plan modification analysis.
 */
export async function analyzePlanModificationActivity(
	userMessage: string,
	currentPlan: TaskPlan,
	journeyStateJson: string,
	userId: string,
	organizationId?: string,
): Promise<PlanModificationAnalysis> {
	const { deserializeJourneyState } = await import(
		"../journey/journey-state-manager"
	);
	const journeyState = deserializeJourneyState(journeyStateJson);
	return analyzePlanModification(
		userMessage,
		currentPlan,
		journeyState,
		userId,
		organizationId,
	);
}
