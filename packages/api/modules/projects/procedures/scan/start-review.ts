import { ORPCError } from "@orpc/server";
import {
	createScanFindingReview,
	hasActiveScanReview,
	hasProjectAccess,
	recordScanActivity,
	updateScanFindingReview,
} from "@repo/database";
import { z } from "zod";
import { withCorrelationMemo } from "../../../../lib/temporal-correlation";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * Start an on-demand AI false-positive review (G7) over the project's current
 * OPEN findings. Creates a `ScanFindingReview` row and dispatches the separate
 * `scanFindingReviewWorkflow` on the general-purpose `fabric-worker` queue. The
 * review only PROPOSES dismiss / severity-change / uncertain verdicts — applying
 * a proposal is a separate explicit user step (`review.apply`).
 *
 * Deduped against an in-flight review so a double-click can't spawn redundant
 * runs. Permission mirrors triage edits (PROJECT_UPDATE) — a review is an
 * analysis the user acts on, not a settings change.
 */
export const startReviewProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/:projectId/scan/review/start",
		tags: ["Projects", "Security"],
		summary: "Start an AI false-positive review of current findings",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			// Pin a specific scan; omit to review the latest COMPLETED scan's
			// findings (what the user currently sees).
			scanId: z.string().optional(),
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

		// Dedupe: if a review is already PENDING/RUNNING, return it as a conflict
		// so the client can poll the existing run instead of starting another.
		if (await hasActiveScanReview(projectId)) {
			throw new ORPCError("CONFLICT", {
				message: "A findings review is already in progress.",
			});
		}

		const review = await createScanFindingReview({
			projectId,
			userId: user.id,
			organizationId: organizationId ?? null,
		});

		// Lazy-load @repo/temporal so importing this procedure doesn't pull the
		// temporal worker graph into the module graph (matches start-scan.ts).
		const { getTemporalClient } = await import("@repo/temporal");
		const client = await getTemporalClient();
		const workflowId = `scan-review-${review.id}`;
		try {
			const handle = await client.workflow.start(
				"scanFindingReviewWorkflow",
				withCorrelationMemo({
					taskQueue: "fabric-worker",
					workflowId,
					args: [
						{
							reviewId: review.id,
							projectId,
							scanId: scanId ?? null,
							userId: user.id,
							organizationId: organizationId ?? null,
						},
					],
					workflowExecutionTimeout: "30 minutes",
				}),
			);
			await updateScanFindingReview(review.id, {
				workflowId: handle.workflowId,
			});
			// Record the trigger (who/when) in the page history. Best-effort: a
			// failed history write must not fail the (already-dispatched) review.
			// `ScanActivityType` isn't re-exported here — pass the enum value as a
			// string literal (matches apply-review.ts's FINDINGS_REVIEWED).
			await recordScanActivity({
				projectId,
				type: "REVIEW_STARTED",
				userId: user.id,
				organizationId: organizationId ?? null,
				scanId: null,
				summary: "Started an AI false-positive review",
			}).catch(() => {});
			return { reviewId: review.id, status: review.status };
		} catch (error) {
			// Dispatch failed — mark the row FAILED so it never hangs in PENDING
			// and the page can surface a retry rather than spin forever.
			await updateScanFindingReview(review.id, {
				status: "FAILED",
				error:
					error instanceof Error
						? error.message
						: "Failed to start findings review",
			}).catch(() => {});
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: "Failed to start findings review",
			});
		}
	});
