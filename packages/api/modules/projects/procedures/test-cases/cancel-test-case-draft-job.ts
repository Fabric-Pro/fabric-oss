import { ORPCError } from "@orpc/client";
import { cancelTestCaseDraftJob, getTestCaseDraftJob } from "@repo/database";
import { logger } from "@repo/logs";
import { getTemporalClient } from "@repo/temporal";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertTestCasesFeatureEnabled } from "../../lib/test-cases-feature";

/**
 * Stop a drafting run that is still in flight.
 *
 * The row is marked CANCELLED first and the Temporal run is cancelled second: the
 * ledger is what the UI reads, so it must reflect the user's intent even if the
 * workflow cancel can't be delivered. The activity's writes are compare-and-set
 * on RUNNING, so anything still in flight lands on a CANCELLED row and is
 * dropped rather than resurrecting it.
 *
 * Cancelling does NOT delete cases already drafted — a partially-finished run
 * leaves real, editable cases behind, and silently destroying them would be a
 * worse surprise than keeping them.
 */
export const cancelTestCaseDraftJobProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.TEST_CASE_CREATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/test-cases/draft-jobs/{jobId}/cancel",
		tags: ["Projects", "Test Cases"],
		summary: "Cancel an in-flight AI test-case drafting run",
	})
	.input(
		z.object({
			projectId: z.string(),
			jobId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		assertTestCasesFeatureEnabled();
		// AUTHORIZATION: requireProjectPermission(TEST_CASE_CREATE) gates project
		// access; only the caller who started the run may cancel it.
		const existing = await getTestCaseDraftJob({
			jobId: input.jobId,
			projectId: input.projectId,
		});
		if (!existing || existing.requestedById !== context.user.id) {
			throw new ORPCError("NOT_FOUND", {
				message: "Drafting run not found",
			});
		}

		const cancelled = await cancelTestCaseDraftJob({
			jobId: input.jobId,
			projectId: input.projectId,
		});
		if (!cancelled) {
			// Already terminal — nothing to stop. Not an error: the caller wanted
			// it stopped and it is stopped.
			return { cancelled: false };
		}

		if (cancelled.workflowId) {
			try {
				const client = await getTemporalClient();
				await client.workflow.getHandle(cancelled.workflowId).cancel();
			} catch (error) {
				// The row is already CANCELLED, which is what the UI reads. A
				// workflow that keeps running finds a non-RUNNING row and drops
				// its writes, so this is a tidy-up failure, not a correctness one.
				logger.warn(
					"[testCaseDraftJob] Failed to cancel workflow run",
					{
						jobId: input.jobId,
						workflowId: cancelled.workflowId,
						error:
							error instanceof Error
								? error.message
								: String(error),
					},
				);
			}
		}

		return { cancelled: true };
	});
