import type { Prisma, WorkflowBuilderStatus } from "../../client";

export interface WorkspaceWorkflowBindingGuard {
	workflowId: string;
	userId: string;
	organizationId: string;
	projectId: string;
	workspaceFrameId: string;
	workflowUpdatedAt: Date;
	frameUpdatedAt: Date;
	status: WorkflowBuilderStatus;
}

export class WorkspaceWorkflowBindingConflictError extends Error {
	constructor() {
		super(
			"The Workspace or workflow changed. Read its current settings again.",
		);
		this.name = "WorkspaceWorkflowBindingConflictError";
	}
}

/**
 * Held only for the database operation, never for Temporal or inference.
 * Lock order: idempotency key (when present), workflow, frame, project, cap.
 * The timestamps bind the graph/surface already validated by the command to
 * these rows; concurrent edits cannot replace them before the operation commits.
 */
export async function assertWorkspaceWorkflowBindingWithin(
	tx: Prisma.TransactionClient,
	guard: WorkspaceWorkflowBindingGuard,
) {
	const workflows = await tx.$queryRaw<Array<{ id: string }>>`
		SELECT id FROM workflow
		WHERE id = ${guard.workflowId} AND "userId" = ${guard.userId}
			AND "organizationId" = ${guard.organizationId}
			AND "projectId" = ${guard.projectId}
			AND "updatedAt" = ${guard.workflowUpdatedAt}
			AND status = ${guard.status}::"WorkflowBuilderStatus"
		FOR SHARE
	`;
	if (workflows.length !== 1) {
		throw new WorkspaceWorkflowBindingConflictError();
	}
	const frames = await tx.$queryRaw<Array<{ id: string }>>`
		SELECT id FROM agent_workspace_file
		WHERE id = ${guard.workspaceFrameId} AND "userId" = ${guard.userId}
			AND "organizationId" = ${guard.organizationId}
			AND "projectId" = ${guard.projectId}
			AND "updatedAt" = ${guard.frameUpdatedAt}
			AND metadata->>'surface' = 'workspace'
		FOR SHARE
	`;
	if (frames.length !== 1) {
		throw new WorkspaceWorkflowBindingConflictError();
	}
	const projects = await tx.$queryRaw<Array<{ id: string }>>`
		SELECT id FROM project
		WHERE id = ${guard.projectId}
			AND "organizationId" = ${guard.organizationId}
			AND "deletedAt" IS NULL
		FOR SHARE
	`;
	if (projects.length !== 1) {
		throw new WorkspaceWorkflowBindingConflictError();
	}
}
