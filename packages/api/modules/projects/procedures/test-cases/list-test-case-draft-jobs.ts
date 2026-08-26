import { listTestCaseDraftJobs, parseFeatureOutcomes } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertTestCasesFeatureEnabled } from "../../lib/test-cases-feature";

/**
 * The rediscovery read: this caller's recent drafting runs for the project.
 *
 * This is what makes the background run survivable. The client holds no state
 * across a reload, so on mount it asks the server "do I have a run in flight
 * here?" and re-attaches its progress indicator to whatever comes back. Nothing
 * depends on the browser having remembered a workflow id.
 *
 * Scoped to the CALLER's own runs (`requestedById`): the progress indicator and
 * completion toast belong to the person who clicked Generate, not to everyone
 * looking at the project. The cases themselves are project-wide, as always.
 */
export const listTestCaseDraftJobsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.TEST_CASE_CREATE))
	.route({
		method: "GET",
		path: "/projects/{projectId}/test-cases/draft-jobs",
		tags: ["Projects", "Test Cases"],
		summary: "List the caller's recent AI test-case drafting runs",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			status: z
				.array(
					z.enum([
						"PENDING",
						"RUNNING",
						"SUCCEEDED",
						"FAILED",
						"CANCELLED",
					]),
				)
				.optional(),
			limit: z.number().int().min(1).max(25).optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		assertTestCasesFeatureEnabled();
		// AUTHORIZATION: requireProjectPermission(TEST_CASE_CREATE) gates project
		// access; the query additionally scopes to the caller's own runs.
		const jobs = await listTestCaseDraftJobs({
			projectId: input.projectId,
			requestedById: context.user.id,
			statuses: input.status,
			limit: input.limit,
		});

		return {
			jobs: jobs.map((job) => ({
				id: job.id,
				status: job.status,
				totalFeatures: job.totalFeatures,
				processedFeatures: job.processedFeatures,
				createdCount: job.createdCaseIds.length,
				error: job.error,
				startedAt: job.startedAt,
				completedAt: job.completedAt,
				outcomes: parseFeatureOutcomes(job.featureOutcomes),
			})),
		};
	});
