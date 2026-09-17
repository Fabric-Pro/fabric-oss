import { ORPCError } from "@orpc/client";
import {
	getInstructionSnapshot,
	startInstructionSnapshotValidation,
} from "@repo/database";
import { getTemporalClient } from "@repo/temporal";
import { z } from "zod";
import { withCorrelationMemo } from "../../../../lib/temporal-correlation";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { requireHostingOrganizationId } from "./hosting-organization";

/**
 * Temporal rejects a second start for a workflow id whose execution is
 * still open. Because the id here is derived from the snapshot row
 * (`project-instruction-snapshot-<snapshotId>`), hitting this on a retry
 * means an earlier finalize attempt already started the workflow, so the
 * start is confirmed rather than failed. Matched by name (copied from
 * `coding-runs/procedures/start-coding-run.ts`'s local
 * `isWorkflowAlreadyStartedError`; not imported — it is local there too):
 * `@temporalio/client` is not a direct dependency of this package.
 */
function isWorkflowAlreadyStartedError(error: unknown): boolean {
	return (
		error instanceof Error &&
		error.name === "WorkflowExecutionAlreadyStartedError"
	);
}

/**
 * AUTHORIZATION: tenantProtectedProcedure + requireProjectPermission(INSTRUCTION_CREATE).
 *
 * Finishes an upload: starts `projectInstructionSnapshotWorkflow` (added in
 * Task 10; started here by string name, which is a valid oRPC → Temporal
 * handoff ahead of the workflow's own implementation landing) and only
 * THEN flips the snapshot to VALIDATING. The snapshot lookup is
 * tenant-scoped (`getInstructionSnapshot(id, projectId, organizationId)`)
 * before anything else runs, so the workflow only ever starts for a
 * snapshot this caller's organization actually owns.
 *
 * Ordering matters here (R15): `workflow.start` runs BEFORE the status
 * transition. Writing VALIDATING first and starting
 * the workflow second would strand the snapshot in VALIDATING forever if
 * the start call failed after the status write committed — every later
 * finalize call short-circuits on `status !== "RECEIVING"`, so nothing
 * would ever retry the start. Starting first means a failed start leaves
 * the row in RECEIVING, which a retried finalize call naturally repairs.
 * The workflow id is deterministic, so RECEIVING (first attempt),
 * VALIDATING (a retry after a previously failed start) and FAILED (the
 * workflow ran and its terminal-failure marker fired) all re-attempt the
 * start; any other status still short-circuits and returns the snapshot's
 * current status unchanged. The transition itself is conditional
 * (`startInstructionSnapshotValidation`), so a workflow that finished while
 * this handler was mid-flight keeps its terminal status and the handler
 * returns that status instead of VALIDATING. A `WorkflowExecutionAlreadyStartedError` from
 * that re-attempt means an earlier call's start actually succeeded (only
 * the subsequent status write failed or never ran), so it is treated as
 * success rather than re-thrown — EXCEPT when the pre-read status was
 * FAILED, where it means the previous execution is still closing and no new
 * run exists to move the row for; that case returns FAILED and writes
 * nothing. Any other start failure propagates
 * unchanged and leaves the snapshot exactly where it was (RECEIVING,
 * VALIDATING or FAILED), for the next finalize call to retry.
 *
 * FAILED is accepted because it is this feature's "Try again" — the tab
 * renders that button for a FAILED snapshot and it calls this procedure.
 * Reusing the workflow id after a CLOSED run is what Temporal's default
 * id-reuse policy allows, and the snapshot's staging objects are still
 * there (`markInstructionSnapshotFailed` deliberately leaves them), so the
 * new run's integrity/secret gate has the bytes it needs.
 */
export const finalizeSnapshotProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.INSTRUCTION_CREATE))
	.route({
		method: "POST",
		path: "/projects/:projectId/instructions/snapshots/:snapshotId/finalize",
		tags: ["Projects", "Instructions"],
		summary: "Finish the upload and start validation",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			snapshotId: z.string(),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = await requireHostingOrganizationId(
			input.projectId,
			context.user.id,
		);
		const snapshot = await getInstructionSnapshot(
			input.snapshotId,
			input.projectId,
			organizationId,
		);
		if (!snapshot) {
			throw new ORPCError("NOT_FOUND", { message: "Upload not found" });
		}
		if (
			snapshot.status !== "RECEIVING" &&
			snapshot.status !== "VALIDATING" &&
			snapshot.status !== "FAILED"
		) {
			return { status: snapshot.status };
		}

		const temporalClient = await getTemporalClient();
		let alreadyStarted = false;
		try {
			await temporalClient.workflow.start(
				"projectInstructionSnapshotWorkflow",
				withCorrelationMemo({
					// Its own queue, not "project-documents": these activities
					// are long and I/O-bound (the gate hashes and scans up
					// to 50 MB, and promotion re-hashes and re-writes it), so
					// sharing the 5 slots that serve a human waiting on a
					// document generation let three uploads hold 60% of it.
					// Registered in `packages/temporal/src/worker.ts`.
					taskQueue: "project-instructions",
					workflowId: `project-instruction-snapshot-${snapshot.id}`,
					args: [
						{
							snapshotId: snapshot.id,
							projectId: input.projectId,
							organizationId,
							userId: context.user.id,
						},
					],
				}),
			);
		} catch (error) {
			if (!isWorkflowAlreadyStartedError(error)) {
				throw error;
			}
			alreadyStarted = true;
		}

		// A FAILED row plus `AlreadyStarted` is the one combination where
		// nothing new is running and nothing should move.
		//
		// `markInstructionSnapshotFailed` writes FAILED from inside the
		// workflow's boundary catch, which then RETHROWS; the execution stays
		// open until Temporal processes that final workflow task. A user who
		// presses "Try again" inside that window gets `AlreadyStarted` from the
		// old, still-closing run — not from a new one. Transitioning on that
		// would move FAILED to VALIDATING with no execution behind it, and the
		// old run would close moments later having already written its verdict,
		// leaving the snapshot VALIDATING forever with the tab polling it.
		//
		// So the status is preserved and reported, and the user retries once
		// the previous run has closed (Temporal's default id-reuse policy
		// allows the same workflow id again at that point). RECEIVING and
		// VALIDATING keep the existing tolerance: there `AlreadyStarted` means
		// an earlier attempt's start genuinely succeeded and only its status
		// write was lost, so the transition is the repair.
		if (alreadyStarted && snapshot.status === "FAILED") {
			return { status: "FAILED" as const };
		}

		// Conditional, because the workflow races this write. It is started
		// first on purpose (a failed start must leave the row where a retried
		// finalize can repair it), and a small upload can reach READY or
		// REJECTED before the line below runs. An unconditional write
		// overwrote that verdict — and for READY it also made the publish
		// activity refuse the snapshot as `not_ready`, so the tab polled a
		// validation that had already finished and could never publish.
		const started = await startInstructionSnapshotValidation({
			snapshotId: snapshot.id,
			projectId: input.projectId,
			organizationId,
		});
		if (started.changed) {
			return { status: "VALIDATING" as const };
		}
		// The conditional write matched nothing: either the workflow has
		// already produced a terminal status, or the row was already
		// VALIDATING. Report what is actually there rather than asserting.
		const current = await getInstructionSnapshot(
			input.snapshotId,
			input.projectId,
			organizationId,
		);
		if (!current) {
			throw new ORPCError("NOT_FOUND", { message: "Upload not found" });
		}
		return { status: current.status };
	});
