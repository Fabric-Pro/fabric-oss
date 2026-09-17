import { describe, expect, it } from "vitest";
import {
	exportKey,
	exportKeyPrefix,
	isStagingKey,
	snapshotKey,
	stagingKey,
} from "../src/storage-keys";

describe("storage keys", () => {
	it("builds staging and snapshot keys under the project prefix", () => {
		expect(stagingKey("p1", "s1", "f1")).toBe(
			"projects/p1/instructions/staging/s1/f1",
		);
		expect(snapshotKey("p1", "s1", "f1")).toBe(
			"projects/p1/instructions/snapshots/s1/f1",
		);
		expect(exportKey("p1", "s1", "123")).toBe(
			"projects/p1/instructions/exports/s1-123.zip",
		);
	});
	// R32: `exportKeyPrefix` is how delete and prune FIND a snapshot's export
	// zips, because nothing records which ones were built. Every export key
	// must therefore start with it, whatever stamp produced it — including
	// the wall-clock-stamped objects written before the stamp became the
	// digest.
	it("nests every export key under the snapshot's own listable prefix", () => {
		const prefix = exportKeyPrefix("p1", "s1");
		expect(prefix).toBe("projects/p1/instructions/exports/s1-");
		for (const stamp of ["123", "abcdef0123", "v7"]) {
			expect(exportKey("p1", "s1", stamp).startsWith(prefix)).toBe(true);
		}
		// And it must not collect a different snapshot's exports.
		expect(exportKey("p1", "s10", "123").startsWith(prefix)).toBe(false);
	});

	it("recognises staging keys", () => {
		expect(isStagingKey(stagingKey("p", "s", "f"))).toBe(true);
		expect(isStagingKey(snapshotKey("p", "s", "f"))).toBe(false);
	});
});
