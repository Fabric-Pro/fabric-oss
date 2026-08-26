import { ORPCError } from "@orpc/server";
import {
	getScanFindingReview,
	hasProjectAccess,
	recordScanActivity,
	updateScanFindingReview,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * Cancel a running on-demand AI false-positive review (G7). The companion to
 * `review.start`: gives the user an immediate out when a review is in flight,
 * without waiting on the workflow's own timeout.
 *
 * Behaviour (robust against a down / unreachable worker):
 *   1. Verify project access + that the review belongs to the project.
 *   2. If the review is already terminal (COMPLETED / FAILED), there's nothing
 *      to cancel — return `{ cancelled: false }` rather than erroring.
 *   3. Best-effort terminate the Temporal workflow (swallowed — it may already
 *      have finished, or the worker may be unreachable).
 *   4. Directly mark the review row terminal (FAILED + "Cancelled by user").
 *      `terminate` doesn't run the workflow's catch, so the procedure owns the
 *      final state.
 *   5. Record a REVIEW_CANCELLED page-history entry. A running review hasn't
 *      applied anything yet, so 0 findings were updated.
 *
 * Permission mirrors the other review procedures (PROJECT_UPDATE) — a review is
 * an analysis the user acts on, not a settings change.
 */
export const cancelReviewProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/:projectId/scan/review/cancel",
		tags: ["Projects", "Security"],
		summary: "Cancel a running AI findings review",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			reviewId: z.string(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { projectId, organizationId, reviewId } = input;
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

		// The review must belong to this project — guards against cancelling under
		// a review id from another project / tenant.
		const review = await getScanFindingReview(reviewId, projectId);
		if (!review) {
			throw new ORPCError("NOT_FOUND", { message: "Review not found" });
		}

		// Already done? Nothing to cancel — don't error, just report no-op so a
		// double-click / late cancel is harmless.
		if (review.status === "COMPLETED" || review.status === "FAILED") {
			return { cancelled: false };
		}

		// Best-effort terminate the (likely in-flight) review workflow so it can't
		// finalize after we flip the row. Swallowed: it may already be closed /
		// never have started / the worker may be unreachable.
		if (review.workflowId) {
			try {
				// Lazy-load @repo/temporal so importing this procedure doesn't pull
				// the temporal worker graph into the module graph (matches
				// start-review.ts).
				const { getTemporalClient } = await import("@repo/temporal");
				const client = await getTemporalClient();
				await client.workflow
					.getHandle(review.workflowId)
					.terminate("Cancelled by user");
			} catch {
				// Non-fatal — the DB flip below is the real cancel.
			}
		}

		// Mark the review terminal. `terminate` doesn't run the workflow's catch,
		// so the procedure owns the final state.
		await updateScanFindingReview(reviewId, {
			status: "FAILED",
			error: "Cancelled by user",
			completedAt: new Date(),
		});

		// A running review hasn't applied anything yet — 0 findings updated.
		await recordScanActivity({
			projectId,
			type: "REVIEW_CANCELLED",
			userId: user.id,
			organizationId: organizationId ?? null,
			scanId: null,
			summary: "Cancelled the findings review — no findings updated",
		}).catch(() => {});

		return { cancelled: true };
	});
