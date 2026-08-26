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
 * Retry PM sync for a batch of test cases. Backs a "Retry all" bulk action.
 * Validates per-item tenant ownership against `db.testCase` (cross-tenant /
 * missing ids are silently dropped, never reported) and fans out fire-and-forget
 * `retryPmSyncItem` calls, each starting `testCaseSyncWorkflow` for one id.
 */
export const retryTestCasePmSyncBatchProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.TEST_CASE_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/test-cases/retry-pm-sync-batch",
		tags: ["Projects", "Test Cases", "Sync"],
		summary: "Retry PM sync for a batch of test cases",
		description:
			"Re-enqueues `testCaseSyncWorkflow` per id for a batch of test cases. Tenant-guarded; cross-tenant ids are dropped.",
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
			enqueuedCount: z.number(),
			results: z.array(
				z.object({
					id: z.string(),
					enqueued: z.boolean(),
					workflowId: z.string().optional(),
					reason: z.string().optional(),
				}),
			),
		}),
	)
	.handler(async ({ input, context }) => {
		assertTestCasesFeatureEnabled();
		// AUTHORIZATION: requireProjectPermission(TEST_CASE_UPDATE) gates project
		// access; per-item ownership is re-checked against db.testCase below.
		const user = context.user;

		if (input.testCaseIds.length === 0) {
			return { enqueuedCount: 0, results: [] };
		}

		const project = await db.project.findUnique({
			where: { id: input.projectId },
			select: {
				id: true,
				organizationId: true,
				projectManagementMcpServerId: true,
				projectManagementMcpConfigId: true,
			},
		});
		if (!project) {
			throw new ORPCError("NOT_FOUND", { message: "Project not found" });
		}

		// Capability gate (LIVE): the batch retry re-drives the case PUSH, so
		// require the connected tool can create/update work items — the same live
		// probe as the bulk sync, not the old Azure-DevOps-only tier. If no PM
		// target resolves, skip the gate; each `retryPmSyncItem` reports the
		// unconfigured state through its own `{ enqueued: false }` result.
		const target = await resolvePmTarget({
			project: {
				projectManagementMcpServerId:
					project.projectManagementMcpServerId,
				projectManagementMcpConfigId:
					project.projectManagementMcpConfigId,
				organizationId: project.organizationId,
			},
			userId: user.id,
			organizationId: project.organizationId,
		});
		if (target) {
			await assertTestCaseSyncSupported(target, "push", {
				userId: user.id,
				organizationId: project.organizationId,
			});
		}

		// Ownership pre-filter carrying each owned case's current PM link.
		const owned = await db.testCase.findMany({
			where: {
				id: { in: input.testCaseIds },
				projectId: input.projectId,
			},
			select: { id: true, externalId: true, externalMcpServerId: true },
		});
		const ownedById = new Map(owned.map((c) => [c.id, c]));

		const filtered = input.testCaseIds.filter((id) => ownedById.has(id));

		const settled = await Promise.allSettled(
			filtered.map((id) => {
				const link = ownedById.get(id);
				return retryPmSyncItem({
					itemId: id,
					itemType: "testCase",
					projectId: input.projectId,
					userId: user.id,
					externalId: link?.externalId ?? null,
					externalMcpServerId: link?.externalMcpServerId ?? null,
				});
			}),
		);

		const results = filtered.map((id, idx) => {
			const entry = settled[idx];
			if (entry?.status === "fulfilled") {
				return {
					id,
					enqueued: entry.value.enqueued,
					workflowId: entry.value.workflowId,
					reason: entry.value.reason,
				};
			}
			return { id, enqueued: false, reason: "temporal-error" };
		});

		const enqueuedCount = results.filter((r) => r.enqueued).length;
		return { enqueuedCount, results };
	});
