/**
 * Staleness threshold (3 minutes) after which an in-flight document generation
 * is considered stalled and eligible for retry.
 */
const DOCUMENT_GENERATION_STALE_THRESHOLD_MS = 3 * 60 * 1000;

/**
 * The clock a generation run is judged by — which is not the same column for
 * every status.
 *
 * `generationStartedAt` is stamped when the request is ACCEPTED, not when the
 * model call begins: it is the attempt's identity, and the server's guarded
 * writes compare against it, so nothing may refresh it mid-run. That makes it
 * the right clock for a QUEUED document — how long this request has been
 * waiting is exactly what it measures — and the wrong one for a GENERATING
 * document. A run that waited fifty minutes on the project's context work and
 * has only just begun writing is already an hour "old" by that column, so every
 * threshold built to spot a run that died fires on a run that is mid-sentence:
 * polling stops and a "Retry" appears over live output.
 *
 * What those thresholds actually ask is "has anything happened lately", and
 * `updatedAt` — the last server write — answers precisely that: a live run
 * keeps bumping it as progress lands, a dead one stops. So anything that is not
 * QUEUED measures from the last write, falling back to the accepted-at stamp
 * only when there is no write to read.
 */
export function resolveGenerationClock(
	status?: string | null,
	generationStartedAt?: Date | string | null,
	updatedAt?: Date | string | null,
): number {
	const [primary, fallback] =
		status === "QUEUED"
			? [generationStartedAt, updatedAt]
			: [updatedAt, generationStartedAt];
	if (primary) {
		return new Date(primary).getTime();
	}
	if (fallback) {
		return new Date(fallback).getTime();
	}
	return Date.now();
}

/**
 * Checks whether an in-flight generation has exceeded the staleness threshold (3 minutes).
 *
 * The status comes first because it can settle the question on its own: a QUEUED
 * document is deliberately waiting on the project's context-building work before
 * its model call may start, and that wait can legitimately last an hour. Judging
 * it by elapsed time would put a "Retry" button in front of a run that is
 * working exactly as designed — and taking that offer restarts the wait.
 */
export function isDocumentGenerationStale(
	status?: string | null,
	generationStartedAt?: Date | string | null,
	updatedAt?: Date | string | null,
	now: number = Date.now(),
): boolean {
	if (status === "QUEUED") {
		return false;
	}
	const lastSignOfLife = resolveGenerationClock(
		status,
		generationStartedAt,
		updatedAt,
	);
	return now - lastSignOfLife > DOCUMENT_GENERATION_STALE_THRESHOLD_MS;
}
