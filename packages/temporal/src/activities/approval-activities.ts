/**
 * Approval Activities
 *
 * Temporal activities for the approval workflow.
 * Handles database operations and notifications.
 */

import { db } from "@repo/database";

// =============================================================================
// Types
// =============================================================================

export interface CreateApprovalRecordInput {
	approvalId: string;
	executionId: string;
	stepId: string;
	stepDescription: string;
	stepType: string;
	userId: string;
	organizationId?: string;
	riskScore?: number;
	riskLevel?: string;
	riskFactors?: string[];
	metadata?: Record<string, unknown>;
}

export interface UpdateApprovalRecordInput {
	approvalId: string;
	status: "approved" | "rejected" | "expired";
	feedback?: string;
	decidedBy?: string;
	decidedAt: Date;
}

export interface NotifyApprovalRequestInput {
	approvalId: string;
	userId: string;
	stepDescription: string;
	riskScore?: number;
	riskLevel?: string;
}

// =============================================================================
// Activities
// =============================================================================

/**
 * Create an approval record in the database
 */
export async function createApprovalRecord(
	input: CreateApprovalRecordInput,
): Promise<{ success: boolean }> {
	console.log(
		`[ApprovalActivity] Creating approval record: ${input.approvalId}`,
	);

	// First, find or create a task to link the approval to
	let taskId: string;

	// XOR pattern: filter by organization context
	const orgFilter = input.organizationId
		? { organizationId: input.organizationId }
		: { organizationId: null };

	// Check if there's an existing task for this execution
	const existingTask = await db.agentTask.findFirst({
		where: {
			userId: input.userId,
			workflowId: input.executionId,
			...orgFilter, // Enforce tenant isolation
		},
		select: { id: true },
	});

	if (existingTask) {
		taskId = existingTask.id;
	} else {
		// Create a new task for this approval
		const newTask = await db.agentTask.create({
			data: {
				userId: input.userId,
				organizationId: input.organizationId,
				agentId: "workflow-executor",
				status: "pending",
				stage: "approval",
				input: {
					executionId: input.executionId,
					stepId: input.stepId,
					stepType: input.stepType,
					riskScore: input.riskScore,
					riskLevel: input.riskLevel,
					riskFactors: input.riskFactors,
					...input.metadata,
				},
				framework: "temporal",
				workflowId: input.executionId,
			},
		});
		taskId = newTask.id;
	}

	// Create the approval record
	await db.agentApproval.create({
		data: {
			id: input.approvalId,
			taskId,
			userId: input.userId,
			status: "pending",
			changes: {
				stepId: input.stepId,
				stepType: input.stepType,
				stepDescription: input.stepDescription,
				riskScore: input.riskScore,
				riskLevel: input.riskLevel,
				riskFactors: input.riskFactors,
				...input.metadata,
			},
			confidence: input.riskScore ? 1 - input.riskScore / 100 : undefined,
		},
	});

	console.log(
		`[ApprovalActivity] Approval record created: ${input.approvalId}`,
	);
	return { success: true };
}

/**
 * Update an approval record with the decision
 */
export async function updateApprovalRecord(
	input: UpdateApprovalRecordInput,
): Promise<{ success: boolean }> {
	console.log(
		`[ApprovalActivity] Updating approval record: ${input.approvalId} -> ${input.status}`,
	);

	await db.agentApproval.update({
		where: { id: input.approvalId },
		data: {
			status: input.status,
			feedback: input.feedback,
			decidedAt: input.decidedAt,
		},
	});

	// Also update the linked task status
	const approval = await db.agentApproval.findUnique({
		where: { id: input.approvalId },
		select: { taskId: true },
	});

	if (approval?.taskId) {
		await db.agentTask.update({
			where: { id: approval.taskId },
			data: {
				status: input.status === "approved" ? "completed" : "failed",
				completedAt: input.decidedAt,
			},
		});
	}

	console.log(
		`[ApprovalActivity] Approval record updated: ${input.approvalId}`,
	);
	return { success: true };
}

/**
 * Send notification about pending approval
 *
 * This is a placeholder - in production, this would:
 * - Send email notification
 * - Push notification to UI
 * - Create in-app notification
 */
export async function notifyApprovalRequest(
	input: NotifyApprovalRequestInput,
): Promise<{ success: boolean }> {
	console.log(
		`[ApprovalActivity] Sending notification for approval: ${input.approvalId}`,
	);

	// TODO: Implement actual notification sending
	// Options:
	// 1. Email via mail package
	// 2. WebSocket push to connected clients
	// 3. Create in-app notification record

	// For now, just log
	console.log(
		`[ApprovalActivity] Notification would be sent to user ${input.userId}:`,
	);
	console.log(`  - Step: ${input.stepDescription}`);
	console.log(`  - Risk: ${input.riskLevel} (${input.riskScore}%)`);

	return { success: true };
}

/**
 * Get pending approvals for a user with tenant isolation
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
): Promise<
	Array<{
		id: string;
		stepDescription: string;
		riskScore?: number;
		riskLevel?: string;
		createdAt: Date;
	}>
> {
	// XOR pattern: filter through task's organizationId
	const orgFilter = organizationId
		? { organizationId }
		: { organizationId: null };

	const approvals = await db.agentApproval.findMany({
		where: {
			userId,
			status: "pending",
			task: orgFilter, // Filter by task's organization context
		},
		select: {
			id: true,
			changes: true,
			createdAt: true,
		},
		orderBy: { createdAt: "desc" },
		take: 50,
	});

	return approvals.map((a) => {
		const changes = a.changes as Record<string, unknown>;
		return {
			id: a.id,
			stepDescription:
				(changes.stepDescription as string) || "Unknown step",
			riskScore: changes.riskScore as number | undefined,
			riskLevel: changes.riskLevel as string | undefined,
			createdAt: a.createdAt,
		};
	});
}
