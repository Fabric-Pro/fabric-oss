import { ORPCError } from "@orpc/client";
import { clearPmSyncFailures, db } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";
import { assertTestCasesFeatureEnabled } from "../../../lib/test-cases-feature";

/**
 * Bulk-dismiss FAILED test-case PM syncs. Backs a bulk Dismiss action. One
 * atomic `updateMany` scoped to the project AND `lastPmSyncStatus = FAILED`, so
 * cross-tenant / non-failed / already-cleared ids are silently skipped. Mirrors
 * `retryTestCasePmSyncBatch`'s ownership model (project pre-check + project-
 * scoped write) without the Temporal fan-out, since a dismiss is a single write.
 */
export const dismissTestCasePmSyncFailureBatchProcedure =
	tenantProtectedProcedure
		.use(requireProjectPermission(Permissions.TEST_CASE_UPDATE))
		.route({
			method: "POST",
			path: "/projects/{projectId}/test-cases/dismiss-pm-sync-failure-batch",
			tags: ["Projects", "Test Cases", "Sync"],
			summary: "Dismiss a batch of failed test-case PM syncs",
			description:
				"Clears the FAILED PM-sync flag on the selected test cases so they leave the failures queue. Scoped to FAILED state and the project (idempotent, tenant-guarded).",
		})
		.input(
			z.object({
				projectId: z.string(),
				testCaseIds: z.array(z.string()).max(200),
				organizationId: z.string().nullable().optional(),
			}),
		)
		.output(
			z.object({
				dismissedCount: z.number(),
			}),
		)
		.handler(async ({ input }) => {
			assertTestCasesFeatureEnabled();
			// AUTHORIZATION: requireProjectPermission(TEST_CASE_UPDATE) gates
			// project access; the write is scoped to the project (tenant guard).
			if (input.testCaseIds.length === 0) {
				return { dismissedCount: 0 };
			}

			const project = await db.project.findUnique({
				where: { id: input.projectId },
				select: { id: true },
			});
			if (!project) {
				throw new ORPCError("NOT_FOUND", {
					message: "Project not found",
				});
			}

			const { cleared } = await clearPmSyncFailures({
				projectId: input.projectId,
				itemIds: input.testCaseIds,
				itemType: "testCase",
			});

			return { dismissedCount: cleared };
		});
