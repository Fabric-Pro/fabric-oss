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
} from "../../../orpc/procedures";
import { assertRowInAuthorizedOrganization } from "../lib/plan-organization";

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
		const plan = await db.weavePlan.findFirst({
			where: {
				id: input.planId,
				userId,
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
		const authorized = await assertProjectPermission(
			plan.projectId,
			userId,
			Permissions.AGENT_READ,
		);
		// The row's stored organization must be its project's — see
		// `lib/plan-organization.ts`.
		assertRowInAuthorizedOrganization(
			input.organizationId,
			plan,
			authorized,
		);

		return plan;
	});
