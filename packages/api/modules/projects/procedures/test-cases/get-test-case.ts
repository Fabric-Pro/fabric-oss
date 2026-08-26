import { ORPCError } from "@orpc/client";
import { getTestCase } from "@repo/database";
import { z } from "zod";
import { userHasProjectPermission } from "../../../../lib/project-permissions";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertTestCasesFeatureEnabled } from "../../lib/test-cases-feature";

export const getTestCaseProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.TEST_CASE_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/test-cases/{testCaseId}",
		tags: ["Projects", "Test Cases"],
		summary: "Get a test case",
	})
	.input(
		z.object({
			projectId: z.string(),
			testCaseId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		assertTestCasesFeatureEnabled();
		// AUTHORIZATION: requireProjectPermission(TEST_CASE_READ) gates project
		// access; the case is additionally scoped to the project (cross-project
		// ids resolve to NOT_FOUND).
		const testCase = await getTestCase({
			id: input.testCaseId,
			projectId: input.projectId,
		});
		if (!testCase) {
			throw new ORPCError("NOT_FOUND", {
				message: "Test case not found",
			});
		}

		// Surface whether the caller may edit so the UI hides write controls it
		// would reject (parity with get-story's canEdit).
		const canEdit = await userHasProjectPermission(
			input.projectId,
			context.user.id,
			Permissions.TEST_CASE_UPDATE,
		);

		return { testCase, canEdit };
	});
