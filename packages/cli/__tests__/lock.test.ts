/**
 * The lock file (Fizzy #2539) — the sync's content ledger and its permission
 * to delete.
 *
 * Two properties matter. It must round-trip exactly, and a lock that does not
 * validate must be an ERROR rather than a `null`: treating a damaged ledger
 * as "never synced" would orphan every file the previous sync wrote and hide
 * the damage. Every field is checked, because a partially-read ledger is how
 * a delete gets authorised by a file nobody validated.
 */
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	type InstructionsLock,
	LOCK_DIRECTORY,
	LOCK_FILENAME,
	LOCK_VERSION,
	lockPath,
	readLock,
	writeLock,
} from "../src/lib/instructions/lock.js";
import { resolveDestinationRoot } from "../src/lib/instructions/safe-write.js";

async function makeTree(): Promise<string> {
	return resolveDestinationRoot(
		await mkdtemp(path.join(tmpdir(), "fabric-lock-")),
	);
}

function sampleLock(
	overrides: Partial<InstructionsLock> = {},
): InstructionsLock {
	return {
		version: 1,
		projectId: "project-1",
		snapshotId: "snap-2",
		snapshotVersion: 7,
		digest: "d".repeat(64),
		syncedAt: "2026-09-17T10:00:00.000Z",
		files: {
			"AGENTS.md": { sha256: "a".repeat(64), mode: 33188 },
			".claude/skills/review/SKILL.md": {
				sha256: "b".repeat(64),
				mode: null,
			},
		},
		...overrides,
	};
}

async function writeRawLock(root: string, body: string): Promise<void> {
	await mkdir(path.join(root, LOCK_DIRECTORY), { recursive: true });
	await writeFile(lockPath(root), body, "utf8");
}

describe("lock round-trip", () => {
	it("writes under .fabric/ and reads back exactly", async () => {
		const root = await makeTree();
		const lock = sampleLock();

		await writeLock(root, lock);

		expect(lockPath(root)).toBe(
			path.join(root, LOCK_DIRECTORY, LOCK_FILENAME),
		);
		await expect(readLock(root)).resolves.toEqual(lock);
	});

	it("writes pretty JSON with LF endings and a trailing newline", async () => {
		const root = await makeTree();

		await writeLock(root, sampleLock());

		const raw = await readFile(lockPath(root), "utf8");
		expect(raw).not.toContain("\r");
		expect(raw.endsWith("}\n")).toBe(true);
		expect(raw.split("\n")[1]).toBe('  "version": 1,');
	});

	it("reports a tree that has never been synced as null", async () => {
		await expect(readLock(await makeTree())).resolves.toBeNull();
	});

	/**
	 * The lock write used to bypass the path guard entirely, so `.fabric -> ..`
	 * wrote the ledger outside the checkout.
	 */
	it("refuses to write through a symlinked .fabric", async () => {
		const root = await makeTree();
		const outside = await makeTree();
		const { symlink, readdir } = await import("node:fs/promises");
		await symlink(outside, path.join(root, LOCK_DIRECTORY), "dir");

		await expect(writeLock(root, sampleLock())).rejects.toThrow(/symlink/);
		expect(await readdir(outside)).toEqual([]);
	});
});

/**
 * Review round 3, finding 7. `files["__proto__"] = entry` sets the prototype
 * instead of creating an own property, so a published file with that name was
 * written to disk and left out of the ledger — and a later snapshot that
 * dropped it could not prove the sync had created it.
 */
describe("paths that collide with Object.prototype", () => {
	it("round-trips __proto__ and constructor as ordinary entries", async () => {
		const root = await makeTree();
		const lock = sampleLock({
			files: Object.fromEntries([
				["__proto__", { sha256: "a".repeat(64), mode: 33188 }],
				["constructor", { sha256: "b".repeat(64), mode: null }],
				["toString", { sha256: "c".repeat(64), mode: null }],
			]),
		});

		await writeLock(root, lock);
		const read = await readLock(root);

		expect(Object.keys(read?.files ?? {}).sort()).toEqual([
			"__proto__",
			"constructor",
			"toString",
		]);
		expect(read?.files.__proto__?.sha256).toBe("a".repeat(64));
		expect(await readFile(lockPath(root), "utf8")).toContain("__proto__");
	});
});

