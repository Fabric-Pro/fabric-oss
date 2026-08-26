/**
 * Process Pool for STDIO MCP Servers
 *
 * Manages a pool of MCP STDIO processes with:
 * - Tenant isolation (separate process per user/org/config)
 * - TTL-based cleanup (60s idle timeout)
 * - Maximum process limits (50 per replica)
 * - LRU eviction when at capacity
 */

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
	 * When multiple requests come in for the same key simultaneously,
	 * only the first one creates the transport - others wait for it.
	 */
	private pendingCreations = new Map<string, Promise<StdioTransport>>();

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
	 * @returns The transport (existing, pending, or newly created)
	 */
	async getOrCreate(
		userId: string,
		organizationId: string | undefined,
		configId: string,
		factory: () => Promise<
			| StdioTransport
			| { transport: StdioTransport; cleanupPaths?: string[] }
		>,
	): Promise<StdioTransport> {
		const key = getProcessPoolKey(userId, organizationId, configId);

		// 1. Check if we already have a healthy transport
		const existing = this.get(userId, organizationId, configId);
		if (existing) {
			return existing;
		}

		// 2. Check if a creation is already in progress for this key
		const pending = this.pendingCreations.get(key);
		if (pending) {
			console.log(`[ProcessPool] Waiting for pending creation: ${key}`);
			return pending;
		}

		// 3. Create a new transport - we're the first request for this key
		console.log(`[ProcessPool] Starting new creation for: ${key}`);

		const creationPromise = (async () => {
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

				// Add to pool (this handles eviction if needed)
				await this.add(
					userId,
					organizationId,
					configId,
					transport,
					paths,
				);

				return transport;
			} finally {
				// Always clear pending state when done (success or failure)
				this.pendingCreations.delete(key);
			}
		})();

		// Track this creation as pending
		this.pendingCreations.set(key, creationPromise);

		return creationPromise;
	}

	/**
	 * Add a new process to the pool.
	 * Will evict LRU entry if at capacity.
	 */
	async add(
		userId: string,
		organizationId: string | undefined,
		configId: string,
		transport: StdioTransport,
		cleanupPaths?: string[],
	): Promise<void> {
		const key = getProcessPoolKey(userId, organizationId, configId);

		// Remove existing entry if present
		const existing = this.processes.get(key);
		if (existing) {
			await existing.transport.close();
			if (existing.cleanupPaths?.length) {
				await cleanupTempFiles(existing.cleanupPaths);
			}
		}

		// Evict LRU if at capacity
		if (this.processes.size >= this.maxProcesses) {
			await this.evictLru();
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
		});

		console.log(
			`[ProcessPool] Added process for key: ${key}, total: ${this.processes.size}`,
		);
	}

	/**
	 * Remove a process from the pool.
	 */
	async remove(
		userId: string,
		organizationId: string | undefined,
		configId: string,
	): Promise<void> {
		const key = getProcessPoolKey(userId, organizationId, configId);
		const entry = this.processes.get(key);

		if (entry) {
			await entry.transport.close();
			if (entry.cleanupPaths?.length) {
				await cleanupTempFiles(entry.cleanupPaths);
			}
			this.processes.delete(key);
			console.log(
				`[ProcessPool] Removed process for key: ${key}, total: ${this.processes.size}`,
			);
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

		// Remove marked processes
		for (const key of keysToRemove) {
			const entry = this.processes.get(key);
			if (entry) {
				try {
					await entry.transport.close();
				} catch (error) {
					console.error(
						`[ProcessPool] Error closing process ${key}:`,
						error,
					);
				}
				if (entry.cleanupPaths?.length) {
					await cleanupTempFiles(entry.cleanupPaths);
				}
				this.processes.delete(key);
			}
		}

		if (keysToRemove.length > 0) {
			console.log(
				`[ProcessPool] Cleaned up ${keysToRemove.length} processes, remaining: ${this.processes.size}`,
			);
		}
	}

	/**
	 * Evict the least recently used process.
	 */
	private async evictLru(): Promise<void> {
		let oldestKey: string | null = null;
		let oldestTime = Date.now();

		for (const [key, entry] of this.processes) {
			if (entry.lastUsedAt < oldestTime) {
				oldestTime = entry.lastUsedAt;
				oldestKey = key;
			}
		}

		if (oldestKey) {
			const entry = this.processes.get(oldestKey);
			if (entry) {
				console.log(`[ProcessPool] Evicting LRU process: ${oldestKey}`);
				try {
					await entry.transport.close();
				} catch (error) {
					console.error(
						`[ProcessPool] Error closing evicted process ${oldestKey}:`,
						error,
					);
				}
				if (entry.cleanupPaths?.length) {
					await cleanupTempFiles(entry.cleanupPaths);
				}
				this.processes.delete(oldestKey);
			}
		}
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
