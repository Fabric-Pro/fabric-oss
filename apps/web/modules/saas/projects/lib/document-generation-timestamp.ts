/**
 * Staleness threshold (3 minutes) after which an in-flight document generation
 * is considered stalled and eligible for retry.
 */
const DOCUMENT_GENERATION_STALE_THRESHOLD_MS = 3 * 60 * 1000;

/**
 * Resolves the effective generation start timestamp for a document.
 * Prefers generationStartedAt, falls back to updatedAt, and defaults to Date.now().
 */
export function resolveGenerationTimestamp(
	generationStartedAt?: Date | string | null,
	updatedAt?: Date | string | null,
): number {
	if (generationStartedAt) {
		return new Date(generationStartedAt).getTime();
	}
	if (updatedAt) {
		return new Date(updatedAt).getTime();
	}
	return Date.now();
}

/**
 * Checks whether an in-flight generation has exceeded the staleness threshold (3 minutes).
 */
export function isDocumentGenerationStale(
	generationStartedAt?: Date | string | null,
	updatedAt?: Date | string | null,
	now: number = Date.now(),
): boolean {
	const startedAt = resolveGenerationTimestamp(
		generationStartedAt,
		updatedAt,
	);
	return now - startedAt > DOCUMENT_GENERATION_STALE_THRESHOLD_MS;
}
