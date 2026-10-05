/**
 * An exclusive lock made of one file: whoever creates it holds the lock.
 *
 * `O_EXCL` creation is the lock, and it works across processes without any
 * help from the platform. A holder that crashed leaves the file behind, so one
 * older than `staleMs` (by the file's own clock) is removed and the creation
 * retried. `work` never runs without the lock: a caller that cannot take it
 * within `waitMs`, or whose `signal` aborts, gives up instead.
 *
 * Three users: the profile's refresh lock (two refreshes of one rotating token
 * end the whole sign-in), the profile's write lock (a write that read the file
 * before another process's write must not put it back as it was), and the
 * fast-forward lock beside a checkout's git data (two hooks must not both move
 * one branch).
 */
import { closeSync, openSync, statSync, unlinkSync, writeSync } from "node:fs";

/** The lock is held by someone else and was not released within the wait. */
export class ExclusiveLockBusyError extends Error {
	constructor() {
		super("another process holds this lock");
		this.name = "ExclusiveLockBusyError";
	}
}

export interface ExclusiveLockOptions {
	lockPath: string;
	/** A lock older than this is taken to belong to a process that died. */
	staleMs: number;
	/** The longest to wait for a held lock; `0` gives up at once. */
	waitMs: number;
	/** How often a waiter looks again. */
	pollMs?: number;
	signal?: AbortSignal;
}

const DEFAULT_POLL_MS = 100;

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

/**
 * One try at the lock. The open file when it was taken; `"retry"` when it was
 * held by a process that is gone (its file was older than `staleMs`, so it was
 * removed) or was released while it was being looked at; `"busy"` when it is
 * held.
 */
function takeOnce(
	lockPath: string,
	staleMs: number,
): number | "busy" | "retry" {
	try {
		const descriptor = openSync(lockPath, "wx", 0o600);
		writeSync(descriptor, String(process.pid));
		return descriptor;
	} catch (error) {
		if (!isExistsError(error)) {
			throw error;
		}
	}
	try {
		if (Date.now() - statSync(lockPath).mtimeMs > staleMs) {
			unlinkSync(lockPath);
			return "retry";
		}
	} catch {
		// Released between the failed create and the stat: retry now.
		return "retry";
	}
	return "busy";
}

function release(descriptor: number, lockPath: string): void {
	closeSync(descriptor);
	try {
		unlinkSync(lockPath);
	} catch {
		// Already removed as stale by another process.
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
	let descriptor: number | undefined;

	while (descriptor === undefined) {
		options.signal?.throwIfAborted();
		const taken = takeOnce(lockPath, staleMs);
		if (typeof taken === "number") {
			descriptor = taken;
		} else if (taken === "busy") {
			if (Date.now() >= deadline) {
				throw new ExclusiveLockBusyError();
			}
			await sleep(options.pollMs ?? DEFAULT_POLL_MS);
		}
	}

	try {
		return await work();
	} finally {
		release(descriptor, lockPath);
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
	let descriptor: number | undefined;

	while (descriptor === undefined) {
		const taken = takeOnce(lockPath, staleMs);
		if (typeof taken === "number") {
			descriptor = taken;
		} else if (taken === "busy") {
			if (Date.now() >= deadline) {
				throw new ExclusiveLockBusyError();
			}
			sleepSync(options.pollMs ?? DEFAULT_POLL_MS);
		}
	}

	try {
		return work();
	} finally {
		release(descriptor, lockPath);
	}
}
