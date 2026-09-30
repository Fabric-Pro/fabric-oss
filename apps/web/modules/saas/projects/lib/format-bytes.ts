/** A byte count as B, KB (whole) or MB (one decimal). */
export function formatBytes(n: number): string {
	if (n < 1024) {
		return `${n} B`;
	}
	if (n < 1024 * 1024) {
		return `${Math.round(n / 1024)} KB`;
	}
	return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
