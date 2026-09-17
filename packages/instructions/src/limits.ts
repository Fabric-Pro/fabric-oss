export const SNAPSHOT_LIMITS = {
	maxFiles: 5000,
	maxTotalBytes: 52_428_800,
	maxFileBytes: 5_242_880,
	maxPathBytes: 512,
	maxDepth: 32,
	maxInlineTextBytes: 262_144,
} as const;
