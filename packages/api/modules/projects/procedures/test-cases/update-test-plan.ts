import { ORPCError } from "@orpc/client";
import { updateTestPlan } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertTestCasesFeatureEnabled } from "../../lib/test-cases-feature";

export const updateTestPlanProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.TEST_CASE_UPDATE))
	.route({
		method: "PATCH",
		path: "/projects/{projectId}/test-plans/{planId}",
		tags: ["Projects", "Test Cases"],
		summary: "Update a test plan",
	})
	.input(
		z.object({
			projectId: z.string(),
			planId: z.string(),
			organizationId: z.string().nullable().optional(),
			name: z.string().min(1).max(255).optional(),
			description: z.string().nullable().optional(),
			state: z.enum(["ACTIVE", "INACTIVE"]).optional(),
		}),
	)
	.handler(async ({ input }) => {
		assertTestCasesFeatureEnabled();
		// AUTHORIZATION: requireProjectPermission(TEST_CASE_UPDATE) gates project
		// access.
		const plan = await updateTestPlan({
			id: input.planId,
			projectId: input.projectId,
			data: {
				name: input.name,
				description: input.description,
				state: input.state,
			},
		});
		if (!plan) {
			throw new ORPCError("NOT_FOUND", {
				message: "Test plan not found",
			});
		}

		return { plan };
	});
