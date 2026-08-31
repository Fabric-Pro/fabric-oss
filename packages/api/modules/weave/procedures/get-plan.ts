/**
 * Get Weave Plan Procedure
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

const GetPlanInputSchema = z.object({
	planId: z.string(),
	organizationId: z.string().nullable().optional(),
});

export const getPlanProcedure = protectedProcedure
	.route({
		method: "GET",
		path: "/weave/plans/:planId",
		tags: ["Weave"],
		summary: "Get weave plan by ID",
	})
	.input(GetPlanInputSchema)
	.handler(async ({ input, context }) => {
		const userId = context.user.id;
		const organizationId = await resolveOrganizationIdForCaller(
			input.organizationId,
			context.session,
			userId,
		);

		const plan = await db.weavePlan.findFirst({
			where: {
				id: input.planId,
				userId,
				...(organizationId
					? { organizationId }
					: { organizationId: null }),
			},
			include: {
				executions: {
					orderBy: { createdAt: "desc" },
					take: 5,
				},
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
			Permissions.AGENT_READ,
		);

		return plan;
	});
