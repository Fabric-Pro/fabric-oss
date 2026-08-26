import { ORPCError } from "@orpc/client";
import { addCaseToPlan, db, Prisma } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertTestCasesFeatureEnabled } from "../../lib/test-cases-feature";

export const addCaseToPlanProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.TEST_CASE_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/test-plans/{planId}/cases",
		tags: ["Projects", "Test Cases"],
		summary: "Add a test case to a plan",
	})
	.input(
		z.object({
			projectId: z.string(),
			planId: z.string(),
			testCaseId: z.string(),
			organizationId: z.string().nullable().optional(),
			section: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input }) => {
		assertTestCasesFeatureEnabled();
		// AUTHORIZATION: requireProjectPermission(TEST_CASE_UPDATE) gates project
		// access. Both the plan and the case are re-verified in-project so a
		// foreign plan/case id can't be joined across tenants.
		const [plan, testCase] = await Promise.all([
			db.testPlan.findFirst({
				where: {
					id: input.planId,
					projectId: input.projectId,
					deletedAt: null,
				},
				select: { id: true },
			}),
			db.testCase.findFirst({
				where: {
					id: input.testCaseId,
					projectId: input.projectId,
					deletedAt: null,
				},
				select: { id: true },
			}),
		]);
		if (!plan) {
			throw new ORPCError("NOT_FOUND", {
				message: "Test plan not found",
			});
		}
		if (!testCase) {
			throw new ORPCError("NOT_FOUND", {
				message: "Test case not found",
			});
		}

		try {
			const link = await addCaseToPlan({
				planId: input.planId,
				testCaseId: input.testCaseId,
				section: input.section ?? null,
			});
			return { link };
		} catch (error) {
			// The (planId, testCaseId) unique key forbids duplicate membership —
			// map the Prisma violation to a clean CONFLICT.
			if (
				error instanceof Prisma.PrismaClientKnownRequestError &&
				error.code === "P2002"
			) {
				throw new ORPCError("CONFLICT", {
					message: "This test case is already in the plan",
				});
			}
			throw error;
		}
	});
