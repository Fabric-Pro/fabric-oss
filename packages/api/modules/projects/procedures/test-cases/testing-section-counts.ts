import { getTestingSectionCounts } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertTestCasesFeatureEnabled } from "../../lib/test-cases-feature";

/**
 * The badge numbers on the Testing tab's six sections.
 *
 * One procedure rather than one per panel: the tab renders all six labels at
 * once, so six queries would fan out on every visit — and each panel only knows
 * its own count once it has mounted, which is exactly when the badge is no
 * longer useful. Every figure is a `count` over an indexed `projectId`, so this
 * stays cheap enough to keep fresh.
 */
export const testingSectionCountsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.TEST_CASE_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/testing-section-counts",
		tags: ["Projects", "Test Cases"],
		summary: "Counts for each section of the Testing tab",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input }) => {
		assertTestCasesFeatureEnabled();
		// AUTHORIZATION: requireProjectPermission(TEST_CASE_READ) gates project
		// access; every count is scoped to the project by the query layer.
		return getTestingSectionCounts(input.projectId);
	});
