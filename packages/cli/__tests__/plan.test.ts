/**
 * Plan computation (Fizzy #2539).
 *
 * Every branch gets a case, because each one is a different promise to the
 * developer: their edits are reported before they are overwritten, their own
 * files are never deleted, and a file already correct is not rewritten.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { InstructionManifestEntry } from "@fabricorg/sdk";
import { describe, expect, it } from "vitest";
import type { InstructionsLock } from "../src/lib/instructions/lock.js";
import { LOCK_VERSION } from "../src/lib/instructions/lock.js";
import {
	computeSyncPlan,
	findLedgerDrift,
	nextLock,
	reconcileKeptInLock,
	verifyLedger,
} from "../src/lib/instructions/plan.js";

function sha256(text: string): string {
	return createHash("sha256").update(Buffer.from(text)).digest("hex");
}

async function makeTree(files: Record<string, string> = {}): Promise<string> {
	const dest = await mkdtemp(path.join(tmpdir(), "fabric-plan-"));
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
	mode: number | null = 33188,
): InstructionManifestEntry {
	return {
		path: filePath,
		sha256: sha256(contents),
		size: Buffer.byteLength(contents),
		mode,
		kind: "INSTRUCTIONS",
	};
}

function lockOf(
	files: Record<string, { contents: string; mode?: number | null }>,
): InstructionsLock {
	const locked: InstructionsLock["files"] = {};
	for (const [key, value] of Object.entries(files)) {
		locked[key] = {
			sha256: sha256(value.contents),
			mode: value.mode ?? 33188,
		};
	}
	return {
		version: 1,
		projectId: "project-1",
		snapshotId: "snap-1",
		snapshotVersion: 6,
		digest: "c".repeat(64),
		syncedAt: "2026-09-16T10:00:00.000Z",
		files: locked,
	};
}

function actionOf(
	plan: Awaited<ReturnType<typeof computeSyncPlan>>,
	filePath: string,
): string | undefined {
	return plan.entries.find((e) => e.path === filePath)?.action;
}

describe("computeSyncPlan", () => {
	it("marks a file whose bytes already match as verified, with no write", async () => {
		const dest = await makeTree({ "AGENTS.md": "same" });

		const plan = await computeSyncPlan({
			destination: dest,
			manifest: [entry("AGENTS.md", "same")],
			lock: lockOf({ "AGENTS.md": { contents: "same" } }),
		});

		expect(actionOf(plan, "AGENTS.md")).toBe("verified");
		expect(plan.writes).toHaveLength(0);
	});

	it("marks a missing file as added", async () => {
		const dest = await makeTree();

		const plan = await computeSyncPlan({
			destination: dest,
			manifest: [entry("AGENTS.md", "new")],
			lock: null,
		});

		expect(actionOf(plan, "AGENTS.md")).toBe("added");
		expect(plan.writes.map((w) => w.path)).toEqual(["AGENTS.md"]);
	});

	it("marks the sync's own untouched file moving forward as updated", async () => {
		const dest = await makeTree({ "AGENTS.md": "old" });

		const plan = await computeSyncPlan({
			destination: dest,
			manifest: [entry("AGENTS.md", "new")],
			lock: lockOf({ "AGENTS.md": { contents: "old" } }),
		});

		expect(actionOf(plan, "AGENTS.md")).toBe("updated");
	});

	it("marks a locally edited file as replaced so the report can say so", async () => {
		const dest = await makeTree({ "AGENTS.md": "my own edit" });

		const plan = await computeSyncPlan({
			destination: dest,
			manifest: [entry("AGENTS.md", "new")],
			lock: lockOf({ "AGENTS.md": { contents: "old" } }),
		});

		expect(actionOf(plan, "AGENTS.md")).toBe("replaced");
		expect(plan.writes.map((w) => w.path)).toEqual(["AGENTS.md"]);
	});

	it("deletes a file that left the snapshot and still matches the lock", async () => {
		const dest = await makeTree({ "gone.md": "written by sync" });

		const plan = await computeSyncPlan({
			destination: dest,
			manifest: [],
			lock: lockOf({ "gone.md": { contents: "written by sync" } }),
		});

		expect(plan.deletes.map((d) => d.path)).toEqual(["gone.md"]);
	});

	it("keeps a departed file the developer has since modified", async () => {
		const dest = await makeTree({ "gone.md": "I changed this" });

		const plan = await computeSyncPlan({
			destination: dest,
			manifest: [],
			lock: lockOf({ "gone.md": { contents: "written by sync" } }),
		});

		expect(plan.deletes).toHaveLength(0);
		expect(plan.keptModified.map((k) => k.path)).toEqual(["gone.md"]);
	});

	it("never deletes a file it did not write", async () => {
		const dest = await makeTree({
			"mine.md": "not the sync's",
			"AGENTS.md": "same",
		});

		const plan = await computeSyncPlan({
			destination: dest,
			manifest: [entry("AGENTS.md", "same")],
			lock: lockOf({ "AGENTS.md": { contents: "same" } }),
		});

		expect(plan.deletes).toHaveLength(0);
		expect(plan.entries.map((e) => e.path)).not.toContain("mine.md");
	});

	it("ignores a lock path whose local file is already gone", async () => {
		const dest = await makeTree();

		const plan = await computeSyncPlan({
			destination: dest,
			manifest: [],
			lock: lockOf({ "gone.md": { contents: "written by sync" } }),
		});

		expect(plan.entries).toHaveLength(0);
	});

	it("refuses a lock that names an unsafe path", async () => {
		const dest = await makeTree();
		const lock = lockOf({ "fine.md": { contents: "x" } });
		lock.files["/etc/passwd"] = { sha256: sha256("x"), mode: null };

		await expect(
			computeSyncPlan({ destination: dest, manifest: [], lock }),
		).rejects.toThrow(/absolute path refused/);
	});

	/**
	 * The lock is a plain JSON file inside the checkout, so anything that can
	 * write there can name a path in it. `.git/config` has a hash anyone can
	 * read off disk, which is all a delete needs — so the reserved roots are
	 * refused on the LOCK side and not only on the manifest side.
	 */
	it.each([
		[".git/config"],
		[".git/hooks/pre-commit"],
		[".fabric/instructions.lock"],
	])("refuses a tampered lock naming %s", async (reserved) => {
		const dest = await makeTree({ [reserved]: "current contents" });
		const lock = lockOf({ "AGENTS.md": { contents: "x" } });
		lock.files[reserved] = {
			sha256: sha256("current contents"),
			mode: null,
		};

		await expect(
			computeSyncPlan({ destination: dest, manifest: [], lock }),
		).rejects.toThrow(/never writes or deletes/);
	});

	/**
	 * Review round 2, finding 1. Collision checks ran over the manifest and
	 * the lock separately, and reconciliation compared exact strings. On a
	 * case-insensitive filesystem the locked `README.md` and the published
	 * `readme.md` are ONE file: the sync wrote it and then, because writes run
	 * before deletes, unlinked it — and wrote a lock saying it was there.
	 */
	it("treats a case-only rename as one file and plans no delete", async () => {
		const dest = await makeTree({ "README.md": "old" });

		const plan = await computeSyncPlan({
			destination: dest,
			manifest: [entry("readme.md", "new")],
			lock: lockOf({ "README.md": { contents: "old" } }),
		});

		expect(plan.deletes).toHaveLength(0);
		expect(plan.keptRenamed.map((k) => k.path)).toEqual(["README.md"]);
		expect(actionOf(plan, "readme.md")).toBe("added");
	});

	it("treats an NFC/NFD-only rename as one file too", async () => {
		const nfc = "caf\u00e9.md";
		const nfd = "cafe\u0301.md";
		const dest = await makeTree();

		const plan = await computeSyncPlan({
			destination: dest,
			manifest: [entry(nfc, "new")],
			lock: lockOf({ [nfd]: { contents: "old" } }),
		});

		expect(plan.deletes).toHaveLength(0);
		expect(plan.keptRenamed.map((k) => k.path)).toEqual([nfd]);
	});

	it("still deletes a departed file whose name resembles nothing published", async () => {
		const dest = await makeTree({ "gone.md": "old" });

		const plan = await computeSyncPlan({
			destination: dest,
			manifest: [entry("readme.md", "new")],
			lock: lockOf({ "gone.md": { contents: "old" } }),
		});

		expect(plan.deletes.map((d) => d.path)).toEqual(["gone.md"]);
		expect(plan.keptRenamed).toHaveLength(0);
	});

	/**
	 * Review round 2, finding 8. `readFile` follows a link, so a symlink
	 * pointing at a file holding the published bytes hashed EQUAL and the
	 * entry became `verified`: no write, no check, and a lock written over a
	 * path that is not a file.
	 */
	it("refuses a symlink standing at a manifest path", async () => {
		const dest = await makeTree({ "real.md": "published" });
		const { symlink } = await import("node:fs/promises");
		await symlink(path.join(dest, "real.md"), path.join(dest, "AGENTS.md"));

		await expect(
			computeSyncPlan({
				destination: dest,
				manifest: [entry("AGENTS.md", "published")],
				lock: null,
			}),
		).rejects.toThrow(/symlink/);
	});

	it("refuses a directory standing at a manifest path", async () => {
		const dest = await makeTree();
		await mkdir(path.join(dest, "AGENTS.md"));

		await expect(
			computeSyncPlan({
				destination: dest,
				manifest: [entry("AGENTS.md", "x")],
				lock: null,
			}),
		).rejects.toThrow(/not a regular file/);
	});

	it("carries the locked hash on every delete, for the unlink to prove", async () => {
		const dest = await makeTree({ "gone.md": "old" });

		const plan = await computeSyncPlan({
			destination: dest,
			manifest: [],
			lock: lockOf({ "gone.md": { contents: "old" } }),
		});

		expect(plan.deletes[0]?.sha256).toBe(sha256("old"));
	});

	it("refuses a lock naming two paths it cannot tell apart", async () => {
		const dest = await makeTree();
		const lock = lockOf({ "README.md": { contents: "x" } });
		lock.files["readme.md"] = { sha256: sha256("x"), mode: null };

		await expect(
			computeSyncPlan({ destination: dest, manifest: [], lock }),
		).rejects.toThrow(/name the same file/);
	});
});

