/**
 * Get Weave Plan Procedure
 */

import { ORPCError } from "@orpc/server";
import { db } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	protectedProcedure,
	requirePermission,
	resolveOrganizationId,
} from "../../../orpc/procedures";

const GetPlanInputSchema = z.object({
	planId: z.string(),
	organizationId: z.string().nullable().optional(),
});

export const getPlanProcedure = protectedProcedure
	.use(requirePermission(Permissions.AGENT_READ))
	.route({
		method: "GET",
		path: "/weave/plans/:planId",
		tags: ["Weave"],
		summary: "Get weave plan by ID",
	})
	.input(GetPlanInputSchema)
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

		return plan;
	});
