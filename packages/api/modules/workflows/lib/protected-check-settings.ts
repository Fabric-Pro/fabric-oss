import { db, type Prisma } from "@repo/database";
import {
	type WorkflowActor,
	WorkflowCommandError,
} from "./workflow-command-context";
import type { UpdateWorkflowInput } from "./workflow-commands";
export const WORKFLOW_RESULT_CHECKS_KEY = "fabricResultChecks";
/** General settings edits cannot forge or erase checks managed by the authorized check commands. */
export async function updateWorkflowWithProtectedChecks(
	actor: WorkflowActor,
	input: UpdateWorkflowInput & { settings: Prisma.InputJsonValue },
	options?: { expectedUpdatedAt: Date },
) {
	const { id, ...patch } = input;
	const settings: Record<
		string,
		Prisma.InputJsonValue | null | undefined
	> | null =
		input.settings &&
		typeof input.settings === "object" &&
		!Array.isArray(input.settings)
			? { ...(input.settings as Prisma.InputJsonObject) }
			: null;
	if (!settings)
		throw new WorkflowCommandError(
			"BAD_REQUEST",
			"Workflow settings must be a JSON object.",
		);
	if (Object.hasOwn(settings, WORKFLOW_RESULT_CHECKS_KEY)) {
		throw new WorkflowCommandError(
			"BAD_REQUEST",
			"Use result-check commands to manage saved checks. Workflow settings must be an object without the reserved check field.",
		);
	}
	return db.$transaction(async (tx) => {
		await tx.$queryRaw`SELECT id FROM workflow WHERE id=${id} AND "userId"=${actor.userId} AND "organizationId"=${actor.organizationId} FOR UPDATE`;
		const row = await tx.workflow.findFirst({
			where: {
				id,
				userId: actor.userId,
				organizationId: actor.organizationId,
			},
			select: { settings: true },
		});
		if (!row) {
			throw new WorkflowCommandError("NOT_FOUND", "Workflow not found");
		}
		if (
			row.settings &&
			typeof row.settings === "object" &&
			!Array.isArray(row.settings) &&
			Object.hasOwn(row.settings, WORKFLOW_RESULT_CHECKS_KEY)
		) {
			settings[WORKFLOW_RESULT_CHECKS_KEY] =
				row.settings[WORKFLOW_RESULT_CHECKS_KEY];
		}
		try {
			return await tx.workflow.update({
				where: {
					id,
					userId: actor.userId,
					organizationId: actor.organizationId,
					...(options
						? { updatedAt: options.expectedUpdatedAt }
						: {}),
				},
				data: { ...patch, settings },
			});
		} catch (error) {
			if (
				error &&
				typeof error === "object" &&
				"code" in error &&
				error.code === "P2025"
			) {
				throw new WorkflowCommandError(
					"CONFLICT",
					"The workflow changed. Refresh before saving settings again.",
				);
			}
			throw error;
		}
	});
}
