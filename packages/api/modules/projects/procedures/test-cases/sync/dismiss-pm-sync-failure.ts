import { ORPCError } from "@orpc/client";
import { clearPmSyncFailure, db } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";
import { assertTestCasesFeatureEnabled } from "../../../lib/test-cases-feature";

/**
 * Dismiss a single FAILED test-case PM sync. Clears the case's
 * `lastPmSyncStatus` / `lastPmSyncError` so it leaves the failures queue. Backs
 * the per-row Dismiss action — the terminal state for a stuck failure that Retry
 * cannot resolve. Idempotent and FAILED-scoped (a no-op returning
 * `dismissed: false` when the case isn't actually FAILED); does not touch the PM
 * tool or the case's external link.
 */
export const dismissTestCasePmSyncFailureProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.TEST_CASE_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/test-cases/{testCaseId}/dismiss-pm-sync-failure",
		tags: ["Projects", "Test Cases", "Sync"],
		summary: "Dismiss a failed test-case PM sync",
		description:
			"Clears a test case's FAILED PM-sync flag so it leaves the failures queue. Scoped to FAILED state (idempotent); does not touch the PM tool or the external link.",
	})
	.input(
		z.object({
			projectId: z.string(),
			testCaseId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.output(
		z.object({
			dismissed: z.boolean(),
		}),
	)
	.handler(async ({ input }) => {
		assertTestCasesFeatureEnabled();
		// AUTHORIZATION: requireProjectPermission(TEST_CASE_UPDATE) gates project
		// access; the existence check scopes the case to the project (tenant
		// guard) so a cross-project id returns NOT_FOUND.
		const item = await db.testCase.findFirst({
			where: { id: input.testCaseId, projectId: input.projectId },
			select: { id: true },
		});
		if (!item) {
			throw new ORPCError("NOT_FOUND", {
				message: "Test case not found",
			});
		}

		const { cleared } = await clearPmSyncFailure({
			itemType: "testCase",
			itemId: input.testCaseId,
			projectId: input.projectId,
		});

		return { dismissed: cleared > 0 };
	});