describe("a lock that does not validate", () => {
	it("is an error, never a silent 'never synced'", async () => {
		const root = await makeTree();
		await writeRawLock(root, "{ not json");

		await expect(readLock(root)).rejects.toThrow(
			/unreadable: it is not valid JSON/,
		);
	});

	it.each([
		[
			"a version this build does not read",
			JSON.stringify({ ...sampleLock(), version: 3 }),
			/its version is 3 and this build reads versions 1 and 2/,
		],
		[
			"a missing projectId",
			JSON.stringify({ ...sampleLock(), projectId: undefined }),
			/"projectId" is not a non-empty string/,
		],
		[
			"an empty digest",
			JSON.stringify({ ...sampleLock(), digest: "" }),
			/"digest" is not a non-empty string/,
		],
		[
			"a non-integer snapshotVersion",
			JSON.stringify({ ...sampleLock(), snapshotVersion: "seven" }),
			/"snapshotVersion" is not a non-negative integer/,
		],
		[
			"files as an array",
			JSON.stringify({ ...sampleLock(), files: [] }),
			/"files" is not an object/,
		],
		[
			"an entry that is not an object",
			JSON.stringify({ ...sampleLock(), files: { "a.md": "hash" } }),
			/entry for "a\.md" is not an object/,
		],
		[
			"a hash that is not 64 hex characters",
			JSON.stringify({
				...sampleLock(),
				files: { "a.md": { sha256: "abc", mode: null } },
			}),
			/no 64-character hex sha256/,
		],
		[
			"a hash with non-hex characters",
			JSON.stringify({
				...sampleLock(),
				files: { "a.md": { sha256: "z".repeat(64), mode: null } },
			}),
			/no 64-character hex sha256/,
		],
		[
			"a mode that is a string",
			JSON.stringify({
				...sampleLock(),
				files: { "a.md": { sha256: "a".repeat(64), mode: "755" } },
			}),
			/neither null nor a non-negative integer/,
		],
		["a JSON array", "[1, 2, 3]", /it is not a JSON object/],
	])("refuses %s", async (_label, body, matcher) => {
		const root = await makeTree();
		await writeRawLock(root, body);

		await expect(readLock(root)).rejects.toThrow(matcher);
	});
});

/**
 * What every released build (lock version 1) does with a lock this build
 * writes, frozen here as released (`lockProblem` and `parseLock`,
 * `lock.ts:98-104` and `:191-192` before this change) because the released
 * code cannot be imported. Anything but version 1 is refused whole, and the
 * error stops `sync`, in hook mode too, before a plan exists.
 */
function releasedV1Refusal(text: string): string | null {
	const { version } = JSON.parse(text) as { version?: unknown };
	return version === 1
		? null
		: `.fabric/instructions.lock is unreadable: its version is ${JSON.stringify(version)} and this build writes version 1. Delete it to start from a clean sync.`;
}

/**
 * Spec §6.4, Decision 38. Version 2 adds one optional entry field, `kept`,
 * with one value. This build reads versions 1 and 2 and writes 2, so a
 * released build, which cannot see the marker, never acts on a lock that
 * carries one: it refuses the whole file and writes nothing.
 */
describe("lock version 2 and the kept marker", () => {
	it("round-trips a version 2 lock with a kept entry", async () => {
		const root = await makeTree();
		const lock = sampleLock({
			version: 2,
			files: {
				"AGENTS.md": {
					sha256: "a".repeat(64),
					mode: 33188,
					kept: true,
				},
			},
		});

		await writeLock(root, lock);

		await expect(readLock(root)).resolves.toEqual(lock);
	});

	it("still reads a version 1 lock, as every released build wrote it", async () => {
		const root = await makeTree();
		await writeRawLock(root, JSON.stringify(sampleLock()));

		await expect(readLock(root)).resolves.toEqual(sampleLock());
	});

	it.each([
		["false", false],
		["a string", "true"],
		["null", null],
	])("refuses kept as %s", async (_label, kept) => {
		const root = await makeTree();
		await writeRawLock(
			root,
			JSON.stringify({
				...sampleLock(),
				version: 2,
				files: { "a.md": { sha256: "a".repeat(64), mode: null, kept } },
			}),
		);

		await expect(readLock(root)).rejects.toThrow(
			/entry for "a\.md" has a "kept" that is not true/,
		);
	});

	it("refuses a kept marker in a version 1 lock, which no released build would honour", async () => {
		const root = await makeTree();
		await writeRawLock(
			root,
			JSON.stringify({
				...sampleLock(),
				files: {
					"a.md": { sha256: "a".repeat(64), mode: null, kept: true },
				},
			}),
		);

		await expect(readLock(root)).rejects.toThrow(
			/entry for "a\.md" has a "kept" marker, which a version 1 lock cannot carry/,
		);
	});

	it("is refused whole by every released build, which therefore never overwrites a kept edit (Decision 38)", async () => {
		const root = await makeTree();
		await writeLock(
			root,
			sampleLock({
				version: LOCK_VERSION,
				files: {
					"AGENTS.md": {
						sha256: "a".repeat(64),
						mode: 33188,
						kept: true,
					},
				},
			}),
		);

		expect(LOCK_VERSION).toBe(2);
		expect(releasedV1Refusal(await readFile(lockPath(root), "utf8"))).toBe(
			".fabric/instructions.lock is unreadable: its version is 2 and this build writes version 1. Delete it to start from a clean sync.",
		);
	});
});
