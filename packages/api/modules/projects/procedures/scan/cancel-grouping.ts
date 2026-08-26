import { ORPCError } from "@orpc/server";
import {
	getScanFindingGrouping,
	hasProjectAccess,
	updateScanFindingGrouping,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * Cancel a running on-demand finding-grouping run (spec
 * `2026-07-01-security-finding-tickets`). The companion to `grouping.start`:
 * gives the user an immediate out when a run is in flight, without waiting on
 * the workflow's own timeout.
 *
 * Behaviour (robust against a down / unreachable worker), mirrors
 * `cancel-review.ts`'s ownership model exactly:
 *   1. Verify project access + that the grouping run belongs to the project.
 *   2. If the run is already terminal (COMPLETED / FAILED), there's nothing to
 *      cancel — return `{ cancelled: false }` rather than erroring.
 *   3. Best-effort terminate the Temporal workflow (swallowed — it may already
 *      have finished, or the worker may be unreachable).
 *   4. Directly mark the grouping row terminal (FAILED + "Cancelled by user").
 *      `terminate` doesn't run the workflow's catch, so the procedure owns the
 *      final state.
 *
 * Tickets already created before cancellation are NOT rolled back — matching
 * `backlogApplyChangesWorkflow`'s no-compensation semantics (§7.1).
 */
export const cancelGroupingProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/:projectId/scan/grouping/cancel",
		tags: ["Projects", "Security"],
		summary: "Cancel a running findings-grouping run",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			groupingId: z.string(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { projectId, organizationId, groupingId } = input;
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

		// The grouping run must belong to this project — guards against
		// cancelling under an id from another project / tenant.
		const grouping = await getScanFindingGrouping(groupingId, projectId);
		if (!grouping) {
			throw new ORPCError("NOT_FOUND", {
				message: "Findings grouping run not found",
			});
		}

		// Already done? Nothing to cancel — don't error, just report no-op so a
		// double-click / late cancel is harmless.
		if (grouping.status === "COMPLETED" || grouping.status === "FAILED") {
			return { cancelled: false };
		}

		// Best-effort terminate the (likely in-flight) grouping workflow so it
		// can't finalize after we flip the row. Swallowed: it may already be
		// closed / never have started / the worker may be unreachable.
		if (grouping.workflowId) {
			try {
				// Lazy-load @repo/temporal so importing this procedure doesn't pull
				// the temporal worker graph into the module graph (matches
				// start-grouping.ts).
				const { getTemporalClient } = await import("@repo/temporal");
				const client = await getTemporalClient();
				await client.workflow
					.getHandle(grouping.workflowId)
					.terminate("Cancelled by user");
			} catch {
				// Non-fatal — the DB flip below is the real cancel.
			}
		}

		// Mark the grouping run terminal. `terminate` doesn't run the workflow's
		// catch, so the procedure owns the final state. Tickets already created
		// before cancellation are not rolled back (§7.1).
		await updateScanFindingGrouping(groupingId, {
			status: "FAILED",
			error: "Cancelled by user",
			completedAt: new Date(),
		});

		return { cancelled: true };
	});
