/**
 * Agent Approval Queries
 *
 * Database queries for managing human-in-the-loop (HITL) approvals.
 * Used by the orchestrator and Temporal workflows for risk-based approval flows.
 */

import { type AgentApproval, db, type Prisma } from "../client";

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

export interface CreateApprovalInput {
	taskId: string;
	userId: string;
	action: string;
	changes: Record<string, unknown>;
	confidence?: number;
	metadata?: Record<string, unknown>;
	expiresInMs?: number;
}

export interface ApprovalWithDetails extends AgentApproval {
	task: {
		id: string;
		agentId: string;
		status: string;
	};
}

/**
 * Create an approval request linked to an agent task
 */
export async function createApproval(
	input: CreateApprovalInput,
): Promise<AgentApproval> {
	return db.agentApproval.create({
		data: {
			taskId: input.taskId,
			userId: input.userId,
			status: "pending",
			changes: input.changes as Prisma.InputJsonValue,
			confidence: input.confidence,
		},
	});
}

/**
 * Get a pending approval by ID
 */
export async function getApprovalById(
	approvalId: string,
): Promise<ApprovalWithDetails | null> {
	return db.agentApproval.findUnique({
		where: { id: approvalId },
		include: {
			task: {
				select: {
					id: true,
					agentId: true,
					status: true,
				},
			},
		},
	});
}

/**
 * Get all pending approvals for a user with tenant isolation
 *
 * TENANT ISOLATION (XOR Pattern):
 * - ORGANIZATION CONTEXT (organizationId provided): Only org approvals
 * - PERSONAL CONTEXT (userId only, no organizationId): Only personal approvals
 *
 * Approvals are linked to tasks, which have organizationId. We filter through the task relation.
 */
export async function getPendingApprovals(
	userId: string,
	organizationId?: string,
	limit = 20,
): Promise<ApprovalWithDetails[]> {
	// XOR pattern: filter through task's organizationId
	const orgFilter = organizationId
		? { organizationId }
		: { organizationId: null };

	return db.agentApproval.findMany({
		where: {
			userId,
			status: "pending",
			task: orgFilter, // Filter by task's organization context
		},
		include: {
			task: {
				select: {
					id: true,
					agentId: true,
					status: true,
				},
			},
		},
		orderBy: { createdAt: "desc" },
		take: limit,
	});
}

/**
 * Approve a pending approval request
 */
export async function approveRequest(
	approvalId: string,
	feedback?: string,
): Promise<AgentApproval> {
	return db.agentApproval.update({
		where: { id: approvalId },
		data: {
			status: "approved",
			feedback,
			decidedAt: new Date(),
		},
	});
}

/**
 * Reject a pending approval request
 */
export async function rejectRequest(
	approvalId: string,
	feedback: string,
): Promise<AgentApproval> {
	return db.agentApproval.update({
		where: { id: approvalId },
		data: {
			status: "rejected",
			feedback,
			decidedAt: new Date(),
		},
	});
}

/**
 * Expire old pending approvals
 */
export async function expireOldApprovals(
	olderThanMs = 300000, // 5 minutes default
): Promise<number> {
	const cutoff = new Date(Date.now() - olderThanMs);

	const result = await db.agentApproval.updateMany({
		where: {
			status: "pending",
			createdAt: { lt: cutoff },
		},
		data: {
			status: "expired",
			decidedAt: new Date(),
		},
	});

	return result.count;
}

/**
 * Check if an approval is still pending
 */
export async function isApprovalPending(approvalId: string): Promise<boolean> {
	const approval = await db.agentApproval.findUnique({
		where: { id: approvalId },
		select: { status: true },
	});

	return approval?.status === "pending";
}

/**
 * Get approval status
 */
export async function getApprovalStatus(
	approvalId: string,
): Promise<{ status: ApprovalStatus; feedback?: string | null } | null> {
	const approval = await db.agentApproval.findUnique({
		where: { id: approvalId },
		select: { status: true, feedback: true },
	});

	if (!approval) {
		return null;
	}

	return {
		status: approval.status as ApprovalStatus,
		feedback: approval.feedback,
	};
}
