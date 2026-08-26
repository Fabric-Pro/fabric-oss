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
