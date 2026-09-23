/**
 * What `fabric context push <dir>` would send, decided against the folder on
 * disk and the lock together, before a single request is made.
 *
 * Per candidate file, one of:
 *
 *   push             its hash is not the one the lock holds for its path —
 *                    sent with the lock's hash as `expectedContentHash`, or
 *                    with none when the lock does not name the path
 *   unchanged-local  its hash is the lock's: no request at all
 *   skipped          not something this command sends (see
 *                    `ContextSkipReason`), with the reason
 *
 * and per path the lock names that is no longer on disk: `removed`. Without
 * `--prune` that is reported and nothing more — the server entry and the
 * lock entry are kept; with it, the push deletes the server entry, only in
 * the version the lock names (Fizzy #2636). The exception is a lock entry
 * recorded as a `duplicate`: the server never stored that path, so there is
 * nothing to keep or delete, and it is `forgotten` (dropped from the lock
 * without a report line).
 *
 * A removed path and a new file with the same content are a `move` (Fizzy
 * #2636), sent as one rename so the server keeps the row, its id and its
 * history instead of deleting one source and creating another. Pairing is
 * one to one and deterministic: removed paths in sorted order, each taking
 * the first unpaired new file (sorted) with its hash. "Removed" is a
 * confirmed lock entry gone from disk; "new" is a file the lock does not name
 * at all. A file the lock names is a change to its own row, whatever it now
 * holds.
 *
 * "No longer on disk" is decided from the names the walk listed, never by
 * asking the filesystem about the lock's spelling: a case-insensitive
 * filesystem answers "yes" for `Docs/Guide.md` after a rename to
 * `docs/guide.md`, and the old path would read as excluded instead of gone.
 *
 * The plan keeps each file's hash and size, not its content: the push reads
 * the file again right before sending it and sends it only if it still
 * hashes to what was planned.
 */
import { readFileSafely } from "../instructions/safe-write.js";
import {
	classifyContextBytes,
	hashContextContent,
	hasTextExtension,
	MAX_CONTEXT_FILE_BYTES,
	type SkippedContextFile,
} from "./classify.js";
import { buildContextIgnoreRules, CONTEXT_IGNORE_FILENAME } from "./ignore.js";
import type { ContextLock } from "./lock.js";
import { normalizeContextSourcePath } from "./source-path.js";
import { walkContextDirectory } from "./walk.js";

export interface ContextPushCandidate {
	/** The normalized path the server keys the file on. */
	sourcePath: string;
	/** The file's path on disk, relative to the folder. */
	diskPath: string;
	/** Of the content as planned; the push sends only content that still has it. */
	sha256: string;
	/** UTF-8 bytes. */
	bytes: number;
	/**
	 * The lock's hash for this path; absent when the lock does not name it,
	 * or names it only as a `duplicate` (a path with no row to replace).
	 */
	expectedContentHash?: string;
}

/** A confirmed lock path gone from disk, and the new file that holds its content. */
export interface ContextMoveCandidate {
	/** The lock's path, no longer on disk. */
	from: string;
	/** The new file's normalized path, which the server keys it on. */
	to: string;
	/** The new file's path on disk, relative to the folder. */
	diskPath: string;
	/** Of both: the lock's hash for `from`, and the new file's as planned. */
	sha256: string;
	/** UTF-8 bytes of the new file. */
	bytes: number;
	/** The row the lock recorded for `from`. */
	contextId: string;
}

export interface ContextPlan {
	/** In sorted `sourcePath` order, which is the order they are sent in. */
	push: ContextPushCandidate[];
	/** In sorted `from` order; sent before `push`. */
	moves: ContextMoveCandidate[];
	unchangedLocal: string[];
	removed: string[];
	/** `duplicate` lock entries whose file is gone: dropped from the lock. */
	forgotten: string[];
	skipped: SkippedContextFile[];
}

