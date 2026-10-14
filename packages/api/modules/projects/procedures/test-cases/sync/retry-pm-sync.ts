import { ORPCError } from "@orpc/client";
import { db } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";
import { pmRecoveryTooRecentMessage } from "../../../lib/pm-recovery-messages";
import { assertTestCaseSyncSupported } from "../../../lib/pm-test-case-sync-capability";
import { resolvePmTarget } from "../../../lib/resolve-pm-target";
import {
	PM_RECOVERY_STALE_MESSAGE,
	retryPmSyncItem,
} from "../../../lib/retry-pm-sync-item";
import { assertTestCasesFeatureEnabled } from "../../../lib/test-cases-feature";

/**
 * Retry PM sync for a single test case. Backs the Retry button on a case whose
 * `lastPmSyncStatus` is FAILED or CONFLICT, and, with `unlinkFirst`, its
 * Unlink & re-create. Reuses the shared `retryPmSyncItem` lib with
 * `itemType: "testCase"`, which starts `testCaseSyncWorkflow` for just this
 * id under the case's one workflow id.
 */
export const retryTestCasePmSyncProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.TEST_CASE_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/test-cases/{testCaseId}/retry-pm-sync",
		tags: ["Projects", "Test Cases", "Sync"],
		summary: "Retry PM sync for a single test case",
		description:
			"Re-enqueues `testCaseSyncWorkflow` for a single test case. Backs the Retry button on a FAILED/CONFLICT case. With `unlinkFirst`, first drops the case's PM link and pending create (exactly as read) so the push creates a new PM item: the Unlink & re-create action for a case whose earlier create may already exist in the PM tool.",
	})
	.input(
		z.object({
			projectId: z.string(),
			testCaseId: z.string(),
			organizationId: z.string().nullable().optional(),
			/**
			 * "Unlink & re-create": drop the case's PM link and its create
			 * claim (only as read here) before the push, so it creates a new
			 * PM item. For a case whose earlier create could not be confirmed
			 * or linked, after the user checked the PM tool.
			 */
			unlinkFirst: z.boolean().default(false),
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
				// The link and create claim, read together: Unlink &
				// re-create clears exactly these or nothing.
				externalId: true,
				externalUrl: true,
				externalMcpServerId: true,
				pmCreateClaimId: true,
				project: {
					select: {
						projectManagementMcpServerId: true,
						projectManagementMcpConfigId: true,
						projectManagementAdditionalContext: true,
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
				projectManagementAdditionalContext:
					item.project.projectManagementAdditionalContext,
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
			unlinkFirst: input.unlinkFirst,
			externalId: item.externalId,
			externalUrl: item.externalUrl,
			externalMcpServerId: item.externalMcpServerId,
			pmCreateClaimId: item.pmCreateClaimId,
		});

		// Unlink & re-create found the create claim it read still held and
		// too recent to clear: a push may still be sending its create.
		if (result.reason === "pm-recovery-too-recent") {
			throw new ORPCError("CONFLICT", {
				message: pmRecoveryTooRecentMessage(result.recoverableAt),
				data: {
					errorCode: "PM_RECOVERY_TOO_RECENT",
					recoverableAt: result.recoverableAt?.toISOString() ?? null,
				},
			});
		}

		// Unlink & re-create found the link or the create claim changed since
		// the read above; nothing was cleared or enqueued.
		if (result.reason === "pm-recovery-stale") {
			throw new ORPCError("CONFLICT", {
				message: PM_RECOVERY_STALE_MESSAGE,
				data: { errorCode: "PM_RECOVERY_STALE" },
			});
		}

		return {
			enqueued: result.enqueued,
			workflowId: result.workflowId,
			reason: result.reason,
		};
	});
