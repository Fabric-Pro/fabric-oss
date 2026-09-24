import { describe, expect, it } from "vitest";
import { computeSnapshotDigest } from "../src/manifest";

describe("computeSnapshotDigest", () => {
	it("is order-independent and changes when any hash changes", async () => {
		const a = await computeSnapshotDigest([
			{ path: "b.md", sha256: "22" },
			{ path: "a.md", sha256: "11" },
		]);
		const b = await computeSnapshotDigest([
			{ path: "a.md", sha256: "11" },
			{ path: "b.md", sha256: "22" },
		]);
		const c = await computeSnapshotDigest([
			{ path: "a.md", sha256: "11" },
			{ path: "b.md", sha256: "23" },
		]);
		expect(a).toBe(b);
		expect(a).not.toBe(c);
		expect(a).toMatch(/^[0-9a-f]{64}$/);
	});

	// Fizzy #2671: repository sync (`instruction-sync-tree.ts`'s `treesEqual`)
	// is mode-aware and publishes a new snapshot version for a mode-only
	// change, but the old digest recipe hashed paths and content only. Every
	// `sinceDigest` consumer then answered "unchanged" for a version that
	// changed a file's executable bit, and nobody installed the new mode.
	it("changes the digest when only a file's mode changes", async () => {
		const nonExecutable = await computeSnapshotDigest([
			{ path: "scripts/run.sh", sha256: "1".repeat(64), mode: 0o644 },
		]);
		const executable = await computeSnapshotDigest([
			{ path: "scripts/run.sh", sha256: "1".repeat(64), mode: 0o755 },
		]);
		expect(executable).not.toBe(nonExecutable);
	});

	// `treesEqual` treats a null published mode as 0o644 (an upload's "no
	// mode recorded"), so the digest has to agree: these four spellings of
	// "the default mode" must never look like four different snapshots.
	it("hashes null, undefined, 0o644 and a missing mode field identically", async () => {
		const entry = { path: "AGENTS.md", sha256: "2".repeat(64) };
		const withNull = await computeSnapshotDigest([
			{ ...entry, mode: null },
		]);
		const withUndefined = await computeSnapshotDigest([
			{ ...entry, mode: undefined },
		]);
		const withDefault = await computeSnapshotDigest([
			{ ...entry, mode: 0o644 },
		]);
		const withMissingField = await computeSnapshotDigest([entry]);
		expect(withUndefined).toBe(withNull);
		expect(withDefault).toBe(withNull);
		expect(withMissingField).toBe(withNull);
	});

	// Review round 2 (Fizzy #2671): the wire contract admits a full `st_mode`,
	// not only bare permission bits — `isAllowedMode`
	// (`packages/cli/src/lib/instructions/safe-write.ts`) masks with
	// `& 0o7777` and explicitly accepts e.g. `0o100644` — and the installer
	// (`permissionBits`, same file) applies both representations identically.
	// A digest that told them apart would move for two manifests the
	// installer treats as the same tree.
	it("hashes a full st_mode the same as its bare permission bits", async () => {
		const entry = { path: "AGENTS.md", sha256: "3".repeat(64) };
		const bareDefault = await computeSnapshotDigest([
			{ ...entry, mode: 0o644 },
		]);
		const fullStatDefault = await computeSnapshotDigest([
			{ ...entry, mode: 0o100644 },
		]);
		expect(fullStatDefault).toBe(bareDefault);

		const executable = { path: "scripts/run.sh", sha256: "4".repeat(64) };
		const bareExecutable = await computeSnapshotDigest([
			{ ...executable, mode: 0o755 },
		]);
		const fullStatExecutable = await computeSnapshotDigest([
			{ ...executable, mode: 0o100755 },
		]);
		expect(fullStatExecutable).toBe(bareExecutable);

		// And a real permission difference still moves the digest under
		// either representation.
		expect(bareExecutable).not.toBe(bareDefault);
		expect(fullStatExecutable).not.toBe(fullStatDefault);
	});

	/**
	 * Pinned against a hash computed with the PRE-mode-aware recipe (sha256
	 * over `path\0sha256\n`, no third field, ever) for
	 * `{ path: "a.md", sha256: "a".repeat(64) }`. A mode-less entry — the
	 * only kind every snapshot published before this change could contain —
	 * must keep hashing to this exact literal, or an old CLI's digest check
	 * on an already-published snapshot starts failing.
	 */
	it("keeps the mode-less digest byte-identical to the pre-mode-aware recipe", async () => {
		const digest = await computeSnapshotDigest([
			{ path: "a.md", sha256: "a".repeat(64) },
		]);
		expect(digest).toBe(
			"7be82d5ec7fa5d7fe4254063862af5743551923763eda46f19ea832ebb63f18c",
		);
	});
});
