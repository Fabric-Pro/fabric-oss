import { countTestCasesForStory } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertTestCasesFeatureEnabled } from "../../lib/test-cases-feature";

export const coverageForStoryProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.TEST_CASE_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/stories/{storyId}/test-coverage",
		tags: ["Projects", "Test Cases"],
		summary: "Count test cases linked to a work item",
	})
	.input(
		z.object({
			projectId: z.string(),
			storyId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input }) => {
		assertTestCasesFeatureEnabled();
		// AUTHORIZATION: requireProjectPermission(TEST_CASE_READ) gates project
		// access; the rollup counts only live cases in this project linked to the
		// story.
		const count = await countTestCasesForStory({
			storyId: input.storyId,
			projectId: input.projectId,
		});

		return { count };
	});
