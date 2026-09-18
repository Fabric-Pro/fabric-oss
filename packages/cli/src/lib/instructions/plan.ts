/**
 * What a sync would do, decided against the LOCAL TREE and not only the lock.
 *
 * The lock says what the last sync wrote; the working tree says what is
 * actually there now. Planning from the lock alone gets both interesting
 * cases wrong — a file the developer edited since the sync would be silently
 * overwritten with no notice, and a file they deleted would never come back
 * because the lock still claims it is present. So every path is hashed.
 *
 * Seven outcomes, and the distinctions between them are the whole point:
 *
 *   verified        local bytes already equal the published bytes — no write
 *   added           nothing local — a new file
 *   updated         local matches the lock, so this is the sync's own file
 *                   moving forward
 *   replaced        local matches neither the lock nor the manifest — local
 *                   edits are about to be overwritten, and the report says so
 *   deleted         gone from the manifest, and local still matches the lock,
 *                   so the sync wrote it and may remove it
 *   kept-modified   gone from the manifest, but local differs from the lock —
 *                   the developer changed it, so it stays
 *   kept-renamed    gone from the manifest under this spelling, but the
 *                   manifest names the same physical file another way — the
 *                   write for the new spelling is the update, so the old one
 *                   must not be unlinked afterwards
 *
 * A path absent from the lock is never deleted, whatever it is — and a
 * reserved path (`.git/`, `.fabric/`, the tool's own Claude settings file) is
 * refused outright wherever it appears, because the lock is an unauthenticated
 * file in the checkout (see `lock.ts`) and those are the paths a tampered one
 * would most want to name.
 */
import { createHash } from "node:crypto";
import type { InstructionManifestEntry } from "@fabricorg/sdk";
import { type InstructionsLock, LOCK_VERSION } from "./lock.js";
import {
	checkRelativePath,
	collisionKey,
	describeRejection,
	findCollision,
	isReservedPath,
} from "./paths.js";
import { readFileSafely } from "./safe-write.js";

type PlanAction =
	| "verified"
	| "added"
	| "updated"
	| "replaced"
	| "deleted"
	| "kept-modified"
	| "kept-renamed";

export interface PlanEntry {
	path: string;
	action: PlanAction;
	/** The published hash, for everything the manifest still carries. */
	sha256?: string;
	mode?: number | null;
}

export interface SyncPlan {
	entries: PlanEntry[];
	/** Entries whose bytes must be fetched and written. */
	writes: PlanEntry[];
	/** Entries to unlink. Always a subset of the previous lock. */
	deletes: PlanEntry[];
	verified: PlanEntry[];
	keptModified: PlanEntry[];
	/**
	 * Lock paths that are the same physical file as a manifest path under a
	 * different spelling. Never deleted; reported so the old spelling is not
	 * a surprise on the filesystems where it survives.
	 */
	keptRenamed: PlanEntry[];
}

/**
 * Hex sha256 of a local file, or `null` when nothing is there.
 *
 * Every read goes through `readFileSafely`, the same guarded walk the writes
 * use: no symlinked component anywhere on the way down, nothing resolving
 * outside the destination, a regular file or nothing at all. A link pointing
 * at a file that happens to hold the published bytes used to hash EQUAL and
 * become `verified` — no write, no check, and a lock written over a path that
 * is not a file.
 */
async function hashLocalFile(
	root: string,
	relativePath: string,
): Promise<string | null> {
	const read = await readFileSafely(root, relativePath);
	return read === null
		? null
		: createHash("sha256").update(read.bytes).digest("hex");
}

function lockPaths(lock: InstructionsLock | null): string[] {
	return lock === null ? [] : Object.keys(lock.files);
}

/**
 * Every path the lock names has to survive the same checks a manifest path
 * does, plus the reserved-root rule — a hand-edited or accidentally
 * committed lock is exactly how `.git/config` would otherwise become an
 * unlink target with a hash anyone can read off disk.
 */
