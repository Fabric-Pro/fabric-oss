import { reorderTestCases } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertTestCasesFeatureEnabled } from "../../lib/test-cases-feature";

export const reorderTestCasesProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.TEST_CASE_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/test-cases/reorder",
		tags: ["Projects", "Test Cases"],
		summary: "Reorder test cases",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			orders: z
				.array(z.object({ id: z.string(), order: z.number() }))
				.max(2000),
		}),
	)
	.handler(async ({ input }) => {
		assertTestCasesFeatureEnabled();
		// AUTHORIZATION: requireProjectPermission(TEST_CASE_UPDATE) gates project
		// access; each write is scoped to the project + live rows by the query.
		await reorderTestCases(input.projectId, input.orders);
		return { success: true };
	});
