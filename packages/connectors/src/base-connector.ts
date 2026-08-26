/**
 * Base Connector
 *
 * Abstract base class for all connectors. Provides common functionality
 * for syncing external data sources.
 */

import type {
	ConnectorConfig,
	ConnectorCredentials,
	ConnectorDocument,
	ConnectorProvider,
	IConnector,
	SyncCursor,
	SyncProgress,
	SyncResult,
} from "./types";

// =============================================================================
// Abstract Base Connector
// =============================================================================

export abstract class BaseConnector implements IConnector {
	abstract provider: ConnectorProvider;

	/**
	 * Test connection and credentials
	 */
	abstract testConnection(config: ConnectorConfig): Promise<boolean>;

	/**
	 * Perform full sync - fetches all data from the provider
	 */
	abstract fullSync(
		config: ConnectorConfig,
		onProgress: (progress: SyncProgress) => void,
	): Promise<SyncResult>;

	/**
	 * Perform incremental sync - fetches only new/updated data
	 */
	abstract incrementalSync(
		config: ConnectorConfig,
		cursor: SyncCursor | null,
		onProgress: (progress: SyncProgress) => void,
	): Promise<{ result: SyncResult; newCursor: SyncCursor }>;

	/**
	 * Garbage collection - removes deleted items
	 */
	abstract garbageCollect(
		config: ConnectorConfig,
		onProgress: (progress: SyncProgress) => void,
	): Promise<SyncResult>;

	// =========================================================================
	// Common Helpers
	// =========================================================================

	/**
	 * Create a sync progress object
	 */
	protected createProgress(
		connectorId: string,
		phase: string,
		progress: number,
		itemsProcessed: number,
		totalItems: number,
	): SyncProgress {
		return {
			connectorId,
			state: "FULL_SYNC",
			phase,
			progress,
			itemsProcessed,
			totalItems,
			startedAt: new Date(),
		};
	}

	/**
	 * Create a successful sync result
	 */
	protected createSuccessResult(
		connectorId: string,
		syncType: "full" | "incremental" | "gc",
		stats: {
			itemsProcessed: number;
			itemsAdded: number;
			itemsUpdated: number;
			itemsDeleted: number;
			durationMs: number;
		},
	): SyncResult {
		return {
			connectorId,
			syncType,
			success: true,
			...stats,
		};
	}

	/**
	 * Create a failed sync result
	 */
	protected createErrorResult(
		connectorId: string,
		syncType: "full" | "incremental" | "gc",
		error: string,
		durationMs: number,
	): SyncResult {
		return {
			connectorId,
			syncType,
			success: false,
			itemsProcessed: 0,
			itemsAdded: 0,
			itemsUpdated: 0,
			itemsDeleted: 0,
			durationMs,
			error,
		};
	}

	/**
	 * Create a sync cursor
	 */
	protected createCursor(
		connectorId: string,
		cursor: string,
		cursorType: "incremental" | "gc" = "incremental",
		metadata?: Record<string, unknown>,
	): SyncCursor {
		return {
			connectorId,
			provider: this.provider,
			cursorType,
			cursor,
			lastSyncedAt: new Date(),
			metadata,
		};
	}

	/**
	 * Batch documents for processing
	 */
	protected async processBatch<T>(
		items: T[],
		batchSize: number,
		processor: (batch: T[]) => Promise<void>,
	): Promise<void> {
		for (let i = 0; i < items.length; i += batchSize) {
			const batch = items.slice(i, i + batchSize);
			await processor(batch);
		}
	}

	/**
	 * Rate limit helper - sleep for specified ms
	 */
	protected async sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	/**
	 * Retry with exponential backoff
	 */
	protected async retryWithBackoff<T>(
		fn: () => Promise<T>,
		maxAttempts = 3,
		initialDelayMs = 1000,
	): Promise<T> {
		let lastError: Error | undefined;

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				return await fn();
			} catch (error) {
				lastError =
					error instanceof Error ? error : new Error(String(error));

				if (attempt < maxAttempts) {
					const delay = initialDelayMs * 2 ** (attempt - 1);
					await this.sleep(delay);
				}
			}
		}

		throw lastError;
	}

	/**
	 * Check if credentials need refresh
	 */
	protected needsTokenRefresh(credentials: ConnectorCredentials): boolean {
		if (!credentials.expiresAt) {
			return false;
		}

		// Refresh if expiring within 5 minutes
		const expiresAt = new Date(credentials.expiresAt);
		const now = new Date();
		const fiveMinutes = 5 * 60 * 1000;

		return expiresAt.getTime() - now.getTime() < fiveMinutes;
	}

	/**
	 * Transform raw content to ConnectorDocument
	 */
	protected abstract transformToDocument(
		connectorId: string,
		rawItem: unknown,
	): ConnectorDocument;
}

// =============================================================================
// Connector Registry
// =============================================================================

const connectorRegistry = new Map<ConnectorProvider, () => IConnector>();

/**
 * Register a connector implementation
 */
export function registerConnector(
	provider: ConnectorProvider,
	factory: () => IConnector,
): void {
	connectorRegistry.set(provider, factory);
}

/**
 * Get a connector by provider
 */
export function getConnector(provider: ConnectorProvider): IConnector | null {
	const factory = connectorRegistry.get(provider);
	return factory ? factory() : null;
}

/**
 * List registered connectors
 */
export function listConnectors(): ConnectorProvider[] {
	return Array.from(connectorRegistry.keys());
}
