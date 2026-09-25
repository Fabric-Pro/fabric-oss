/**
 * `readLockSafely` — the lock read for a reader that must not be steered
 * outside the checkout (`fabric instructions doctor`).
 *
 * `readLock` opens the lock with a plain `readFile`, which follows a
 * symlinked `.fabric` or lock to wherever it points. The safe reader goes
 * through `readFileSafely` and must:
 *
 *  - read exactly what `readLock` reads for an ordinary lock, and validate it
 *    with the same `parseLock` (same messages);
 *  - refuse a symlinked `.fabric`, a symlinked lock, a lock that is not a
 *    regular file, and a lock over the bound, as `LockReadRefusedError`,
 *    before a byte of it is parsed.
 */
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	type InstructionsLock,
	LOCK_DIRECTORY,
	LockReadRefusedError,
	lockPath,
	parseLock,
	readLock,
	readLockSafely,
	writeLock,
} from "../src/lib/instructions/lock.js";
import { isTooLarge } from "../src/lib/instructions/mcp-config.js";
import {
	readFileSafely,
	resolveDestinationRoot,
} from "../src/lib/instructions/safe-write.js";

const BOUND = { maxBytes: 1024 * 1024 };

async function makeTree(): Promise<string> {
	return resolveDestinationRoot(
		await mkdtemp(path.join(tmpdir(), "fabric-lock-safe-")),
	);
}

function sampleLock(): InstructionsLock {
	return {
		version: 1,
		projectId: "project-1",
		snapshotId: "snap-2",
		snapshotVersion: 7,
		digest: "d".repeat(64),
		syncedAt: "2026-09-17T10:00:00.000Z",
		files: {
			"AGENTS.md": { sha256: "a".repeat(64), mode: 33188 },
		},
	};
}

async function refusal(root: string): Promise<LockReadRefusedError> {
	const error = await readLockSafely(root, BOUND).then(
		() => null,
		(caught: unknown) => caught,
	);
	expect(error).toBeInstanceOf(LockReadRefusedError);
	return error as LockReadRefusedError;
}

describe("readLockSafely", () => {
	it("reads the lock writeLock wrote, exactly as readLock does", async () => {
		const root = await makeTree();
		await writeLock(root, sampleLock());

		// The reserved `.fabric` root is not refused by the guarded reader:
		// it enforces filesystem invariants, not the manifest's path policy.
		await expect(
			readFileSafely(root, `${LOCK_DIRECTORY}/instructions.lock`, BOUND),
		).resolves.not.toBeNull();
		await expect(readLockSafely(root, BOUND)).resolves.toEqual(
			await readLock(root),
		);
		await expect(readLockSafely(root, BOUND)).resolves.toEqual(
			sampleLock(),
		);
	});

	it("answers null for a tree that was never synced", async () => {
		await expect(
			readLockSafely(await makeTree(), BOUND),
		).resolves.toBeNull();
	});

	it("rejects an invalid lock with readLock's own message", async () => {
		const root = await makeTree();
		await mkdir(path.join(root, LOCK_DIRECTORY));
		await writeFile(lockPath(root), `{"version": 1`, "utf8");

		const safe = await readLockSafely(root, BOUND).catch(
			(error: Error) => error,
		);
		const plain = await readLock(root).catch((error: Error) => error);

		expect(safe).not.toBeInstanceOf(LockReadRefusedError);
		expect((safe as Error).message).toBe((plain as Error).message);
		expect((safe as Error).message).toMatch(
			/unreadable: it is not valid JSON/,
		);
	});

	it("refuses a symlinked .fabric directory that readLock would follow", async () => {
		const root = await makeTree();
		const outside = await makeTree();
		await writeLock(outside, sampleLock());
		await symlink(
			path.join(outside, LOCK_DIRECTORY),
			path.join(root, LOCK_DIRECTORY),
			"dir",
		);

		// The property being closed: the plain reader follows the link.
		await expect(readLock(root)).resolves.toEqual(sampleLock());
		await refusal(root);
	});

	it("refuses a symlinked lock file", async () => {
		const root = await makeTree();
		const outside = await makeTree();
		await writeLock(outside, sampleLock());
		await mkdir(path.join(root, LOCK_DIRECTORY));
		await symlink(lockPath(outside), lockPath(root));

		await expect(readLock(root)).resolves.toEqual(sampleLock());
		await refusal(root);
	});

	it("refuses a lock that is not a regular file", async () => {
		const root = await makeTree();
		await mkdir(lockPath(root), { recursive: true });

		await refusal(root);
	});

	it("refuses a lock over the bound before parsing it, and says it was the size", async () => {
		const root = await makeTree();
		await mkdir(path.join(root, LOCK_DIRECTORY));
		// A VALID lock padded past the bound: only the bound can refuse it.
		const padded = `${JSON.stringify(sampleLock())}${" ".repeat(BOUND.maxBytes)}`;
		await writeFile(lockPath(root), padded, "utf8");

		await expect(readLock(root)).resolves.toEqual(sampleLock());
		const error = await refusal(root);
		expect(isTooLarge(error.cause)).toBe(true);
	});

	// Fizzy #2709: the safe reader must see a version 3 lock, with or
	// without `source`, exactly as `readLock` does.
	it("reads a version 3 lock with a source exactly as readLock does", async () => {
		const root = await makeTree();
		const lock: InstructionsLock = {
			...sampleLock(),
			version: 3,
			source: {
				kind: "REPOSITORY",
				ref: "main",
				commitSha: "a".repeat(40),
				current: true,
			},
		};
		await writeLock(root, lock);

		await expect(readLockSafely(root, BOUND)).resolves.toEqual(
			await readLock(root),
		);
		await expect(readLockSafely(root, BOUND)).resolves.toEqual(lock);
	});

	it("reads a version 3 lock with no source exactly as readLock does", async () => {
		const root = await makeTree();
		const lock: InstructionsLock = { ...sampleLock(), version: 3 };
		await writeLock(root, lock);

		await expect(readLockSafely(root, BOUND)).resolves.toEqual(
			await readLock(root),
		);
		await expect(readLockSafely(root, BOUND)).resolves.toEqual(lock);
	});
});

describe("parseLock", () => {
	it("names the lock's relative path when no source is given", () => {
		expect(() => parseLock("[]")).toThrow(
			".fabric/instructions.lock is unreadable: it is not a JSON object. Delete it to start from a clean sync.",
		);
	});

	it("round-trips what writeLock serialises", () => {
		expect(parseLock(`${JSON.stringify(sampleLock(), null, 2)}\n`)).toEqual(
			sampleLock(),
		);
	});
});
