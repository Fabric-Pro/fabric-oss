/**
 * Starting a snapshot's validation workflow, shared by every caller that
 * finishes an upload.
 *
 * Extracted from `finalize-snapshot.ts` so the inline-content entry point
 * (`submit-change.ts`) finishes an upload the same way the browser does rather
 * than growing a second, subtly different copy of the ordering rules below.
 * The procedure keeps the lookup and the authorization; only the part that
 * knows how the workflow is started lives here.
 */
import { ORPCError } from "@orpc/client";
import {
	claimInstructionValidationAttempt,
	getInstructionSnapshot,
	type InstructionSnapshotStatus,
	startInstructionSnapshotValidation,
} from "@repo/database";
import { instructionSnapshotWorkflowId } from "@repo/instructions";
import { getTemporalClient } from "@repo/temporal";
import { withCorrelationMemo } from "../../../../lib/temporal-correlation";
import { instructionWorkflowNotStarted } from "./instruction-workflow-start";

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
 * Start `projectInstructionSnapshotWorkflow` for a snapshot and only THEN flip
 * it to VALIDATING.
 *
 * Ordering matters here (R15): `workflow.start` runs BEFORE the status
 * transition. Writing VALIDATING first and starting the workflow second would
 * strand the snapshot in VALIDATING forever if the start call failed after the
 * status write committed — every later finalize call short-circuits on
 * `status !== "RECEIVING"`, so nothing would ever retry the start. Starting
 * first means a failed start leaves the row in RECEIVING, which a retried
 * finalize call naturally repairs. The workflow id is deterministic, so
 * RECEIVING (first attempt) and FAILED (the workflow ran and its
 * terminal-failure marker fired) both re-attempt the start; any other status
 * short-circuits and returns the snapshot's current status unchanged. The
 * transition itself is conditional (`startInstructionSnapshotValidation`), so a
 * workflow that finished while this was mid-flight keeps its terminal status
 * and the current status is returned instead of VALIDATING. A
 * `WorkflowExecutionAlreadyStartedError` from that re-attempt means an earlier
 * call's start actually succeeded (only the subsequent status write failed or
 * never ran), so it is treated as success rather than re-thrown — EXCEPT when
 * the pre-read status was FAILED, where it means either the previous
 * execution is still closing (no new run exists to move the row for) or a
 * second press of "Try again" landed on the run the first press started; that
 * case writes nothing and returns the row's status as read again. Any other start failure propagates unchanged and
 * leaves the snapshot exactly where it was (RECEIVING or FAILED), for the next
 * finalize call to retry.
 *
 * VALIDATING is NOT one of them (round 8, finding 1). A VALIDATING row is
 * owned by a live run, and this has no way to tell a live one from a dead one
 * — so it reports the status and starts nothing. Starting a new execution from
 * an UNCHANGED VALIDATING row was the unsafe case: the row looked exactly like
 * the stale one the reaper's watchdog phase was about to fail, because nothing
 * about it had moved, and the watchdog would then have written FAILED over a
 * live run. If the previous run really is dead, that watchdog marks the row
 * FAILED within about a sweep cycle, and the tab's "Try again" restarts it FROM
 * FAILED — the only path that puts a fresh generation on the row, and the one
 * the watchdog's compare-and-set can see. A retried finalize whose response was
 * merely lost gets the same VALIDATING answer it would have got before, without
 * a redundant start.
 *
 * FAILED is accepted because it is this feature's "Try again" — the tab renders
 * that button for a FAILED snapshot and it calls this path. Reusing the
 * workflow id after a CLOSED run is what Temporal's default id-reuse policy
 * allows, and the snapshot's staging objects are still there
 * (`markInstructionSnapshotFailed` deliberately leaves them), so the new run's
 * integrity/secret gate has the bytes it needs.
 *
 * Before the start, the row is given the ownership token the run carries
 * (`claimInstructionValidationAttempt`), passed to the workflow as
 * `validationAttemptId`. Every write the run makes names it, so a stale
 * attempt of an earlier run matches nothing, and the run's own claim can move
 * a FAILED row it owns to VALIDATING when this handler's status write below
 * was lost.
 *
 * `snapshot.publishBeforeScan` (Fizzy #2737) is read off the row the caller
 * loaded and handed to the workflow, which takes its publish-first path only
 * for an explicit `true`. It is added to the arguments only when set, so every
 * other start is byte-for-byte what it was.
 */
export async function finalizeInstructionSnapshot(input: {
	snapshot: {
		id: string;
		status: InstructionSnapshotStatus;
		publishBeforeScan?: boolean;
	};
	projectId: string;
	organizationId: string;
	userId: string;
}): Promise<{ status: InstructionSnapshotStatus }> {
	const { snapshot, projectId, organizationId, userId } = input;

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

	// Wrapped so a caller that has just created a snapshot row can tell "no
	// workflow exists" from "a workflow may exist" — see
	// `instruction-workflow-start.ts`. Only the work BEFORE the start is
	// wrapped (the token claim and client acquisition): everything below
	// either IS the start or follows it, and a start that was called is
	// ambiguous by construction.
	//
	// The token is written to the row BEFORE the run starts, so every write
	// the run makes can name it and a stale attempt of an earlier run cannot
	// touch the row (see `claimInstructionValidationAttempt`).
	let validationAttemptId: string | null;
	let temporalClient: Awaited<ReturnType<typeof getTemporalClient>>;
	try {
		validationAttemptId = await claimInstructionValidationAttempt({
			snapshotId: snapshot.id,
			projectId,
			organizationId,
		});
		temporalClient = await getTemporalClient();
	} catch (error) {
		throw instructionWorkflowNotStarted(error);
	}
	if (validationAttemptId === null) {
		// The row left RECEIVING/FAILED since the caller read it: a run
		// already owns it or has reached a verdict. Report what is there.
		return {
			status: await currentStatus(snapshot.id, projectId, organizationId),
		};
	}
	let alreadyStarted = false;
	try {
		await temporalClient.workflow.start(
			"projectInstructionSnapshotWorkflow",
			withCorrelationMemo({
				// Its own queue, not "project-documents": these activities
				// are long and I/O-bound (the gate hashes and scans up
				// to 50 MB, and promotion re-hashes and re-writes what was
				// uploaded and copies the rest inside storage), so
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
						projectId,
						organizationId,
						userId,
						validationAttemptId,
						...(snapshot.publishBeforeScan === true
							? { publishBeforeScan: true }
							: {}),
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

	// A FAILED row plus `AlreadyStarted` has two possible meanings, and the
	// row, read again, tells them apart.
	//
	// `markInstructionSnapshotFailed` writes FAILED from inside the
	// workflow's boundary catch, which then RETHROWS; the execution stays
	// open until Temporal processes that final workflow task. A user who
	// presses "Try again" inside that window gets `AlreadyStarted` from the
	// old, still-closing run — not from a new one. Transitioning on that
	// would move FAILED to VALIDATING with no execution behind it, and the
	// old run would close moments later having already written its verdict,
	// leaving the snapshot VALIDATING forever with the tab polling it. The
	// row is still FAILED then, so the status is reported and nothing moves.
	//
	// The other meaning is a second press of "Try again": the first press
	// started a fresh run, and this one read the row before the first
	// press's VALIDATING write landed. That run is live, and the row, read
	// again, is no longer FAILED, so what is actually there is the answer.
	//
	// RECEIVING keeps the existing tolerance: there `AlreadyStarted` means an
	// earlier attempt's start genuinely succeeded and only its status write
	// was lost, so the transition is the repair. VALIDATING never reaches
	// this line — it returned above.
	if (alreadyStarted && snapshot.status === "FAILED") {
		return {
			status: await currentStatus(snapshot.id, projectId, organizationId),
		};
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
		projectId,
		organizationId,
		validationAttemptId,
	});
	if (started.changed) {
		return { status: "VALIDATING" as const };
	}
	// The conditional write matched nothing: either the workflow has
	// already produced a terminal status, or the row was already
	// VALIDATING. Report what is actually there rather than asserting.
	return {
		status: await currentStatus(snapshot.id, projectId, organizationId),
	};
}

async function currentStatus(
	snapshotId: string,
	projectId: string,
	organizationId: string,
): Promise<InstructionSnapshotStatus> {
	const current = await getInstructionSnapshot(
		snapshotId,
		projectId,
		organizationId,
	);
	if (!current) {
		throw new ORPCError("NOT_FOUND", { message: "Upload not found" });
	}
	return current.status;
}
