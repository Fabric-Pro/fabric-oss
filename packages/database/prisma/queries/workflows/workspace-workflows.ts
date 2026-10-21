import { z } from "zod";
import { db, type WorkflowExecution } from "../../client";
import { recordAuditTx } from "../audit-log";
import {
	assertWorkspaceWorkflowBindingWithin,
	WorkspaceWorkflowBindingConflictError,
	workspaceWorkflowBindingsSchema,
	type WorkspaceWorkflowBindingGuard,
	type WorkspaceWorkflowReadGuard,
	type WorkspaceWorkflowRowGuard,
	type WorkspaceWorkflowRunGuard,
} from "./workspace-workflow-binding";

const metadataSchema = z
	.object({ workflowBindings: workspaceWorkflowBindingsSchema.optional() })
	.passthrough();

/** Only row metadata grants authority. Document content and page records are never consulted. */
export async function getWorkspaceWorkflowGrant(input: {
	frameId: string;
	workflowId: string;
	userId: string;
	organizationId: string;
}) {
	const frame = await db.agentWorkspaceFile.findFirst({
		where: {
			id: input.frameId,
			userId: input.userId,
			organizationId: input.organizationId,
			fileType: { in: ["FRAME", "SLIDESHOW"] },
		},
		select: {
			id: true,
			userId: true,
			organizationId: true,
			projectId: true,
			updatedAt: true,
			metadata: true,
		},
	});
	if (!frame || !frame.projectId) {
		return null;
	}
	const metadata = metadataSchema.safeParse(frame.metadata);
	const surface = z
		.object({ surface: z.literal("workspace") })
		.safeParse(frame.metadata);
	const grant = metadata.success
		? metadata.data.workflowBindings?.workflows.find(
				(entry) => entry.workflowId === input.workflowId,
			)
		: undefined;
	return surface.success && grant ? { frame, grant } : null;
}

export async function mutateWorkspaceWorkflowBinding(
	input: {
		binding: WorkspaceWorkflowRowGuard;
		auditActor: {
			userId: string;
			emailSnapshot?: string;
			nameSnapshot?: string;
		};
	} & ({ action: "bind"; workflowVersion: number } | { action: "unbind" }),
) {
	const { binding } = input;
	return db.$transaction(
		async (tx) => {
			// Consistent lock order with execution reservation: workflow, frame, project.
			const workflows = await tx.$queryRaw<
				Array<{ version: number; publishedVersion: number | null }>
			>`SELECT version, "publishedVersion" FROM workflow
			WHERE id = ${binding.workflowId} AND "userId" = ${binding.userId}
				AND "organizationId" = ${binding.organizationId} AND "projectId" = ${binding.projectId}
				AND "updatedAt" = ${binding.workflowUpdatedAt} FOR SHARE`;
			await tx.$queryRaw`SELECT id FROM agent_workspace_file
			WHERE id = ${binding.workspaceFrameId} AND "userId" = ${binding.userId}
				AND "organizationId" = ${binding.organizationId} AND "projectId" = ${binding.projectId}
				AND "updatedAt" = ${binding.frameUpdatedAt} FOR UPDATE`;
			await assertWorkspaceWorkflowBindingWithin(tx, binding);
			if (
				input.action === "bind" &&
				((binding.status !== "PUBLISHED" &&
					binding.status !== "ACTIVE") ||
					workflows[0]?.version !== input.workflowVersion ||
					workflows[0]?.publishedVersion !== input.workflowVersion)
			) {
				throw new WorkspaceWorkflowBindingConflictError();
			}
			const frame = await tx.agentWorkspaceFile.findFirst({
				where: {
					id: binding.workspaceFrameId,
					userId: binding.userId,
					organizationId: binding.organizationId,
					updatedAt: binding.frameUpdatedAt,
				},
				select: { metadata: true },
			});
			const parsed = metadataSchema.safeParse(frame?.metadata);
			const metadata = frame?.metadata;
			if (
				!parsed.success ||
				!metadata ||
				typeof metadata !== "object" ||
				Array.isArray(metadata) ||
				input.auditActor.userId !== binding.userId
			) {
				throw new WorkspaceWorkflowBindingConflictError();
			}
			const remaining = (
				parsed.data.workflowBindings?.workflows ?? []
			).filter((entry) => entry.workflowId !== binding.workflowId);
			if (input.action === "bind") {
				remaining.push({
					workflowId: binding.workflowId,
					authorizedWorkflowVersion: input.workflowVersion,
					authorizedWorkflowUpdatedAt:
						binding.workflowUpdatedAt.toISOString(),
				});
			}
			const workflowBindings = workspaceWorkflowBindingsSchema.parse({
				version: 1,
				workflows: remaining,
			});
			const updated = await tx.agentWorkspaceFile.update({
				where: {
					id: binding.workspaceFrameId,
					updatedAt: binding.frameUpdatedAt,
				},
				data: { metadata: { ...metadata, workflowBindings } },
				select: { id: true, updatedAt: true },
			});
			await recordAuditTx(tx, {
				action: "activity.mcp.fabric_bind_workspace_workflow",
				actor: { type: "user", ...input.auditActor },
				organizationId: binding.organizationId,
				projectId: binding.projectId,
				resource: {
					type: "agent_workspace_file",
					id: binding.workspaceFrameId,
				},
				metadata: {
					workflowId: binding.workflowId,
					operation: input.action,
					workflowVersion: workflows[0]?.version,
					workflowUpdatedAt: binding.workflowUpdatedAt.toISOString(),
				},
			});
			return {
				frameId: updated.id,
				frameUpdatedAt: updated.updatedAt.toISOString(),
				workflowId: binding.workflowId,
				action: input.action,
			};
		},
		{ maxWait: 5_000, timeout: 10_000 },
	);
}

