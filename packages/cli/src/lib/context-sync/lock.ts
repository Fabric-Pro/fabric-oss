/**
 * `<dir>/.fabric/context.lock` — what the server confirmed at the last push.
 *
 * A CONTENT LEDGER: each path with the hash the server holds for it and the
 * context row it is stored as. It decides two things and nothing else:
 *
 *  - a file whose bytes still hash to the ledger's value is not sent at all;
 *  - a changed file names the ledger's hash as `expectedContentHash`, so the
 *    push replaces exactly the version this folder last saw, and anybody
 *    else's edit since is a conflict rather than a silent overwrite.
 *
 * It never causes a read (only the walk decides what is read) and never a
 * deletion (this command deletes nothing). A tampered lock can therefore make
 * a push skip a file, or state a version the server will check; it cannot
 * make one reach outside the folder.
 *
 * Written LAST, after every request, with what the server answered:
 * `created`, `updated` or `unchanged` record the hash and the row; a
 * `duplicate` records the hash with `state: "duplicate"` and no row, because
 * the path has none of its own (its content is stored under another path).
 * An unchanged duplicate is therefore not sent again, and a changed one is
 * sent naming no version. A conflict and a failure leave their entry as it
 * was. An interrupted run leaves the old lock, and the next run repairs
 * itself: content the server already holds is answered `unchanged` and
 * recorded then.
 *
 * Read and written through the same guarded helpers as the coding-
 * instructions lock (`../instructions/safe-write.ts`), so a `.fabric -> ..`
 * symlink cannot turn either into an access outside the folder.
 */
import path from "node:path";
import { readFileSafely, writeFileSafely } from "../instructions/safe-write.js";
import { normalizeContextSourcePath } from "./source-path.js";

const CONTEXT_LOCK_DIRECTORY = ".fabric";
const CONTEXT_LOCK_FILENAME = "context.lock";

/**
 * Bumped only if the shape below changes incompatibly. The `duplicate` entry
 * was added without a bump: confirmed entries kept their exact shape.
 */
export const CONTEXT_LOCK_VERSION = 1;

const CONTEXT_LOCK_RELATIVE_PATH = `${CONTEXT_LOCK_DIRECTORY}/${CONTEXT_LOCK_FILENAME}`;

/** Generous: one line per pushed file. Bounds a read, it limits nobody. */
const MAX_CONTEXT_LOCK_BYTES = 32 * 1024 * 1024;

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** A path the server stores: its hash when last confirmed, and its row. */
interface ConfirmedContextLockEntry {
	/** The server's `contentHash` for this path when it was last confirmed. */
	sha256: string;
	contextId: string;
	state?: undefined;
}

/**
 * A path the server answered `duplicate` for: this content is stored under
 * another path, and this path has no row. Kept so an unchanged duplicate is
 * not sent on every run; it names no version when its content changes.
 */
interface DuplicateContextLockEntry {
	/** The hash of the content that was answered `duplicate`. */
	sha256: string;
	state: "duplicate";
	contextId?: undefined;
}

type ContextLockEntry =
	| ConfirmedContextLockEntry
	| DuplicateContextLockEntry;

export interface ContextLock {
	version: number;
	projectId: string;
	/** ISO 8601 timestamp of the push that wrote this lock. */
	pushedAt: string;
	/** Keyed by the normalized `sourcePath` the server stores. */
	files: Record<string, ContextLockEntry>;
}

export function contextLockPath(root: string): string {
	return path.join(root, CONTEXT_LOCK_DIRECTORY, CONTEXT_LOCK_FILENAME);
}

/**
 * The lock, or `null` when this folder has never been pushed.
 *
 * A lock that exists but does not validate is an ERROR, never a `null`:
 * reading a damaged ledger as "first push" would send every file with no
 * expected version, turning every one of them the server already holds into
 * a conflict and hiding the damage behind that noise.
 */
export async function readContextLock(
	root: string,
): Promise<ContextLock | null> {
	const file = contextLockPath(root);
	const read = await readFileSafely(root, CONTEXT_LOCK_RELATIVE_PATH, {
		maxBytes: MAX_CONTEXT_LOCK_BYTES,
	});
	if (read === null) {
		return null;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder().decode(read.bytes));
	} catch {
		throw new Error(
			`${file} is unreadable: it is not valid JSON. Delete it to push every file again with no expected version.`,
		);
	}
	const problem = lockProblem(parsed);
	if (problem !== null) {
		throw new Error(
			`${file} is unreadable: ${problem}. Delete it to push every file again with no expected version.`,
		);
	}
	return parsed as ContextLock;
}

/** Pretty JSON with LF endings and a trailing newline, so a diff of it reads. */
function serializeLock(lock: ContextLock): string {
	return `${JSON.stringify(lock, null, 2).replace(/\r\n/g, "\n")}\n`;
}

/** Atomic (temp file, then rename), through the guarded writer. */
export async function writeContextLock(
	root: string,
	lock: ContextLock,
): Promise<void> {
	await writeFileSafely({
		root,
		relativePath: CONTEXT_LOCK_RELATIVE_PATH,
		bytes: new TextEncoder().encode(serializeLock(lock)),
	});
}

/**
 * Why this value is not a lock, or `null` when it is one.
 *
 * Every path must already be in the server's stored spelling. That keeps a
 * hand-edited lock from printing a control character into the terminal when
 * a path is reported, and from naming anything the server could never hold.
 */
function lockProblem(value: unknown): string | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return "it is not a JSON object";
	}
	const candidate = value as Record<string, unknown>;
	if (candidate.version !== CONTEXT_LOCK_VERSION) {
		return `its version is ${JSON.stringify(candidate.version)} and this build writes version ${CONTEXT_LOCK_VERSION}`;
	}
	for (const field of ["projectId", "pushedAt"] as const) {
		const actual = candidate[field];
		if (typeof actual !== "string" || actual.length === 0) {
			return `its "${field}" is not a non-empty string`;
		}
	}
	if (
		typeof candidate.files !== "object" ||
		candidate.files === null ||
		Array.isArray(candidate.files)
	) {
		return 'its "files" is not an object';
	}
	for (const [filePath, entry] of Object.entries(
		candidate.files as Record<string, unknown>,
	)) {
		const normalized = normalizeContextSourcePath(filePath);
		if (!normalized.ok || normalized.sourcePath !== filePath) {
			return `it names ${JSON.stringify(filePath)}, which is not a path the server stores`;
		}
		if (
			typeof entry !== "object" ||
			entry === null ||
			Array.isArray(entry)
		) {
			return `its entry for ${JSON.stringify(filePath)} is not an object`;
		}
		const record = entry as Record<string, unknown>;
		if (
			typeof record.sha256 !== "string" ||
			!SHA256_HEX.test(record.sha256)
		) {
			return `its entry for ${JSON.stringify(filePath)} has no 64-character hex sha256`;
		}
		if (record.state === "duplicate") {
			if (record.contextId !== undefined) {
				return `its duplicate entry for ${JSON.stringify(filePath)} names a contextId, which a duplicate never has`;
			}
			continue;
		}
		if (record.state !== undefined) {
			return `its entry for ${JSON.stringify(filePath)} has an unknown state ${JSON.stringify(record.state)}`;
		}
		if (
			typeof record.contextId !== "string" ||
			record.contextId.length === 0
		) {
			return `its entry for ${JSON.stringify(filePath)} has no contextId`;
		}
	}
	return null;
}
