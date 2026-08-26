import { ORPCError } from "@orpc/client";
import { db, listTestCaseResultHistory } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertTestCasesFeatureEnabled } from "../../lib/test-cases-feature";

export const getResultHistoryProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.TEST_CASE_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/test-cases/{testCaseId}/results",
		tags: ["Projects", "Test Cases"],
		summary: "Get a test case's run result history",
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
		// access; the case is re-verified in-project so history for a foreign
		// case id can't be enumerated (the history query is scoped by testCaseId
		// only).
		const testCase = await db.testCase.findFirst({
			where: {
				id: input.testCaseId,
				projectId: input.projectId,
				deletedAt: null,
			},
			select: { id: true },
		});
		if (!testCase) {
			throw new ORPCError("NOT_FOUND", {
				message: "Test case not found",
			});
		}

		return listTestCaseResultHistory({
			testCaseId: input.testCaseId,
			limit: input.limit,
			offset: input.offset,
		});
	});
