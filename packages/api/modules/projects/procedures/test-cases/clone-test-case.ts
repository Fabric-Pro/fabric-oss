import { ORPCError } from "@orpc/client";
import { cloneTestCase } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertTestCasesFeatureEnabled } from "../../lib/test-cases-feature";
import { mirrorTestCaseToContext } from "./sync-context";

export const cloneTestCaseProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.TEST_CASE_CREATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/test-cases/{testCaseId}/clone",
		tags: ["Projects", "Test Cases"],
		summary: "Clone a test case",
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
		// AUTHORIZATION: requireProjectPermission(TEST_CASE_CREATE) gates project
		// access — cloning produces a new case, so create rights apply.
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const testCase = await cloneTestCase({
			id: input.testCaseId,
			projectId: input.projectId,
			actorUserId: user.id,
		});
		if (!testCase) {
			throw new ORPCError("NOT_FOUND", {
				message: "Test case not found",
			});
		}

		// Mirror the new DRAFT clone into its own ProjectContext (AC7).
		await mirrorTestCaseToContext(testCase, {
			userId: user.id,
			organizationId,
		});

		return { testCase };
	});
