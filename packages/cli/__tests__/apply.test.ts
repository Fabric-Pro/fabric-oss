/**
 * Applying a plan (Fizzy #2539).
 *
 * The two promises being pinned: a checksum mismatch writes NOTHING (so the
 * lock the caller does not rewrite still describes a tree that exists), and
 * bytes and modes arrive exactly as published.
 */
import { createHash } from "node:crypto";
import {
	chmod,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { InstructionManifestEntry } from "@fabricorg/sdk";
import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { applyPlan } from "../src/lib/instructions/apply.js";
import { extractBundle } from "../src/lib/instructions/bundle.js";
import { readLock, writeLock } from "../src/lib/instructions/lock.js";
import { computeSyncPlan } from "../src/lib/instructions/plan.js";
import { resolveDestinationRoot } from "../src/lib/instructions/safe-write.js";

function sha256(bytes: Uint8Array | string): string {
	return createHash("sha256")
		.update(typeof bytes === "string" ? Buffer.from(bytes) : bytes)
		.digest("hex");
}

async function makeTree(files: Record<string, string> = {}): Promise<string> {
	const dest = await resolveDestinationRoot(
		await mkdtemp(path.join(tmpdir(), "fabric-apply-")),
	);
	for (const [relative, contents] of Object.entries(files)) {
		const target = path.join(dest, relative);
		await mkdir(path.dirname(target), { recursive: true });
		await writeFile(target, contents);
	}
	return dest;
}

function entry(
	filePath: string,
	contents: string,
	mode: number | null = 0o100644,
): InstructionManifestEntry {
	return {
		path: filePath,
		sha256: sha256(contents),
		size: Buffer.byteLength(contents),
		mode,
		kind: "INSTRUCTIONS",
	};
}

function contentsOf(files: Record<string, string>): Map<string, Uint8Array> {
	return new Map(
		Object.entries(files).map(([key, value]) => [
			key,
			new Uint8Array(Buffer.from(value)),
		]),
	);
}

describe("applyPlan", () => {
	it("writes new files with their published bytes and mode", async () => {
		const dest = await makeTree();
		const manifest = [
			entry("AGENTS.md", "hello\nworld\n"),
			entry("scripts/run.sh", "#!/bin/sh\n", 0o100755),
		];
		const plan = await computeSyncPlan({
			destination: dest,
			manifest,
			lock: null,
		});

		const result = await applyPlan({
			root: dest,
			plan,
			contents: contentsOf({
				"AGENTS.md": "hello\nworld\n",
				"scripts/run.sh": "#!/bin/sh\n",
			}),
		});

		expect(result.written.sort()).toEqual(["AGENTS.md", "scripts/run.sh"]);
		// Bytes exactly — no newline conversion, no re-encoding.
		expect(await readFile(path.join(dest, "AGENTS.md"))).toEqual(
			Buffer.from("hello\nworld\n"),
		);
		if (process.platform !== "win32") {
			const mode = (await stat(path.join(dest, "scripts/run.sh"))).mode;
			expect(mode & 0o777).toBe(0o755);
		}
	});

	it("leaves no temp files behind", async () => {
		const dest = await makeTree();
		const plan = await computeSyncPlan({
			destination: dest,
			manifest: [entry("AGENTS.md", "x")],
			lock: null,
		});

		await applyPlan({
			root: dest,
			plan,
			contents: contentsOf({ "AGENTS.md": "x" }),
		});

		expect(await readdir(dest)).toEqual(["AGENTS.md"]);
	});

	it("aborts on a checksum mismatch and writes nothing at all", async () => {
		const dest = await makeTree();
		const manifest = [
			entry("good.md", "good"),
			entry("bad.md", "expected"),
		];
		const plan = await computeSyncPlan({
			destination: dest,
			manifest,
			lock: null,
		});

		await expect(
			applyPlan({
				root: dest,
				plan,
				contents: contentsOf({
					"good.md": "good",
					"bad.md": "tampered",
				}),
			}),
		).rejects.toThrow(/Checksum mismatch for bad\.md/);

		// Not "the good one landed and the bad one did not" — nothing landed.
		expect(await readdir(dest)).toEqual([]);
	});

	it("leaves the previous lock untouched when a write is refused", async () => {
		const dest = await makeTree();
		const previous = {
			version: 1,
			projectId: "project-1",
			snapshotId: "snap-1",
			snapshotVersion: 6,
			digest: "c".repeat(64),
			syncedAt: "2026-09-16T10:00:00.000Z",
			files: {},
		};
		await writeLock(dest, previous);

		const plan = await computeSyncPlan({
			destination: dest,
			manifest: [entry("bad.md", "expected")],
			lock: previous,
		});

		await expect(
			applyPlan({
				root: dest,
				plan,
				contents: contentsOf({ "bad.md": "tampered" }),
			}),
		).rejects.toThrow(/Checksum mismatch/);

		await expect(readLock(dest)).resolves.toEqual(previous);
	});

	it("refuses when the bundle is missing a planned file", async () => {
		const dest = await makeTree();
		const plan = await computeSyncPlan({
			destination: dest,
			manifest: [entry("AGENTS.md", "x")],
			lock: null,
		});

		await expect(
			applyPlan({ root: dest, plan, contents: new Map() }),
		).rejects.toThrow(/missing AGENTS\.md/);
	});

	/**
	 * Since review round 2 the refusal comes one step earlier: planning hashes
	 * with `lstat` and no link-following, so a symlink at a manifest path never
	 * reaches `applyPlan` at all. Phase 1 still refuses it — the case below —
	 * because the link can appear between the two.
	 */
	it("refuses a symlink at a manifest path while planning", async () => {
		const dest = await makeTree();
		const outside = await makeTree({ "victim.md": "original" });
		await symlink(
			path.join(outside, "victim.md"),
			path.join(dest, "AGENTS.md"),
		);

		await expect(
			computeSyncPlan({
				destination: dest,
				manifest: [entry("AGENTS.md", "replacement")],
				lock: null,
			}),
		).rejects.toThrow(/symlink/);

		expect(await readFile(path.join(outside, "victim.md"), "utf8")).toBe(
			"original",
		);
	});

	it("refuses a symlink that appeared after the plan, writing nothing", async () => {
		const dest = await makeTree();
		const outside = await makeTree({ "victim.md": "original" });

		const plan = await computeSyncPlan({
			destination: dest,
			manifest: [
				entry("a.md", "first"),
				entry("AGENTS.md", "replacement"),
			],
			lock: null,
		});
		// The window phase 1 exists to cover.
		await symlink(
			path.join(outside, "victim.md"),
			path.join(dest, "AGENTS.md"),
		);

		await expect(
			applyPlan({
				root: dest,
				plan,
				contents: contentsOf({
					"a.md": "first",
					"AGENTS.md": "replacement",
				}),
			}),
		).rejects.toThrow(/symlink/);

		expect(await readFile(path.join(outside, "victim.md"), "utf8")).toBe(
			"original",
		);
		// "Nothing was written" is literal: the earlier entry in the same plan
		// must not have landed either.
		expect(await readdir(dest)).toEqual(["AGENTS.md"]);
	});

	/**
	 * Review round 2, finding 8: a `verified` entry is not written, so it used
	 * to skip every filesystem check — and on Windows, or whenever the mode is
	 * null, `applyMode` returned before looking at all.
	 */
	it("refuses a symlink at a verified path even with no mode to apply", async () => {
		const dest = await makeTree({ "real.md": "published" });
		const outside = await makeTree({ "victim.md": "published" });

		await applyPlan({
			root: dest,
			plan: {
				entries: [],
				writes: [],
				deletes: [],
				keptModified: [],
				keptRenamed: [],
				verified: [
					{
						path: "real.md",
						action: "verified",
						sha256: sha256("published"),
						mode: null,
					},
				],
			},
			contents: new Map(),
		});

		await symlink(
			path.join(outside, "victim.md"),
			path.join(dest, "linked.md"),
		);
		await expect(
			applyPlan({
				root: dest,
				plan: {
					entries: [],
					writes: [],
					deletes: [],
					keptModified: [],
					keptRenamed: [],
					verified: [
						{
							path: "linked.md",
							action: "verified",
							sha256: sha256("published"),
							mode: null,
						},
					],
				},
				contents: new Map(),
			}),
		).rejects.toThrow(/symlink/);
	});

	/**
	 * Review round 3, finding 2. With a regular file at `z`, `lstat` on
	 * `z/child.md` answers ENOTDIR — which used to read as "absent", so phase
	 * 1 accepted the whole plan, phase 2 wrote `a.md`, and only then did
	 * `makeParents` refuse. That leaves a partially updated tree and an old
	 * lock: exactly what the whole-plan preflight promises cannot happen.
	 */
	it("refuses a plan whose later path has a regular-file ancestor, writing nothing", async () => {
		const dest = await makeTree({ z: "I am a file" });
		const plan = {
			entries: [],
			writes: [
				{
					path: "a.md",
					action: "added" as const,
					sha256: sha256("first"),
					mode: null,
				},
				{
					path: "z/child.md",
					action: "added" as const,
					sha256: sha256("second"),
					mode: null,
				},
			],
			deletes: [],
			verified: [],
			keptModified: [],
			keptRenamed: [],
		};

		await expect(
			applyPlan({
				root: dest,
				plan,
				contents: contentsOf({
					"a.md": "first",
					"z/child.md": "second",
				}),
			}),
		).rejects.toThrow(/not a directory/);

		expect(await readdir(dest)).toEqual(["z"]);
	});

	/**
	 * Review round 2, finding 2: the unlink is bound to the hash the plan
	 * decided on, so an edit saved between planning and applying survives.
	 */
	it("keeps a departed file that was edited after the plan was made", async () => {
		const dest = await makeTree({ "gone.md": "written by sync" });
		const plan = await computeSyncPlan({
			destination: dest,
			manifest: [],
			lock: {
				version: 1,
				projectId: "project-1",
				snapshotId: "snap-1",
				snapshotVersion: 6,
				digest: "c".repeat(64),
				syncedAt: "2026-09-16T10:00:00.000Z",
				files: {
					"gone.md": {
						sha256: sha256("written by sync"),
						mode: null,
					},
				},
			},
		});
		expect(plan.deletes).toHaveLength(1);

		// The developer saves the file while the bundle is downloading.
		await writeFile(path.join(dest, "gone.md"), "mine now");

		const result = await applyPlan({
			root: dest,
			plan,
			contents: new Map(),
		});

		expect(result.deleted).toEqual([]);
		expect(result.keptModified).toEqual(["gone.md"]);
		expect(await readFile(path.join(dest, "gone.md"), "utf8")).toBe(
			"mine now",
		);
	});

	it("unlinks a departed file but keeps its directory", async () => {
		const dest = await makeTree({ "docs/gone.md": "written by sync" });
		const lock = {
			version: 1,
			projectId: "project-1",
			snapshotId: "snap-1",
			snapshotVersion: 6,
			digest: "c".repeat(64),
			syncedAt: "2026-09-16T10:00:00.000Z",
			files: {
				"docs/gone.md": {
					sha256: sha256("written by sync"),
					mode: null,
				},
			},
		};
		const plan = await computeSyncPlan({
			destination: dest,
			manifest: [],
			lock,
		});

		const result = await applyPlan({
			root: dest,
			plan,
			contents: new Map(),
		});

		expect(result.deleted).toEqual(["docs/gone.md"]);
		expect(await readdir(path.join(dest, "docs"))).toEqual([]);
	});

	it("corrects the mode of a file whose bytes already match", async () => {
		if (process.platform === "win32") {
			return;
		}
		const dest = await makeTree({ "scripts/run.sh": "#!/bin/sh\n" });
		await chmod(path.join(dest, "scripts/run.sh"), 0o644);

		const plan = await computeSyncPlan({
			destination: dest,
			manifest: [entry("scripts/run.sh", "#!/bin/sh\n", 0o100755)],
			lock: null,
		});

		const result = await applyPlan({
			root: dest,
			plan,
			contents: new Map(),
		});

		expect(result.written).toEqual([]);
		expect(result.remoded).toEqual(["scripts/run.sh"]);
		expect(
			(await stat(path.join(dest, "scripts/run.sh"))).mode & 0o777,
		).toBe(0o755);
	});
});

describe("extractBundle", () => {
	it("returns only the entries the plan asked for", () => {
		const archive = zipSync({
			"AGENTS.md": new Uint8Array(Buffer.from("wanted")),
			"other.md": new Uint8Array(Buffer.from("not wanted")),
		});

		const contents = extractBundle(archive, [
			{ path: "AGENTS.md", size: 6 },
		]);

		expect([...contents.keys()]).toEqual(["AGENTS.md"]);
		expect(
			Buffer.from(contents.get("AGENTS.md") as Uint8Array).toString(),
		).toBe("wanted");
	});

	it("ignores an archive entry with a traversing name", () => {
		const archive = zipSync({
			"../../etc/passwd": new Uint8Array(Buffer.from("root:x")),
			"AGENTS.md": new Uint8Array(Buffer.from("wanted")),
		});

		const contents = extractBundle(archive, [
			{ path: "AGENTS.md", size: 6 },
		]);

		expect([...contents.keys()]).toEqual(["AGENTS.md"]);
	});

	/**
	 * The filter runs before `fflate` allocates, so a declared size that does
	 * not match the manifest is refused rather than decompressed. The sha256
	 * check in `applyPlan` catches substituted CONTENT, but only after the
	 * bytes are already in memory.
	 */
	it("refuses an entry whose declared size is not the manifest's", () => {
		const archive = zipSync({
			"AGENTS.md": new Uint8Array(
				Buffer.from("much longer than claimed"),
			),
		});

		expect(() =>
			extractBundle(archive, [{ path: "AGENTS.md", size: 6 }]),
		).toThrow(/declares 24 bytes for AGENTS\.md and the manifest says 6/);
	});

	it("refuses a second entry with a wanted name rather than letting it win", () => {
		// Two members with the same name: `zipSync` will not build one, so the
		// archive is assembled by concatenating a second local+central record
		// for the same name.
		const archive = zipWithDuplicate("AGENTS.md", "first", "second");

		expect(() =>
			extractBundle(archive, [{ path: "AGENTS.md", size: 5 }]),
		).toThrow(/more than once/);
	});

	it("does nothing when nothing is wanted", () => {
		const archive = zipSync({
			"AGENTS.md": new Uint8Array(Buffer.from("wanted")),
		});
		expect(extractBundle(archive, []).size).toBe(0);
	});
});

/**
 * A zip holding two members with the same name. `fflate` will not produce
 * one, so the central directory is rewritten by hand: two local file headers,
 * two central records, and an end-of-central-directory that counts both.
 */
function zipWithDuplicate(
	name: string,
	first: string,
	second: string,
): Uint8Array {
	const a = zipSync({ [name]: new Uint8Array(Buffer.from(first)) });
	const b = zipSync({ [name]: new Uint8Array(Buffer.from(second)) });
	const aBuf = Buffer.from(a);
	const bBuf = Buffer.from(b);

	const aCentral = aBuf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
	const bCentral = bBuf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
	const aEnd = aBuf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
	const bEnd = bBuf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));

	const aLocal = aBuf.subarray(0, aCentral);
	const bLocal = bBuf.subarray(0, bCentral);
	const aDir = Buffer.from(aBuf.subarray(aCentral, aEnd));
	const bDir = Buffer.from(bBuf.subarray(bCentral, bEnd));
	// The second record's local header now starts after the first one's.
	bDir.writeUInt32LE(aLocal.length, 42);

	const directory = Buffer.concat([aDir, bDir]);
	const end = Buffer.from(aBuf.subarray(aEnd));
	end.writeUInt16LE(2, 8);
	end.writeUInt16LE(2, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(aLocal.length + bLocal.length, 16);

	return new Uint8Array(Buffer.concat([aLocal, bLocal, directory, end]));
}
