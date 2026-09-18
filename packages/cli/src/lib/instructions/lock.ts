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
import { writeFileSafely } from "./safe-write.js";

export const LOCK_DIRECTORY = ".fabric";
export const LOCK_FILENAME = "instructions.lock";

/** Bumped only if the shape below changes incompatibly. */
export const LOCK_VERSION = 1;

/** The lock's own path, relative to the destination — never from a manifest. */
const LOCK_RELATIVE_PATH = `${LOCK_DIRECTORY}/${LOCK_FILENAME}`;

const SHA256_HEX = /^[0-9a-f]{64}$/;

interface LockFileEntry {
	sha256: string;
	/** POSIX mode as published, or null when the snapshot recorded none. */
	mode: number | null;
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

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error(
			`${file} is unreadable: it is not valid JSON. Delete it to start from a clean sync.`,
		);
	}
	const problem = lockProblem(parsed);
	if (problem !== null) {
		throw new Error(
			`${file} is unreadable: ${problem}. Delete it to start from a clean sync.`,
		);
	}
	return parsed as InstructionsLock;
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

	if (candidate.version !== LOCK_VERSION) {
		return `its version is ${JSON.stringify(candidate.version)} and this build writes version ${LOCK_VERSION}`;
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
	}
	return null;
}
