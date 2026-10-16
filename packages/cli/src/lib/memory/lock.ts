/**
 * `<root>/.fabric/memory.lock` -- what the memory mirror last agreed with the
 * server, and what it has sent that is not settled.
 *
 * `files` records, for each mirrored path, the git blob the server held and
 * the sha256 of the content at the time they were last equal. Both decisions
 * the mirror takes rest on it: a file whose bytes still hash to the lock's
 * value is untouched by the developer and may be replaced by a newer remote
 * version; one that does not is theirs, and is never overwritten. A push names
 * the lock's blob as `ifMatchOid`, so it replaces exactly the version this
 * folder last saw.
 *
 * `outbox` is every write submitted whose outcome is not yet folded into
 * `files`: pending, awaiting a merge, or ended in a conflict, a refusal or a
 * failure. A problem stays in it, and in every report, until the files it names
 * are back in step or the person dismisses it.
 *
 * Read and written through the guarded helpers the coding-instructions lock
 * uses, so a `.fabric -> ..` symlink cannot turn either into an access outside
 * the folder.
 */
import { readFileSafely, writeFileSafely } from "../instructions/safe-write.js";

const MEMORY_LOCK_RELATIVE_PATH = ".fabric/memory.lock";
const MEMORY_LOCK_VERSION = 1;
const MAX_MEMORY_LOCK_BYTES = 32 * 1024 * 1024;

export interface MemoryLockEntry {
	targetId: string;
	/** The git blob the server held; `null` until a sync run stamped it. */
	blobOid: string | null;
	/** sha256 hex of the content when the mirror and the server agreed. */
	contentHash: string;
	/** `push` until the server's listing shows the file: it may not be ingested yet. */
	origin: "pull" | "push";
}

type OutboxStatus =
	| "PENDING"
	| "PULL_REQUEST"
	| "CONFLICT"
	| "REFUSED"
	| "FAILED";

export interface OutboxPath {
	path: string;
	op: "PUT" | "DELETE";
	/** sha256 of the content sent; `null` for a delete. */
	contentHash: string | null;
	/** The blob id the content has in git, so a committed write can be folded into the lock. */
	newBlobOid: string | null;
	verdict?: { code: string; currentOid?: string | null };
}

export interface OutboxRecord {
	writeId: string;
	targetId: string;
	folder: string;
	submittedAt: string;
	status: OutboxStatus;
	/** A refusal or failure code, or the reason a pull request was opened. */
	detail?: string;
	url?: string;
	paths: OutboxPath[];
}

export interface MemoryLock {
	version: number;
	projectId: string;
	/**
	 * The write folders as the server last listed them. A push at the end of a
	 * turn uses them instead of asking, so a turn that changed nothing costs
	 * no request at all; a refusal that says they moved asks again.
	 */
	targets?: Array<{
		id: string;
		folder: string;
		mode: "PULL_REQUEST" | "DIRECT_PUSH";
		version: number;
	}>;
	files: Record<string, MemoryLockEntry>;
	outbox: OutboxRecord[];
}

export function emptyMemoryLock(projectId: string): MemoryLock {
	return {
		version: MEMORY_LOCK_VERSION,
		projectId,
		files: {},
		outbox: [],
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function damaged(): Error {
	return new Error(
		`${MEMORY_LOCK_RELATIVE_PATH} is unreadable. Delete it to mirror again from the server; files you changed here are kept.`,
	);
}

/**
 * The lock, or `null` when this folder has never been mirrored. A lock that
 * exists and does not validate is an error: reading it as "never mirrored"
 * would treat every local edit as the server's, or the reverse.
 */
export async function readMemoryLock(
	root: string,
	projectId: string,
): Promise<MemoryLock | null> {
	const read = await readFileSafely(root, MEMORY_LOCK_RELATIVE_PATH, {
		maxBytes: MAX_MEMORY_LOCK_BYTES,
	});
	if (read === null) {
		return null;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder().decode(read.bytes));
	} catch {
		throw damaged();
	}
	if (
		!isRecord(parsed) ||
		parsed.version !== MEMORY_LOCK_VERSION ||
		typeof parsed.projectId !== "string" ||
		!isRecord(parsed.files) ||
		!Array.isArray(parsed.outbox)
	) {
		throw damaged();
	}
	if (parsed.projectId !== projectId) {
		throw new Error(
			`${MEMORY_LOCK_RELATIVE_PATH} belongs to another project. Run this from that project's folder, or delete the file.`,
		);
	}
	return parsed as unknown as MemoryLock;
}

export async function writeMemoryLock(
	root: string,
	lock: MemoryLock,
): Promise<void> {
	const files = Object.fromEntries(
		Object.entries(lock.files).sort(([a], [b]) => (a < b ? -1 : 1)),
	);
	await writeFileSafely({
		root,
		relativePath: MEMORY_LOCK_RELATIVE_PATH,
		bytes: new TextEncoder().encode(
			`${JSON.stringify({ ...lock, files }, null, 2)}\n`,
		),
	});
}
