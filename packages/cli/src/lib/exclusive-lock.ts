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
	openSync,
	readFileSync,
	statSync,
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

interface HeldLock {
	descriptor: number;
	owner: string;
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
		if (Date.now() - statSync(lockPath).mtimeMs > staleMs) {
			if (ownerIsAlive(readFileSync(lockPath, "utf8"))) {
				return "busy";
			}
			return "abandoned";
		}
	} catch (error) {
		// Released between the failed create and the stat/read: retry now.
		if (isNotFoundError(error)) {
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

function release(held: HeldLock, lockPath: string): void {
	closeSync(held.descriptor);
	try {
		if (readFileSync(lockPath, "utf8") === held.owner) {
			unlinkSync(lockPath);
		}
	} catch {
		// The lock was removed or replaced before its former holder finished.
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
		return work();
	} finally {
		release(held, lockPath);
	}
}
