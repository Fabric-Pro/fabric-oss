import { ORPCError } from "@orpc/client";
import { db, removeCaseFromPlan } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertTestCasesFeatureEnabled } from "../../lib/test-cases-feature";

export const removeCaseFromPlanProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.TEST_CASE_UPDATE))
	.route({
		method: "DELETE",
		path: "/projects/{projectId}/test-plans/{planId}/cases/{testCaseId}",
		tags: ["Projects", "Test Cases"],
		summary: "Remove a test case from a plan",
	})
	.input(
		z.object({
			projectId: z.string(),
			planId: z.string(),
			testCaseId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input }) => {
		assertTestCasesFeatureEnabled();
		// AUTHORIZATION: requireProjectPermission(TEST_CASE_UPDATE) gates project
		// access; the plan is re-verified in-project so the removal can't target a
		// foreign plan by id.
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

		const { removed } = await removeCaseFromPlan({
			planId: input.planId,
			testCaseId: input.testCaseId,
		});

		return { success: true, removed };
	});
