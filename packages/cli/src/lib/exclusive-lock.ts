/**
 * An exclusive lock made of one file: whoever creates it holds the lock.
 *
 * `O_EXCL` creation is the lock, and it works across processes without any
 * help from the platform. A holder that crashed leaves the file behind; an
 * old lock with no live owner is reported for explicit recovery rather than
 * reclaimed automatically. `work` never runs without the lock: a caller that cannot take it
 * within `waitMs`, or whose `signal` aborts, gives up instead.
 *
 * Three users: the profile's refresh lock (two refreshes of one rotating token
 * end the whole sign-in), the profile's write lock (a write that read the file
 * before another process's write must not put it back as it was), and the
 * fast-forward lock beside a checkout's git data (two hooks must not both move
 * one branch).
 */
import { randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	openSync,
	readSync,
	type Stats,
	unlinkSync,
	writeSync,
} from "node:fs";

/** The lock is held by someone else and was not released within the wait. */
export class ExclusiveLockBusyError extends Error {
	constructor(readonly abandoned = false) {
		super(
			abandoned
				? "an abandoned lock must be removed manually"
				: "another process holds this lock",
		);
		this.name = "ExclusiveLockBusyError";
	}
}

export interface ExclusiveLockOptions {
	lockPath: string;
	/** Age after which a lock with no live owner is reported as abandoned. */
	staleMs: number;
	/** The longest to wait for a held lock; `0` gives up at once. */
	waitMs: number;
	/** How often a waiter looks again. */
	pollMs?: number;
	signal?: AbortSignal;
}

const DEFAULT_POLL_MS = 100;
const MAX_LOCK_BYTES = 256;

interface HeldLock {
	descriptor: number;
	owner: string;
}

class LockIdentityChangedError extends Error {
	constructor() {
		super("The lock changed while it was being read.");
		this.name = "LockIdentityChangedError";
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function isExistsError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "EEXIST"
	);
}

function isNotFoundError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "ENOENT"
	);
}

/**
 * One try at the lock. The open file when it was taken; `"retry"` when the
 * file was released while it was being looked at; `"abandoned"` when an old
 * file has no live owner; `"busy"` when it is held.
 */
function takeOnce(
	lockPath: string,
	staleMs: number,
): HeldLock | "busy" | "retry" | "abandoned" {
	try {
		const descriptor = openSync(lockPath, "wx", 0o600);
		const owner = `${process.pid}:${randomUUID()}`;
		writeSync(descriptor, owner);
		return { descriptor, owner };
	} catch (error) {
		if (!isExistsError(error)) {
			throw error;
		}
	}
	try {
		const read = readLock(lockPath);
		if (Date.now() - read.stats.mtimeMs > staleMs) {
			return ownerIsAlive(read.owner) ? "busy" : "abandoned";
		}
	} catch (error) {
		// A holder released or replaced the file during inspection. Only a
		// waiting contender may retry; ownership checks must still fail closed.
		if (
			isNotFoundError(error) ||
			error instanceof LockIdentityChangedError
		) {
			return "retry";
		}
		throw error;
	}
	return "busy";
}

function ownerIsAlive(owner: string): boolean {
	const match = /^(\d+)(?::[0-9a-f-]+)?$/.exec(owner);
	if (!match) {
		return false;
	}
	const pid = Number(match[1]);
	if (!Number.isSafeInteger(pid) || pid <= 0) {
		return false;
	}
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return code === "EPERM" || (code !== "ESRCH" && code !== "ENOENT");
	}
}

