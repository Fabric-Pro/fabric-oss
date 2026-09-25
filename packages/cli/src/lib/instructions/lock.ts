/**
 * `<dest>/.fabric/instructions.lock` — what the last sync wrote.
 *
 * ## What the lock is, and what it is not
 *
 * It is a CONTENT LEDGER: a list of paths with the hash each one had when
 * this tool last wrote it. It is the only reason the sync may delete
 * anything — a path must be in the ledger AND still hash to what the ledger
 * recorded before it can be removed.
 *
 * It is NOT authenticated. It is a plain JSON file inside the checkout, so
 * anything that can write there can write it. That bounds what a tampered
 * lock can do rather than preventing it: an attacker who can already edit
 * files in the tree can make the next sync delete a file whose CURRENT
 * content hash they name correctly. They cannot make it write anywhere new,
 * because writes come from the server manifest, and they cannot name
 * `.git/**` or `.fabric/**` at all (`isReservedPath`). Closing the rest
 * needs a ledger stored outside the checkout, which is a larger change than
 * this feature.
 *
 * The lock is rewritten LAST, after every write has succeeded. A ledger
 * naming files that are not there would authorise deleting whatever is in
 * their place on the next run.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { PublishedInstructionSource } from "@fabricorg/sdk";
import { readFileSafely, writeFileSafely } from "./safe-write.js";

export const LOCK_DIRECTORY = ".fabric";
export const LOCK_FILENAME = "instructions.lock";

/**
 * The version this build writes. Version 2 adds `LockFileEntry.kept` (spec
 * §6.4, Decision 38). Version 3 adds `InstructionsLock.source` (Fizzy #2709):
 * the published snapshot's provenance (a repository sync's ref, commit and
 * whether it is still the project's CURRENT sync configuration, or plain
 * `UPLOAD`), absent when the server did not report one. Every released build
 * reads only the versions it knows and refuses anything else whole, so a
 * marker or field a build cannot see is never acted on, and never silently
 * overwritten, by one that cannot see it. This build reads versions 1
 * through 3.
 */
export const LOCK_VERSION = 3;

/** Every lock version this build reads. It writes only `LOCK_VERSION`. */
const READABLE_LOCK_VERSIONS: readonly number[] = [1, 2, LOCK_VERSION];

/** The lock's own path, relative to the destination — never from a manifest. */
const LOCK_RELATIVE_PATH = `${LOCK_DIRECTORY}/${LOCK_FILENAME}`;

const SHA256_HEX = /^[0-9a-f]{64}$/;

interface LockFileEntry {
	sha256: string;
	/** POSIX mode as published, or null when the snapshot recorded none. */
	mode: number | null;
	/**
	 * Present only when a sync left a local edit at this path in place
	 * (`fabric instructions sync` without `--repair`, spec §6.4). `sha256`
	 * and `mode` are still the PUBLISHED values. Only a version 2 lock may
	 * carry it.
	 */
	kept?: true;
}

export interface InstructionsLock {
	version: number;
	projectId: string;
	snapshotId: string;
	snapshotVersion: number;
	digest: string;
	/** ISO 8601 timestamp of the sync that wrote this lock. */
	syncedAt: string;
	/** Every path that sync wrote or verified — the manifest at that time. */
	files: Record<string, LockFileEntry>;
	/**
	 * The published snapshot's provenance, as `getPublished` reported it at
	 * sync time. Absent when the server did not report one (an older server) —
	 * never defaulted, so an absent value is never mistaken for `UPLOAD`. Only
	 * a version 3 lock may carry it. The repository itself (owner/name, host,
	 * root path) is NOT recorded here: it is the project's current
	 * configuration, not this snapshot's, and is not part of the lock.
	 */
	source?: PublishedInstructionSource;
}

export function lockPath(destination: string): string {
	return path.join(destination, LOCK_DIRECTORY, LOCK_FILENAME);
}

