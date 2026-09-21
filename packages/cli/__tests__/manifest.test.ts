/**
 * Manifest validation (Fizzy #2539, review round 1 finding 7).
 *
 * An absent manifest used to become `[]`, and an empty manifest means
 * "delete everything the lock names". A version-skewed server or a truncated
 * response was one step from emptying the tree and writing a ledger that
 * agreed with it. A manifest is now complete and self-consistent or it is a
 * refusal.
 */
import { createHash } from "node:crypto";
import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
	assertValidManifest,
	computeSnapshotDigest,
	maxArchiveBytes,
} from "../src/lib/instructions/manifest.js";

/**
 * The separator the digest recipe uses, built rather than written: a
 * unicode escape would be rewritten by the formatter into the byte it
 * names, which turns this source file binary.
 */
const NUL = String.fromCharCode(0);

function sha256(text: string): string {
	return createHash("sha256").update(Buffer.from(text)).digest("hex");
}

function entry(
	filePath: string,
	contents: string,
	mode: number | null = 0o100644,
) {
	return {
		path: filePath,
		sha256: sha256(contents),
		size: Buffer.byteLength(contents),
		mode,
		kind: "INSTRUCTIONS" as const,
	};
}

function snapshotFor(entries: ReturnType<typeof entry>[]) {
	return {
		digest: computeSnapshotDigest(entries),
		fileCount: entries.length,
		version: 7,
	};
}

describe("computeSnapshotDigest", () => {
	/**
	 * Pinned against the server's recipe in
	 * `packages/instructions/src/manifest.ts`: sha256 over `path\0sha256\n`
	 * lines sorted by path. Reimplemented here because that package is
	 * private and this one is published.
	 */
	it("matches the documented recipe", () => {
		const entries = [
			{ path: "b.md", sha256: "b".repeat(64) },
			{ path: "a.md", sha256: "a".repeat(64) },
		];
		const expected = createHash("sha256")
			.update(
				Buffer.from(
					`a.md${NUL}${"a".repeat(64)}\nb.md${NUL}${"b".repeat(64)}\n`,
					"utf8",
				),
			)
			.digest("hex");

		expect(computeSnapshotDigest(entries)).toBe(expected);
	});

	it("does not depend on the order entries arrive in", () => {
		const a = { path: "a.md", sha256: "a".repeat(64) };
		const b = { path: "b.md", sha256: "b".repeat(64) };
		expect(computeSnapshotDigest([a, b])).toBe(
			computeSnapshotDigest([b, a]),
		);
	});
});

