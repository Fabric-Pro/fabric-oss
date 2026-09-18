import { ORPCError } from "@orpc/client";
import {
	getInstructionSnapshot,
	startInstructionSnapshotValidation,
} from "@repo/database";
import { instructionSnapshotWorkflowId } from "@repo/instructions";
import { getTemporalClient } from "@repo/temporal";
import { z } from "zod";
import { withCorrelationMemo } from "../../../../lib/temporal-correlation";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { requireHostingOrganizationId } from "./hosting-organization";
import { assertInstructionSnapshotMutationAccess } from "./proposal-authorization";

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
 * The workflow id is deterministic, so RECEIVING (first attempt) and FAILED
 * (the workflow ran and its terminal-failure marker fired) both re-attempt
 * the start; any other status short-circuits and returns the snapshot's
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
 * unchanged and leaves the snapshot exactly where it was (RECEIVING or
 * FAILED), for the next finalize call to retry.
 *
 * VALIDATING is NOT one of them (round 8, finding 1). A VALIDATING row is
 * owned by a live run, and this handler has no way to tell a live one from
 * a dead one — so it reports the status and starts nothing. Starting a new
 * execution from an UNCHANGED VALIDATING row was the unsafe case: the row
 * looked exactly like the stale one the reaper's watchdog phase was about
 * to fail, because nothing about it had moved, and the watchdog would then
 * have written FAILED over a live run. If the previous run really is dead,
 * that watchdog marks the row FAILED within about a sweep cycle, and the
 * tab's "Try again" restarts it FROM FAILED — the only path that puts a
 * fresh generation on the row, and the one the watchdog's compare-and-set
 * can see. A retried finalize whose response was merely lost gets the same
 * VALIDATING answer it would have got before, without a redundant start.
 *
 * FAILED is accepted because it is this feature's "Try again" — the tab
 * renders that button for a FAILED snapshot and it calls this procedure.
 * Reusing the workflow id after a CLOSED run is what Temporal's default
 * id-reuse policy allows, and the snapshot's staging objects are still
 * there (`markInstructionSnapshotFailed` deliberately leaves them), so the
 * new run's integrity/secret gate has the bytes it needs.
 */
// The baseline middleware proves project visibility. The snapshot-aware guard
// below then requires CREATE for direct versions, or READ plus proposer
// ownership for a pending proposal.
export const finalizeSnapshotProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.INSTRUCTION_READ))
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
		await assertInstructionSnapshotMutationAccess({
			projectId: input.projectId,
			userId: context.user.id,
			snapshot,
		});
		// A live run already owns this row, and nothing here can prove it is
		// dead. Report it and start nothing: see the note above on why a new
		// execution from an unchanged VALIDATING row is the unsafe case, and
		// why recovery goes through the reaper's FAILED marker instead.
		if (snapshot.status === "VALIDATING") {
			return { status: "VALIDATING" as const };
		}
		if (snapshot.status !== "RECEIVING" && snapshot.status !== "FAILED") {
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
					// The shared builder, not a template literal: the
					// scheduled reaper asks Temporal about this exact id
					// before it closes a stale RECEIVING row out, and a
					// drifted copy there would answer "nothing is running"
					// for every snapshot.
					workflowId: instructionSnapshotWorkflowId(snapshot.id),
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
		// allows the same workflow id again at that point). RECEIVING keeps
		// the existing tolerance: there `AlreadyStarted` means an earlier
		// attempt's start genuinely succeeded and only its status write was
		// lost, so the transition is the repair. VALIDATING never reaches
		// this line — it returned above.
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
