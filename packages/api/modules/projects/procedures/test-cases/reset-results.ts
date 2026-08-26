import { resetProjectTestResults } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertTestCasesFeatureEnabled } from "../../lib/test-cases-feature";

export const resetResultsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.TEST_CASE_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/test-cases/reset-results",
		tags: ["Projects", "Test Cases"],
		summary: "Reset all test case results to Not run",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		assertTestCasesFeatureEnabled();
		// AUTHORIZATION: requireProjectPermission(TEST_CASE_UPDATE) gates project
		// access; the reset is scoped to the project + tenant by the query layer.
		// History is preserved — every reset case gets a MANUAL NOT_RUN event
		// attributed to the acting user.
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const { reset } = await resetProjectTestResults({
			projectId: input.projectId,
			organizationId: organizationId ?? null,
			changedByUserId: context.user.id,
		});

		return { reset };
	});
