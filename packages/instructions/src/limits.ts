export const SNAPSHOT_LIMITS = {
	maxFiles: 5000,
	// ProjectInstructionSnapshot.storedBytes is a signed PostgreSQL integer.
	maxTotalBytes: 2_147_483_647,
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

const MOST_DECIMALS = 3;

const UNIT_BYTES = { B: 1, KB: 1024, MB: 1024 * 1024 } as const;

function unitOf(written: string): keyof typeof UNIT_BYTES {
	return written.endsWith(" MB")
		? "MB"
		: written.endsWith(" KB")
			? "KB"
			: "B";
}

/** The bytes a `formatByteSize` string reads as. */
function writtenBytes(written: string): number {
	return Number.parseFloat(written) * UNIT_BYTES[unitOf(written)];
}

/**
 * A byte count that is OVER `limit`, written so it visibly is: in the limit's
 * unit, with as many decimals as it takes for the figure to read greater than
 * the limit's own. `formatByteSize` rounds both, so a file a kilobyte over
 * five megabytes read "5 MB" against "at most 5 MB". When three decimals still
 * do not separate them, the exact count is the honest figure.
 *
 * A value that is not over the limit is written as `formatByteSize` writes it.
 */
export function formatByteSizeOver(actual: number, limit: number): string {
	if (actual <= limit) {
		return formatByteSize(actual);
	}
	const written = formatByteSize(limit);
	const plain = formatByteSize(actual);
	if (writtenBytes(plain) > writtenBytes(written)) {
		return plain;
	}
	const unit = unitOf(written);
	const size = UNIT_BYTES[unit];
	const writtenLimit = Number.parseFloat(written);
	for (let decimals = 0; decimals <= MOST_DECIMALS; decimals++) {
		const figure = (actual / size).toFixed(decimals);
		if (Number.parseFloat(figure) > writtenLimit) {
			return `${figure} ${unit}`;
		}
	}
	return `${actual.toLocaleString("en-US")} bytes`;
}
