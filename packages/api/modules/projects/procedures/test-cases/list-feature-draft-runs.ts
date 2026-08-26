import { listTestCaseDraftJobsForStory } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertTestCasesFeatureEnabled } from "../../lib/test-cases-feature";

/**
 * The QA tab's per-feature drafting-run history: every
 * "Draft test cases with AI" run that covered this feature, newest first —
 * project-wide across all requesters, not just the caller's own in-flight runs
 * (that is `draftJobs.list`).
 *
 * Read-only, gated by TEST_CASE_READ; the query is scoped by project + storyId,
 * so a cross-project story id resolves to an empty history.
 */
export const listFeatureDraftRunsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.TEST_CASE_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/stories/{storyId}/test-case-draft-runs",
		tags: ["Projects", "Test Cases"],
		summary: "List the AI drafting runs that covered one feature",
	})
	.input(
		z.object({
			projectId: z.string(),
			storyId: z.string(),
			organizationId: z.string().nullable().optional(),
			limit: z.number().int().min(1).max(50).optional(),
			offset: z.number().int().min(0).optional(),
		}),
	)
	.output(
		z.object({
			total: z.number(),
			runs: z.array(
				z.object({
					id: z.string(),
					status: z.enum([
						"PENDING",
						"RUNNING",
						"SUCCEEDED",
						"FAILED",
						"CANCELLED",
					]),
					totalFeatures: z.number(),
					processedFeatures: z.number(),
					createdCount: z.number(),
					error: z.string().nullable(),
					requestedByName: z.string().nullable(),
					createdAt: z.string(),
					startedAt: z.string().nullable(),
					completedAt: z.string().nullable(),
				}),
			),
		}),
	)
	.handler(async ({ input }) => {
		assertTestCasesFeatureEnabled();
		// AUTHORIZATION: requireProjectPermission(TEST_CASE_READ) gates project
		// access; the query is project + story scoped.
		const { runs, total } = await listTestCaseDraftJobsForStory({
			projectId: input.projectId,
			storyId: input.storyId,
			limit: input.limit,
			offset: input.offset,
		});
		return { runs, total };
	});