function byPath(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/** The folder's own `.contextignore`, through the guarded reader, or `null`. */
async function readContextIgnore(root: string): Promise<string | null> {
	const read = await readFileSafely(root, CONTEXT_IGNORE_FILENAME, {
		maxBytes: 1024 * 1024,
	});
	return read === null ? null : new TextDecoder().decode(read.bytes);
}

/**
 * Whether a lock path is one the walk saw and the ignore rules dropped —
 * itself, or beneath a dropped directory — compared in the server's spelling
 * (NFC) and with the case the listing gave it.
 */
function ignoredByWalk(
	ignored: readonly { path: string; directory: boolean }[],
): (sourcePath: string) => boolean {
	const exact = new Set(ignored.map((entry) => entry.path.normalize("NFC")));
	const directories = ignored
		.filter((entry) => entry.directory)
		.map((entry) => `${entry.path.normalize("NFC")}/`);
	return (sourcePath) =>
		exact.has(sourcePath) ||
		directories.some((prefix) => sourcePath.startsWith(prefix));
}

/**
 * Why a readable file shares its stored path with another, or `null`. Two
 * files the server would store as ONE path (a composed and a decomposed
 * spelling of a name) would silently drop one of them; two that differ only
 * in case are two rows on the server but one file on a case-insensitive
 * filesystem, where the lock and every later push would confuse them.
 * Neither file of such a pair is sent.
 */
function sharedPathProblem(
	entry: { diskPath: string; sourcePath: string },
	group: readonly { diskPath: string; sourcePath: string }[],
): string | null {
	const others = group.filter((other) => other.diskPath !== entry.diskPath);
	if (others.length === 0) {
		return null;
	}
	const names = others.map((other) => other.diskPath).join(", ");
	return others.every((other) => other.sourcePath === entry.sourcePath)
		? `names the same source as ${names}`
		: `case-only collision with ${names}`;
}

export async function computeContextPlan(input: {
	/** Already canonical (`resolveExistingRoot`). */
	root: string;
	lock: ContextLock | null;
	excludes?: readonly string[];
}): Promise<ContextPlan> {
	const { root, lock } = input;
	const rules = buildContextIgnoreRules({
		contextIgnore: await readContextIgnore(root),
		excludes: input.excludes,
	});
	const walk = await walkContextDirectory(root, rules);

	const skipped: SkippedContextFile[] = [
		...walk.symlinks.map((p) => ({ path: p, reason: "symlink" as const })),
		...walk.special.map((p) => ({
			path: p,
			reason: "unsupported-type" as const,
		})),
		...walk.unmatchable.map((p) => ({
			path: p,
			reason: "invalid-path" as const,
			detail: "cannot be matched against the ignore rules",
		})),
	];

	// Path checks first: they cost nothing and need no read.
	const readable: { diskPath: string; sourcePath: string }[] = [];
	for (const file of walk.files) {
		// A backslash inside a POSIX file name is not a separator on disk, and
		// the server would read it as one: the file would be stored under a
		// path that names something else.
		if (file.path.includes("\\")) {
			skipped.push({
				path: file.path,
				reason: "invalid-path",
				detail: "backslash",
			});
			continue;
		}
		const normalized = normalizeContextSourcePath(file.path);
		if (!normalized.ok) {
			skipped.push({
				path: file.path,
				reason: "invalid-path",
				detail: normalized.reason,
			});
			continue;
		}
		if (!hasTextExtension(file.path)) {
			skipped.push({ path: file.path, reason: "unsupported-type" });
			continue;
		}
		if (file.size > MAX_CONTEXT_FILE_BYTES) {
			skipped.push({ path: file.path, reason: "too-large" });
			continue;
		}
		readable.push({
			diskPath: file.path,
			sourcePath: normalized.sourcePath,
		});
	}

	// Grouped by the case-folded stored path, which catches both kinds of
	// sharing `sharedPathProblem` describes.
	const byFoldedPath = new Map<string, typeof readable>();
	for (const entry of readable) {
		const key = entry.sourcePath.toLowerCase();
		byFoldedPath.set(key, [...(byFoldedPath.get(key) ?? []), entry]);
	}

	const push: ContextPushCandidate[] = [];
	const unchangedLocal: string[] = [];
	/** Stored paths the walk found on disk this run, pushed or not. */
	const present = new Set<string>();
	for (const entry of readable) {
		const problem = sharedPathProblem(
			entry,
			byFoldedPath.get(entry.sourcePath.toLowerCase()) ?? [],
		);
		if (problem !== null) {
			skipped.push({
				path: entry.diskPath,
				reason: "invalid-path",
				detail: problem,
			});
			continue;
		}
		const read = await readFileSafely(root, entry.diskPath, {
			maxBytes: MAX_CONTEXT_FILE_BYTES,
		}).catch((error: unknown) => {
			// Grew past the limit between the walk and the read.
			if (error instanceof Error && /too large/.test(error.message)) {
				return "too-large" as const;
			}
			throw error;
		});
		if (read === null) {
			// Deleted since the walk: nothing to send.
			continue;
		}
		if (read === "too-large") {
			skipped.push({ path: entry.diskPath, reason: "too-large" });
			continue;
		}
		const verdict = classifyContextBytes(read.bytes);
		if (!verdict.ok) {
			skipped.push({ path: entry.diskPath, reason: verdict.reason });
			continue;
		}
		// Only the hash and the size are kept; `verdict.content` goes out of
		// scope here, so planning holds one file's text at a time.
		const sha256 = hashContextContent(verdict.content);
		const locked = lock?.files[entry.sourcePath];
		const plannedFile = {
			sourcePath: entry.sourcePath,
			diskPath: entry.diskPath,
			sha256,
			bytes: read.bytes.byteLength,
		};
		if (locked?.sha256 === sha256) {
			unchangedLocal.push(entry.sourcePath);
		} else {
			push.push(
				// A duplicate never had a row of its own, so there is no
				// version to name: it is sent like a new path.
				locked && locked.state !== "duplicate"
					? { ...plannedFile, expectedContentHash: locked.sha256 }
					: plannedFile,
			);
		}
		present.add(entry.sourcePath);
	}

	// Lock paths with no candidate and no skip line. Gone from disk is
	// `removed` (or, for a duplicate the server never stored, `forgotten`);
	// still there but now excluded by the ignore rules is a skip, so nobody
	// reads "removed" about a file they can see.
	for (const skip of skipped) {
		const check = normalizeContextSourcePath(skip.path);
		if (check.ok) {
			present.add(check.sourcePath);
		}
	}
	const isIgnored = ignoredByWalk(walk.ignored);
	const removed: string[] = [];
	const forgotten: string[] = [];
	for (const [sourcePath, entry] of Object.entries(lock?.files ?? {})) {
		if (present.has(sourcePath)) {
			continue;
		}
		if (entry.state === "duplicate") {
			// No server entry to keep or to report on, gone or excluded.
			forgotten.push(sourcePath);
		} else if (isIgnored(sourcePath)) {
			skipped.push({ path: sourcePath, reason: "ignored" });
		} else {
			removed.push(sourcePath);
		}
	}

	push.sort((a, b) => byPath(a.sourcePath, b.sourcePath));
	removed.sort(byPath);
	const moves = pairMoves(lock, removed, push);
	const moved = new Set(moves.map((move) => move.from));
	const arrived = new Set(moves.map((move) => move.to));

	unchangedLocal.sort(byPath);
	forgotten.sort(byPath);
	skipped.sort((a, b) => byPath(a.path, b.path));
	return {
		push: push.filter((entry) => !arrived.has(entry.sourcePath)),
		moves,
		unchangedLocal,
		removed: removed.filter((sourcePath) => !moved.has(sourcePath)),
		forgotten,
		skipped,
	};
}

/**
 * The moves among `removed` (confirmed lock paths gone from disk, sorted) and
 * the new files among `push` (sorted, the lock naming none of them): each
 * removed path in order takes the first unpaired new file with its hash.
 */
function pairMoves(
	lock: ContextLock | null,
	removed: readonly string[],
	push: readonly ContextPushCandidate[],
): ContextMoveCandidate[] {
	const added = push.filter(
		(entry) => lock?.files[entry.sourcePath] === undefined,
	);
	const taken = new Set<string>();
	const moves: ContextMoveCandidate[] = [];
	for (const from of removed) {
		const entry = lock?.files[from];
		if (!entry || entry.state === "duplicate") {
			continue;
		}
		const match = added.find(
			(candidate) =>
				!taken.has(candidate.sourcePath) &&
				candidate.sha256 === entry.sha256,
		);
		if (!match) {
			continue;
		}
		taken.add(match.sourcePath);
		moves.push({
			from,
			to: match.sourcePath,
			diskPath: match.diskPath,
			sha256: match.sha256,
			bytes: match.bytes,
			contextId: entry.contextId,
		});
	}
	return moves;
}
