import { db, type Prisma, recordAuditTx } from "@repo/database";
import { WorkflowCommandError } from "./workflow-command-context";
/** One database commit: either both the snapshot and publication pointer exist, or neither does. */
export async function commitWorkflowVersion(input: {
	operation: "publish" | "rollback";
	workflowId: string;
	userId: string;
	organizationId: string;
	expectedUpdatedAt: Date;
	content: {
		nodes: Prisma.InputJsonValue;
		edges: Prisma.InputJsonValue;
		variables?: Prisma.InputJsonValue;
		settings?: Prisma.InputJsonValue;
		triggerConfig?: Prisma.InputJsonValue;
	};
	patch: Prisma.WorkflowUpdateInput;
	changelog?: string;
	publishedAt: Date;
}) {
	try {
		return await db.$transaction(async (tx) => {
			const latest = await tx.workflowVersion.findFirst({
				where: {
					workflowId: input.workflowId,
					userId: input.userId,
					organizationId: input.organizationId,
				},
				orderBy: { version: "desc" },
				select: { version: true },
			});
			const version = (latest?.version ?? 0) + 1;
			await tx.workflow.update({
				where: {
					id: input.workflowId,
					userId: input.userId,
					organizationId: input.organizationId,
					updatedAt: input.expectedUpdatedAt,
				},
				data: {
					...input.patch,
					version,
					publishedVersion: version,
					publishedAt: input.publishedAt,
					publishedBy: input.userId,
				},
			});
			await tx.workflowVersion.create({
				data: {
					workflowId: input.workflowId,
					version,
					...input.content,
					changelog: input.changelog,
					isPublished: true,
					publishedAt: input.publishedAt,
					createdBy: input.userId,
					userId: input.userId,
					organizationId: input.organizationId,
				},
			});
			await recordAuditTx(tx, {
				action: "activity.workflows.lifecycle",
				actor: { type: "user", userId: input.userId },
				organizationId: input.organizationId,
				resource: { type: "workflow", id: input.workflowId },
				metadata: { operation: input.operation, version },
			});
			return version;
		});
	} catch (error) {
		if (
			error &&
			typeof error === "object" &&
			"code" in error &&
			(error.code === "P2025" || error.code === "P2002")
		) {
			throw new WorkflowCommandError(
				"CONFLICT",
				"The workflow changed while publishing. Refresh and review it before retrying.",
			);
		}
		throw error;
	}
}
