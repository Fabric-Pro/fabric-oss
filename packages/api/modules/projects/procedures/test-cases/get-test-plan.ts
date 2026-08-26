import { ORPCError } from "@orpc/client";
import { getTestPlan } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertTestCasesFeatureEnabled } from "../../lib/test-cases-feature";

export const getTestPlanProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.TEST_CASE_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/test-plans/{planId}",
		tags: ["Projects", "Test Cases"],
		summary: "Get a test plan",
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
		// AUTHORIZATION: requireProjectPermission(TEST_CASE_READ) gates project
		// access; the plan is scoped to the project (cross-project ids resolve to
		// NOT_FOUND).
		const plan = await getTestPlan({
			id: input.planId,
			projectId: input.projectId,
		});
		if (!plan) {
			throw new ORPCError("NOT_FOUND", {
				message: "Test plan not found",
			});
		}

		return { plan };
	});
