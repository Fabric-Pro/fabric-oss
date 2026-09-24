/**
 * What a sync would do, decided against the LOCAL TREE and not only the lock.
 *
 * The lock says what the last sync wrote; the working tree says what is
 * actually there now. Planning from the lock alone gets both interesting
 * cases wrong — a file the developer edited since the sync would be silently
 * overwritten with no notice, and a file they deleted would never come back
 * because the lock still claims it is present. So every path is hashed.
 *
 * Eight outcomes, and the distinctions between them are the whole point:
 *
 *   verified        local bytes already equal the published bytes — no write
 *   added           nothing local — a new file
 *   updated         local matches the lock, so this is the sync's own file
 *                   moving forward
 *   replaced        local matches neither the lock nor the manifest, and the
 *                   caller did not ask to keep local edits (`sync --repair`) —
 *                   they are about to be overwritten, and the report says so
 *   kept-edited     the same, when the caller keeps local edits (every `sync`
 *                   without `--repair`, spec §6.4) — the file stays as it is
 *                   and the lock records the published hash with `kept: true`
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
	| "kept-renamed"
	| "kept-edited";

export interface PlanEntry {
	path: string;
	action: PlanAction;
	/** The published hash, for everything the manifest still carries. */
	sha256?: string;
	mode?: number | null;
	/**
	 * For a manifest entry that is not `verified`: the hash the planner read
	 * at this path, or null when nothing was there. A keeping apply re-hashes
	 * before it writes and leaves the file alone when it changed since
	 * (Decision 37).
	 */
	localSha256?: string | null;
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
	/**
	 * Still-published paths whose local bytes match neither the lock nor the
	 * manifest, left alone because the caller keeps local edits. Never
	 * written; the lock records them with the published hash and
	 * `kept: true`.
	 */
	keptEdited: PlanEntry[];
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
export async function hashLocalFile(
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
	const drift = await findLedgerDrift(input);
	return drift.map(describeLedgerDrift);
}

/**
 * Why one locked path no longer matches, as a class a caller can branch on.
 * `refused` is a guarded-read refusal: a symlinked ancestor, a directory
 * where a file belongs, a path resolving outside the root.
 */
export type LedgerDriftReason = "missing" | "edited" | "mode" | "refused";

export interface LedgerDrift {
	path: string;
	reason: LedgerDriftReason;
	/** The parenthetical `verifyLedger` prints after the path. */
	detail: string;
	/**
	 * The lock marks this path as a local edit an earlier sync kept (spec
	 * §6.4). An `edited` entry with this set has the detail `kept`.
	 */
	kept: boolean;
}

/** One drift entry as `verifyLedger` prints it: `AGENTS.md (edited)`. */
export function describeLedgerDrift(entry: LedgerDrift): string {
	return `${entry.path} (${entry.detail})`;
}

/**
 * `verifyLedger`, structured: one entry per locked path that no longer
 * matches, with its reason as a class rather than folded into a sentence.
 * `fabric instructions doctor` reports these as check items and must not
 * repeat a refusal's message (it names local paths), so it needs the class.
 */
export async function findLedgerDrift(input: {
	/** An already-canonical root — `resolveDestinationRoot` or `resolveExistingRoot`. */
	root: string;
	lock: InstructionsLock;
}): Promise<LedgerDrift[]> {
	// FIRST, before a single path is joined or opened. This function reads
	// paths that come out of an unauthenticated file in the checkout, and it
	// used to read them raw: `../outside` reached outside the destination, and
	// `rules/` replaced by a symlink was followed wherever it pointed. The
	// same validation `computeSyncPlan` runs, run before anything is touched.
	assertSafeLockPaths(lockPaths(input.lock));

	const drifted: LedgerDrift[] = [];
	for (const [lockedPath, locked] of Object.entries(input.lock.files)) {
		// A refusal from the guarded reader — a symlinked ancestor, a
		// directory where a file belongs — is drift, not a crash: the caller
		// re-plans, and planning refuses it there with the same message.
		let read: Awaited<ReturnType<typeof readFileSafely>>;
		try {
			read = await readFileSafely(input.root, lockedPath);
		} catch (error) {
			drifted.push({
				path: lockedPath,
				reason: "refused",
				detail:
					error instanceof Error
						? error.message
								.replace(/^Refusing to sync: /, "")
								.replace(/\.$/, "")
						: String(error),
				kept: locked.kept === true,
			});
			continue;
		}
		if (read === null) {
			drifted.push({
				path: lockedPath,
				reason: "missing",
				detail: "missing",
				kept: locked.kept === true,
			});
			continue;
		}
		const actual = createHash("sha256").update(read.bytes).digest("hex");
		if (actual !== locked.sha256) {
			drifted.push({
				path: lockedPath,
				reason: "edited",
				detail: locked.kept === true ? "kept" : "edited",
				kept: locked.kept === true,
			});
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
			drifted.push({
				path: lockedPath,
				reason: "mode",
				detail: `mode ${(read.mode & 0o7777).toString(8)}, published as ${(locked.mode & 0o7777).toString(8)}`,
				kept: locked.kept === true,
			});
		}
	}
	return drifted;
}

