/**
 * Proposal artifact (Fizzy #2801) — the live sections of an in-flight
 * coordinated Proposal run.
 *
 * Live sections are OWNED BY A RUN TOKEN. Planning a run mints `liveRunId` and
 * resets the live columns; the generation activity claims its attempt on
 * entry, and records its workflow on the document with the claim; every later
 * live write is guarded on that run, on GENERATING, and on the attempt —
 * never on a shared status alone, which every regeneration passes through
 * (docs/solutions/architecture-patterns/a-terminal-status-guard-blocks-the-retry-that-starts-from-it.md).
 * `content` is never written here: the final save owns it.
 *
 * The run's `generationProgress` is written here only for the "preview
 * stopped" milestone, under the same guards, and taken back by the next
 * attempt's claim (Fizzy #2946). A request to generate the document again
 * while a run may be live takes this module's per-document dispatch lock.
 */

import {
	PROPOSAL_DRAFTING_PROGRESS,
	PROPOSAL_FINISHING_PROGRESS,
	PROPOSAL_PREVIEW_STOPPED_PROGRESS,
} from "@repo/utils/proposal-artifact/live-progress";
import { db, type Prisma, type ProjectDocumentStatus } from "../../client";
import { advisoryObjectKey } from "../lib/refresh-lock-key";
import { sanitizeContent } from "./documents";
import type { ProposalArtifactGuardedOutcome } from "./proposal-artifact-shared";

export interface LiveRunAttempt {
	documentId: string;
	/** The run token minted when the run was planned. */
	runId: string;
	/** The generation activity's attempt number. */
	attempt: number;
}

/**
 * This attempt still owns the run: no later attempt has claimed it. A null
 * `liveAttempt` is a run nobody has claimed yet.
 */
function attemptStillCurrent(
	attempt: number,
): Prisma.ProjectDocumentWhereInput {
	return { OR: [{ liveAttempt: null }, { liveAttempt: { lte: attempt } }] };
}

/**
 * Start a run's live sections: point the document at the new run and drop
 * whatever an earlier run left behind. Planning a run is what takes the live
 * columns over, so any older run's later writes become `superseded`.
 *
 * With `generationStartedAt`, the generation attempt's identity as the
 * dispatch stamped it, the takeover happens only while the document still
 * carries that identity: a late or retried plan of an attempt that a newer
 * request replaced is `superseded` and writes nothing (a document that no
 * longer exists answers the same), and so is the plan of an attempt whose
 * document is no longer queued or generating, such as one a person's save
 * over the stalled run ended. Without it, for runs started with no
 * attempt identity, the takeover is unconditional, as it always was, and
 * throws when the document no longer exists.
 */
export async function resetLiveSections(input: {
	documentId: string;
	runId: string;
	generationStartedAt?: Date;
}): Promise<ProposalArtifactGuardedOutcome> {
	const data = {
		liveRunId: input.runId,
		liveContent: null,
		liveAttempt: null,
	};
	if (!input.generationStartedAt) {
		await db.projectDocument.update({
			where: { id: input.documentId },
			data,
		});
		return "written";
	}
	const { count } = await db.projectDocument.updateMany({
		where: {
			id: input.documentId,
			generationStartedAt: input.generationStartedAt,
			// A run that stalled before its plan, and whose document a person
			// has since saved over (which ends the run), must not take the
			// finished document back when it wakes.
			status: { in: ["QUEUED", "GENERATING"] },
		},
		data,
	});
	return count > 0 ? "written" : "superseded";
}

