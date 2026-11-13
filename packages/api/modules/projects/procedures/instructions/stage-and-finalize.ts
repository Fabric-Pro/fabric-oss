/**
 * Writing a snapshot's staged bytes from the server and starting its
 * validation workflow, for a caller that created the snapshot row in the same
 * request.
 *
 * Extracted from `submit-change.ts` when a second caller had to finish a
 * server-created snapshot the same way: the organization template copy
 * (`apply-template.ts`) stages bytes by copying them inside storage instead of
 * uploading them. Both stage into the exact keys the browser's presigned flow
 * would have used, so the same verify → scan → publish gate reads them, and
 * both close the row out the same way when no workflow took it over. Only how
 * one object is written differs, which is the `writeObject` callback.
 */
import { ORPCError } from "@orpc/client";
import {
	claimInstructionFileStagingKey,
	type InstructionSnapshotStatus,
	listInstructionFiles,
	rejectAbandonedInstructionSnapshot,
} from "@repo/database";
import { isStagingKey, stagingKey } from "@repo/instructions";
import { finalizeInstructionSnapshot } from "./finalize";
import {
	isInstructionWorkflowNotStarted,
	unwrapInstructionWorkflowError,
} from "./instruction-workflow-start";

/** A staged file row as `listInstructionFiles` returns it. */
type StagedInstructionFile = Awaited<
	ReturnType<typeof listInstructionFiles>
>[number];

/**
 * Stage every file in `stagedFileIds` through `writeObject`, then start the
 * validation workflow, closing the snapshot out when it fails before any
 * workflow owns it.
 *
 * Everything from `beforeStaging` to the VALIDATION workflow's start is
 * COMPENSATED on failure. The snapshot row exists already, RECEIVING (and for
 * a proposal PENDING, counting against both admission caps). The tab's flow can
 * leave such a row behind harmlessly: the browser owns the next step, the
 * person can retry or cancel, and the six-hour reaper is the backstop. A
 * server-side caller has no next step and no person at the keyboard — a
 * storage outage here would leave the row holding its slot for six hours.
 *
 * So a failure BEFORE the validation workflow's start is closed out here,
 * through the same conditional write the reaper uses: REJECTED, carrying the
 * "staging pending" mark so the reaper's second phase still sweeps whatever
 * bytes did land. The compare-and-set on `status: "RECEIVING"` is what makes it
 * safe, and the row is always one the CALLER created in this request. For a
 * repository proposal the same transaction moves its operation to CANCELED
 * (`rejectAbandonedInstructionSnapshot`), and a waiting pull-request workflow's
 * next readiness check reads the REJECTED, CANCELED row and stops.
 *
 * `finalizerWasEntered` is flipped immediately before the finalizer is called.
 * Everything up to that line is this request's own work — an audit row, a
 * staging claim, an object write — and none of it can have handed the
 * snapshot to the validation workflow, the only one that takes it over.
 * `isInstructionWorkflowNotStarted` covers the one failure INSIDE the finalizer
 * that is still on this side of the line.
 *
 * `concurrency` bounds how many objects are written at once. After a failure
 * no further file is started, and every write already started settles before
 * the row is closed out, so nothing lands after the compensation.
 */
