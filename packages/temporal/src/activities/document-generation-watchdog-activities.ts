/**
 * Stale-generation watchdog activities.
 *
 * A generation dispatch writes the document a non-terminal status and then
 * relies on the workflow to replace it. When the start never took, or the run
 * vanished, nothing is left to write a terminal one — the workflow that would
 * have is not there — and the row sits mid-generation forever.
 *
 * The status that is left behind depends on the path. The API's dispatch marks
 * the row QUEUED *after* its start attempt (see `dispatch-document-generation.ts`
 * for why that ordering, not the mark-before-start of issue #720), so a run it
 * loses track of is usually QUEUED; the workflow itself flips that to GENERATING
 * when its dependency wait clears. The separate upload-extraction flow still
 * marks GENERATING up front via `markDocumentGenerationStarted`, because the row
 * exists before there is any run to wait on. This sweep therefore has to cover
 * both states rather than assume either one.
 *
 * The dispatch helper already recovers every case it can prove. What it will not
 * do is guess: when `describe()` is itself unreachable, it cannot distinguish
 * "the start was lost" from "the start succeeded and the response was lost", and
 * marking FAILED on that ambiguity would let the user fire a second run racing a
 * live one over the same document. It therefore leaves the row alone, and the
 * editor's own timer shows a soft "taking longer than expected" notice.
 *
 * That notice is a client-side state, though: it is gone on the next page load,
 * and the row still reads as generating. This sweep is the server-side half —
 * the only thing that can tell the difference later, once Temporal is reachable
 * again and the answer is no longer ambiguous.
 *
 * The same sweep also covers QUEUED rows — a generation accepted but held back
 * until the project's context-building work finishes — because they leak the
 * same way and nothing else would ever close them. What does not carry over is
 * the age ceiling: a wait of an hour is the queue working, so a queued row is
 * judged purely on whether its workflow is still there.
 *
 * Activity boundary: every Prisma write and Temporal client call lives here, not
 * in the workflow, so the workflow stays replay-safe. Mirrors
 * `backlog-apply-watchdog-activities.ts`.
 */

import {
	findStaleGeneratingDocuments,
	markDocumentGenerationFailed,
} from "@repo/database/prisma/queries/projects/documents";
import type { Client } from "@temporalio/client";
import { getTemporalClient } from "../client";

/**
 * Default ceiling: a document dispatched more than this many minutes ago and
 * still GENERATING is considered stuck.
 *
 * Generous on purpose. A long document over a large retrieval corpus is a
 * multi-minute run, and this sweep writes a terminal FAILED that the user sees —
 * killing a live run is a worse outcome than a stale row lingering a while
 * longer. Override per-deployment via `FABRIC_DOCUMENT_GENERATION_STALE_MINUTES`.
 *
 * It applies to GENERATING rows only. A QUEUED row is waiting on the project's
 * own context-building work before its model call may start, and that wait can
 * legitimately run for an hour — no ceiling could separate a healthy wait from a
 * dead one, so the queued arm of the query does not use one. See
 * `findStaleGeneratingDocuments`.
 */
const DEFAULT_STALE_MINUTES = 30;

export interface StaleGeneratingDocument {
	documentId: string;
	projectId: string;
	organizationId: string | null;
	/**
	 * Which arm of the sweep produced this row: GENERATING rows are here because
	 * they are past the age ceiling, QUEUED rows because a wait has a workflow
	 * whose liveness can be checked. Both fail the same way.
	 */
	status: "QUEUED" | "GENERATING";
	workflowId: string | null;
	/**
	 * Passed back to `markDocumentGenerationFailed`, whose write is scoped to
	 * one attempt. A row re-dispatched between this scan and that write carries
	 * a newer timestamp and is skipped rather than clobbered.
	 */
	generationStartedAtMs: number;
}

export interface FindStaleGeneratingDocumentsInput {
	staleAfterMinutes: number;
	batchSize: number;
}

export interface FindStaleGeneratingDocumentsOutput {
	rows: StaleGeneratingDocument[];
}

