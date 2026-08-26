import { ORPCError } from "@orpc/client";
import { getProjectPipelineRunDetail } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertPipelineResultsEnabled } from "../../lib/pipeline-results-feature";

/**
 * One CI/pipeline run with its full per-test breakdown — the in-portal
 * run-detail sheet. Each test carries its mapped result, failure, duration, and
 * the Fabric case it matched (when the linkage cascade resolved one). Read-gated
 * by TEST_CASE_READ + the pipeline-results flag; `requireProjectPermission` is
 * the tenant boundary and the query re-scopes by projectId.
 */
export const pipelineRunDetailProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.TEST_CASE_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/pipeline-results/runs/{runId}",
		tags: ["Projects", "Test Cases"],
		summary: "Get one CI/pipeline run with its per-test breakdown",
	})
	.input(
		z.object({
			projectId: z.string(),
			runId: z.string(),
		}),
	)
	.handler(async ({ input }) => {
		assertPipelineResultsEnabled();
		const detail = await getProjectPipelineRunDetail({
			projectId: input.projectId,
			runId: input.runId,
		});
		if (!detail) {
			throw new ORPCError("NOT_FOUND", {
				message: "Pipeline run not found",
			});
		}
		return detail;
	});
