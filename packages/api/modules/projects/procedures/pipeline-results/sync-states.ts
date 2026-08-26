import { listPipelineSyncStates } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertPipelineResultsEnabled } from "../../lib/pipeline-results-feature";

/**
 * The per-source pipeline sync state for a project — powers the QA
 * tab's "stale data" badge. Each row carries the last SUCCESSFUL fetch time and,
 * on failure, the last error (so a source that can't be reached is surfaced
 * rather than silently showing nothing). Scoped by projectId; project access is
 * the tenant boundary (no caller-supplied org trusted).
 */
export const listPipelineSyncStatesProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.TEST_CASE_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/pipeline-results/sync-states",
		tags: ["Projects", "Test Cases"],
		summary: "Get per-source pipeline fetch state for a project",
	})
	.input(
		z.object({
			projectId: z.string(),
		}),
	)
	.handler(async ({ input }) => {
		assertPipelineResultsEnabled();
		return listPipelineSyncStates({
			projectId: input.projectId,
		});
	});
