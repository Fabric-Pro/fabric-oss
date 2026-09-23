import { ORPCError } from "@orpc/client";
import { db } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";

/** Progress of one story-sync run, read from Temporal. */
async function readWorkflowProgress(workflowId: string) {
	const { getTemporalClient, storySyncProgressQuery } = await import(
		"@repo/temporal"
	);
	const client = await getTemporalClient();

	try {
		const handle = client.workflow.getHandle(workflowId);
		const progress = await handle.query(storySyncProgressQuery);
		return progress;
	} catch (_queryError) {
		// The progress query is answered by replaying the workflow, so it can
		// transiently fail while the run is mid-flight or just finishing.
		// Before assuming the workflow is gone, read the AUTHORITATIVE
		// execution status (a cheap, replay-free service call). While it is
		// still RUNNING, keep the client polling instead of synthesizing a
		// "completed" result — which previously stopped polling early and
		// masked the real synced / needs-review / failed summary (and the
		// Review-conflicts CTA) on slower (conflict-checked) bulk syncs.
		try {
			const handle = client.workflow.getHandle(workflowId);
			const description = await handle.describe();
			if (description.status?.name === "RUNNING") {
				return {
					status: "syncing",
					totalStories: 0,
					syncedCount: 0,
					failedCount: 0,
					conflictedCount: 0,
					message: "Finalizing sync…",
					results: [],
				};
			}
		} catch {
			// describe() failed too — fall through to the result() path below.
		}

		// Workflow is terminal (or status unknown) - read the persisted result.
		try {
			const handle = client.workflow.getHandle(workflowId);
			const result = await Promise.race([
				handle.result(),
				new Promise<never>((_, reject) =>
					setTimeout(() => reject(new Error("Result timeout")), 8000),
				),
			]);
			// Convert workflow output to progress format (matches StorySyncProgress)
			const cancelled =
				result.error === "Cancelled by user" ||
				result.error?.includes("cancelled");
			const status = cancelled
				? "cancelled"
				: result.success
					? "completed"
					: "failed";
			return {
				status,
				totalStories: result.totalStories,
				syncedCount: result.syncedCount,
				failedCount: result.failedCount,
				conflictedCount: result.conflictedCount ?? 0,
				message:
					result.error ??
					(result.success ? "Sync completed" : "Sync failed"),
				results: result.results,
			};
		} catch (resultError) {
			// handle.result() rejects when workflow failed (e.g. activity threw)
			// Extract error message and return as failed status instead of throwing
			const err = resultError as Error & { cause?: Error };
			const isWorkflowFailed =
				err.name === "WorkflowFailedError" ||
				err.message?.includes("WorkflowFailed");
			const errorMessage =
				err.cause?.message ?? err.message ?? "Sync failed";

			if (isWorkflowFailed || errorMessage !== "Result timeout") {
				return {
					status: "failed",
					totalStories: 0,
					syncedCount: 0,
					failedCount: 0,
					conflictedCount: 0,
					message: errorMessage,
					results: [],
				};
			}

			// Result timeout or workflow doesn't exist - workflow likely completed
			// and was evicted. Return completed so frontend stops polling without error.
			return {
				status: "completed",
				totalStories: 0,
				syncedCount: 0,
				failedCount: 0,
				conflictedCount: 0,
				message: "Sync completed",
				results: [],
			};
		}
	}
}

/**
 * Get sync workflow progress
 */
export const syncProgressProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_UPDATE))
	.route({
		method: "GET",
		path: "/projects/{projectId}/stories/sync/{workflowId}/progress",
		tags: ["Projects", "Stories", "Sync"],
		summary: "Get sync progress",
		description: "Get the progress of a running sync workflow",
	})
	.input(
		z.object({
			projectId: z.string(),
			workflowId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input }) => {
		// TENANT ISOLATION (SOC 2 CC6.1): the Temporal handle is opened by
		// input.workflowId, which is NOT bound to the permission-checked
		// projectId. Story-sync workflow ids are `story-sync-<projectId>-<ts>`
		// (see create-project.ts / sync-stories-bulk.ts), so require the id to
		// belong to the authorized project before reading its progress.
		if (!input.workflowId.startsWith(`story-sync-${input.projectId}-`)) {
			throw new ORPCError("NOT_FOUND", {
				message: "Sync workflow not found",
			});
		}
		const progress = await readWorkflowProgress(input.workflowId);
		// Read AFTER the progress, so a run the progress read saw finish has
		// already closed its row. Scoped to the authorized project as well as
		// the workflow. Read only: the progress query can report `cancelled`
		// before the run has closed its row, so this never reconciles it.
		const job = await db.backgroundJob.findFirst({
			where: {
				workflowId: input.workflowId,
				projectId: input.projectId,
				kind: "PM_STORY_SYNC",
			},
			orderBy: { createdAt: "desc" },
			select: { status: true, counts: true },
		});
		/**
		 * The durable outcome of the run. `progress.status` can be synthesized
		 * ("completed" when the result read times out), so a caller that must
		 * know the run really finished — Do both, the "no new items" toast —
		 * keys on this instead. Null when no row exists (a run started before
		 * rows were opened).
		 *
		 * `jobFailedCount` is the run's own failure count from that row, for the
		 * same reason: the synthesized progress reports `failedCount: 0`.
		 */
		const failed = (job?.counts as Record<string, unknown> | null)?.failed;
		return {
			...progress,
			jobStatus: job?.status ?? null,
			jobFailedCount: typeof failed === "number" ? failed : null,
		};
	});

/**
 * Cancel sync workflow
 */
export const cancelSyncProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/stories/sync/{workflowId}/cancel",
		tags: ["Projects", "Stories", "Sync"],
		summary: "Cancel sync workflow",
		description: "Cancel a running sync workflow",
	})
	.input(
		z.object({
			projectId: z.string(),
			workflowId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input }) => {
		// TENANT ISOLATION (SOC 2 CC6.1): bind input.workflowId to the
		// permission-checked projectId (ids are `story-sync-<projectId>-<ts>`)
		// so a caller cannot cancel another tenant's sync workflow by id.
		if (!input.workflowId.startsWith(`story-sync-${input.projectId}-`)) {
			throw new ORPCError("NOT_FOUND", {
				message: "Sync workflow not found or already completed",
			});
		}
		const { getTemporalClient, cancelSyncSignal } = await import(
			"@repo/temporal"
		);
		const client = await getTemporalClient();

		try {
			const handle = client.workflow.getHandle(input.workflowId);
			await handle.signal(cancelSyncSignal);
			return { success: true, message: "Cancel signal sent" };
		} catch (_error) {
			throw new ORPCError("NOT_FOUND", {
				message: "Sync workflow not found or already completed",
			});
		}
	});
