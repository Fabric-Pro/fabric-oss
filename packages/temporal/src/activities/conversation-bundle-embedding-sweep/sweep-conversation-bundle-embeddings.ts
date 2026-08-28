/**
 * Finish the conversation bundles whose embedding never completed
 * (Fizzy #2228, U11).
 *
 * # Why this exists at all
 *
 * U5 made a failed embed non-fatal: the channel-monitor activity catches it,
 * records "Not searchable" on the parent and RETURNS SUCCESSFULLY. That is the
 * right call — the conversation text is already durable by then, and failing
 * the activity would make Temporal re-run an analyzer whose claims are gone.
 * But it also means Temporal has no reason to retry anything, so nothing in
 * production ever comes back for that row. The same is true of the worse case:
 * a worker that dies between taking the embedding lease and the vector write
 * leaves `embeddedAt` null with no failure record anywhere and no activity
 * left running to notice.
 *
 * Without this pass the lease model describes a state nobody transitions out
 * of. `embeddingLeaseAt` exists precisely so a crashed embed stays reclaimable;
 * this is the thing that reclaims it.
 *
 * # It reuses the live embedder rather than repeating it
 *
 * `embedConversationBundle` is exported from `capture-conversation-bundle.ts`
 * for this caller. Reimplementing the sequence here would mean reimplementing
 * BOTH halves of the unlink guard — the pre-write check and the compensating
 * delete after a point lands in the window the unlink's filter has already
 * swept past — and those are exactly the parts that would drift into two
 * slightly different behaviours. The claim inside it is also what makes this
 * sweep safe next to a live embedder: the listing below only nominates rows,
 * and the compare-and-set decides.
 *
 * # It also drains the stranded-vector queue
 *
 * The other thing nothing in production comes back for: an unlink whose vector
 * delete failed. It deletes the context and bundle ROWS before the vectors —
 * deliberately, because row absence is what a concurrent embedder reads — so a
 * Qdrant failure leaves points behind with no row to find them from. The ids
 * are written to `ProjectContextPendingVectorCleanup` in the same transaction
 * as that delete, and a retried unlink drains them; this pass is what finishes
 * the job when the user never retries. Same bounded-batch discipline as the
 * embedding half, same never-throw-for-one-bad-row rule, same "tenant off the
 * row" rule — the record's own `organizationId` decides which collection the
 * delete is aimed at.
 *
 * # One tenant per row, not one per run
 *
 * The collection a point lands in is derived from `organizationId`, so the
 * tenant is read off each ROW rather than taken from an ambient value: an
 * organization's bundle goes to that organization's collection and a personal
 * one to the shared collection. Getting this wrong does not fail loudly — it
 * writes a point into a collection no unlink of that channel will ever search.
 */

import {
	CONVERSATION_BUNDLE_EMBEDDING_SWEEP_BATCH,
	listConversationBundlesAwaitingEmbedding,
	listPendingVectorCleanups,
	PENDING_VECTOR_CLEANUP_SWEEP_BATCH,
	recordPendingVectorCleanupFailure,
} from "@repo/database";
import { logger } from "@repo/logs";
import {
	type EmbedBundleOutcome,
	embedConversationBundle,
} from "../../lib/capture-conversation-bundle";
import { drainPendingVectorCleanup } from "../../lib/delete-channel-context";
import { safeHeartbeat } from "../lib/activity-liveness";

export interface SweepConversationBundleEmbeddingsInput {
	/**
	 * Rows to attempt in this run. Bounded on purpose — see
	 * `CONVERSATION_BUNDLE_EMBEDDING_SWEEP_BATCH`.
	 */
	batchSize?: number;
	/**
	 * Staleness window for "somebody else is working on this". Passed to BOTH
	 * the listing and the claim so the two cannot disagree about which leases
	 * are live; overridable only so tests can compress it.
	 */
	leaseMs?: number;
	/**
	 * Stranded vector-cleanup records to attempt in this run. Bounded
	 * separately from `batchSize` because the two queues are unrelated: a
	 * backlog of un-embedded bundles says nothing about how many unlinks failed
	 * at the vector store.
	 */
	cleanupBatchSize?: number;
}

export interface SweepConversationBundleEmbeddingsOutput {
	/** Rows nominated by the listing. */
	scanned: number;
	embedded: number;
	/** Refused by the compare-and-set: a live lease, or already embedded. */
	notClaimed: number;
	/** The channel was unlinked — nothing to finish, and no point left behind. */
	abandoned: number;
	/**
	 * The channel was unlinked AND the compensating delete of the point this
	 * pass had just written did not go through. Counted apart from `abandoned`
	 * because it is not clean cleanup: a point may still hold that channel's
	 * conversation text. The per-row ERROR line carries the collection.
	 */
	abandonedOrphaned: number;
	/** The embed itself failed; the row stays in the queue for the next run. */
	failed: number;
	/** No tenant could be resolved, so the row was left untouched. */
	skipped: number;
	/**
	 * The batch came back full, so there is very likely more waiting. Reported
	 * rather than drained in a loop: a row that keeps failing releases its lease
	 * immediately, so an in-run loop would re-pick the same poisoned rows for
	 * every batch instead of making progress.
	 */
	batchFull: boolean;
	/** Stranded id lists nominated by the cleanup queue's listing. */
	cleanupsScanned: number;
	/** Id lists whose points the vector store confirmed gone, record dropped. */
	cleanupsDrained: number;
	/**
	 * The vector store refused. The record STAYS — its ids are the only
	 * remaining trace of points that may still hold conversation text — with
	 * its attempt count raised so it cannot starve the rest of the queue.
	 */
	cleanupsFailed: number;
	/** The cleanup batch came back full, so more is very likely waiting. */
	cleanupBatchFull: boolean;
}

