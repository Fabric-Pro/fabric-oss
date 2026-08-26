import { listUnmatchedAutomatedTests } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertPipelineResultsEnabled } from "../../lib/pipeline-results-feature";

/**
 * Automated tests CI is running that map to NO Fabric test case — the coverage
 * a project has but isn't tracking.
 *
 * Ingestion counts these today (`unmatchedCount`) and drops them; every test is
 * persisted per run, so they can be listed and turned into real cases. Same read
 * gate and tenant boundary as the other pipeline-results procedures.
 */
export const listUnmatchedAutomatedTestsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.TEST_CASE_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/pipeline-results/unmatched-tests",
		tags: ["Projects", "Test Cases"],
		summary: "List automated tests that match no Fabric test case",
	})
	.input(
		z.object({
			projectId: z.string(),
			runLimit: z.number().int().min(1).max(100).optional(),
			limit: z.number().int().min(1).max(500).optional(),
		}),
	)
	.handler(async ({ input }) => {
		assertPipelineResultsEnabled();
		return listUnmatchedAutomatedTests(input);
	});