/** Bound lock reads and verify file type and descriptor identity. */
function readLock(lockPath: string): { owner: string; stats: Stats } {
	const descriptor = openSync(
		lockPath,
		constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
	);
	try {
		const stats = fstatSync(descriptor);
		if (!stats.isFile()) {
			throw new Error("The lock is not a regular file.");
		}
		if (stats.size > MAX_LOCK_BYTES) {
			throw new Error("The lock is too large.");
		}
		const buffer = Buffer.allocUnsafe(MAX_LOCK_BYTES + 1);
		let total = 0;
		while (total <= MAX_LOCK_BYTES) {
			const count = readSync(
				descriptor,
				buffer,
				total,
				MAX_LOCK_BYTES + 1 - total,
				total,
			);
			if (count === 0) {
				break;
			}
			total += count;
		}
		if (total > MAX_LOCK_BYTES) {
			throw new Error("The lock is too large.");
		}
		const current = lstatSync(lockPath);
		if (!current.isFile()) {
			throw new Error("The lock is not a regular file.");
		}
		if (current.size > MAX_LOCK_BYTES) {
			throw new Error("The lock is too large.");
		}
		if (current.dev !== stats.dev || current.ino !== stats.ino) {
			throw new LockIdentityChangedError();
		}
		return { owner: buffer.toString("utf8", 0, total), stats };
	} finally {
		closeSync(descriptor);
	}
}

function stillHeld(held: HeldLock, lockPath: string): boolean {
	const expected = fstatSync(held.descriptor);
	const read = readLock(lockPath);
	return (
		read.owner === held.owner &&
		read.stats.dev === expected.dev &&
		read.stats.ino === expected.ino
	);
}

function release(held: HeldLock, lockPath: string): void {
	try {
		if (stillHeld(held, lockPath)) {
			unlinkSync(lockPath);
		}
	} catch {
		// The lock was removed or replaced before its former holder finished.
	} finally {
		closeSync(held.descriptor);
	}
}

/**
 * Run `work` while holding the lock. Throws `ExclusiveLockBusyError` when it
 * cannot be taken in time; any other file-system error is the caller's.
 */
export async function withExclusiveLock<T>(
	work: () => Promise<T>,
	options: ExclusiveLockOptions,
): Promise<T> {
	const { lockPath, staleMs } = options;
	const deadline = Date.now() + options.waitMs;
	let held: HeldLock | undefined;

	while (held === undefined) {
		options.signal?.throwIfAborted();
		const taken = takeOnce(lockPath, staleMs);
		if (typeof taken === "object") {
			held = taken;
		} else if (taken === "abandoned") {
			throw new ExclusiveLockBusyError(true);
		} else if (taken === "busy") {
			if (Date.now() >= deadline) {
				throw new ExclusiveLockBusyError();
			}
			await sleep(options.pollMs ?? DEFAULT_POLL_MS);
		} else if (Date.now() >= deadline) {
			throw new ExclusiveLockBusyError();
		} else {
			await sleep(options.pollMs ?? DEFAULT_POLL_MS);
		}
	}

	try {
		options.signal?.throwIfAborted();
		if (!stillHeld(held, lockPath)) {
			throw new Error("The lock changed before work could start.");
		}
		return await work();
	} finally {
		release(held, lockPath);
	}
}

/** Block this thread for `ms`, which a waiter that cannot be async has to do. */
function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * `withExclusiveLock` for work that is synchronous and short, such as one
 * read-modify-write of a file, so the caller can stay synchronous too. A
 * waiter blocks the thread while it waits, so use it only where the holder
 * holds for milliseconds.
 */
export function withExclusiveLockSync<T>(
	work: () => T,
	options: Omit<ExclusiveLockOptions, "signal">,
): T {
	const { lockPath, staleMs } = options;
	const deadline = Date.now() + options.waitMs;
	let held: HeldLock | undefined;

	while (held === undefined) {
		const taken = takeOnce(lockPath, staleMs);
		if (typeof taken === "object") {
			held = taken;
		} else if (taken === "abandoned") {
			throw new ExclusiveLockBusyError(true);
		} else if (taken === "busy") {
			if (Date.now() >= deadline) {
				throw new ExclusiveLockBusyError();
			}
			sleepSync(options.pollMs ?? DEFAULT_POLL_MS);
		} else if (Date.now() >= deadline) {
			throw new ExclusiveLockBusyError();
		} else {
			sleepSync(options.pollMs ?? DEFAULT_POLL_MS);
		}
	}

	try {
		if (!stillHeld(held, lockPath)) {
			throw new Error("The lock changed before work could start.");
		}
		return work();
	} finally {
		release(held, lockPath);
	}
}