/**
 * The lock, or `null` when this tree has never been synced.
 *
 * A lock that exists but does not validate is an ERROR and never a `null`.
 * Treating a damaged ledger as "never synced" would orphan every file the
 * previous sync wrote and hide the damage; the caller stops and says so.
 */
export async function readLock(
	destination: string,
): Promise<InstructionsLock | null> {
	const file = lockPath(destination);
	let raw: string;
	try {
		raw = await readFile(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return null;
		}
		throw error;
	}
	return parseLock(raw, file);
}

/**
 * The validating half of `readLock`: the text of a lock file, as a lock, or
 * an error saying why it is not one. `source` names the file in that error.
 */
export function parseLock(
	text: string,
	source: string = LOCK_RELATIVE_PATH,
): InstructionsLock {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error(
			`${source} is unreadable: it is not valid JSON. Delete it to start from a clean sync.`,
		);
	}
	const problem = lockProblem(parsed);
	if (problem !== null) {
		throw new Error(
			`${source} is unreadable: ${problem}. Delete it to start from a clean sync.`,
		);
	}
	return parsed as InstructionsLock;
}

/**
 * `readFileSafely` refused the lock before a byte of it was parsed: a
 * symlinked `.fabric` or lock, something that is not a regular file, or a
 * file over the caller's bound. The guard's own error is the `cause`.
 */
export class LockReadRefusedError extends Error {
	constructor(options: { cause: unknown }) {
		super(`${LOCK_RELATIVE_PATH} could not be read safely.`, options);
		this.name = "LockReadRefusedError";
	}
}

/**
 * `readLock` for a reader that must not be steered outside `root`.
 *
 * `readLock` opens `<destination>/.fabric/instructions.lock` with a plain
 * `readFile`, which follows a symlinked `.fabric` or lock to wherever it
 * points and reads the whole file. This goes through `readFileSafely`
 * instead: descriptor-based, refusing a symlinked ancestor or final
 * component, refusing anything but a regular file, and reading at most
 * `maxBytes`. A refusal throws `LockReadRefusedError`; a file that reads but
 * does not validate throws `parseLock`'s error. `root` must already be
 * canonical, as for every guarded read.
 */
export async function readLockSafely(
	root: string,
	options: { maxBytes: number },
): Promise<InstructionsLock | null> {
	let read: Awaited<ReturnType<typeof readFileSafely>>;
	try {
		read = await readFileSafely(root, LOCK_RELATIVE_PATH, {
			maxBytes: options.maxBytes,
		});
	} catch (error) {
		throw new LockReadRefusedError({ cause: error });
	}
	if (read === null) {
		return null;
	}
	// The decoder `readFile(file, "utf8")` uses, so both readers see the same text.
	const text = Buffer.from(
		read.bytes.buffer,
		read.bytes.byteOffset,
		read.bytes.byteLength,
	).toString("utf8");
	return parseLock(text, lockPath(root));
}

/** Pretty JSON with LF endings and a trailing newline, so a diff of it reads. */
function serializeLock(lock: InstructionsLock): string {
	return `${JSON.stringify(lock, null, 2).replace(/\r\n/g, "\n")}\n`;
}

/**
 * Write the lock through the same guarded writer as every instruction file.
 * `root` is an already-canonical destination from `resolveDestinationRoot`:
 * a `.fabric -> ..` symlink is how the lock write used to escape the tree.
 */
export async function writeLock(
	root: string,
	lock: InstructionsLock,
): Promise<void> {
	await writeFileSafely({
		root,
		relativePath: LOCK_RELATIVE_PATH,
		bytes: new TextEncoder().encode(serializeLock(lock)),
	});
}

/**
 * Why this value is not a lock, or `null` when it is one.
 *
 * Every field is checked, including `version`: a future lock this build does
 * not understand must stop the run rather than be half-read.
 */
