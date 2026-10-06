import { describe, expect, it } from "vitest";
import { formatByteSize, formatByteSizeOver, SNAPSHOT_LIMITS } from "../src";

const MIB = 1024 * 1024;

describe("formatByteSizeOver", () => {
	it("writes a file a kilobyte over the limit as more than the limit, not as the limit", () => {
		const actual = SNAPSHOT_LIMITS.maxFileBytes + 1024;

		expect(formatByteSize(actual)).toBe("5 MB");
		expect(formatByteSizeOver(actual, SNAPSHOT_LIMITS.maxFileBytes)).toBe(
			"5.001 MB",
		);
	});

	it("writes the exact count when three decimals still read as the limit", () => {
		const actual = SNAPSHOT_LIMITS.maxTotalBytes + 1;

		expect(formatByteSizeOver(actual, SNAPSHOT_LIMITS.maxTotalBytes)).toBe(
			"2,147,483,648 bytes",
		);
	});

	it("leaves a value that already reads as over the limit as formatByteSize writes it", () => {
		const actual = Math.round(7.3 * MIB);

		expect(formatByteSizeOver(actual, SNAPSHOT_LIMITS.maxFileBytes)).toBe(
			formatByteSize(actual),
		);
		expect(formatByteSizeOver(actual, SNAPSHOT_LIMITS.maxFileBytes)).toBe(
			"7.3 MB",
		);
	});

	it("writes a value that is not over the limit as formatByteSize writes it", () => {
		expect(formatByteSizeOver(2 * MIB, SNAPSHOT_LIMITS.maxFileBytes)).toBe(
			"2 MB",
		);
		expect(
			formatByteSizeOver(
				SNAPSHOT_LIMITS.maxFileBytes,
				SNAPSHOT_LIMITS.maxFileBytes,
			),
		).toBe("5 MB");
	});

	it("keeps the kilobyte unit for a limit written in kilobytes", () => {
		expect(formatByteSizeOver(256 * 1024 + 100, 256 * 1024)).toBe(
			"256.1 KB",
		);
	});

	it("writes a byte-sized limit in bytes", () => {
		expect(formatByteSizeOver(501, 500)).toBe("501 B");
	});
});
