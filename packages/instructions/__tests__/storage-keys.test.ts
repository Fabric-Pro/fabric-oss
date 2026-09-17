import { describe, expect, it } from "vitest";
import {
	exportKey,
	exportKeyPrefix,
	isKeyOwnedBySnapshot,
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

	/**
	 * Fizzy #2546. A derived snapshot's inherited rows carry the BASE's
	 * immutable promoted keys until its own promotion rewrites them, so every
	 * code path that deletes objects BY ROW KEY filters the set through this.
	 * Without it, cleaning up an edit that was rejected — or that aged out of
	 * retention before it finished — deletes the bytes of the version it was
	 * edited from, which is normally the published one.
	 */
	it("owns exactly its own staging, snapshot and export prefixes", () => {
		for (const key of [
			stagingKey("p1", "s1", "f1"),
			snapshotKey("p1", "s1", "f1"),
			exportKey("p1", "s1", "digest"),
		]) {
			expect(isKeyOwnedBySnapshot(key, "p1", "s1")).toBe(true);
		}
	});

	it("disowns another snapshot's keys, including a base it inherits from", () => {
		expect(
			isKeyOwnedBySnapshot(snapshotKey("p1", "base", "bf1"), "p1", "s1"),
		).toBe(false);
		expect(
			isKeyOwnedBySnapshot(stagingKey("p1", "other", "f1"), "p1", "s1"),
		).toBe(false);
		expect(
			isKeyOwnedBySnapshot(exportKey("p1", "other", "d"), "p1", "s1"),
		).toBe(false);
	});

	it("disowns another project's keys, and a prefix that merely starts the same", () => {
		expect(
			isKeyOwnedBySnapshot(snapshotKey("p2", "s1", "f1"), "p1", "s1"),
		).toBe(false);
		// `s1` must not own `s10`'s objects: the snapshot prefix ends in a
		// separator precisely so a longer id cannot be swallowed by a shorter
		// one.
		expect(
			isKeyOwnedBySnapshot(snapshotKey("p1", "s10", "f1"), "p1", "s1"),
		).toBe(false);
	});
});
