import { ORPCError } from "@orpc/client";
import { db, reorderPlanCases } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertTestCasesFeatureEnabled } from "../../lib/test-cases-feature";

export const reorderPlanCasesProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.TEST_CASE_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/test-plans/{planId}/cases/reorder",
		tags: ["Projects", "Test Cases"],
		summary: "Reorder the cases in a test plan",
	})
	.input(
		z.object({
			projectId: z.string(),
			planId: z.string(),
			organizationId: z.string().nullable().optional(),
			orders: z
				.array(z.object({ id: z.string(), order: z.number() }))
				.max(2000),
		}),
	)
	.handler(async ({ input }) => {
		assertTestCasesFeatureEnabled();
		// AUTHORIZATION: requireProjectPermission(TEST_CASE_UPDATE) gates project
		// access; the plan is re-verified in-project before its memberships are
		// reordered (each write is additionally scoped to the plan by the query).
		const plan = await db.testPlan.findFirst({
			where: {
				id: input.planId,
				projectId: input.projectId,
				deletedAt: null,
			},
			select: { id: true },
		});
		if (!plan) {
			throw new ORPCError("NOT_FOUND", {
				message: "Test plan not found",
			});
		}

		await reorderPlanCases(input.planId, input.orders);

		return { success: true };
	});
