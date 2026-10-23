/** Starting limits for 60s analysis and 100s fetch calls, not measured throughput.
 * Tune from summaryCallLatenciesMs and the per-call summary latency events.
 */
export const MAX_ANALYSIS_MEETING_SUMMARY_TARGET_CHARS = 12_000;
export const MAX_FETCH_MEETING_SUMMARY_TARGET_CHARS = 24_000;
export const MIN_MEETING_SUMMARY_TARGET_CHARS = 1_024;
export const MEETING_SUMMARY_BUCKET_GROWTH = 1.25;

// Include the path limits as terminal buckets. Skip a near-terminal geometric
// step so the limits do not create tiny buckets with little cache reuse.
const buckets = [MIN_MEETING_SUMMARY_TARGET_CHARS];
for (const limit of [
	MAX_ANALYSIS_MEETING_SUMMARY_TARGET_CHARS,
	MAX_FETCH_MEETING_SUMMARY_TARGET_CHARS,
]) {
	while (buckets[buckets.length - 1] < limit) {
		const next = Math.ceil(
			buckets[buckets.length - 1] * MEETING_SUMMARY_BUCKET_GROWTH,
		);
		buckets.push(
			next * MEETING_SUMMARY_BUCKET_GROWTH >= limit ? limit : next,
		);
	}
}

/** Round a requested size up to a reusable bucket, bounded by the fetch maximum. */
export function bucketMeetingSummaryTargetChars(targetChars: number): number {
	return (
		buckets.find((bucket) => bucket >= targetChars) ??
		MAX_FETCH_MEETING_SUMMARY_TARGET_CHARS
	);
}

/** Largest reusable target within a hard room, source, path or provider limit. */
export function fittingMeetingSummaryTargetChars(maxChars: number): number {
	for (let index = buckets.length - 1; index >= 0; index--) {
		if (buckets[index] <= maxChars) {
			return buckets[index];
		}
	}
	return 0;
}
