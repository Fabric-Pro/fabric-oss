/**
 * Trust Activities
 *
 * Temporal activities for trust-based approval management.
 * These wrap the trust-manager functions for use in workflows.
 */

import { logger } from "@repo/logs";
import type { TaskPlan, TaskStep } from "../../../workflows/orchestrator/types";
import {
	type AutoApprovalDecision,
	analyzePlanForApproval,
	checkAutoApproval,
	loadTrustConfiguration,
	type PlanApprovalSummary,
	recordTrustOutcome,
	saveTrustConfiguration,
	type TrustConfiguration,
} from "./trust-manager";

export interface AnalyzePlanApprovalInput {
	plan: TaskPlan;
	userId: string;
	organizationId?: string;
}

export interface AnalyzePlanApprovalOutput {
	summary: PlanApprovalSummary;
	requiresApproval: boolean;
	autoApprovedStepIds: string[];
	pendingApprovalStepIds: string[];
	consolidatedReason: string;
}

/**
 * Analyze a plan for approval requirements.
 * Returns which steps need approval and which can be auto-approved.
 */
export async function analyzePlanApprovalActivity(
	input: AnalyzePlanApprovalInput,
): Promise<AnalyzePlanApprovalOutput> {
	logger.info("[TrustActivity] Analyzing plan for approval", {
		planId: input.plan.id,
		stepCount: input.plan.steps.length,
		userId: input.userId,
	});

	// Load user's trust configuration
	const trustConfig = await loadTrustConfiguration(
		input.userId,
		input.organizationId,
	);

	// Analyze the plan
	const summary = analyzePlanForApproval(input.plan, trustConfig);

	// Determine if any approval is needed
	const requiresApproval = summary.pendingApprovalSteps.length > 0;

	// Build consolidated reason for approval
	let consolidatedReason = "";
	if (requiresApproval) {
		const reasons: string[] = [];

		if (summary.highRiskSteps.length > 0) {
			reasons.push(
				`${summary.highRiskSteps.length} high-risk step(s): ${summary.highRiskSteps.map((s) => s.description).join(", ")}`,
			);
		}

		if (summary.plannedActions.filter((a) => !a.reversible).length > 0) {
			reasons.push("Contains irreversible operations");
		}

		consolidatedReason =
			reasons.length > 0
				? reasons.join(". ")
				: `${summary.pendingApprovalSteps.length} step(s) require approval`;
	}

	logger.info("[TrustActivity] Plan analysis complete", {
		planId: input.plan.id,
		requiresApproval,
		autoApprovedCount: summary.autoApprovedSteps.length,
		pendingApprovalCount: summary.pendingApprovalSteps.length,
	});

	return {
		summary,
		requiresApproval,
		autoApprovedStepIds: summary.autoApprovedSteps,
		pendingApprovalStepIds: summary.pendingApprovalSteps,
		consolidatedReason,
	};
}

export interface CheckStepAutoApprovalInput {
	step: TaskStep;
	userId: string;
	organizationId?: string;
}

/**
 * Check if a specific step can be auto-approved.
 */
export async function checkStepAutoApprovalActivity(
	input: CheckStepAutoApprovalInput,
): Promise<AutoApprovalDecision> {
	logger.debug("[TrustActivity] Checking step auto-approval", {
		stepId: input.step.id,
		stepType: input.step.type,
		riskLevel: input.step.riskLevel,
	});

	const trustConfig = await loadTrustConfiguration(
		input.userId,
		input.organizationId,
	);

	return checkAutoApproval(input.step, trustConfig);
}

export interface RecordApprovalOutcomeInput {
	userId: string;
	organizationId?: string;
	stepId: string;
	stepDescription?: string;
	stepType?: string;
	executor?: string;
	riskLevel?: "low" | "medium" | "high" | "critical";
	approved: boolean;
	success?: boolean;
	feedback?: string;
}

/**
 * Record the outcome of an approval decision for trust learning.
 */
export async function recordApprovalOutcomeActivity(
	input: RecordApprovalOutcomeInput,
): Promise<void> {
	logger.debug("[TrustActivity] Recording approval outcome", {
		stepId: input.stepId,
		approved: input.approved,
		success: input.success,
	});

	const trustConfig = await loadTrustConfiguration(
		input.userId,
		input.organizationId,
	);

	// Create a minimal TaskStep for the trust system
	// Note: type must be a valid TaskType
	const validType =
		input.stepType === "api" ||
		input.stepType === "browser" ||
		input.stepType === "hybrid" ||
		input.stepType === "generate" ||
		input.stepType === "research" ||
		input.stepType === "direct"
			? input.stepType
			: "api";

	const step: TaskStep = {
		id: input.stepId,
		description: input.stepDescription || input.stepId,
		type: validType as TaskStep["type"],
		status: "complete",
		order: 1,
		executor: input.executor,
		riskLevel: input.riskLevel || "low",
	};

	const outcome: "success" | "failure" | "unknown" =
		input.success === true
			? "success"
			: input.success === false
				? "failure"
				: "unknown";

	recordTrustOutcome(trustConfig, step, input.approved, outcome);

	// Save updated trust configuration (only takes config as argument)
	await saveTrustConfiguration(trustConfig);
}

export interface GetTrustConfigInput {
	userId: string;
	organizationId?: string;
}

/**
 * Get the current trust configuration for a user.
 */
export async function getTrustConfigActivity(
	input: GetTrustConfigInput,
): Promise<TrustConfiguration> {
	return loadTrustConfiguration(input.userId, input.organizationId);
}
