/**
 * Zombie Sweep Workflow for Project Document Embeddings
 *
 * Periodic background workflow that finds and deletes stale Qdrant chunks
 * left behind by superseded embed runs. When two embed runs race on the
 * same document (e.g. rapid save → TERMINATE_EXISTING on the workflow
 * level but the old activity's in-flight upserts complete after the new
 * run's), the old run's points use a lower `documentVersion` than the
 * document's current version. This workflow reaps them.
 *
 * Paginates through all embedded documents in batches and calls the
 * sweep activity which runs a Qdrant filter-based delete scoped to
 * `originalContextId = doc-${id} AND documentVersion < currentVersion`.
 *
 * Fire-and-forget from a Temporal schedule — see packages/temporal/src/
 * schedules.ts for the cron registration.
 */

import { log, proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities";

const { sweepStaleDocumentEmbeddingsActivity } = proxyActivities<
	typeof activities
>({
	startToCloseTimeout: "10 minutes",
	// The activity's first step is a Postgres query (listEmbeddedDocumentsForSweep)
	// that runs BEFORE its per-document heartbeat loop begins. A transient DB
	// connection/auth blip ("DriverAdapterError: Authentication timed out", same
	// shape as #1750) makes that initial query take ~45s+, which false-tripped the
	// old 30s heartbeat timeout as a generic "Activity task timed out" before the
	// real error could surface — and burned every retry the same way. 2 minutes
	// lets the underlying error surface and retry cleanly while still catching a
	// genuinely wedged sweep (the loop heartbeats every document, well inside this
	// window under normal operation).
	heartbeatTimeout: "2 minutes",
	retry: {
		initialInterval: "5s",
		backoffCoefficient: 2,
		maximumAttempts: 3,
		maximumInterval: "1 minute",
	},
});

export interface DocumentEmbeddingSweepWorkflowInput {
	/** Maximum number of documents to scan in a single activity batch */
	batchSize?: number;
	/**
	 * Hard ceiling on total batches per workflow run to bound worst-case
	 * runtime. A workflow that hits this ceiling just returns and lets the
	 * next scheduled invocation pick up where it left off.
	 */
	maxBatches?: number;
}

export interface DocumentEmbeddingSweepWorkflowOutput {
	scanned: number;
	sweptDocuments: number;
	batchesCompleted: number;
	reachedEnd: boolean;
}

/**
 * Workflow: Sweep stale document embeddings from Qdrant
 */
export async function projectDocumentEmbeddingSweepWorkflow(
	input: DocumentEmbeddingSweepWorkflowInput = {},
): Promise<DocumentEmbeddingSweepWorkflowOutput> {
	const batchSize = input.batchSize ?? 100;
	const maxBatches = input.maxBatches ?? 50;

	log.info("Starting document embedding sweep", { batchSize, maxBatches });

	let scanned = 0;
	let sweptDocuments = 0;
	let batchesCompleted = 0;
	let cursor: string | undefined;

	for (let i = 0; i < maxBatches; i += 1) {
		const result = await sweepStaleDocumentEmbeddingsActivity({
			batchSize,
			cursor,
		});
		scanned += result.scanned;
		sweptDocuments += result.sweptDocuments;
		batchesCompleted += 1;

		if (!result.nextCursor) {
			log.info("Document embedding sweep reached end of list", {
				scanned,
				sweptDocuments,
				batchesCompleted,
			});
			return {
				scanned,
				sweptDocuments,
				batchesCompleted,
				reachedEnd: true,
			};
		}

		cursor = result.nextCursor;
	}

	log.info("Document embedding sweep hit max batches ceiling", {
		scanned,
		sweptDocuments,
		batchesCompleted,
		maxBatches,
	});

	return {
		scanned,
		sweptDocuments,
		batchesCompleted,
		reachedEnd: false,
	};
}
