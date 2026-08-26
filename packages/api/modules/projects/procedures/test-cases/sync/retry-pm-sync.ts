import { ORPCError } from "@orpc/client";
import { db } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";
import { assertTestCaseSyncSupported } from "../../../lib/pm-test-case-sync-capability";
import { resolvePmTarget } from "../../../lib/resolve-pm-target";
import { retryPmSyncItem } from "../../../lib/retry-pm-sync-item";
import { assertTestCasesFeatureEnabled } from "../../../lib/test-cases-feature";

/**
 * Retry PM sync for a single test case. Backs the Retry button on a case whose
 * `lastPmSyncStatus` is FAILED or CONFLICT. Reuses the shared `retryPmSyncItem`
 * lib with `itemType: "testCase"`, which starts `testCaseSyncWorkflow` for just
 * this id.
 */
export const retryTestCasePmSyncProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.TEST_CASE_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/test-cases/{testCaseId}/retry-pm-sync",
		tags: ["Projects", "Test Cases", "Sync"],
		summary: "Retry PM sync for a single test case",
		description:
			"Re-enqueues `testCaseSyncWorkflow` for a single test case. Backs the Retry button on a FAILED/CONFLICT case.",
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
			enqueued: z.boolean(),
			workflowId: z.string().optional(),
			reason: z.string().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		assertTestCasesFeatureEnabled();
		// AUTHORIZATION: requireProjectPermission(TEST_CASE_UPDATE) gates project
		// access; the lookup additionally scopes the case to the project so a
		// cross-project id returns NOT_FOUND.
		const item = await db.testCase.findFirst({
			where: { id: input.testCaseId, projectId: input.projectId },
			select: {
				id: true,
				externalId: true,
				externalMcpServerId: true,
				project: {
					select: {
						projectManagementMcpServerId: true,
						projectManagementMcpConfigId: true,
						organizationId: true,
					},
				},
			},
		});
		if (!item) {
			throw new ORPCError("NOT_FOUND", {
				message: "Test case not found",
			});
		}

		// Capability gate (LIVE): a retry re-drives the case PUSH, so require the
		// connected tool can create/update work items — the same live probe as the
		// bulk sync, not the old Azure-DevOps-only test-executions tier. If no PM
		// target resolves, skip the gate and let `retryPmSyncItem` report the
		// unconfigured state through its normal `{ enqueued: false }` path.
		const target = await resolvePmTarget({
			project: {
				projectManagementMcpServerId:
					item.project.projectManagementMcpServerId,
				projectManagementMcpConfigId:
					item.project.projectManagementMcpConfigId,
				organizationId: item.project.organizationId,
			},
			userId: context.user.id,
			organizationId: item.project.organizationId,
		});
		if (target) {
			await assertTestCaseSyncSupported(target, "push", {
				userId: context.user.id,
				organizationId: item.project.organizationId,
			});
		}

		const result = await retryPmSyncItem({
			itemId: input.testCaseId,
			itemType: "testCase",
			projectId: input.projectId,
			userId: context.user.id,
			externalId: item.externalId,
			externalMcpServerId: item.externalMcpServerId,
		});

		return {
			enqueued: result.enqueued,
			workflowId: result.workflowId,
			reason: result.reason,
		};
	});
