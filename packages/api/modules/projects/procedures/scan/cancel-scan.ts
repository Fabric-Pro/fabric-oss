import { ORPCError } from "@orpc/server";
import {
	failScanIfActive,
	getProjectScan,
	hasProjectAccess,
	recordScanActivity,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * Cancel a running security & accessibility scan. The companion to `trigger`:
 * gives the user an immediate out when a scan is in flight, without waiting on
 * the workflow's own (up to 90-minute) execution timeout.
 *
 * Behaviour (robust against a down / unreachable worker) — mirrors
 * `cancel-review.ts`:
 *   1. Verify project access + that the scan belongs to the project.
 *   2. If the scan is already terminal (COMPLETED / FAILED), there's nothing to
 *      cancel — return `{ cancelled: false }` rather than erroring, so a
 *      double-click / late cancel is harmless.
 *   3. Best-effort terminate the Temporal workflow by its DETERMINISTIC id
 *      (`security-scan-<scanId>`) — even during the brief window before
 *      start-scan writes workflowId back to the row — so a cancel can't be
 *      silently undone by the workflow running on to completion.
 *   4. Compare-and-set the row to FAILED ("Cancelled by user") ONLY if it is
 *      still active, so a persist that won the race isn't overwritten.
 *   5. Record a SCAN_FAILED page-history entry ("Scan cancelled by user"). The
 *      existing enum value is reused deliberately — the activity taxonomy has a
 *      hard count test, so no new value is added.
 *
 * Permission mirrors the other scan mutations (PROJECT_UPDATE).
 */
export const cancelScanProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/:projectId/scan/cancel",
		tags: ["Projects", "Security"],
		summary: "Cancel a running scan",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			scanId: z.string(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { projectId, organizationId, scanId } = input;
		const user = context.user;

		const hasAccess = await hasProjectAccess(
			projectId,
			user.id,
			organizationId ?? undefined,
		);
		if (!hasAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		// The scan must belong to this project — guards against cancelling under
		// a scan id from another project / tenant.
		const scan = await getProjectScan(scanId, projectId);
		if (!scan) {
			throw new ORPCError("NOT_FOUND", { message: "Scan not found" });
		}

		// Already done? Nothing to cancel — don't error, just report no-op so a
		// double-click / late cancel is harmless.
		if (scan.status === "COMPLETED" || scan.status === "FAILED") {
			return { cancelled: false };
		}

		// Best-effort terminate the (likely in-flight) scan workflow so it can't
		// finalize after we flip the row. The workflowId is deterministic
		// (`security-scan-<scanId>`), so terminate by the derived id even during
		// the brief window before start-scan writes workflowId back to the row —
		// otherwise a cancel in that window can't kill the workflow and is
		// silently undone (the scan runs on to COMPLETED). Swallowed: the workflow
		// may already be closed / never have started / the worker unreachable.
		const workflowId = scan.workflowId ?? `security-scan-${scanId}`;
		try {
			// Lazy-load @repo/temporal so importing this procedure doesn't pull
			// the temporal worker graph into the module graph (matches
			// start-scan.ts).
			const { getTemporalClient } = await import("@repo/temporal");
			const client = await getTemporalClient();
			await client.workflow
				.getHandle(workflowId)
				.terminate("Cancelled by user");
		} catch {
			// Non-fatal — the DB flip below is the real cancel.
		}

		// Compare-and-set: flip to FAILED ONLY if the scan is still active. If the
		// workflow's persist won the race and wrote COMPLETED between our status
		// read (above) and here, this updates 0 rows and we report a no-op —
		// rather than overwriting a completed scan (and its persisted findings)
		// as FAILED. Also makes a double-click cancel idempotent.
		const flipped = await failScanIfActive(
			scanId,
			projectId,
			"Cancelled by user",
		);
		if (flipped === 0) {
			return { cancelled: false };
		}

		// SCAN_FAILED page-history entry — an existing taxonomy value (the count
		// test forbids adding a new one) that reads accurately for a cancel.
		await recordScanActivity({
			projectId,
			type: "SCAN_FAILED",
			userId: user.id,
			organizationId: organizationId ?? null,
			scanId,
			summary: "Scan cancelled by user",
		}).catch(() => {});

		return { cancelled: true };
	});
