import { z } from "zod";
import type { Prisma, WorkflowBuilderStatus } from "../../client";

export const workspaceWorkflowBindingsSchema = z
	.object({
		version: z.literal(1),
		workflows: z
			.array(
				z
					.object({
						workflowId: z.string().min(1).max(128),
						authorizedWorkflowVersion: z.number().int().positive(),
						authorizedWorkflowUpdatedAt: z.string().datetime(),
					})
					.strict(),
			)
			.max(20),
	})
	.strict()
	.refine(
		(value) =>
			new Set(value.workflows.map((entry) => entry.workflowId)).size ===
			value.workflows.length,
	);

export const workspaceWorkflowRunProvenanceSchema = z
	.object({
		kind: z.literal("workspace-workflow"),
		version: z.literal(1),
		workflowId: z.string().min(1).max(128),
		workspaceFrameId: z.string().min(1).max(128),
		projectId: z.string().min(1).max(128),
		workflowVersion: z.number().int().positive(),
		workflowUpdatedAt: z.string().datetime(),
		frameUpdatedAt: z.string().datetime(),
		inputsFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
	})
	.strict();

interface WorkspaceWorkflowRows {
	workflowId: string;
	userId: string;
	organizationId: string;
	projectId: string;
	workspaceFrameId: string;
	workflowUpdatedAt: Date;
	frameUpdatedAt: Date;
	status: WorkflowBuilderStatus;
}

export type WorkspaceWorkflowRowGuard = WorkspaceWorkflowRows & {
	requirement: { kind: "row-only" };
};

export type WorkspaceWorkflowReadGuard = WorkspaceWorkflowRows & {
	requirement: { kind: "bound-read" };
};

export type WorkspaceWorkflowRunGuard = WorkspaceWorkflowRows & {
	requirement: { kind: "bound-run"; workflowVersion: number };
};

export type WorkspaceWorkflowBindingGuard =
	| WorkspaceWorkflowRowGuard
	| WorkspaceWorkflowReadGuard
	| WorkspaceWorkflowRunGuard;

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
	const workflows = await tx.$queryRaw<
		Array<{ id: string; version: number; publishedVersion: number | null }>
	>`
		SELECT id, version, "publishedVersion" FROM workflow
		WHERE id = ${guard.workflowId} AND "userId" = ${guard.userId}
			AND "organizationId" = ${guard.organizationId}
			AND "projectId" = ${guard.projectId}
			AND "updatedAt" = ${guard.workflowUpdatedAt}
			AND status = ${guard.status}::"WorkflowBuilderStatus"
		FOR SHARE
	`;
	const workflow = workflows[0];
	if (workflows.length !== 1 || !workflow) {
		throw new WorkspaceWorkflowBindingConflictError();
	}
	const frames = await tx.$queryRaw<
		Array<{ id: string; metadata: Prisma.JsonValue }>
	>`
		SELECT id, metadata FROM agent_workspace_file
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
	switch (guard.requirement.kind) {
		case "row-only":
			break;
		case "bound-read":
		case "bound-run": {
			const metadata = z
				.object({ workflowBindings: workspaceWorkflowBindingsSchema })
				.safeParse(frames[0]?.metadata);
			const grant = metadata.success
				? metadata.data.workflowBindings.workflows.find(
						(entry) => entry.workflowId === guard.workflowId,
					)
				: undefined;
			if (
				!grant ||
				(guard.requirement.kind === "bound-run" &&
					(workflow.version !== guard.requirement.workflowVersion ||
						workflow.publishedVersion !==
							guard.requirement.workflowVersion ||
						grant.authorizedWorkflowVersion !==
							guard.requirement.workflowVersion ||
						grant.authorizedWorkflowUpdatedAt !==
							guard.workflowUpdatedAt.toISOString()))
			) {
				throw new WorkspaceWorkflowBindingConflictError();
			}
			break;
		}
		default: {
			const exhaustive: never = guard.requirement;
			throw new Error(`Unsupported Workspace binding: ${exhaustive}`);
		}
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
	return workflow;
}
