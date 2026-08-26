import { listPipelineRunsPage, PIPELINE_RUN_OUTCOMES } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertPipelineResultsEnabled } from "../../lib/pipeline-results-feature";

/**
 * One page of CI/pipeline run history (newest first) — the "View all runs"
 * surface, paired with `total` for a "showing N of M" affordance. Offset-paged
 * to mirror the per-case history dialog. Same read gate + tenant boundary as
 * {@link listPipelineRunsProcedure}.
 */
export const listPipelineRunsPageProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.TEST_CASE_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/pipeline-results/runs-page",
		tags: ["Projects", "Test Cases"],
		summary: "List a page of a project's full CI/pipeline run history",
	})
	.input(
		z.object({
			projectId: z.string(),
			limit: z.number().int().min(1).max(100).optional(),
			offset: z.number().int().min(0).optional(),
			/**
			 * Narrow to the runs that touched ONE feature, which is what makes a
			 * result readable beside the work it proves. Must
			 * mirror whatever {@link listPipelineRunsProcedure} was given for the
			 * same surface — a scoped preview above an unscoped "view all" is a
			 * dialog that contradicts the list that opened it.
			 */
			storyId: z.string().optional(),
			providers: z.array(z.string()).optional(),
			statuses: z.array(z.enum(PIPELINE_RUN_OUTCOMES)).optional(),
		}),
	)
	.handler(async ({ input }) => {
		assertPipelineResultsEnabled();
		const limit = input.limit ?? 20;
		const offset = input.offset ?? 0;
		const { runs, total } = await listPipelineRunsPage({
			projectId: input.projectId,
			storyId: input.storyId,
			providers: input.providers,
			statuses: input.statuses,
			limit,
			offset,
		});
		return { runs, total, limit, offset };
	});
