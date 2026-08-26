/**
 * Stale-generation watchdog activities.
 *
 * The dispatch path marks a document GENERATING *before* it starts the
 * workflow. That ordering is deliberate and load-bearing — reversing it was
 * issue #720 — but it means a start that never took leaves the row GENERATING
 * with nothing left to write a terminal status, because the workflow that would
 * have written one does not exist.
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
 */
const DEFAULT_STALE_MINUTES = 30;

export interface StaleGeneratingDocument {
	documentId: string;
	projectId: string;
	organizationId: string | null;
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
		rows: stale
			.filter((row) => row.generationStartedAt !== null)
			.map<StaleGeneratingDocument>((row) => ({
				documentId: row.id,
				projectId: row.projectId,
				organizationId: row.project?.organizationId ?? null,
				workflowId: row.workflowId,
				// biome-ignore lint/style/noNonNullAssertion: filtered above
				generationStartedAtMs: row.generationStartedAt!.getTime(),
			})),
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
 * Flip the stuck document GENERATING -> FAILED, scoped to the attempt that was
 * scanned. The message is written for the person who opens the document, not
 * for an operator: it says the run did not start and that retrying is safe,
 * because from the reader's side an abandoned row and a failed one look alike.
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
