/**
 * Incremental-fetch cursor arithmetic, shared by every provider fetcher.
 *
 * Each fetcher remembers the highest run id it has ingested and asks the
 * provider only for runs above it. The subtle part is WHICH id is safe to
 * remember, because run ids are allocated when a run STARTS while results only
 * exist when it FINISHES — so ids do not finish in order.
 *
 * The bug this exists to prevent: run 100 (a long e2e job) starts, run 101 (a
 * fast unit job) starts after it and finishes first. Remembering 101 makes the
 * next fetch ask for `id > 101`, and run 100 — which finished in the meantime —
 * is never listed again. Its results are lost permanently, because the cursor
 * only moves forward. All three fetchers had this, and the GitLab one carried a
 * comment claiming to defend against exactly this case while advancing to the
 * highest FINISHED id, which is still above the in-flight run.
 *
 * The rule: ingest everything finished (results should appear as soon as they
 * exist), but only advance the cursor to just below the OLDEST run still in
 * flight. Runs already ingested above that barrier are re-listed on the next
 * fetch and skipped cheaply by `ingestPipelineRun`'s idempotency check, which
 * is the correct trade — re-reading a run is free, losing one is not.
 */

export interface CursorInput {
	/** The cursor this fetch started from; the result never goes below it. */
	since: number;
	/** Ids of terminal runs this fetch actually ingested. */
	ingestedIds: number[];
	/** Ids of runs seen in the listing that have NOT reached a terminal state. */
	inFlightIds: number[];
}

/**
 * The highest run id for which "everything at or below this is ingested" holds.
 * Returns `since` unchanged when nothing new was safely completed.
 */
export function advanceCursor(input: CursorInput): number {
	const { since, ingestedIds, inFlightIds } = input;

	const highestIngested = ingestedIds.reduce(
		(max, id) => (id > max ? id : max),
		since,
	);

	const oldestInFlight = inFlightIds
		.filter((id) => id > since)
		.reduce((min, id) => (id < min ? id : min), Number.POSITIVE_INFINITY);

	if (oldestInFlight === Number.POSITIVE_INFINITY) {
		return highestIngested;
	}

	// Hold the cursor immediately below the oldest run still running, so that
	// run is re-listed once it finishes. Never move backwards past `since`.
	return Math.max(since, Math.min(highestIngested, oldestInFlight - 1));
}
