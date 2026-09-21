/**
 * A poll fetch is "complete" when every linked card was observed this cycle —
 * either fetched (`seenExternalIds`) or confirmed absent (`notFoundIds`). A
 * transient failure, budget-skip, or discovery-timeout leaves a card
 * un-observed (`seen + notFound < totalLinked`), so the caller must NOT advance
 * the changed-date watermark (`lastAdoStatePollAt`) — otherwise a later fetch of
 * a skipped Done card would be dropped by the `changedDate <= anchor`
 * incremental filter (DEC-6).
 */
export function isFetchComplete(r: {
	seenExternalIds: string[];
	notFoundIds: string[];
	totalLinked: number;
}): boolean {
	return r.seenExternalIds.length + r.notFoundIds.length >= r.totalLinked;
}

/**
 * The suffix a per-item fetch path appends to an id's `failedIdErrors` entry
 * when it never tried to read that id: the poll budget ran out, capability
 * discovery timed out, or GitLab answered an earlier read with a rate limit.
 * Such an id sits in `failedIds` as a TRANSIENT failure (never `notFoundIds`),
 * but it was deferred, not failed — the status-sync run summary counts it as
 * "not fetched" (Fizzy #2304).
 */
export const NOT_ATTEMPTED_MARKER = "(not attempted)";

/** Whether a `failedIdErrors` entry records an id that was never read. */
export function isNotAttemptedError(error: string | undefined): boolean {
	return error?.endsWith(NOT_ATTEMPTED_MARKER) === true;
}
