/**
 * Delete Weave Plan Procedure
 *
 * Permanently removes a weave plan (and, via the schema's cascade, its
 * executions). Refuses to delete a plan that still has a live execution so
 * an in-flight workflow is never deleted out from under itself.
 */

import { ORPCError } from "@orpc/server";
import { db, hasProjectAccess } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	protectedProcedure,
	requirePermission,
	resolveOrganizationId,
} from "../../../orpc/procedures";

const DeletePlanInputSchema = z.object({
	planId: z.string(),
	organizationId: z.string().nullable().optional(),
});

const DeletePlanOutputSchema = z.object({
	success: z.boolean(),
	planId: z.string(),
});

/** Execution statuses that mean a workflow may still be running. */
const ACTIVE_EXECUTION_STATUSES = [
	"PENDING",
	"RUNNING",
	"PAUSED",
	"CHECKPOINT",
] as const;

export const deletePlanProcedure = protectedProcedure
	.use(requirePermission(Permissions.AGENT_DELETE))
	.route({
		method: "POST",
		path: "/weave/plans/:planId/delete",
		tags: ["Weave"],
		summary: "Delete a weave plan",
		description:
			"Permanently deletes a plan and its executions. Blocked while an execution is still active.",
	})
	.input(DeletePlanInputSchema)
	.output(DeletePlanOutputSchema)
	.handler(async ({ input, context }) => {
		const userId = context.user.id;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const plan = await db.weavePlan.findFirst({
			where: {
				id: input.planId,
				userId,
				...(organizationId
					? { organizationId }
					: { organizationId: null }),
			},
		});

		if (!plan) {
			throw new ORPCError("NOT_FOUND", {
				message: "Plan not found or access denied",
			});
		}

		const hasAccess = await hasProjectAccess(
			plan.projectId,
			userId,
			organizationId,
		);

		if (!hasAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		// Refuse to delete while a workflow may still be running — cancel the
		// execution first so the run is torn down cleanly.
		const activeExecution = await db.weaveExecution.findFirst({
			where: {
				planId: plan.id,
				status: {
					in: ACTIVE_EXECUTION_STATUSES as unknown as never[],
				},
			},
			select: { id: true },
		});

		if (activeExecution) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"This plan has a running execution. Cancel it before deleting the plan.",
			});
		}

		// Executions cascade-delete via the schema relation; checkboxes are
		// embedded JSON; the linked story/task use SetNull and are untouched.
		await db.weavePlan.delete({ where: { id: plan.id } });

		return { success: true, planId: plan.id };
	});
