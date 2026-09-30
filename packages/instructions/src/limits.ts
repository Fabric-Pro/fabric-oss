export const SNAPSHOT_LIMITS = {
	maxFiles: 5000,
	maxTotalBytes: 52_428_800,
	maxFileBytes: 5_242_880,
	maxPathBytes: 512,
	maxDepth: 32,
	maxInlineTextBytes: 262_144,
} as const;

/**
 * A byte count as B, KB (whole) or MB (one decimal, dropped when it is .0),
 * the way the limits above are written: "5 MB", "7.3 MB".
 */
export function formatByteSize(n: number): string {
	if (n < 1024) {
		return `${n} B`;
	}
	if (n < 1024 * 1024) {
		return `${Math.round(n / 1024)} KB`;
	}
	return `${(n / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")} MB`;
}