export async function getWorkspacePublishedWorkflowGraph(
	binding: WorkspaceWorkflowBindingGuard,
) {
	return db.$transaction(async (tx) => {
		const workflow = await assertWorkspaceWorkflowBindingWithin(
			tx,
			binding,
		);
		return tx.workflowVersion.findFirst({
			where: {
				workflowId: binding.workflowId,
				version: workflow.publishedVersion ?? -1,
				isPublished: true,
				userId: binding.userId,
				organizationId: binding.organizationId,
			},
			select: { nodes: true, edges: true, variables: true },
		});
	});
}

type HistoryRow = Pick<
	WorkflowExecution,
	"id" | "status" | "triggerType" | "startedAt" | "completedAt" | "duration"
> & { hasError: boolean; frameId: string | null };

/** Bounded metadata only: never materialize execution output or provider errors. */
export async function listWorkspaceWorkflowHistory(input: {
	binding: WorkspaceWorkflowReadGuard | WorkspaceWorkflowRunGuard;
	limit: number;
	offset: number;
}) {
	const { binding, limit, offset } = input;
	if (
		!Number.isInteger(limit) ||
		limit < 1 ||
		limit > 20 ||
		!Number.isInteger(offset) ||
		offset < 0 ||
		offset > 1000
	) {
		throw new RangeError("Workflow history pagination is out of bounds.");
	}
	return db.$transaction(
		async (tx) => {
			await assertWorkspaceWorkflowBindingWithin(tx, binding);
			const rows = await tx.$queryRaw<HistoryRow[]>`
			SELECT e.id, e.status, e."triggerType", e."startedAt", e."completedAt", e.duration,
				e.error IS NOT NULL AS "hasError",
				(SELECT f.id
				 FROM jsonb_each(CASE WHEN jsonb_typeof(e.output) = 'object' THEN e.output ELSE '{}'::jsonb END) node
				 JOIN agent_workspace_file f ON f.id = node.value->>'frameId'
				 WHERE jsonb_typeof(node.value->'frameId') = 'string'
					AND length(node.value->>'frameId') BETWEEN 1 AND 128
					AND f."sourceRunType" = 'workflow' AND f.metadata->>'sourceNodeId' = node.key
					AND f."userId" = ${binding.userId} AND f."organizationId" = ${binding.organizationId}
					AND f."projectId" = ${binding.projectId} AND f.metadata->>'surface' = 'artifact'
				 ORDER BY f."createdAt", f.id LIMIT 1) AS "frameId"
			FROM workflow_execution e
			WHERE e."workflowId" = ${binding.workflowId} AND e."userId" = ${binding.userId}
				AND e."organizationId" = ${binding.organizationId}
			ORDER BY e."startedAt" DESC, e.id DESC LIMIT ${limit + 1} OFFSET ${offset}
		`;
			const hasMore = rows.length > limit && offset + limit <= 1000;
			return {
				runs: rows.slice(0, limit),
				hasMore,
				nextOffset: hasMore ? offset + limit : null,
			};
		},
		{ maxWait: 5_000, timeout: 10_000 },
	);
}
