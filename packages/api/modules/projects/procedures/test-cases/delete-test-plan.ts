import { ORPCError } from "@orpc/client";
import { softDeleteTestPlan } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertTestCasesFeatureEnabled } from "../../lib/test-cases-feature";

export const deleteTestPlanProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.TEST_CASE_DELETE))
	.route({
		method: "DELETE",
		path: "/projects/{projectId}/test-plans/{planId}",
		tags: ["Projects", "Test Cases"],
		summary: "Delete a test plan",
	})
	.input(
		z.object({
			projectId: z.string(),
			planId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input }) => {
		assertTestCasesFeatureEnabled();
		// AUTHORIZATION: requireProjectPermission(TEST_CASE_DELETE) gates project
		// access — plan delete reuses the test-case delete right.
		const removed = await softDeleteTestPlan({
			id: input.planId,
			projectId: input.projectId,
		});
		if (!removed) {
			throw new ORPCError("NOT_FOUND", {
				message: "Test plan not found",
			});
		}

		return { success: true };
	});