/**
 * Find documents stuck mid-generation. Reads
 * `FABRIC_DOCUMENT_GENERATION_STALE_MINUTES` when `input.staleAfterMinutes` is
 * zero or negative, so the workflow body stays free of `process.env` reads,
 * which are non-deterministic under SDK 1.16 with `reuseV8Context`.
 *
 * The cutoff bounds the GENERATING arm only. Queued rows come back at any age
 * and are decided entirely by the liveness check downstream, which is what lets
 * an intentionally long dependency wait sit here untouched while an orphaned one
 * — a row whose workflow is gone — is still recovered.
 */
export async function findStaleGeneratingDocumentsActivity(
	input: FindStaleGeneratingDocumentsInput,
): Promise<FindStaleGeneratingDocumentsOutput> {
	const envCeiling = Number.parseInt(
		process.env.FABRIC_DOCUMENT_GENERATION_STALE_MINUTES ?? "",
		10,
	);
	const effectiveMinutes =
		input.staleAfterMinutes > 0
			? input.staleAfterMinutes
			: Number.isFinite(envCeiling) && envCeiling > 0
				? envCeiling
				: DEFAULT_STALE_MINUTES;
	const cutoff = new Date(Date.now() - effectiveMinutes * 60_000);

	const stale = await findStaleGeneratingDocuments({
		cutoff,
		limit: input.batchSize > 0 ? input.batchSize : 50,
	});

	return {
		rows: stale.flatMap<StaleGeneratingDocument>((row) => {
			// A row with no start timestamp cannot be swept at all: the write
			// that would fail it is scoped to that exact value. The status is
			// checked rather than asserted so a later widening of the query
			// cannot quietly relabel a third status as one of these two.
			if (
				row.generationStartedAt === null ||
				(row.status !== "QUEUED" && row.status !== "GENERATING")
			) {
				return [];
			}
			return [
				{
					documentId: row.id,
					projectId: row.projectId,
					organizationId: row.project?.organizationId ?? null,
					status: row.status,
					workflowId: row.workflowId,
					generationStartedAtMs: row.generationStartedAt.getTime(),
				},
			];
		}),
	};
}

export interface IsGenerationWorkflowLiveInput {
	workflowId: string;
}

/**
 * Whether the generation workflow is still running.
 *
 * The guard that makes this sweep safe. A row can be past the ceiling for an
 * ordinary reason — a genuinely slow run, a worker backlog — and failing one of
 * those would kill work the user is still waiting for, with the model spend
 * already incurred. So a row is only swept once Temporal confirms nothing is
 * running under its workflow id.
 *
 * For a QUEUED row it is the ONLY guard, since a wait has no age at which it
 * becomes suspicious. That is the whole recovery story for an orphaned queue
 * entry, and the whole protection for a healthy one.
 *
 * Errs toward live on every uncertainty: an unreachable Temporal, an unexpected
 * describe error, or a client that will not construct all answer "live", which
 * makes the caller skip the row and try again on the next tick. That is the same
 * bias the dispatch helper takes on its ambiguous branch, and for the same
 * reason — a stale row costs a confusing status, a wrongly-failed row costs
 * real work.
 */
export async function isGenerationWorkflowLiveActivity(
	input: IsGenerationWorkflowLiveInput,
): Promise<boolean> {
	let client: Client;
	try {
		client = await getTemporalClient();
	} catch {
		return true;
	}
	try {
		const description = await client.workflow
			.getHandle(input.workflowId)
			.describe();
		return description.status.name === "RUNNING";
	} catch (error) {
		// A workflow Temporal has never heard of is the case this sweep exists
		// for: the start never took. Anything else is an unknown, and unknown
		// means leave it alone.
		const name = error instanceof Error ? error.name : "";
		return name !== "WorkflowNotFoundError";
	}
}

export interface MarkGenerationTimedOutInput {
	documentId: string;
	generationStartedAtMs: number;
}

/**
 * Flip the stuck document (GENERATING or QUEUED) to FAILED, scoped to the
 * attempt that was scanned. The message is written for the person who opens the
 * document, not for an operator: it says the run did not start and that retrying
 * is safe, because from the reader's side an abandoned row and a failed one look
 * alike — and a queue entry whose workflow is gone is abandoned in exactly that
 * way, however recently it was written.
 */
export async function markGenerationTimedOutActivity(
	input: MarkGenerationTimedOutInput,
): Promise<void> {
	await markDocumentGenerationFailed(
		input.documentId,
		new Date(input.generationStartedAtMs),
		"Generation never started and was stopped automatically. You can run it again.",
	);
}