describe("assertValidManifest", () => {
	it("returns the entries when everything agrees", () => {
		const entries = [entry("AGENTS.md", "hello"), entry("docs/b.md", "b")];

		expect(
			assertValidManifest({
				manifest: entries,
				snapshot: snapshotFor(entries),
			}),
		).toEqual(entries);
	});

	it.each([[undefined], [null], ["not an array"], [{}]])(
		"refuses a response whose manifest is %s",
		(manifest) => {
			expect(() =>
				assertValidManifest({
					manifest,
					snapshot: {
						digest: "d".repeat(64),
						fileCount: 2,
						version: 7,
					},
				}),
			).toThrow(/sent no file manifest/);
		},
	);

	it("refuses a manifest shorter than the snapshot's fileCount", () => {
		const entries = [entry("AGENTS.md", "hello")];
		expect(() =>
			assertValidManifest({
				manifest: entries,
				snapshot: { ...snapshotFor(entries), fileCount: 2 },
			}),
		).toThrow(/lists 1 files and the snapshot says 2/);
	});

	it("refuses a manifest that does not hash to the snapshot's digest", () => {
		const entries = [entry("AGENTS.md", "hello")];
		expect(() =>
			assertValidManifest({
				manifest: entries,
				snapshot: { ...snapshotFor(entries), digest: "d".repeat(64) },
			}),
		).toThrow(/does not match its own digest/);
	});

	it("refuses two entries that name the same file", () => {
		const entries = [entry("README.md", "a"), entry("readme.md", "b")];
		expect(() =>
			assertValidManifest({
				manifest: entries,
				snapshot: snapshotFor(entries),
			}),
		).toThrow(/name the same file/);
	});

	it.each([
		[{ sha256: "abc" }, /no 64-character hex sha256/],
		[{ size: -1 }, /no non-negative integer size/],
		[{ size: 1.5 }, /no non-negative integer size/],
		[{ size: "120" }, /no non-negative integer size/],
		[{ mode: "755" }, /neither null nor an integer/],
		[{ mode: 0o100777 }, /only 644 and 755 are accepted/],
		[{ mode: 0o104755 }, /only 644 and 755 are accepted/],
	])("refuses an entry with %s", (patch, matcher) => {
		const base = entry("AGENTS.md", "hello");
		const entries = [{ ...base, ...patch }];
		expect(() =>
			assertValidManifest({
				manifest: entries,
				snapshot: { digest: "d".repeat(64), fileCount: 1, version: 7 },
			}),
		).toThrow(matcher);
	});

	it.each([["../escape.md"], ["/etc/passwd"], ["a\\b.md"], ["NUL"]])(
		"refuses the unsafe path %s",
		(unsafePath) => {
			const entries = [entry(unsafePath, "x")];
			expect(() =>
				assertValidManifest({
					manifest: entries,
					snapshot: {
						digest: "d".repeat(64),
						fileCount: 1,
						version: 7,
					},
				}),
			).toThrow(/Refusing to sync/);
		},
	);

	it.each([
		[".git/config"],
		[".fabric/instructions.lock"],
		// Review round 2, finding 5: `init` writes this file and then syncs.
		// A manifest naming it overwrote the session hook that had just been
		// installed, and the resulting lock could later authorise deleting it.
		[".claude/settings.local.json"],
		[".claude/Settings.Local.JSON"],
		[".codex/hooks.json"],
		[".codex/Hooks.JSON"],
	])("refuses the reserved path %s even from the server", (reserved) => {
		const entries = [entry(reserved, "x")];
		expect(() =>
			assertValidManifest({
				manifest: entries,
				snapshot: {
					digest: "d".repeat(64),
					fileCount: 1,
					version: 7,
				},
			}),
		).toThrow(/never writes or deletes/);
	});

	it("still accepts instruction files elsewhere under the tool roots", () => {
		const entries = [
			entry(".claude/skills/review/SKILL.md", "x"),
			entry(".codex/skills/review/SKILL.md", "x"),
		];
		expect(
			assertValidManifest({
				manifest: entries,
				snapshot: snapshotFor(entries),
			}),
		).toEqual(entries);
	});

	/**
	 * Review round 2, finding 7. Sizes and count were checked against each
	 * other and never against an absolute, so a manifest claiming a million
	 * 4 GB files was internally consistent — and sized the download bound off
	 * its own claim.
	 */
	describe("published snapshot limits", () => {
		it("refuses more files than a snapshot can hold", () => {
			const manifest = Array.from({ length: 5001 }, (_, index) =>
				entry(`f${index}.md`, `${index}`),
			);
			expect(() =>
				assertValidManifest({
					manifest,
					snapshot: {
						digest: "d".repeat(64),
						fileCount: 5001,
						version: 7,
					},
				}),
			).toThrow(/at most 5000/);
		});

		it("refuses a single file larger than the per-file limit", () => {
			const entries = [{ ...entry("big.md", "x"), size: 5_242_881 }];
			expect(() =>
				assertValidManifest({
					manifest: entries,
					snapshot: {
						digest: "d".repeat(64),
						fileCount: 1,
						version: 7,
					},
				}),
			).toThrow(/at most 5242880/);
		});

		it("refuses a total larger than the snapshot limit", () => {
			const entries = [
				{ ...entry("a.md", "x"), size: 5_242_880 },
				...Array.from({ length: 10 }, (_, index) => ({
					...entry(`f${index}.md`, `${index}`),
					size: 5_242_880,
				})),
			];
			expect(() =>
				assertValidManifest({
					manifest: entries,
					snapshot: {
						digest: "d".repeat(64),
						fileCount: entries.length,
						version: 7,
					},
				}),
			).toThrow(/at most 52428800/);
		});

		it("refuses an absurdly long path", () => {
			const entries = [entry(`${"a".repeat(1100)}.md`, "x")];
			expect(() =>
				assertValidManifest({
					manifest: entries,
					snapshot: {
						digest: "d".repeat(64),
						fileCount: 1,
						version: 7,
					},
				}),
			).toThrow(/at most 1024 is accepted/);
		});

		it("refuses a path nested past the depth cap", () => {
			const entries = [
				entry(
					`${Array.from({ length: 65 }, () => "d").join("/")}/a.md`,
					"x",
				),
			];
			expect(() =>
				assertValidManifest({
					manifest: entries,
					snapshot: {
						digest: "d".repeat(64),
						fileCount: 1,
						version: 7,
					},
				}),
			).toThrow(/nested deeper than 64/);
		});
	});

	/**
	 * The bound must be generous enough for every snapshot the SERVER would
	 * accept. A flat 1 MiB of slack was not: zip framing grows with the entry
	 * count and the length of the names, so 5000 empty files with 200-byte
	 * paths needed about 2.4 MB of pure structure and could not be downloaded
	 * at all (review round 3, finding 5).
	 */
	describe("maxArchiveBytes", () => {
		it("bounds the download by the manifest, never by the response", () => {
			expect(
				maxArchiveBytes([
					{ path: "a.md", size: 100 },
					{ path: "b.md", size: 200 },
				]),
			).toBe(300 + 2 * (512 + 2 * 4) + 1_048_576);
		});

		it("leaves room for a maximum-count, long-path snapshot", () => {
			const longPath = `${"p".repeat(196)}.md`;
			const manifest = Array.from({ length: 5000 }, () => ({
				path: longPath,
				size: 0,
			}));

			// What the format actually needs for this shape: an end-of-central
			// -directory record, plus a local header and a central-directory
			// header per entry, each carrying the name.
			const zipFloor = 22 + 5000 * (30 + 200 + 46 + 200);
			expect(maxArchiveBytes(manifest)).toBeGreaterThan(zipFloor);
		});

		it("covers a real zip of the same manifest", () => {
			const files = {
				"AGENTS.md": new Uint8Array(Buffer.from("hello\n")),
				".claude/skills/review/SKILL.md": new Uint8Array(
					Buffer.from("skill\n"),
				),
			};
			const archive = zipSync(files);
			const manifest = Object.entries(files).map(([path, bytes]) => ({
				path,
				size: bytes.length,
			}));

			expect(maxArchiveBytes(manifest)).toBeGreaterThan(archive.length);
		});
	});

	it("accepts an empty manifest only when the snapshot agrees it is empty", () => {
		expect(
			assertValidManifest({
				manifest: [],
				snapshot: snapshotFor([]),
			}),
		).toEqual([]);
	});
});
