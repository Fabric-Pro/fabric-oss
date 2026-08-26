/**
 * Format a duration in milliseconds into a compact string.
 */
export function formatDuration(durationMs: number): string {
	if (durationMs < 1000) {
		return `${durationMs}ms`;
	}

	if (durationMs < 60000) {
		return `${(durationMs / 1000).toFixed(1)}s`;
	}

	return `${(durationMs / 60000).toFixed(1)}m`;
}