function lockProblem(value: unknown): string | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return "it is not a JSON object";
	}
	const candidate = value as Record<string, unknown>;

	if (
		typeof candidate.version !== "number" ||
		!READABLE_LOCK_VERSIONS.includes(candidate.version)
	) {
		return `its version is ${JSON.stringify(candidate.version)} and this build reads versions ${READABLE_LOCK_VERSIONS.join(" and ")}`;
	}
	for (const field of [
		"projectId",
		"snapshotId",
		"digest",
		"syncedAt",
	] as const) {
		const actual = candidate[field];
		if (typeof actual !== "string" || actual.length === 0) {
			return `its "${field}" is not a non-empty string`;
		}
	}
	if (
		typeof candidate.snapshotVersion !== "number" ||
		!Number.isInteger(candidate.snapshotVersion) ||
		candidate.snapshotVersion < 0
	) {
		return 'its "snapshotVersion" is not a non-negative integer';
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
		if (
			record.mode !== null &&
			(typeof record.mode !== "number" ||
				!Number.isInteger(record.mode) ||
				record.mode < 0)
		) {
			return `its entry for ${JSON.stringify(filePath)} has a mode that is neither null nor a non-negative integer`;
		}
		if (record.kept !== undefined) {
			if (record.kept !== true) {
				return `its entry for ${JSON.stringify(filePath)} has a "kept" that is not true`;
			}
			// A released build reads version 1 and would ignore the marker,
			// so a version 1 lock carrying one is not a lock this tool wrote.
			if (candidate.version === 1) {
				return `its entry for ${JSON.stringify(filePath)} has a "kept" marker, which a version 1 lock cannot carry`;
			}
		}
	}

	if (candidate.source !== undefined) {
		// Same precedent as `kept` above: a marker introduced by a later
		// version must not be silently accepted from an earlier one, whether
		// or not this build itself understands it — a version 1 or 2 lock
		// carrying `source` is not a lock this tool wrote.
		if (candidate.version !== 3) {
			return `it carries a "source", which only a version 3 lock can carry (this one is version ${candidate.version})`;
		}
		const problem = sourceProblem(candidate.source);
		if (problem !== null) {
			return `its "source" ${problem}`;
		}
	}
	return null;
}

/** Lowercase hex, 7 to 64 characters — a short or full git commit sha. */
const COMMIT_SHA_HEX = /^[0-9a-f]{7,64}$/;

/**
 * Why `value` is not a valid `PublishedInstructionSource`, or `null` when it
 * is one. Each arm's key set is exact, not merely a minimum: an "UPLOAD"
 * source carries only `kind`, a "REPOSITORY" one exactly `kind`, `ref`,
 * `commitSha` and `current` — an extra key is refused rather than ignored,
 * since a future version of this shape would otherwise be silently
 * misread by a build that only checks for the keys it knows (Fizzy #2709
 * review).
 */
function sourceProblem(value: unknown): string | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return "is not an object";
	}
	const source = value as Record<string, unknown>;
	const keys = Object.keys(source);
	if (source.kind === "UPLOAD") {
		const extra = keys.filter((key) => key !== "kind");
		if (extra.length > 0) {
			return `has a key besides "kind" on an "UPLOAD" source: ${extra.join(", ")}`;
		}
		return null;
	}
	if (source.kind !== "REPOSITORY") {
		return 'has a "kind" that is neither "UPLOAD" nor "REPOSITORY"';
	}
	if (typeof source.ref !== "string" || source.ref.length === 0) {
		return 'has a "ref" that is not a non-empty string';
	}
	if (
		typeof source.commitSha !== "string" ||
		!COMMIT_SHA_HEX.test(source.commitSha)
	) {
		return 'has a "commitSha" that is not 7 to 64 lowercase hex characters';
	}
	if (typeof source.current !== "boolean") {
		return 'has a "current" that is not a boolean';
	}
	const allowed = new Set(["kind", "ref", "commitSha", "current"]);
	const extra = keys.filter((key) => !allowed.has(key));
	if (extra.length > 0) {
		return `has a key besides "kind", "ref", "commitSha" and "current" on a "REPOSITORY" source: ${extra.join(", ")}`;
	}
	return null;
}