function assertSafeLockPaths(paths: readonly string[]): void {
	for (const lockedPath of paths) {
		const check = checkRelativePath(lockedPath);
		if (!check.ok) {
			throw new Error(
				`Refusing to sync: ${describeRejection(check)}. The lock names a path this tool will not touch.`,
			);
		}
		if (isReservedPath(lockedPath)) {
			throw new Error(
				`Refusing to sync: ${describeRejection({
					ok: false,
					reason: "reserved_path",
					detail: lockedPath,
				})}. The lock names a path this tool will not touch.`,
			);
		}
	}
	const collision = findCollision(paths);
	if (collision !== null) {
		throw new Error(
			`Refusing to sync: ${describeRejection({
				ok: false,
				reason: "collision",
				detail: `${collision.first} and ${collision.second}`,
			})}. The lock names two paths this tool cannot tell apart.`,
		);
	}
}

/**
 * Does the working tree still hold what the lock says it holds?
 *
 * The server answers "unchanged" by comparing digests, and a digest describes
 * the PUBLISHED snapshot — it says nothing about the checkout. Accepting that
 * answer as "nothing to do" meant an edited, deleted or chmod-ed instruction
 * file stayed that way until some later publication happened to move the
 * digest. For a feature whose point is that an agent reads the same
 * instructions everyone else does, that is the failure that matters most:
 * tampering persists and the tool reports success.
 *
 * Returns the paths that no longer match, as reasons a person can act on.
 * Never throws: a symlink or a directory standing where a file should be is
 * drift to REPORT, and the re-plan that follows is what refuses it.
 */
export async function verifyLedger(input: {
	/** An already-canonical root — `resolveDestinationRoot` or `resolveExistingRoot`. */
	root: string;
	lock: InstructionsLock;
}): Promise<string[]> {
	// FIRST, before a single path is joined or opened. This function reads
	// paths that come out of an unauthenticated file in the checkout, and it
	// used to read them raw: `../outside` reached outside the destination, and
	// `rules/` replaced by a symlink was followed wherever it pointed. The
	// same validation `computeSyncPlan` runs, run before anything is touched.
	assertSafeLockPaths(lockPaths(input.lock));

	const drifted: string[] = [];
	for (const [lockedPath, locked] of Object.entries(input.lock.files)) {
		// A refusal from the guarded reader — a symlinked ancestor, a
		// directory where a file belongs — is drift, not a crash: the caller
		// re-plans, and planning refuses it there with the same message.
		let read: Awaited<ReturnType<typeof readFileSafely>>;
		try {
			read = await readFileSafely(input.root, lockedPath);
		} catch (error) {
			drifted.push(
				`${lockedPath} (${error instanceof Error ? error.message.replace(/^Refusing to sync: /, "").replace(/\.$/, "") : String(error)})`,
			);
			continue;
		}
		if (read === null) {
			drifted.push(`${lockedPath} (missing)`);
			continue;
		}
		const actual = createHash("sha256").update(read.bytes).digest("hex");
		if (actual !== locked.sha256) {
			drifted.push(`${lockedPath} (edited)`);
			continue;
		}
		// Modes are meaningless on Windows and a published `0755` that arrived
		// as `0644` leaves a script that will not run, so this is checked
		// wherever it can be.
		if (
			process.platform !== "win32" &&
			locked.mode !== null &&
			(read.mode & 0o7777) !== (locked.mode & 0o7777)
		) {
			drifted.push(
				`${lockedPath} (mode ${(read.mode & 0o7777).toString(8)}, published as ${(locked.mode & 0o7777).toString(8)})`,
			);
		}
	}
	return drifted;
}

