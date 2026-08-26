import { ORPCError } from "@orpc/client";
import { db, linkTestCaseToWorkItem } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertTestCasesFeatureEnabled } from "../../lib/test-cases-feature";

export const linkWorkItemProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.TEST_CASE_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/test-cases/{testCaseId}/links",
		tags: ["Projects", "Test Cases"],
		summary: "Link a test case to a work item",
	})
	.input(
		z.object({
			projectId: z.string(),
			testCaseId: z.string(),
			organizationId: z.string().nullable().optional(),
			userStoryId: z.string(),
			// A list: a case routinely proves more than one criterion. Absent
			// and empty both mean it names none.
			acceptanceCriterionRefs: z.array(z.string()).optional(),
		}),
	)
	.handler(async ({ input }) => {
		assertTestCasesFeatureEnabled();
		// AUTHORIZATION: requireProjectPermission(TEST_CASE_UPDATE) gates project
		// access. Both endpoints of the link are re-verified to belong to this
		// project so a case can never be tied to a foreign-tenant work item.
		const [testCase, story] = await Promise.all([
			db.testCase.findFirst({
				where: {
					id: input.testCaseId,
					projectId: input.projectId,
					deletedAt: null,
				},
				select: { id: true },
			}),
			db.userStory.findFirst({
				where: { id: input.userStoryId, projectId: input.projectId },
				select: { id: true },
			}),
		]);
		if (!testCase) {
			throw new ORPCError("NOT_FOUND", {
				message: "Test case not found",
			});
		}
		if (!story) {
			throw new ORPCError("NOT_FOUND", {
				message: "Work item not found in this project",
			});
		}

		const link = await linkTestCaseToWorkItem({
			testCaseId: input.testCaseId,
			userStoryId: input.userStoryId,
			acceptanceCriterionRefs: input.acceptanceCriterionRefs ?? [],
		});

		return { link };
	});
