/**
 * Connector Sync Workflow Types
 *
 * Types for the three-phase sync workflow pattern:
 * Full Sync → Incremental Sync → Garbage Collection
 */

// =============================================================================
// Input/Output Types
// =============================================================================

export interface ConnectorSyncInput {
	/** Sync job ID for lifecycle/status updates */
	syncJobId?: string;

	/** Connector ID from database */
	connectorId: string;

	/** Connector provider type */
	provider: string;

	/** Type of sync to perform */
	syncType: "full" | "incremental" | "gc" | "auto";

	/** User/Organization ownership */
	userId: string;
	organizationId?: string;

	/** Force sync even if recently synced */
	force?: boolean;

	/** Workspace IDs to sync into (for vector storage) */
	workspaceIds?: string[];
}

export interface ConnectorSyncOutput {
	/** Execution ID */
	executionId: string;

	/** Connector ID */
	connectorId: string;

	/** Provider */
	provider: string;

	/** Sync type that was performed */
	syncType: "full" | "incremental" | "gc";

	/** Was sync successful */
	success: boolean;

	/** Statistics */
	stats: SyncStats;

	/** Next scheduled sync */
	nextSyncAt?: string;

	/** Error if failed */
	error?: string;
}

export interface SyncStats {
	itemsProcessed: number;
	itemsAdded: number;
	itemsUpdated: number;
	itemsDeleted: number;
	vectorsCreated: number;
	vectorsUpdated: number;
	vectorsDeleted: number;
	durationMs: number;
}

// =============================================================================
// Progress Types
// =============================================================================

export interface ConnectorSyncProgress {
	executionId: string;
	connectorId: string;
	phase: SyncPhase;
	message: string;
	progress: number; // 0-100
	itemsProcessed: number;
	totalItems: number;
	currentResource?: string;
	timestamp: string;
}

export type SyncPhase =
	| "initializing"
	| "authenticating"
	| "discovering"
	| "fetching"
	| "processing"
	| "embedding"
	| "storing"
	| "cleanup"
	| "completed"
	| "failed";

// =============================================================================
// State Types
// =============================================================================

export interface ConnectorSyncState {
	executionId: string;
	connectorId: string;
	provider: string;
	syncType: "full" | "incremental" | "gc";
	userId: string;
	organizationId?: string;

	status: "pending" | "running" | "completed" | "failed" | "cancelled";
	cancelled: boolean;

	stats: SyncStats;
	currentProgress: ConnectorSyncProgress;

	/** Sync cursor for incremental */
	cursor?: SyncCursor;

	/** Error tracking */
	errors: Array<{ resource: string; error: string; timestamp: string }>;

	/** Timing */
	startTime: number;
}

export interface SyncCursor {
	connectorId: string;
	provider: string;
	cursorType: "incremental" | "gc";
	cursor: string;
	lastSyncedAt: string;
	metadata?: Record<string, unknown>;
}

// =============================================================================
// Configuration Types
// =============================================================================

export interface ConnectorSyncConfig {
	/** Maximum items to process per batch */
	batchSize: number;

	/** Rate limit delay between API calls (ms) */
	rateLimitDelayMs: number;

	/** Maximum retries for failed operations */
	maxRetries: number;

	/** Whether to continue on individual item errors */
	continueOnError: boolean;

	/** Vector embedding settings */
	embedding: {
		enabled: boolean;
		batchSize: number;
		model: string;
	};

	/** When to use continueAsNew (prevents workflow history from growing too large) */
	continueAsNewThreshold: number;
}

export const DEFAULT_SYNC_CONFIG: ConnectorSyncConfig = {
	batchSize: 100,
	rateLimitDelayMs: 1000,
	maxRetries: 3,
	continueOnError: true,
	embedding: {
		enabled: true,
		batchSize: 50,
		model: "text-embedding-3-small",
	},
	continueAsNewThreshold: 5000, // Continue as new after 5000 items
};

// =============================================================================
// Helpers
// =============================================================================

export function createInitialSyncState(
	input: ConnectorSyncInput,
): ConnectorSyncState {
	const executionId = `sync_${input.connectorId}_${Date.now()}`;

	const syncType =
		input.syncType === "auto" ? determineSyncType(input) : input.syncType;

	return {
		executionId,
		connectorId: input.connectorId,
		provider: input.provider,
		syncType,
		userId: input.userId,
		organizationId: input.organizationId,

		status: "pending",
		cancelled: false,

		stats: {
			itemsProcessed: 0,
			itemsAdded: 0,
			itemsUpdated: 0,
			itemsDeleted: 0,
			vectorsCreated: 0,
			vectorsUpdated: 0,
			vectorsDeleted: 0,
			durationMs: 0,
		},

		currentProgress: {
			executionId,
			connectorId: input.connectorId,
			phase: "initializing",
			message: "Starting sync...",
			progress: 0,
			itemsProcessed: 0,
			totalItems: 0,
			timestamp: new Date().toISOString(),
		},

		errors: [],
		startTime: Date.now(),
	};
}

function determineSyncType(
	_input: ConnectorSyncInput,
): "full" | "incremental" | "gc" {
	// TODO: Check last sync time and cursor to determine sync type
	// For now, default to incremental
	return "incremental";
}