/**
 * One bounded pass over the never-embedded backlog, and one over the stranded
 * vector-cleanup queue.
 *
 * Never throws for a single bad row, on either queue. One project whose provider
 * is misconfigured must not be able to stop every other project's bundles from
 * being recovered, and `embedConversationBundle` already swallows its own
 * failures — the guard here is for the unexpected shape it does not cover. The
 * cleanup half is the same bargain: a record the vector store refuses is counted
 * and left standing, never dropped, so nothing that may still hold conversation
 * text loses its last reference.
 */
export async function sweepConversationBundleEmbeddingsActivity(
	input: SweepConversationBundleEmbeddingsInput = {},
): Promise<SweepConversationBundleEmbeddingsOutput> {
	const batchSize =
		input.batchSize ?? CONVERSATION_BUNDLE_EMBEDDING_SWEEP_BATCH;

	const pending = await listConversationBundlesAwaitingEmbedding({
		limit: batchSize,
		leaseMs: input.leaseMs,
	});

	const tally: Record<EmbedBundleOutcome, number> = {
		embedded: 0,
		"not-claimed": 0,
		abandoned: 0,
		"abandoned-orphaned": 0,
		failed: 0,
	};
	let skipped = 0;

	for (const bundle of pending) {
		safeHeartbeat({ stage: "embedding", bundleId: bundle.id });

		if (!bundle.userId) {
			// Unreachable through any writer: capture requires a userId and the
			// parent context row always carries one. Counted rather than thrown
			// so a row that somehow lacks both is visible in the tally instead
			// of taking the whole batch down.
			skipped += 1;
			logger.warn(
				"[ConversationBundleSweep] Bundle has no tenant to embed under",
				{
					bundleId: bundle.id,
					parentContextId: bundle.parentContextId,
				},
			);
			continue;
		}

		try {
			const outcome = await embedConversationBundle({
				bundleId: bundle.id,
				parentContextId: bundle.parentContextId,
				projectId: bundle.projectId,
				userId: bundle.userId,
				// Per row, so an organization's bundle lands in its own
				// collection and a personal one in the shared collection.
				organizationId: bundle.organizationId ?? undefined,
				content: bundle.content,
				sourceTitle: bundle.sourceTitle ?? undefined,
				leaseMs: input.leaseMs,
			});
			tally[outcome] += 1;
		} catch (error) {
			tally.failed += 1;
			logger.error(
				"[ConversationBundleSweep] Unexpected failure recovering bundle",
				{
					bundleId: bundle.id,
					error:
						error instanceof Error ? error.message : String(error),
				},
			);
		}
	}

	// The second queue: ids whose rows are already gone and whose vectors an
	// unlink could not delete. Drained AFTER the embedding half so a vector
	// store that is refusing everything does not spend the run's whole
	// heartbeat budget failing cleanups before a single bundle is attempted.
	const cleanupBatchSize =
		input.cleanupBatchSize ?? PENDING_VECTOR_CLEANUP_SWEEP_BATCH;
	const strandedCleanups = await listPendingVectorCleanups({
		limit: cleanupBatchSize,
	});
	let cleanupsDrained = 0;
	let cleanupsFailed = 0;

	for (const record of strandedCleanups) {
		safeHeartbeat({ stage: "vector-cleanup", cleanupId: record.id });
		try {
			await drainPendingVectorCleanup(record);
			cleanupsDrained += 1;
		} catch (error) {
			cleanupsFailed += 1;
			const message =
				error instanceof Error ? error.message : String(error);
			// The record STAYS. Its ids are the only remaining trace of points
			// that may still hold conversation text, so it is never dropped on
			// a failure — only counted up, which is what keeps it from sitting
			// at the head of every future batch.
			await recordPendingVectorCleanupFailure({
				id: record.id,
				error: message,
			}).catch(() => {
				// A bookkeeping write that fails changes nothing about the
				// record's ids, which is the part that matters. Swallowed so
				// one unwritable row cannot take down a batch that is otherwise
				// making progress.
			});
			logger.error(
				"[ConversationBundleSweep] Failed to drain stranded vector cleanup",
				{
					cleanupId: record.id,
					projectId: record.projectId,
					contextCount: record.contextIds.length,
					error: message,
				},
			);
		}
	}

	const result: SweepConversationBundleEmbeddingsOutput = {
		scanned: pending.length,
		embedded: tally.embedded,
		notClaimed: tally["not-claimed"],
		abandoned: tally.abandoned,
		abandonedOrphaned: tally["abandoned-orphaned"],
		failed: tally.failed,
		skipped,
		batchFull: pending.length === batchSize,
		cleanupsScanned: strandedCleanups.length,
		cleanupsDrained,
		cleanupsFailed,
		cleanupBatchFull: strandedCleanups.length === cleanupBatchSize,
	};

	// Logged on every pass, including the empty one. A backlog that never
	// drains is only visible as a run that keeps reporting a full batch, and
	// that comparison needs the quiet runs to be on the record too.
	if (result.scanned > 0 || result.cleanupsScanned > 0) {
		logger.info(
			"[ConversationBundleSweep] Recovered conversation bundle embeddings",
			result,
		);
	} else {
		logger.debug(
			"[ConversationBundleSweep] No conversation bundles awaiting embedding",
		);
	}

	return result;
}