/**
 * Claim the run for this generation attempt, on entry to the activity. A
 * later attempt's claim makes every write of an earlier one `superseded`, so
 * an attempt Temporal has given up on cannot keep writing while its
 * replacement streams. `superseded` means another run owns the document or a
 * later attempt already claimed this one.
 *
 * A claim that finds the "preview stopped" milestone an earlier attempt left
 * (see {@link markLivePreviewStopped}) puts the progress the workflow wrote
 * before the activity back: this attempt streams a preview of its own.
 *
 * With `workflowId`, the workflow the activity runs in, the same guarded
 * write records it as the document's workflow (Fizzy #2946). A run that a
 * wizard, a batch or a project setup starts never passes through the dispatch
 * that writes it, so without this a request to generate again would ask
 * Temporal about an earlier, finished workflow and start a run over the live
 * one. It
 * is the generation child's id, the workflow that holds the document while
 * it is GENERATING. A retried attempt writes the same id; a `superseded`
 * claim writes nothing, so a newer dispatch's id is never replaced.
 */
export async function claimLiveAttempt(
	input: LiveRunAttempt & { now?: Date; workflowId?: string },
): Promise<ProposalArtifactGuardedOutcome> {
	const { count } = await db.projectDocument.updateMany({
		where: {
			id: input.documentId,
			liveRunId: input.runId,
			...attemptStillCurrent(input.attempt),
		},
		data: {
			liveAttempt: input.attempt,
			...(input.workflowId ? { workflowId: input.workflowId } : {}),
		},
	});
	if (count === 0) {
		return "superseded";
	}
	await db.projectDocument.updateMany({
		where: {
			id: input.documentId,
			liveRunId: input.runId,
			liveAttempt: input.attempt,
			status: "GENERATING",
			generationProgress: PROPOSAL_PREVIEW_STOPPED_PROGRESS,
		},
		data: {
			generationProgress: PROPOSAL_DRAFTING_PROGRESS,
			updatedAt: input.now ?? new Date(),
		},
	});
	return "written";
}

/**
 * Save the completed sections streamed so far. Written only while the run
 * owns the document, the document is still GENERATING, and no later attempt
 * has claimed the run. `updatedAt` is set explicitly so readers polling on it
 * see every new section. `superseded` means this attempt must stop writing
 * live sections; it does not mean the generation failed.
 */
export async function writeLiveSections(
	input: LiveRunAttempt & { content: string; now?: Date },
): Promise<ProposalArtifactGuardedOutcome> {
	const { count } = await db.projectDocument.updateMany({
		where: {
			id: input.documentId,
			liveRunId: input.runId,
			status: "GENERATING",
			...attemptStillCurrent(input.attempt),
		},
		data: {
			liveContent: sanitizeContent(input.content),
			updatedAt: input.now ?? new Date(),
		},
	});
	return count > 0 ? "written" : "superseded";
}

/**
 * Say the run's live preview stopped while the run carries on without it
 * (Fizzy #2946): the generation activity's agent stream was cut or failed, or
 * ended without a document, and the gateway fallback writes the Main with no
 * preview. The sections written so far stay; the progress takes the fixed
 * {@link PROPOSAL_PREVIEW_STOPPED_PROGRESS} milestone, so the page keeps them
 * and says the result may differ instead of showing the previous body.
 *
 * Written only while the run owns the document, the document is GENERATING,
 * no later attempt has claimed the run, and the progress is still below
 * {@link PROPOSAL_FINISHING_PROGRESS}: a write that lands late, after the
 * workflow reported the stream's end, never moves the bar back. The fallback
 * writes it again about once a minute as a sign of life; `updatedAt` is set
 * explicitly so the page's stall check sees every write. `superseded` means
 * nothing was written.
 */
export async function markLivePreviewStopped(
	input: LiveRunAttempt & { now?: Date },
): Promise<ProposalArtifactGuardedOutcome> {
	const { count } = await db.projectDocument.updateMany({
		where: {
			id: input.documentId,
			liveRunId: input.runId,
			status: "GENERATING",
			generationProgress: { lt: PROPOSAL_FINISHING_PROGRESS },
			...attemptStillCurrent(input.attempt),
		},
		data: {
			generationProgress: PROPOSAL_PREVIEW_STOPPED_PROGRESS,
			updatedAt: input.now ?? new Date(),
		},
	});
	return count > 0 ? "written" : "superseded";
}