export async function computeSyncPlan(
	input: {
		/** An already-canonical root, as every guarded read resolves against it. */
		destination: string;
		manifest: InstructionManifestEntry[];
		lock: InstructionsLock | null;
	},
	options: {
		/**
		 * Leave a still-published file whose local bytes match neither the
		 * lock nor the manifest as it is (`kept-edited`) instead of
		 * overwriting it (`replaced`). The CLI passes `true` unless
		 * `sync --repair` was given (spec §6.4).
		 */
		keepLocalEdits?: boolean;
	} = {},
): Promise<SyncPlan> {
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
	// The lock's own collision keys. A manifest entry whose EXACT spelling the
	// lock does not know may still be the same file the lock already tracks
	// under a different spelling — a case-only or Unicode-normalization-only
	// rename — and on the filesystems that fold those, reading the manifest's
	// spelling returns the OLD spelling's bytes. Without this fallback that
	// read looked like a local edit with nothing to compare against, so in
	// keep mode the rename's write never happened and the file stayed stale
	// until `--repair` (review finding, Fizzy #2540).
	const lockedKeys = new Map(
		Array.from(lockedFiles.keys()).map(
			(lockedPath) => [collisionKey(lockedPath), lockedPath] as const,
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
		const renamedFrom = lockedKeys.get(collisionKey(entry.path));
		const locked =
			lockedFiles.get(entry.path) ??
			(renamedFrom === undefined
				? undefined
				: lockedFiles.get(renamedFrom));
		const lockedHash = locked?.sha256;
		// A path the lock does not name under this spelling OR a renamed one
		// (a file that was there before the first sync) has no `lockedHash`,
		// so it lands here too: it is the developer's until `--repair` says
		// otherwise.
		const action: PlanAction =
			localHash === null
				? "added"
				: localHash === lockedHash
					? "updated"
					: options.keepLocalEdits
						? "kept-edited"
						: "replaced";
		entries.push({
			path: entry.path,
			action,
			sha256: entry.sha256,
			mode: entry.mode,
			// What the plan saw here, so a keeping apply can tell a save that
			// landed after planning (Decision 37).
			localSha256: localHash,
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
		keptEdited: entries.filter((entry) => entry.action === "kept-edited"),
	};
}

/** The lock the sync should leave behind once `plan` has been applied. */
export function nextLock(input: {
	projectId: string;
	snapshot: { id: string; version: number; digest: string };
	manifest: InstructionManifestEntry[];
	/**
	 * Paths the plan kept as local edits. Their entries still carry the
	 * PUBLISHED hash and mode, so `push` diffs the edit against the published
	 * file, plus `kept: true`, so `check --verify` and doctor can say so.
	 */
	kept?: readonly string[];
	now?: Date;
}): InstructionsLock {
	// `Object.fromEntries` rather than assignment into `{}`: assigning
	// `files["__proto__"]` sets the prototype instead of creating an own
	// property, so a published file called `__proto__` was written to disk and
	// then left out of the ledger — and a later snapshot that dropped it could
	// not prove the sync had created it.
	const kept = new Set(input.kept ?? []);
	const files: InstructionsLock["files"] = Object.fromEntries(
		input.manifest.map((entry) => [
			entry.path,
			kept.has(entry.path)
				? {
						sha256: entry.sha256,
						mode: entry.mode,
						kept: true as const,
					}
				: { sha256: entry.sha256, mode: entry.mode },
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

/**
 * `lock` with `kept: true` on exactly `paths` and on no other entry, for a
 * run that keeps local edits without a manifest in hand (the server answered
 * "unchanged"). A marker whose file matches the published bytes again, put
 * back by hand, is dropped, so the lock never claims an edit that is gone
 * (Decision 41). Everything else, including `syncedAt`, is left as it was:
 * nothing was synced, only recorded.
 *
 * The result is always at `LOCK_VERSION`, because only a version 2 lock may
 * carry a marker (Decision 38). `changed` is true only when a marker was
 * added or dropped, so a run that finds the same edits again writes nothing.
 * A copy, so the caller's parsed lock is untouched.
 */
export function reconcileKeptInLock(
	lock: InstructionsLock,
	paths: readonly string[],
): { lock: InstructionsLock; changed: boolean } {
	const kept = new Set(paths);
	let changed = false;
	// `Object.fromEntries` for the same `__proto__` reason as `nextLock`.
	const files: InstructionsLock["files"] = Object.fromEntries(
		Object.entries(lock.files).map(([lockedPath, entry]) => {
			const keep = kept.has(lockedPath);
			if (keep === (entry.kept === true)) {
				return [lockedPath, entry];
			}
			changed = true;
			return [
				lockedPath,
				keep
					? {
							sha256: entry.sha256,
							mode: entry.mode,
							kept: true as const,
						}
					: { sha256: entry.sha256, mode: entry.mode },
			];
		}),
	);
	return { lock: { ...lock, version: LOCK_VERSION, files }, changed };
}
