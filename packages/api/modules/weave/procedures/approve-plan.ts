/**
 * Approve Weave Plan Procedure
 *
 * Approval marks the plan ready for execution. Users can then choose
 * whether implementation should be delegated to remote or local agents.
 */

import { ORPCError } from "@orpc/server";
import { db } from "@repo/database";
import { z } from "zod";
import {
	assertProjectPermission,
	Permissions,
	protectedProcedure,
	resolveOrganizationIdForCaller,
} from "../../../orpc/procedures";

const ApprovePlanInputSchema = z.object({
	planId: z.string(),
	organizationId: z.string().nullable().optional(),
	approved: z.boolean(),
	feedback: z.string().optional(),
});

export const approvePlanProcedure = protectedProcedure
	.route({
		method: "POST",
		path: "/weave/plans/:planId/approve",
		tags: ["Weave"],
		summary: "Approve or reject a weave plan",
		description:
			"Approves a plan so implementation can be delegated explicitly afterward",
	})
	.input(ApprovePlanInputSchema)
	.handler(async ({ input, context }) => {
		const userId = context.user.id;
		const organizationId = await resolveOrganizationIdForCaller(
			input.organizationId,
			context.session,
			userId,
		);

		// Find plan with proper tenant isolation
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

		// Object-level, and the same decision the middleware makes for a
		// procedure whose input names the project. This one names a plan, so
		// the project is only known here.
		await assertProjectPermission(
			plan.projectId,
			userId,
			Permissions.AGENT_UPDATE,
		);

		if (plan.status !== "PENDING_APPROVAL" && plan.status !== "DRAFT") {
			throw new ORPCError("BAD_REQUEST", {
				message: `Plan cannot be approved in status: ${plan.status}`,
			});
		}

		// Rejection flow
		if (!input.approved) {
			await db.weavePlan.update({
				where: { id: input.planId },
				data: { status: "CANCELLED" },
			});

			return {
				success: true,
				message: "Plan rejected",
				planId: input.planId,
			};
		}

		await db.weavePlan.update({
			where: { id: input.planId },
			data: { status: "APPROVED" },
		});

		return {
			success: true,
			message: "Plan approved and ready for delegation",
			planId: input.planId,
		};
	});