/**
 * Drop the live preview of a run, on failure: a preview that repeated a
 * settled decision's wording, or the run failed for good. (When the gateway
 * fallback takes over, the preview is kept and marked stopped instead; see
 * {@link markLivePreviewStopped}.) A run may clear its own preview in any
 * status, but never a newer run's. With `attempt` (an activity attempt
 * clearing its own preview), only while no later attempt has claimed the
 * run: an attempt Temporal gave up on, finishing late, must not erase the
 * preview its retry is writing. Without it (the workflow, once the run has
 * failed), the run alone. `superseded` means nothing was written.
 */
export async function clearLiveContent(input: {
	documentId: string;
	runId: string;
	attempt?: number;
	now?: Date;
}): Promise<ProposalArtifactGuardedOutcome> {
	const { count } = await db.projectDocument.updateMany({
		where: {
			id: input.documentId,
			liveRunId: input.runId,
			...(input.attempt !== undefined &&
				attemptStillCurrent(input.attempt)),
		},
		data: { liveContent: null, updatedAt: input.now ?? new Date() },
	});
	return count > 0 ? "written" : "superseded";
}

/**
 * Advisory-lock class for starting a client-document Proposal's generation.
 * Its own class, so a dispatch never queues behind another feature's lock
 * that happens to hash to the same object key.
 */
const LIVE_RUN_DISPATCH_ADVISORY_CLASS = 0x50724473; // "PrDs"

/**
 * How long one locked dispatch may take: the liveness question, the workflow
 * start, a describe() after a failed start, and the queue mark. The dispatch
 * bounds each Temporal call so the whole stays near 23 s, well inside this
 * budget; past it Prisma rolls back and releases the lock while the dispatch
 * is still running. A dispatch queued behind another waits up to
 * `LIVE_RUN_DISPATCH_MAX_WAIT_MS` to start its transaction.
 */
const LIVE_RUN_DISPATCH_TRANSACTION_TIMEOUT_MS = 30_000;
const LIVE_RUN_DISPATCH_MAX_WAIT_MS = 10_000;

/** What a dispatch decides on: the document's run state, read under the lock. */
export interface LiveRunDispatchState {
	status: ProjectDocumentStatus;
	/**
	 * The workflow that last took the document, if any: the one the last
	 * accepted request started, or, once a run's generation attempt claimed
	 * its live sections, that run's generation workflow.
	 */
	workflowId: string | null;
}

/**
 * Run `dispatch` holding a per-document advisory lock, serialized across
 * every process on this database, with the document's run state read under
 * it (`null` when the document no longer exists).
 *
 * A request to generate a client-document Proposal again while a run may be
 * live asks Temporal whether the stored workflow still runs, then starts and
 * marks the document QUEUED with the new workflow id (Fizzy #2946). Two
 * requests a second apart would both read the old state and both start; under
 * the lock the second reads the first's mark and joins its run instead.
 * `dispatch` may call Temporal and write the document through its own
 * queries: the lock is advisory, so those writes do not wait on it, and each
 * commits before the lock is released.
 *
 * Throws when the lock cannot be taken: it is the concurrency guard itself,
 * and a caller that went on without it would start exactly the duplicate run
 * it exists to refuse. `$executeRaw`, not `$queryRaw`:
 * `pg_advisory_xact_lock()` returns `void`, which the driver adapter's
 * `$queryRaw` cannot deserialize.
 */
export async function withLiveRunDispatchLock<T>(
	documentId: string,
	dispatch: (current: LiveRunDispatchState | null) => Promise<T>,
): Promise<T> {
	return db.$transaction(
		async (tx) => {
			await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LIVE_RUN_DISPATCH_ADVISORY_CLASS}::int, ${advisoryObjectKey(`liverun:${documentId}`)}::int)`;
			const current = await tx.projectDocument.findUnique({
				where: { id: documentId },
				select: { status: true, workflowId: true },
			});
			return dispatch(current);
		},
		{
			timeout: LIVE_RUN_DISPATCH_TRANSACTION_TIMEOUT_MS,
			maxWait: LIVE_RUN_DISPATCH_MAX_WAIT_MS,
		},
	);
}
