import { listTestCaseActivity } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertTestCasesFeatureEnabled } from "../../lib/test-cases-feature";

/**
 * A test case's edit history — creation provenance plus
 * every state / priority / title / steps / automation change, newest first. The
 * client merges this with the run-result history (`resultHistory`) into one
 * per-case Activity timeline.
 *
 * Read-only, gated by TEST_CASE_READ. The query re-verifies the case lives in
 * the project (scoped by testCaseId alone otherwise), so history for a foreign
 * case id resolves to an empty list rather than leaking another project's edits.
 */
export const getActivityHistoryProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.TEST_CASE_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/test-cases/{testCaseId}/activity",
		tags: ["Projects", "Test Cases"],
		summary: "Get a test case's edit activity history",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			testCaseId: z.string(),
			limit: z.number().int().min(1).max(100).optional(),
			offset: z.number().int().min(0).optional(),
		}),
	)
	.handler(async ({ input }) => {
		assertTestCasesFeatureEnabled();
		// AUTHORIZATION: requireProjectPermission(TEST_CASE_READ) gates project
		// access; listTestCaseActivity re-checks the case is in this project, so
		// a foreign case id returns nothing.
		const { items, total } = await listTestCaseActivity({
			projectId: input.projectId,
			testCaseId: input.testCaseId,
			limit: input.limit,
			offset: input.offset,
		});
		// `total` lets the panel show the newest few and still say how many
		// exist, instead of silently truncating.
		return { items, total };
	});
