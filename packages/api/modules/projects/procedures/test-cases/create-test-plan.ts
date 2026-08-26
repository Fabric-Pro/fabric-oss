import { createTestPlan } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertTestCasesFeatureEnabled } from "../../lib/test-cases-feature";

export const createTestPlanProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.TEST_CASE_CREATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/test-plans",
		tags: ["Projects", "Test Cases"],
		summary: "Create a test plan",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			name: z.string().min(1).max(255),
			description: z.string().nullable().optional(),
			state: z.enum(["ACTIVE", "INACTIVE"]).optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		assertTestCasesFeatureEnabled();
		// AUTHORIZATION: requireProjectPermission(TEST_CASE_CREATE) gates project
		// access — plan create reuses the test-case create right.
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const plan = await createTestPlan({
			projectId: input.projectId,
			createdById: user.id,
			name: input.name,
			description: input.description ?? null,
			state: input.state,
			userId: user.id,
			organizationId,
		});

		return { plan };
	});
