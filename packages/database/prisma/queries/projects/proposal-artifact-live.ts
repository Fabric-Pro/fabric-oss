/**
 * Proposal artifact (Fizzy #2801) — the live sections of an in-flight
 * coordinated Proposal run.
 *
 * Live sections are OWNED BY A RUN TOKEN. Planning a run mints `liveRunId` and
 * resets the live columns; the generation activity claims its attempt on
 * entry; every later live write is guarded on that run, on GENERATING, and on
 * the attempt — never on a shared status alone, which every regeneration
 * passes through
 * (docs/solutions/architecture-patterns/a-terminal-status-guard-blocks-the-retry-that-starts-from-it.md).
 * `content` is never written here: the final save owns it.
 */

import { db, type Prisma } from "../../client";
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
 * longer exists answers the same). Without it, for runs started with no
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
 */
export async function claimLiveAttempt(
	input: LiveRunAttempt,
): Promise<ProposalArtifactGuardedOutcome> {
	const { count } = await db.projectDocument.updateMany({
		where: {
			id: input.documentId,
			liveRunId: input.runId,
			...attemptStillCurrent(input.attempt),
		},
		data: { liveAttempt: input.attempt },
	});
	return count > 0 ? "written" : "superseded";
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
 * Drop the live preview of a run, on failure or when the gateway fallback
 * takes over. A run may clear its own preview in any status, but never a
 * newer run's. With `attempt` (an activity attempt clearing on its own
 * fallback), only while no later attempt has claimed the run: an attempt
 * Temporal gave up on, finishing late, must not erase the preview its retry
 * is writing. Without it (the workflow, once the run has failed), the run
 * alone. `superseded` means nothing was written.
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