export async function computeSyncPlan(input: {
	/** An already-canonical root, as every guarded read resolves against it. */
	destination: string;
	manifest: InstructionManifestEntry[];
	lock: InstructionsLock | null;
}): Promise<SyncPlan> {
	const { destination, manifest, lock } = input;

	// `assertValidManifest` has already checked every manifest entry's path,
	// shape, mode, uniqueness, count and digest before this is called. What
	// is re-checked here is the LOCK, which no server validated: it is a
	// plain file in the checkout, and it is the only thing that can authorise
	// a delete.
	assertSafeLockPaths(lockPaths(lock));

	// A Map, not the parsed object: a manifest path of `constructor` or
	// `toString` reads a value off `Object.prototype` when the lookup is a
	// plain property access, and `__proto__` does not read back at all.
	const lockedFiles = new Map(Object.entries(lock?.files ?? {}));
	const manifestPaths = new Set(manifest.map((entry) => entry.path));
	// The union, not the two sets separately. Each list is internally free of
	// collisions by now, which says nothing about a path appearing in one under
	// a spelling the other uses differently — and that case is a RENAME, not a
	// conflict. See `isRenameOf` below for what it costs to get wrong.
	const manifestKeys = new Map(
		manifest.map(
			(entry) => [collisionKey(entry.path), entry.path] as const,
		),
	);
	const entries: PlanEntry[] = [];

	for (const entry of manifest) {
		const localHash = await hashLocalFile(destination, entry.path);
		if (localHash === entry.sha256) {
			entries.push({
				path: entry.path,
				action: "verified",
				sha256: entry.sha256,
				mode: entry.mode,
			});
			continue;
		}
		const lockedHash = lockedFiles.get(entry.path)?.sha256;
		const action: PlanAction =
			localHash === null
				? "added"
				: localHash === lockedHash
					? "updated"
					: "replaced";
		entries.push({
			path: entry.path,
			action,
			sha256: entry.sha256,
			mode: entry.mode,
		});
	}

	for (const [lockedPath, locked] of lockedFiles) {
		if (manifestPaths.has(lockedPath)) {
			continue;
		}

		// `README.md` in the lock and `readme.md` in the manifest are two
		// spellings of one file wherever the filesystem folds case or
		// normalises names — and writes run before deletes, so planning a
		// delete here unlinked the file the same run had just written and then
		// wrote a lock claiming it was there. The manifest spelling's own write
		// IS the update; this one must not be touched. On Linux the two really
		// are separate files, and skipping the delete is still the right answer:
		// a tool that deletes a file because another file's name resembles it
		// would be worse than one that leaves a stale copy and says so.
		const renamedTo = manifestKeys.get(collisionKey(lockedPath));
		if (renamedTo !== undefined) {
			entries.push({
				path: lockedPath,
				action: "kept-renamed",
				sha256: locked.sha256,
			});
			continue;
		}

		const localHash = await hashLocalFile(destination, lockedPath);
		if (localHash === null) {
			continue;
		}
		entries.push({
			path: lockedPath,
			action: localHash === locked.sha256 ? "deleted" : "kept-modified",
			// Carried so the unlink can prove it is still removing the file
			// this hash described, rather than whatever is at the path by the
			// time the writes are done.
			sha256: locked.sha256,
		});
	}

	entries.sort((a, b) => a.path.localeCompare(b.path));

	return {
		entries,
		writes: entries.filter(
			(entry) =>
				entry.action === "added" ||
				entry.action === "updated" ||
				entry.action === "replaced",
		),
		deletes: entries.filter((entry) => entry.action === "deleted"),
		verified: entries.filter((entry) => entry.action === "verified"),
		keptModified: entries.filter(
			(entry) => entry.action === "kept-modified",
		),
		keptRenamed: entries.filter((entry) => entry.action === "kept-renamed"),
	};
}

/** The lock the sync should leave behind once `plan` has been applied. */
export function nextLock(input: {
	projectId: string;
	snapshot: { id: string; version: number; digest: string };
	manifest: InstructionManifestEntry[];
	now?: Date;
}): InstructionsLock {
	// `Object.fromEntries` rather than assignment into `{}`: assigning
	// `files["__proto__"]` sets the prototype instead of creating an own
	// property, so a published file called `__proto__` was written to disk and
	// then left out of the ledger — and a later snapshot that dropped it could
	// not prove the sync had created it.
	const files: InstructionsLock["files"] = Object.fromEntries(
		input.manifest.map((entry) => [
			entry.path,
			{ sha256: entry.sha256, mode: entry.mode },
		]),
	);
	return {
		version: LOCK_VERSION,
		projectId: input.projectId,
		snapshotId: input.snapshot.id,
		snapshotVersion: input.snapshot.version,
		digest: input.snapshot.digest,
		syncedAt: (input.now ?? new Date()).toISOString(),
		files,
	};
}
