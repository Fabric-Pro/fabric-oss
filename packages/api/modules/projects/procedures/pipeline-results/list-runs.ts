import {
	listProjectPipelineRuns,
	listStoryPipelineRuns,
	PIPELINE_RUN_OUTCOMES,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertPipelineResultsEnabled } from "../../lib/pipeline-results-feature";

/**
 * List recent ingested CI/pipeline runs for a project, newest first
 * — the QA tab's "recent runs" surface. Read-gated by TEST_CASE_READ and the
 * pipeline-results feature flag (which implies the base Test Cases flag). Scoped
 * by projectId: `requireProjectPermission` is the tenant boundary (a project
 * belongs to one tenant), so no caller-supplied org is trusted here.
 */
export const listPipelineRunsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.TEST_CASE_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/pipeline-results/runs",
		tags: ["Projects", "Test Cases"],
		summary: "List recent ingested CI/pipeline runs for a project",
	})
	.input(
		z.object({
			projectId: z.string(),
			limit: z.number().int().min(1).max(100).optional(),
			/**
			 * Narrow to the runs that actually touched ONE feature, which is what
			 * lets a result be read beside the work it proves. Omit for the
			 * project-wide list the QA tab shows.
			 */
			storyId: z.string().optional(),
			/**
			 * Filter by source and by outcome. Arrays rather than single values:
			 * "GitHub or GitLab" is a real question on a multi-repo project, and
			 * an omitted/empty array means unfiltered.
			 */
			providers: z.array(z.string()).optional(),
			statuses: z.array(z.enum(PIPELINE_RUN_OUTCOMES)).optional(),
		}),
	)
	.handler(async ({ input }) => {
		assertPipelineResultsEnabled();
		// A feature with no automated coverage returns an empty list rather than
		// falling back to the project's runs — a silent widening is how "nothing
		// tests this" gets mistaken for "everything is fine".
		return input.storyId
			? listStoryPipelineRuns({
					projectId: input.projectId,
					storyId: input.storyId,
					limit: input.limit,
					providers: input.providers,
					statuses: input.statuses,
				})
			: listProjectPipelineRuns({
					projectId: input.projectId,
					limit: input.limit,
					providers: input.providers,
					statuses: input.statuses,
				});
	});