/**
 * Review round 3, finding 2. `ENOTDIR` means an ancestor exists and is not a
 * directory, which is not the same as "absent". Reading the two alike let a
 * regular file at `z` pass the whole-plan preflight for `z/child.md`.
 */
describe("a non-directory ancestor", () => {
	it("is refused while planning, not after part of the tree is written", async () => {
		const dest = await makeTree({ z: "I am a file, not a directory" });

		await expect(
			computeSyncPlan({
				destination: dest,
				manifest: [
					entry("a.md", "first"),
					entry("z/child.md", "second"),
				],
				lock: null,
			}),
		).rejects.toThrow(/not a directory/);
	});
});

/**
 * Review round 3, finding 1. The server's "unchanged" is about the SNAPSHOT;
 * this is the local half of the question.
 */
describe("verifyLedger", () => {
	it("reports nothing when the tree matches the lock", async () => {
		const dest = await makeTree({ "AGENTS.md": "same" });

		expect(
			await verifyLedger({
				root: dest,
				lock: lockOf({ "AGENTS.md": { contents: "same" } }),
			}),
		).toEqual([]);
	});

	it("reports an edited file", async () => {
		const dest = await makeTree({ "AGENTS.md": "edited" });

		const drift = await verifyLedger({
			root: dest,
			lock: lockOf({ "AGENTS.md": { contents: "published" } }),
		});

		expect(drift).toEqual(["AGENTS.md (edited)"]);
	});

	it("reports a deleted file", async () => {
		const dest = await makeTree();

		expect(
			await verifyLedger({
				root: dest,
				lock: lockOf({ "AGENTS.md": { contents: "published" } }),
			}),
		).toEqual(["AGENTS.md (missing)"]);
	});

	it("reports a mode that drifted", async () => {
		const dest = await makeTree({ "script.sh": "#!" });
		const { chmod } = await import("node:fs/promises");
		await chmod(path.join(dest, "script.sh"), 0o644);

		const drift = await verifyLedger({
			root: dest,
			lock: lockOf({ "script.sh": { contents: "#!", mode: 0o100755 } }),
		});

		expect(drift).toEqual(["script.sh (mode 644, published as 755)"]);
	});

	/**
	 * Delta review, finding 1. `verifyLedger` used to join and read lock paths
	 * before anything validated them, so a crafted lock reached outside the
	 * destination on the one path that skips planning entirely.
	 */
	it("refuses a lock path that climbs out of the destination, reading nothing", async () => {
		const dest = await makeTree();
		const outside = await makeTree({ "secret.md": "not yours" });
		const lock = lockOf({ "here.md": { contents: "x" } });
		lock.files["../outside/secret.md"] = {
			sha256: sha256("not yours"),
			mode: null,
		};

		await expect(verifyLedger({ root: dest, lock })).rejects.toThrow(
			/traversal/,
		);
		// And the file it named is untouched.
		expect(await readFile(path.join(outside, "secret.md"), "utf8")).toBe(
			"not yours",
		);
	});

	it("refuses to follow a symlinked ANCESTOR, not just a symlinked file", async () => {
		const dest = await makeTree();
		const outside = await makeTree({ "AGENTS.md": "published" });
		const { symlink } = await import("node:fs/promises");
		await symlink(outside, path.join(dest, "rules"), "dir");

		const drift = await verifyLedger({
			root: dest,
			lock: lockOf({ "rules/AGENTS.md": { contents: "published" } }),
		});

		// Bytes and mode would have matched through the link, so this is
		// exactly the case that used to answer "up to date".
		expect(drift).toHaveLength(1);
		expect(drift[0]).toMatch(/symlink/);
	});

	it("refuses the same ancestor symlink when the plan is recomputed", async () => {
		const dest = await makeTree();
		const outside = await makeTree({ "AGENTS.md": "published" });
		const { symlink } = await import("node:fs/promises");
		await symlink(outside, path.join(dest, "rules"), "dir");

		await expect(
			computeSyncPlan({
				destination: dest,
				manifest: [entry("rules/AGENTS.md", "published")],
				lock: null,
			}),
		).rejects.toThrow(/symlink/);
	});

	it("reports a symlink standing in for a file, rather than throwing", async () => {
		const dest = await makeTree({ "real.md": "published" });
		const { symlink } = await import("node:fs/promises");
		await symlink(path.join(dest, "real.md"), path.join(dest, "AGENTS.md"));

		const drift = await verifyLedger({
			root: dest,
			lock: lockOf({ "AGENTS.md": { contents: "published" } }),
		});

		expect(drift).toHaveLength(1);
		expect(drift[0]).toMatch(/^AGENTS\.md \(refusing to follow a symlink/);
	});
});

describe("nextLock", () => {
	it("records a path named __proto__ as an ordinary entry", () => {
		const lock = nextLock({
			projectId: "project-1",
			snapshot: { id: "snap-2", version: 7, digest: "d".repeat(64) },
			manifest: [entry("__proto__", "x"), entry("constructor", "y")],
		});

		expect(Object.keys(lock.files).sort()).toEqual([
			"__proto__",
			"constructor",
		]);
		expect(JSON.parse(JSON.stringify(lock)).files.__proto__.sha256).toBe(
			sha256("x"),
		);
	});

	it("records every manifest path with its published hash and mode", () => {
		const lock = nextLock({
			projectId: "project-1",
			snapshot: { id: "snap-2", version: 7, digest: "d".repeat(64) },
			manifest: [
				entry("AGENTS.md", "new"),
				entry("script.sh", "#!", 33261),
			],
			now: new Date("2026-09-17T10:00:00.000Z"),
		});

		expect(lock).toEqual({
			version: 3,
			projectId: "project-1",
			snapshotId: "snap-2",
			snapshotVersion: 7,
			digest: "d".repeat(64),
			syncedAt: "2026-09-17T10:00:00.000Z",
			files: {
				"AGENTS.md": { sha256: sha256("new"), mode: 33188 },
				"script.sh": { sha256: sha256("#!"), mode: 33261 },
			},
		});
	});

	// Fizzy #2709: the lock carries the published snapshot's provenance
	// through, unchanged, so a later sync can report it.
	it("carries the snapshot's source into the lock", () => {
		const lock = nextLock({
			projectId: "project-1",
			snapshot: {
				id: "snap-2",
				version: 7,
				digest: "d".repeat(64),
				source: {
					kind: "REPOSITORY",
					ref: "main",
					commitSha: "a".repeat(40),
					current: true,
				},
			},
			manifest: [entry("AGENTS.md", "new")],
			now: new Date("2026-09-17T10:00:00.000Z"),
		});

		expect(lock.source).toEqual({
			kind: "REPOSITORY",
			ref: "main",
			commitSha: "a".repeat(40),
			current: true,
		});
	});

	it("omits source entirely when the snapshot has none", () => {
		const lock = nextLock({
			projectId: "project-1",
			snapshot: { id: "snap-2", version: 7, digest: "d".repeat(64) },
			manifest: [entry("AGENTS.md", "new")],
		});

		expect(lock).not.toHaveProperty("source");
	});
});

/**
 * Spec §6.4 (Fizzy #2540). A local edit to a still-published file is the
 * developer's. Keeping it is the caller's choice, so the planner's default
 * stays `replaced` for every other caller.
 */
describe("keeping local edits", () => {
	it("keeps a locally edited file instead of replacing it", async () => {
		const dest = await makeTree({ "AGENTS.md": "my own edit" });

		const plan = await computeSyncPlan(
			{
				destination: dest,
				manifest: [entry("AGENTS.md", "new")],
				lock: lockOf({ "AGENTS.md": { contents: "old" } }),
			},
			{ keepLocalEdits: true },
		);

		expect(actionOf(plan, "AGENTS.md")).toBe("kept-edited");
		expect(plan.writes).toEqual([]);
		expect(plan.keptEdited).toEqual([
			{
				path: "AGENTS.md",
				action: "kept-edited",
				sha256: sha256("new"),
				mode: 33188,
				localSha256: sha256("my own edit"),
			},
		]);
	});

	it("records the hash each planned write saw, so the write can tell a later save (Decision 37)", async () => {
		const dest = await makeTree({ "rules/a.md": "old" });

		const plan = await computeSyncPlan(
			{
				destination: dest,
				manifest: [
					entry("rules/a.md", "newer"),
					entry("rules/b.md", "new"),
				],
				lock: lockOf({ "rules/a.md": { contents: "old" } }),
			},
			{ keepLocalEdits: true },
		);

		expect(
			plan.writes.map((w) => [w.path, w.action, w.localSha256]),
		).toEqual([
			["rules/a.md", "updated", sha256("old")],
			["rules/b.md", "added", null],
		]);
	});

	it("keeps a file that was there before the first sync", async () => {
		const dest = await makeTree({ "CLAUDE.md": "written by hand" });

		const plan = await computeSyncPlan(
			{
				destination: dest,
				manifest: [entry("CLAUDE.md", "published")],
				lock: null,
			},
			{ keepLocalEdits: true },
		);

		expect(actionOf(plan, "CLAUDE.md")).toBe("kept-edited");
	});

	it("still writes new files and the sync's own files while keeping an edit", async () => {
		const dest = await makeTree({
			"AGENTS.md": "my own edit",
			"rules/a.md": "old",
		});

		const plan = await computeSyncPlan(
			{
				destination: dest,
				manifest: [
					entry("AGENTS.md", "new"),
					entry("rules/a.md", "newer"),
					entry("rules/b.md", "brand new"),
				],
				lock: lockOf({
					"AGENTS.md": { contents: "old" },
					"rules/a.md": { contents: "old" },
				}),
			},
			{ keepLocalEdits: true },
		);

		expect(plan.writes.map((w) => [w.path, w.action])).toEqual([
			["rules/a.md", "updated"],
			["rules/b.md", "added"],
		]);
		expect(plan.keptEdited.map((k) => k.path)).toEqual(["AGENTS.md"]);
	});

	it("replaces the edit when keeping is not asked for", async () => {
		const dest = await makeTree({ "AGENTS.md": "my own edit" });

		const plan = await computeSyncPlan({
			destination: dest,
			manifest: [entry("AGENTS.md", "new")],
			lock: lockOf({ "AGENTS.md": { contents: "old" } }),
		});

		expect(actionOf(plan, "AGENTS.md")).toBe("replaced");
		expect(plan.keptEdited).toEqual([]);
	});

	it("records the published hash with a kept marker for a kept path", () => {
		const lock = nextLock({
			projectId: "project-1",
			snapshot: { id: "snap-2", version: 7, digest: "d".repeat(64) },
			manifest: [
				entry("AGENTS.md", "published"),
				entry("rules/a.md", "a"),
			],
			kept: ["AGENTS.md"],
		});

		expect(lock.files).toEqual({
			"AGENTS.md": {
				sha256: sha256("published"),
				mode: 33188,
				kept: true,
			},
			"rules/a.md": { sha256: sha256("a"), mode: 33188 },
		});
	});

	it("marks only the named paths, at the current lock version, when the lock is rewritten without a manifest (Decision 41)", () => {
		const lock = lockOf({
			"AGENTS.md": { contents: "published" },
			"rules/a.md": { contents: "a" },
		});

		const reconciled = reconcileKeptInLock(lock, ["AGENTS.md"]);

		expect(reconciled).toEqual({
			changed: true,
			lock: {
				...lock,
				// Rewritten at the current lock version (Decision 38; Fizzy #2709).
				version: LOCK_VERSION,
				files: {
					"AGENTS.md": {
						sha256: sha256("published"),
						mode: 33188,
						kept: true,
					},
					"rules/a.md": { sha256: sha256("a"), mode: 33188 },
				},
			},
		});
		// A copy: the lock that was read is not changed under its reader.
		expect(lock.version).toBe(1);
		expect(lock.files["AGENTS.md"]).toEqual({
			sha256: sha256("published"),
			mode: 33188,
		});
	});

	it("drops a marker whose file is no longer an edit, and changes nothing when every marker is already right (Decision 41)", () => {
		const { lock: kept } = reconcileKeptInLock(
			lockOf({
				"AGENTS.md": { contents: "published" },
				"rules/a.md": { contents: "a" },
			}),
			["AGENTS.md"],
		);

		// The developer put the published bytes back by hand.
		const restored = reconcileKeptInLock(kept, []);
		expect(restored.changed).toBe(true);
		expect(restored.lock.files["AGENTS.md"]).toEqual({
			sha256: sha256("published"),
			mode: 33188,
		});

		// The same edit, seen again.
		expect(reconcileKeptInLock(kept, ["AGENTS.md"]).changed).toBe(false);
	});

	it("labels an edit the lock records as kept", async () => {
		const dest = await makeTree({
			"AGENTS.md": "my note",
			"rules/a.md": "edited since",
		});
		const { lock } = reconcileKeptInLock(
			lockOf({
				"AGENTS.md": { contents: "published" },
				"rules/a.md": { contents: "a" },
			}),
			["AGENTS.md"],
		);

		expect(await findLedgerDrift({ root: dest, lock })).toEqual([
			{ path: "AGENTS.md", reason: "edited", detail: "kept", kept: true },
			{
				path: "rules/a.md",
				reason: "edited",
				detail: "edited",
				kept: false,
			},
		]);
		expect(await verifyLedger({ root: dest, lock })).toEqual([
			"AGENTS.md (kept)",
			"rules/a.md (edited)",
		]);
	});

	/**
	 * Review finding 1 (Fizzy #2540). On a case-insensitive filesystem,
	 * reading the manifest's own spelling ("readme.md") returns the bytes the
	 * lock recorded under the OLD spelling ("README.md"), because there both
	 * names are one file. Without a collision-key fallback that lock entry is
	 * invisible under the new spelling, so the read looks like a local edit
	 * with nothing to compare against — and in keep mode the rename's write
	 * never happens, leaving the file stale until `--repair`. Simulated with
	 * a real file at the manifest's own spelling holding the OLD bytes, so
	 * this proves the same thing on Linux's case-sensitive filesystem too,
	 * without depending on the host OS.
	 */
	it("treats a case-only rename as the update it is, not a kept local edit", async () => {
		const dest = await makeTree({ "readme.md": "old" });

		const plan = await computeSyncPlan(
			{
				destination: dest,
				manifest: [entry("readme.md", "new")],
				lock: lockOf({ "README.md": { contents: "old" } }),
			},
			{ keepLocalEdits: true },
		);

		expect(actionOf(plan, "readme.md")).toBe("updated");
		expect(plan.keptRenamed.map((k) => k.path)).toEqual(["README.md"]);
		expect(plan.keptEdited).toEqual([]);
	});
});
