/**
 * Process Pool for STDIO MCP Servers
 *
 * Manages a pool of MCP STDIO processes with:
 * - Tenant isolation (separate process per user/org/config)
 * - TTL-based cleanup (60s idle timeout)
 * - Maximum process limits (50 per replica)
 * - LRU eviction when at capacity
 * - Respawn when a request carries different credentials than the process
 *   was started with (see `hashCredentials`), unless the request's
 *   credentials are older than the pooled process's (`credentialsVersion`):
 *   it is then served by a process of its own, closed when it finishes
 * - Per-request leases (`getOrCreate` takes one, `release` returns it), so a
 *   process taken out of the pool (replaced, removed after a failure,
 *   evicted or reaped) is closed only once the requests using it finish
 * - Closes in the background: no request waits for another process's child
 *   to exit (up to `StdioTransport`'s SIGKILL fallback). `shutdown` and
 *   `closesSettled` wait for them.
 */

import { createHmac, randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import type { StdioTransport } from "./stdio-transport";

export interface ProcessPoolConfig {
	/** Maximum number of concurrent processes (default: 50) */
	maxProcesses?: number;
	/** TTL for idle processes in milliseconds (default: 60000) */
	idleTtlMs?: number;
	/** Cleanup interval in milliseconds (default: 10000) */
	cleanupIntervalMs?: number;
}

export interface ProcessPoolEntry {
	transport: StdioTransport;
	createdAt: number;
	lastUsedAt: number;
	userId: string;
	organizationId?: string;
	configId: string;
	/** Temp file paths to clean up when the process is removed */
	cleanupPaths?: string[];
	/**
	 * `hashCredentials` of the credentials the process was started with.
	 * Never logged and never returned by `getStats`.
	 */
	credentialsHash: string;
	/**
	 * Order in which this process's creation started (`creationSeq`). A
	 * creation that started earlier never replaces it, unless the two carry
	 * comparable credential versions (see `add`).
	 */
	creationSeq: number;
	/**
	 * How fresh the credentials the process was started with are, as the
	 * caller reports it (`compareCredentialsVersions`). Undefined when the
	 * caller sent none.
	 */
	credentialsVersion?: readonly number[];
}

/** A creation in flight, shared by requests with the same credentials. */
interface PendingCreation {
	promise: Promise<StdioTransport>;
	state: {
		/** Set once the factory returns, before the transport is pooled. */
		transport?: StdioTransport;
		/** Requests waiting on `promise` before `transport` was set. */
		waiters: number;
	};
}

/**
 * Per-process key for `hashCredentials`. Random on every start, so a hash is
 * comparable only inside this process and cannot be checked offline against
 * a guessed credential.
 */
const CREDENTIALS_HASH_KEY = randomBytes(32);

/**
 * A stable digest of a credentials map: the same entries in any order give
 * the same value. The pool compares it to decide whether a live process
 * still runs with the credentials a request carries (a refreshed access
 * token, a revoke or a reconnect changes them). Entries are sorted by key
 * and serialized as JSON, so no key/value boundary is ambiguous.
 */
export function hashCredentials(
	credentials: Record<string, string> | undefined,
): string {
	const entries = Object.entries(credentials ?? {}).sort(([a], [b]) =>
		a < b ? -1 : a > b ? 1 : 0,
	);
	return createHmac("sha256", CREDENTIALS_HASH_KEY)
		.update(JSON.stringify(entries))
		.digest("hex");
}

/**
 * Orders two credential versions: lexicographically, element by element,
 * then by length (a version with more elements is newer when one is a prefix
 * of the other). Returns a negative number when `a` is older, positive when
 * newer, 0 when equal, and null when either is missing, so the caller falls
 * back to another order. The caller decides what the elements mean (the web
 * app sends `[grant generation, access-token expiry]` for Google Drive).
 */
function compareCredentialsVersions(
	a: readonly number[] | undefined,
	b: readonly number[] | undefined,
): number | null {
	if (!a || !b) {
		return null;
	}
	const length = Math.min(a.length, b.length);
	for (let i = 0; i < length; i++) {
		const x = a[i] as number;
		const y = b[i] as number;
		if (x !== y) {
			return x < y ? -1 : 1;
		}
	}
	return a.length - b.length;
}

/**
 * Best-effort cleanup of temporary files/directories.
 */
async function cleanupTempFiles(paths: string[]): Promise<void> {
	for (const p of paths) {
		try {
			await rm(p, { recursive: true, force: true });
		} catch {
			// Best-effort — ignore errors
		}
	}
}

const DEFAULT_MAX_PROCESSES = 50;
const DEFAULT_IDLE_TTL_MS = 60 * 1000; // 60 seconds
const DEFAULT_CLEANUP_INTERVAL_MS = 10 * 1000; // 10 seconds

/**
 * Generate a cache key for tenant isolation.
 * Format: ${userId}:${organizationId ?? 'personal'}:${configId}
 */
function getProcessPoolKey(
	userId: string,
	organizationId: string | undefined,
	configId: string,
): string {
	return `${userId}:${organizationId ?? "personal"}:${configId}`;
}

export class ProcessPool {
	private processes = new Map<string, ProcessPoolEntry>();
	private cleanupInterval: NodeJS.Timeout | null = null;
	private readonly maxProcesses: number;
	private readonly idleTtlMs: number;
	private readonly cleanupIntervalMs: number;

	/**
	 * Track in-flight transport creations to prevent race conditions.
	 * When multiple requests come in for the same key and credentials
	 * simultaneously, only the first one creates the transport - others wait
	 * for it. Keyed by pool key plus credentials hash, so a request with
	 * other credentials never receives a process started with these.
	 */
	private pendingCreations = new Map<string, PendingCreation>();

	/**
	 * Requests holding each transport: taken in `getOrCreate`, returned with
	 * `release`. A transport with a lease is not closed when it is replaced.
	 */
	private leases = new Map<StdioTransport, number>();

	/**
	 * Transports taken out of the pool (replaced, or created too late to be
	 * pooled) while still leased, with their temp files. `release` closes
	 * each one when its last lease is returned; `shutdown` closes the rest.
	 */
	private retired = new Map<StdioTransport, string[] | undefined>();

	/** Incremented as each creation starts; see `creationSeq` on entries. */
	private nextCreationSeq = 0;

	/** Closes started in the background (see `closeInBackground`). */
	private closing = new Set<Promise<void>>();

	constructor(config: ProcessPoolConfig = {}) {
		this.maxProcesses = config.maxProcesses ?? DEFAULT_MAX_PROCESSES;
		this.idleTtlMs = config.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
		this.cleanupIntervalMs =
			config.cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS;

		// Start cleanup interval
		this.startCleanupInterval();
	}

	/**
	 * Get an existing process from the pool, if available and healthy.
	 */
	get(
		userId: string,
		organizationId: string | undefined,
		configId: string,
	): StdioTransport | null {
		const key = getProcessPoolKey(userId, organizationId, configId);
		const entry = this.processes.get(key);

		if (!entry) {
			return null;
		}

		// Check if process is still healthy
		if (!entry.transport.isAlive()) {
			console.log(`[ProcessPool] Removing dead process for key: ${key}`);
			this.remove(userId, organizationId, configId);
			return null;
		}

		// Update last used time
		entry.lastUsedAt = Date.now();
		return entry.transport;
	}

	/**
	 * Get or create a transport, handling concurrent requests safely.
	 *
	 * This method prevents race conditions when multiple requests arrive
	 * simultaneously for the same key. Only the first request creates
	 * the transport; others wait for the pending creation to complete.
	 *
	 * @param userId - User ID for tenant isolation
	 * @param organizationId - Organization ID (undefined for personal context)
	 * @param configId - MCP config ID
	 * @param factory - Async function to create a new transport if needed
	 * @param credentialsHash - `hashCredentials` of the request's credentials.
	 *   A live process started with other credentials is not reused: a new one
	 *   is created, and `add` takes the old one out of the pool once the new
	 *   one is ready (closing it when its last request finishes).
	 * @param credentialsVersion - How fresh the request's credentials are
	 *   (`compareCredentialsVersions`). When they are older than the pooled
	 *   process's, the new process serves this request (and any joining its
	 *   creation) only: `add` does not pool it, and it closes on `release`.
	 * @returns The transport (existing, pending, or newly created), leased to
	 *   the caller, who must pass it to `release` when its request is done.
	 */
	async getOrCreate(
		userId: string,
		organizationId: string | undefined,
		configId: string,
		factory: () => Promise<
			| StdioTransport
			| { transport: StdioTransport; cleanupPaths?: string[] }
		>,
		credentialsHash: string,
		credentialsVersion?: readonly number[],
	): Promise<StdioTransport> {
		const key = getProcessPoolKey(userId, organizationId, configId);

		// 1. Reuse a healthy transport started with these same credentials
		const existing = this.get(userId, organizationId, configId);
		if (
			existing &&
			this.processes.get(key)?.credentialsHash === credentialsHash
		) {
			this.lease(existing);
			return existing;
		}
		if (existing) {
			const order = compareCredentialsVersions(
				credentialsVersion,
				this.processes.get(key)?.credentialsVersion,
			);
			console.log(
				order !== null && order < 0
					? `[ProcessPool] Request carries older credentials; serving it with an unpooled process for key: ${key}`
					: `[ProcessPool] Credentials changed; replacing process for key: ${key}`,
			);
		}

		// 2. Check if a creation is already in progress for this key and
		// these credentials
		const pendingKey = `${key}#${credentialsHash}`;
		const pending = this.pendingCreations.get(pendingKey);
		if (pending) {
			console.log(`[ProcessPool] Waiting for pending creation: ${key}`);
			if (pending.state.transport) {
				this.lease(pending.state.transport);
			} else {
				pending.state.waiters++;
			}
			return pending.promise;
		}

		// 3. Create a new transport - we're the first request for this key
		console.log(`[ProcessPool] Starting new creation for: ${key}`);

		const creationSeq = this.nextCreationSeq++;
		const state: PendingCreation["state"] = { waiters: 0 };
		// Only this creation's entry: once it is cleared, a newer creation
		// for the same key and credentials may have registered its own.
		const clearPending = () => {
			if (this.pendingCreations.get(pendingKey)?.state === state) {
				this.pendingCreations.delete(pendingKey);
			}
		};
		const promise = (async () => {
			try {
				const result = await factory();

				// Factory can return a plain transport or { transport, cleanupPaths }
				const transport =
					result &&
					typeof result === "object" &&
					"transport" in result
						? result.transport
						: (result as StdioTransport);
				const paths =
					result &&
					typeof result === "object" &&
					"cleanupPaths" in result
						? result.cleanupPaths
						: undefined;

				// One lease for this request and one per waiter, taken before
				// `add` so neither it nor a later replacement closes the
				// transport under them.
				state.transport = transport;
				this.leases.set(transport, 1 + state.waiters);

				// Add to pool (this handles eviction if needed, and retires a
				// process this key held with other credentials). `add`
				// changes the pool synchronously; the pending entry goes
				// right after, so a later request never joins a finished
				// creation whose process may since have died or been removed
				// (`get` checks that; this map would not).
				const added = this.add(
					userId,
					organizationId,
					configId,
					transport,
					paths,
					credentialsHash,
					creationSeq,
					credentialsVersion,
				);
				clearPending();
				await added;

				return transport;
			} finally {
				// Always clear pending state when done (success or failure)
				clearPending();
			}
		})();

		// Track this creation as pending
		this.pendingCreations.set(pendingKey, { promise, state });

		return promise;
	}

	/**
	 * Return the lease `getOrCreate` took for one request. A transport that
	 * was taken out of the pool meanwhile is closed, and its temp files
	 * deleted, once its last lease is returned.
	 */
	async release(transport: StdioTransport): Promise<void> {
		const count = (this.leases.get(transport) ?? 0) - 1;
		if (count > 0) {
			this.leases.set(transport, count);
			return;
		}
		this.leases.delete(transport);
		if (this.retired.has(transport)) {
			const cleanupPaths = this.retired.get(transport);
			this.retired.delete(transport);
			this.closeInBackground(transport, cleanupPaths);
		}
	}

	/**
	 * Resolves once every close started so far (and any started while
	 * waiting) has finished.
	 */
	async closesSettled(): Promise<void> {
		while (this.closing.size > 0) {
			await Promise.all(Array.from(this.closing));
		}
	}

	private lease(transport: StdioTransport): void {
		this.leases.set(transport, (this.leases.get(transport) ?? 0) + 1);
	}

	/**
	 * Take a transport out of service: close it now (in the background) when
	 * no request holds it, otherwise when `release` returns its last lease.
	 */
	private retire(
		transport: StdioTransport,
		cleanupPaths: string[] | undefined,
	): void {
		if ((this.leases.get(transport) ?? 0) > 0) {
			this.retired.set(transport, cleanupPaths);
			return;
		}
		this.closeInBackground(transport, cleanupPaths);
	}

	/**
	 * Start closing a transport without making the caller wait for its child
	 * to exit. The close is tracked in `closing` for `shutdown` and
	 * `closesSettled`.
	 */
	private closeInBackground(
		transport: StdioTransport,
		cleanupPaths: string[] | undefined,
	): void {
		const done: Promise<void> = this.closeTransport(transport, cleanupPaths)
			.catch((error) => {
				console.error("[ProcessPool] Error closing transport:", error);
			})
			.finally(() => {
				this.closing.delete(done);
			});
		this.closing.add(done);
	}

	private async closeTransport(
		transport: StdioTransport,
		cleanupPaths: string[] | undefined,
	): Promise<void> {
		try {
			await transport.close();
		} catch (error) {
			console.error("[ProcessPool] Error closing transport:", error);
		}
		if (cleanupPaths?.length) {
			await cleanupTempFiles(cleanupPaths);
		}
	}

	/**
	 * Add a new process to the pool.
	 * Will evict LRU entry if at capacity.
	 *
	 * The process the key held before is retired: closed now if no request
	 * holds it, otherwise when its last lease is returned. When that process
	 * is the newer one, it stays pooled and this transport is retired
	 * instead. "Newer" is by credential freshness when both carry a
	 * `credentialsVersion` that differ (a request that resolved its token
	 * just before a refresh can start its creation after the refreshed one),
	 * and otherwise by start order (`creationSeq`).
	 *
	 * Every change to `processes` happens synchronously, so two creations
	 * for one key finishing close together cannot overwrite each other's
	 * entry or leave one unpooled and never closed. Retired processes close
	 * in the background: the caller does not wait for them.
	 */
	async add(
		userId: string,
		organizationId: string | undefined,
		configId: string,
		transport: StdioTransport,
		cleanupPaths: string[] | undefined,
		credentialsHash: string,
		creationSeq: number = this.nextCreationSeq++,
		credentialsVersion?: readonly number[],
	): Promise<void> {
		const key = getProcessPoolKey(userId, organizationId, configId);

		const existing = this.processes.get(key);
		const order = existing
			? compareCredentialsVersions(
					credentialsVersion,
					existing.credentialsVersion,
				)
			: null;
		const existingIsNewer =
			existing !== undefined &&
			(order !== null && order !== 0
				? order < 0
				: existing.creationSeq > creationSeq);
		if (existingIsNewer) {
			console.log(
				`[ProcessPool] A newer process is already pooled; not pooling this one for key: ${key}`,
			);
			this.retire(transport, cleanupPaths);
			return;
		}

		const toRetire: ProcessPoolEntry[] = [];
		if (existing) {
			this.processes.delete(key);
			toRetire.push(existing);
		}
		// Evict LRU if at capacity
		if (this.processes.size >= this.maxProcesses) {
			const victim = this.takeLru();
			if (victim) {
				toRetire.push(victim);
			}
		}

		const now = Date.now();
		this.processes.set(key, {
			transport,
			createdAt: now,
			lastUsedAt: now,
			userId,
			organizationId,
			configId,
			cleanupPaths,
			credentialsHash,
			creationSeq,
			credentialsVersion,
		});

		console.log(
			`[ProcessPool] Added process for key: ${key}, total: ${this.processes.size}`,
		);

		for (const entry of toRetire) {
			this.retire(entry.transport, entry.cleanupPaths);
		}
	}

	/**
	 * Remove a process from the pool. With `transport`, only when the key
	 * still holds that transport: a request that failed on a process that has
	 * since been replaced (new credentials) must not remove the replacement.
	 * The process stops getting new requests at once and is closed when no
	 * request holds it (see `retire`), so one request's failure does not
	 * reject the others still running on it.
	 */
	async remove(
		userId: string,
		organizationId: string | undefined,
		configId: string,
		transport?: StdioTransport,
	): Promise<void> {
		const key = getProcessPoolKey(userId, organizationId, configId);
		const entry = this.processes.get(key);

		if (entry && (!transport || entry.transport === transport)) {
			this.processes.delete(key);
			console.log(
				`[ProcessPool] Removed process for key: ${key}, total: ${this.processes.size}`,
			);
			this.retire(entry.transport, entry.cleanupPaths);
		}
	}

	/**
	 * Get pool statistics.
	 */
	getStats(): {
		size: number;
		maxProcesses: number;
		idleTtlMs: number;
		entries: Array<{
			key: string;
			ageMs: number;
			idleMs: number;
			userId: string;
			organizationId?: string;
			configId: string;
		}>;
	} {
		const now = Date.now();
		return {
			size: this.processes.size,
			maxProcesses: this.maxProcesses,
			idleTtlMs: this.idleTtlMs,
			entries: Array.from(this.processes.entries()).map(
				([key, entry]) => ({
					key,
					ageMs: now - entry.createdAt,
					idleMs: now - entry.lastUsedAt,
					userId: entry.userId,
					organizationId: entry.organizationId,
					configId: entry.configId,
				}),
			),
		};
	}

	/**
	 * Shutdown the pool, closing all processes.
	 */
	async shutdown(): Promise<void> {
		console.log("[ProcessPool] Shutting down...");

		// Stop cleanup interval
		if (this.cleanupInterval) {
			clearInterval(this.cleanupInterval);
			this.cleanupInterval = null;
		}

		// Close all processes and clean up temp files
		const closePromises = Array.from(this.processes.values()).map(
			async (entry) => {
				try {
					await entry.transport.close();
				} catch (error) {
					console.error(
						"[ProcessPool] Error closing transport during shutdown:",
						error,
					);
				}
				if (entry.cleanupPaths?.length) {
					await cleanupTempFiles(entry.cleanupPaths);
				}
			},
		);

		await Promise.all(closePromises);
		this.processes.clear();

		const retired = Array.from(this.retired.entries());
		this.retired.clear();
		this.leases.clear();
		await Promise.all(
			retired.map(([transport, cleanupPaths]) =>
				this.closeTransport(transport, cleanupPaths),
			),
		);
		await this.closesSettled();

		console.log("[ProcessPool] Shutdown complete");
	}

	/**
	 * Start the cleanup interval for removing idle processes.
	 */
	private startCleanupInterval(): void {
		this.cleanupInterval = setInterval(() => {
			this.cleanupIdleProcesses().catch((error) => {
				console.error("[ProcessPool] Cleanup error:", error);
			});
		}, this.cleanupIntervalMs);

		// Don't prevent Node.js from exiting
		this.cleanupInterval.unref();
	}

	/**
	 * Remove processes that have exceeded the idle TTL.
	 */
	private async cleanupIdleProcesses(): Promise<void> {
		const now = Date.now();
		const keysToRemove: string[] = [];

		for (const [key, entry] of this.processes) {
			const idleTime = now - entry.lastUsedAt;

			// Check if process is dead
			if (!entry.transport.isAlive()) {
				console.log(
					`[ProcessPool] Marking dead process for removal: ${key}`,
				);
				keysToRemove.push(key);
				continue;
			}

			// Check idle TTL
			if (idleTime > this.idleTtlMs) {
				console.log(
					`[ProcessPool] Marking idle process for removal: ${key} (idle ${Math.round(idleTime / 1000)}s)`,
				);
				keysToRemove.push(key);
			}
		}

		// Unmap every marked entry before any await, so a replacement pooled
		// under the same key while a close is in progress is never removed.
		const removed: ProcessPoolEntry[] = [];
		for (const key of keysToRemove) {
			const entry = this.processes.get(key);
			if (entry) {
				this.processes.delete(key);
				removed.push(entry);
			}
		}
		for (const entry of removed) {
			this.retire(entry.transport, entry.cleanupPaths);
		}

		if (keysToRemove.length > 0) {
			console.log(
				`[ProcessPool] Cleaned up ${keysToRemove.length} processes, remaining: ${this.processes.size}`,
			);
		}
	}

	/**
	 * Take the least recently used process out of the pool, synchronously.
	 * The caller retires it (see `retire`).
	 */
	private takeLru(): ProcessPoolEntry | undefined {
		let oldestKey: string | null = null;
		let oldestTime = Date.now();

		for (const [key, entry] of this.processes) {
			if (entry.lastUsedAt < oldestTime) {
				oldestTime = entry.lastUsedAt;
				oldestKey = key;
			}
		}

		if (!oldestKey) {
			return undefined;
		}
		const entry = this.processes.get(oldestKey);
		this.processes.delete(oldestKey);
		console.log(`[ProcessPool] Evicting LRU process: ${oldestKey}`);
		return entry;
	}
}

// Global singleton for the process pool
let globalPool: ProcessPool | null = null;

/**
 * Get the global process pool instance.
 */
export function getProcessPool(config?: ProcessPoolConfig): ProcessPool {
	if (!globalPool) {
		globalPool = new ProcessPool(config);
	}
	return globalPool;
}

/**
 * Shutdown the global process pool.
 */
export async function shutdownProcessPool(): Promise<void> {
	if (globalPool) {
		await globalPool.shutdown();
		globalPool = null;
	}
}