export async function stageAndFinalizeInstructionSnapshot(input: {
	snapshotId: string;
	projectId: string;
	organizationId: string;
	userId: string;
	/** The rows this request created to be written; inherited rows are never among them. */
	stagedFileIds: readonly string[];
	/** Runs first, inside the compensated section: an audit row, a workflow that waits for READY. */
	beforeStaging?: () => Promise<void>;
	/** Writes one staged row's bytes to `key`, its real staging key. */
	writeObject: (row: StagedInstructionFile, key: string) => Promise<void>;
	concurrency: number;
	/** `metadata.source` on the close-out's audit row. */
	compensationSource: string;
}): Promise<{ status: InstructionSnapshotStatus }> {
	const { snapshotId, projectId, organizationId } = input;
	let finalizerWasEntered = false;
	try {
		await input.beforeStaging?.();

		// The same rewrite `createUploadUrls` performs before it signs: the
		// row's provisional `stagingKey(projectId, "pending", <index>)` becomes
		// the real `(projectId, snapshotId, fileId)` key, under a
		// compare-and-set that also checks the parent is still RECEIVING.
		// Doing it the same way is what keeps the bytes where the verify
		// activity looks for them.
		const staged = new Set(input.stagedFileIds);
		const rows = (
			await listInstructionFiles(snapshotId, organizationId)
		).filter((f) => staged.has(f.id));
		await runDrainingPool(rows, input.concurrency, async (row) => {
			const key = stagingKey(projectId, snapshotId, row.id);
			if (row.storageKey !== key) {
				// A key outside staging is an IMMUTABLE snapshot key that
				// promotion wrote, and nothing may point such a row back at
				// writable storage. Not reachable for a row this request just
				// created; checked because the invariant is what makes the
				// write below safe.
				if (!isStagingKey(row.storageKey)) {
					throw new ORPCError("CONFLICT", {
						message: "Upload not found or no longer receiving",
					});
				}
				const { moved } = await claimInstructionFileStagingKey({
					fileId: row.id,
					snapshotId,
					projectId,
					organizationId,
					from: row.storageKey,
					to: key,
				});
				if (!moved) {
					throw new ORPCError("CONFLICT", {
						message: "Upload not found or no longer receiving",
					});
				}
			}
			await input.writeObject(row, key);
		});
		finalizerWasEntered = true;
		// The finalizer is INSIDE the compensated section, and the boundary
		// is drawn inside it rather than around it.
		//
		// `finalizeInstructionSnapshot` reaches Temporal before it starts
		// anything, and reaching Temporal is the failure most likely to
		// happen at all — a misconfigured deployment, an unreachable
		// cluster. Nothing owns the row when that fails, so closing it out is
		// safe; leaving the finalizer wholly outside the section would strand
		// the row on exactly the common case.
		//
		// Once `workflow.start` has been CALLED, the outcome is ambiguous by
		// construction: a start can succeed and its acknowledgement be lost,
		// which is why the finalizer tolerates
		// `WorkflowExecutionAlreadyStartedError` at all. Rejecting the row
		// then would race a validation run that is already reading it, so
		// that half is left to the reaper's stale-VALIDATING sweep, which
		// asks Temporal about the workflow before deciding — the question
		// this code cannot answer.
		return await finalizeInstructionSnapshot({
			snapshot: { id: snapshotId, status: "RECEIVING" },
			projectId,
			organizationId,
			userId: input.userId,
		});
	} catch (error) {
		// Compensate unless the validation workflow's start was actually
		// reached: either this failed before the finalizer was entered at
		// all, or the finalizer says it never got as far as calling
		// `workflow.start`. An already-started pull-request or commit
		// workflow does not change this; it stops once the row it waits on is
		// closed out.
		if (!finalizerWasEntered || isInstructionWorkflowNotStarted(error)) {
			await releaseUnstartedSnapshot({
				snapshotId,
				projectId,
				organizationId,
				source: input.compensationSource,
			});
		}
		// The marker is transport for that verdict, not the failure itself:
		// the caller sees the error that actually happened.
		throw unwrapInstructionWorkflowError(error);
	}
}

/**
 * A bounded pool that stops claiming items after the first failure, waits for
 * every item already started, then rethrows that failure — so the caller's
 * compensation never races a write still in flight.
 */
async function runDrainingPool<T>(
	items: readonly T[],
	width: number,
	fn: (item: T) => Promise<void>,
): Promise<void> {
	const iterator = items[Symbol.iterator]();
	let firstError: { value: unknown } | undefined;
	const worker = async (): Promise<void> => {
		while (firstError === undefined) {
			const next = iterator.next();
			if (next.done) {
				return;
			}
			try {
				await fn(next.value);
			} catch (error) {
				firstError ??= { value: error };
			}
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(Math.max(width, 1), items.length) }, () =>
			worker(),
		),
	);
	if (firstError !== undefined) {
		throw firstError.value;
	}
}

/**
 * Close out a snapshot row that no validation workflow ever took ownership
 * of, through the same conditional write the reaper uses: REJECTED, carrying
 * the "staging pending" mark so the reaper's sweep phase still removes
 * whatever bytes did land.
 *
 * A repository proposal's pull-request workflow may already be running. It
 * does not own the row: it is waiting on readiness. The same transaction
 * cancels the proposal's operation, and that workflow's next readiness check
 * stops on the REJECTED, CANCELED row.
 *
 * What this buys is TIME, not an instant free slot. The row stays inside
 * `activeProposalFilter` until that sweep clears the marker, which is the
 * existing invariant and the thing that keeps a half-swept prefix
 * discoverable. Without this, the row would sit RECEIVING for the six-hour
 * abandonment window before the reaper would even consider it.
 *
 * Best effort, and deliberately unable to mask the real failure: the caller
 * must see WHY the request failed, not a secondary error from the cleanup. A
 * compensation that itself fails leaves exactly the row the reaper already
 * exists to close out.
 */
async function releaseUnstartedSnapshot(input: {
	snapshotId: string;
	projectId: string;
	organizationId: string;
	source: string;
}): Promise<void> {
	try {
		await rejectAbandonedInstructionSnapshot(input);
	} catch (error) {
		console.error(
			"[instructions] failed to close out an unstarted snapshot after a server-side staging error",
			error,
		);
	}
}
