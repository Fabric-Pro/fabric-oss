/**
 * Human Approval Workflow
 *
 * Durable workflow for human-in-the-loop approval requests.
 * Follows the pattern from fabric/standards/backend/temporal.md
 *
 * Features:
 * - Signal-based approval/rejection
 * - Query for current status
 * - Configurable timeout with expiration
 * - Risk-aware context for UI display
 * - Database integration for persistence
 */

import {
	condition,
	defineQuery,
	defineSignal,
	log,
	proxyActivities,
	setHandler,
} from "@temporalio/workflow";
import type * as activities from "../activities/approval-activities";

// Proxy approval activities
const { createApprovalRecord, updateApprovalRecord, notifyApprovalRequest } =
	proxyActivities<typeof activities>({
		startToCloseTimeout: "30s",
		heartbeatTimeout: "30 seconds",
		retry: {
			initialInterval: "1s",
			maximumAttempts: 3,
		},
	});

// =============================================================================
// Signals and Queries
// =============================================================================

export interface ApprovalDecision {
	approved: boolean;
	feedback?: string;
	decidedBy?: string;
}

export const approveSignal = defineSignal<[ApprovalDecision]>("approve");

export interface ApprovalStatus {
	status: "pending" | "approved" | "rejected" | "expired";
	approvalId: string;
	stepDescription: string;
	riskScore?: number;
	riskLevel?: string;
	createdAt: string;
	decidedAt?: string;
	feedback?: string;
}

export const statusQuery = defineQuery<ApprovalStatus>("status");

// =============================================================================
// Types
// =============================================================================

export interface ApprovalWorkflowInput {
	/** Unique ID for this approval request */
	approvalId: string;
	/** Execution ID this approval is for */
	executionId: string;
	/** Step ID being approved */
	stepId: string;
	/** Human-readable description of what's being approved */
	stepDescription: string;
	/** Type of step (e.g., "http-request", "browser-automation") */
	stepType: string;
	/** User who owns this workflow */
	userId: string;
	/** Optional organization */
	organizationId?: string;
	/** Risk score (0-100) */
	riskScore?: number;
	/** Risk level category */
	riskLevel?: "low" | "medium" | "high" | "critical";
	/** Factors contributing to risk */
	riskFactors?: string[];
	/** Timeout in milliseconds (default: 5 minutes) */
	timeoutMs?: number;
	/** Whether to send notification */
	sendNotification?: boolean;
	/** Additional context for display */
	metadata?: Record<string, unknown>;
}

export interface ApprovalWorkflowOutput {
	approvalId: string;
	approved: boolean;
	status: "approved" | "rejected" | "expired";
	feedback?: string;
	decidedBy?: string;
	decidedAt?: string;
	durationMs: number;
}

// =============================================================================
// Workflow Implementation
// =============================================================================

/**
 * Human Approval Workflow
 *
 * Waits for a human to approve or reject an action via signal.
 * Used by other workflows to gate high-risk operations.
 */
export async function approvalWorkflow(
	input: ApprovalWorkflowInput,
): Promise<ApprovalWorkflowOutput> {
	const startTime = Date.now();
	const timeoutMs = input.timeoutMs ?? 300000; // 5 minutes default

	let decision: ApprovalDecision | undefined;
	let status: "pending" | "approved" | "rejected" | "expired" = "pending";
	let decidedAt: string | undefined;

	log.info("Starting approval workflow", {
		approvalId: input.approvalId,
		stepId: input.stepId,
		riskScore: input.riskScore,
		timeoutMs,
	});

	// Set up signal handler for approval/rejection
	setHandler(approveSignal, (data) => {
		log.info("Received approval decision", {
			approvalId: input.approvalId,
			approved: data.approved,
		});
		decision = data;
		status = data.approved ? "approved" : "rejected";
		decidedAt = new Date().toISOString();
	});

	// Set up query handler for status checks
	setHandler(statusQuery, () => ({
		status,
		approvalId: input.approvalId,
		stepDescription: input.stepDescription,
		riskScore: input.riskScore,
		riskLevel: input.riskLevel,
		createdAt: new Date(startTime).toISOString(),
		decidedAt,
		feedback: decision?.feedback,
	}));

	// Create approval record in database
	await createApprovalRecord({
		approvalId: input.approvalId,
		executionId: input.executionId,
		stepId: input.stepId,
		stepDescription: input.stepDescription,
		stepType: input.stepType,
		userId: input.userId,
		organizationId: input.organizationId,
		riskScore: input.riskScore,
		riskLevel: input.riskLevel,
		riskFactors: input.riskFactors,
		metadata: input.metadata,
	});

	// Send notification if enabled
	if (input.sendNotification !== false) {
		await notifyApprovalRequest({
			approvalId: input.approvalId,
			userId: input.userId,
			stepDescription: input.stepDescription,
			riskScore: input.riskScore,
			riskLevel: input.riskLevel,
		});
	}

	// Wait for decision or timeout
	log.info("Waiting for approval decision", {
		approvalId: input.approvalId,
		timeoutMs,
	});

	const received = await condition(() => decision !== undefined, timeoutMs);

	const durationMs = Date.now() - startTime;

	if (!received) {
		// Timeout - mark as expired
		status = "expired";
		decidedAt = new Date().toISOString();

		log.info("Approval request expired", {
			approvalId: input.approvalId,
			durationMs,
		});

		await updateApprovalRecord({
			approvalId: input.approvalId,
			status: "expired",
			decidedAt: new Date(),
		});

		return {
			approvalId: input.approvalId,
			approved: false,
			status: "expired",
			feedback: `Approval request expired after ${Math.ceil(timeoutMs / 1000)} seconds`,
			decidedAt,
			durationMs,
		};
	}

	if (!decision) {
		throw new Error(
			"Approval decision was not set before workflow completion",
		);
	}

	// Update database with decision
	await updateApprovalRecord({
		approvalId: input.approvalId,
		status: decision.approved ? "approved" : "rejected",
		feedback: decision.feedback,
		decidedBy: decision.decidedBy,
		decidedAt: new Date(),
	});

	log.info("Approval workflow completed", {
		approvalId: input.approvalId,
		status,
		durationMs,
	});

	return {
		approvalId: input.approvalId,
		approved: decision.approved,
		status: decision.approved ? "approved" : "rejected",
		feedback: decision.feedback,
		decidedBy: decision.decidedBy,
		decidedAt,
		durationMs,
	};
}
