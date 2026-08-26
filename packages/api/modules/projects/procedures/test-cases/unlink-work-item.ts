import { ORPCError } from "@orpc/client";
import { db, unlinkTestCaseFromWorkItem } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertTestCasesFeatureEnabled } from "../../lib/test-cases-feature";

export const unlinkWorkItemProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.TEST_CASE_UPDATE))
	.route({
		method: "DELETE",
		path: "/projects/{projectId}/test-cases/{testCaseId}/links/{userStoryId}",
		tags: ["Projects", "Test Cases"],
		summary: "Unlink a test case from a work item",
	})
	.input(
		z.object({
			projectId: z.string(),
			testCaseId: z.string(),
			userStoryId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input }) => {
		assertTestCasesFeatureEnabled();
		// AUTHORIZATION: requireProjectPermission(TEST_CASE_UPDATE) gates project
		// access; the case is re-verified in-project so the unlink can't target a
		// foreign case by id.
		const testCase = await db.testCase.findFirst({
			where: {
				id: input.testCaseId,
				projectId: input.projectId,
				deletedAt: null,
			},
			select: { id: true },
		});
		if (!testCase) {
			throw new ORPCError("NOT_FOUND", {
				message: "Test case not found",
			});
		}

		const { removed } = await unlinkTestCaseFromWorkItem({
			testCaseId: input.testCaseId,
			userStoryId: input.userStoryId,
		});

		return { success: true, removed };
	});
