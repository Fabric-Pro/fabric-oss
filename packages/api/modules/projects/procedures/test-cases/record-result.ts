import { ORPCError } from "@orpc/client";
import { db, recordTestCaseResult } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertTestCasesFeatureEnabled } from "../../lib/test-cases-feature";

export const recordResultProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.TEST_CASE_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/test-cases/{testCaseId}/results",
		tags: ["Projects", "Test Cases"],
		summary: "Record a test case run result",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			testCaseId: z.string(),
			/**
			 * Deliberately excludes SKIPPED. This is a result a PERSON records
			 * after working through a case; SKIPPED describes what an automated
			 * suite did with one. A human who chose not to run a case records
			 * BLOCKED or leaves it NOT_RUN. Mirrors `MARKABLE_RESULTS` on the
			 * client, which omits it from the mark menu for the same reason.
			 */
			result: z.enum(["NOT_RUN", "PASSED", "FAILED", "BLOCKED"]),
			testPlanId: z.string().nullable().optional(),
			note: z.string().max(2000).nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		assertTestCasesFeatureEnabled();
		// AUTHORIZATION: requireProjectPermission(TEST_CASE_UPDATE) gates project
		// access. The case (and optional plan) are re-verified in-project so a
		// foreign id can't attach a result across tenants. This route is the
		// user-driven MANUAL mark path only; PM_SYNC events are written solely by
		// the ingestion query layer with real provenance (actorLabel +
		// externalRunRef), never forgeable through here.
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

		if (input.testPlanId) {
			const plan = await db.testPlan.findFirst({
				where: {
					id: input.testPlanId,
					projectId: input.projectId,
					deletedAt: null,
				},
				select: { id: true },
			});
			if (!plan) {
				throw new ORPCError("NOT_FOUND", {
					message: "Test plan not found",
				});
			}
		}

		const recorded = await recordTestCaseResult({
			testCaseId: input.testCaseId,
			result: input.result,
			source: "MANUAL",
			// Manual marks are always attributed to the acting user.
			changedByUserId: context.user.id,
			testPlanId: input.testPlanId ?? null,
			note: input.note ?? null,
		});
		if (!recorded) {
			// Lost a race with a concurrent soft-delete between the check + write.
			throw new ORPCError("NOT_FOUND", {
				message: "Test case not found",
			});
		}

		return { testCase: recorded };
	});
