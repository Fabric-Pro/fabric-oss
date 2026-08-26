/**
 * Connector Sync Workflow
 *
 * Orchestrates the three-phase sync pattern:
 * 1. Full Sync - Initial complete fetch from provider
 * 2. Incremental Sync - Fetch only new/updated items
 * 3. Garbage Collection - Remove deleted items
 *
 * Uses continueAsNew for long-running syncs to prevent workflow history
 * from growing too large.
 */

import {
	continueAsNew,
	defineQuery,
	defineSignal,
	log,
	patched,
	proxyActivities,
	setHandler,
	sleep,
	workflowInfo,
} from "@temporalio/workflow";
import type * as connectorActivities from "../../activities/connector-sync";

import {
	type ConnectorSyncInput,
	type ConnectorSyncOutput,
	type ConnectorSyncProgress,
	type ConnectorSyncState,
	createInitialSyncState,
	DEFAULT_SYNC_CONFIG,
	type SyncPhase,
} from "./types";

// Re-export types
export * from "./types";

// =============================================================================
// Signals & Queries
// =============================================================================

export const cancelSignal = defineSignal("cancel");
export const progressQuery = defineQuery<ConnectorSyncProgress>("progress");
export const statusQuery = defineQuery<ConnectorSyncState["status"]>("status");

// =============================================================================
// Activity Proxies
// =============================================================================

const activities = proxyActivities<typeof connectorActivities>({
	startToCloseTimeout: "5 minutes",
	heartbeatTimeout: "30 seconds",
	retry: {
		initialInterval: "2s",
		backoffCoefficient: 2,
		maximumInterval: "60s",
		maximumAttempts: 3,
	},
});

// Long-running activities (fetching large datasets)
const longActivities = proxyActivities<typeof connectorActivities>({
	startToCloseTimeout: "30 minutes",
	heartbeatTimeout: "60 seconds",
	retry: {
		initialInterval: "5s",
		backoffCoefficient: 2,
		maximumInterval: "120s",
		maximumAttempts: 2,
	},
});

// =============================================================================
// Main Workflow
// =============================================================================

export async function connectorSyncWorkflow(
	input: ConnectorSyncInput,
	resumeState?: Partial<ConnectorSyncState>,
): Promise<ConnectorSyncOutput> {
	// Initialize or resume state
	const state = resumeState
		? { ...createInitialSyncState(input), ...resumeState }
		: createInitialSyncState(input);

	const config = DEFAULT_SYNC_CONFIG;

	// ==========================================================================
	// Signal & Query Handlers
	// ==========================================================================

	setHandler(cancelSignal, () => {
		log.info("Received cancel signal", { executionId: state.executionId });
		state.cancelled = true;
	});

	setHandler(progressQuery, () => state.currentProgress);
	setHandler(statusQuery, () => state.status);

	// ==========================================================================
	// Helper Functions
	// ==========================================================================

	function updateProgress(
		phase: SyncPhase,
		message: string,
		progress = 0,
		currentResource?: string,
	) {
		state.currentProgress = {
			executionId: state.executionId,
			connectorId: state.connectorId,
			phase,
			message,
			progress,
			itemsProcessed: state.stats.itemsProcessed,
			totalItems: 0,
			currentResource,
			timestamp: new Date().toISOString(),
		};
	}

	function isCancelled(): boolean {
		return state.cancelled;
	}

	// ==========================================================================
	// Main Execution
	// ==========================================================================

	try {
		log.info("Starting connector sync workflow", {
			executionId: state.executionId,
			syncJobId: input.syncJobId,
			connectorId: input.connectorId,
			syncType: state.syncType,
			provider: input.provider,
		});

		state.status = "running";

		if (input.syncJobId) {
			await activities.updateSyncJobActivity({
				jobId: input.syncJobId,
				status: "RUNNING",
				startedAt: new Date().toISOString(),
				error: null,
			});
		}

		// ======================================================================
		// Phase 1: Initialize & Authenticate
		// ======================================================================
		updateProgress("initializing", "Loading connector configuration...");

		if (isCancelled()) {
			return buildOutput(state, false, "Cancelled");
		}

		// Load connector config from database
		const connectorConfig = await activities.loadConnectorConfig({
			connectorId: input.connectorId,
			userId: input.userId,
			organizationId: input.organizationId,
		});

		if (!connectorConfig) {
			throw new Error(`Connector ${input.connectorId} not found`);
		}

		// Test connection
		updateProgress("authenticating", "Testing connection...");

		const isConnected = await activities.testConnection({
			connectorId: input.connectorId,
			provider: input.provider,
			credentials: connectorConfig.credentials,
		});

		if (!isConnected) {
			throw new Error("Failed to authenticate with provider");
		}

		// ======================================================================
		// Phase 2: Discover Resources
		// ======================================================================
		updateProgress("discovering", "Discovering resources...");

		if (isCancelled()) {
			return buildOutput(state, false, "Cancelled");
		}

		const resources = await activities.discoverResources({
			connectorId: input.connectorId,
			provider: input.provider,
			providerConfig: connectorConfig.providerConfig,
			credentials: connectorConfig.credentials,
		});

		log.info("Resources discovered", {
			count: resources.length,
			provider: input.provider,
		});

		// ======================================================================
		// Phase 3: Fetch & Process
		// ======================================================================

		// Load cursor for incremental sync
		if (state.syncType === "incremental" && !state.cursor) {
			state.cursor = await activities.loadSyncCursor({
				connectorId: input.connectorId,
				cursorType: "incremental",
			});
		}

		let itemsProcessedThisRun = 0;

		for (const resource of resources) {
			if (isCancelled()) {
				break;
			}

			updateProgress(
				"fetching",
				`Fetching: ${resource.name}`,
				Math.round((itemsProcessedThisRun / resources.length) * 50),
				resource.id,
			);

			try {
				// Fetch documents from resource
				const fetchResult = await longActivities.fetchResourceDocuments(
					{
						connectorId: input.connectorId,
						provider: input.provider,
						resource,
						credentials: connectorConfig.credentials,
						providerConfig: connectorConfig.providerConfig,
						syncType: state.syncType,
						cursor: state.cursor,
						batchSize: config.batchSize,
					},
				);

				// Process documents in batches
				for (const batch of batchArray(
					fetchResult.documents,
					config.batchSize,
				)) {
					if (isCancelled()) {
						break;
					}

					updateProgress(
						"processing",
						`Processing: ${resource.name}`,
						Math.round(
							((itemsProcessedThisRun + batch.length) /
								resources.length) *
								70,
						),
						resource.id,
					);

					// Store documents
					const storeResult = await activities.storeDocuments({
						connectorId: input.connectorId,
						documents: batch,
						userId: input.userId,
						organizationId: input.organizationId,
					});

					state.stats.itemsAdded += storeResult.added;
					state.stats.itemsUpdated += storeResult.updated;
					state.stats.itemsProcessed += batch.length;
					itemsProcessedThisRun += batch.length;

					// Generate embeddings if enabled
					if (config.embedding.enabled) {
						updateProgress(
							"embedding",
							`Embedding: ${resource.name}`,
							Math.round(
								(itemsProcessedThisRun / resources.length) * 80,
							),
							resource.id,
						);

						const embedResult = await activities.generateEmbeddings(
							{
								connectorId: input.connectorId,
								documents: batch,
								workspaceIds: input.workspaceIds || [],
								model: config.embedding.model,
								userId: input.userId,
								organizationId: input.organizationId,
							},
						);

						state.stats.vectorsCreated += embedResult.created;
						state.stats.vectorsUpdated += embedResult.updated;
					}

					// Check if we should continueAsNew
					if (
						state.stats.itemsProcessed >=
						config.continueAsNewThreshold
					) {
						log.info("Continuing as new workflow", {
							itemsProcessed: state.stats.itemsProcessed,
							threshold: config.continueAsNewThreshold,
						});

						// Save cursor before continuing
						if (fetchResult.newCursor) {
							await activities.saveSyncCursor({
								cursor: fetchResult.newCursor,
							});
						}

						// Continue with remaining resources
						const _remainingResources = resources.slice(
							resources.indexOf(resource),
						);

						await continueAsNew<typeof connectorSyncWorkflow>(
							input,
							{
								...state,
								cursor: fetchResult.newCursor,
								// Pass remaining resources info
							},
						);
					}
				}

				// Update cursor after processing resource
				if (fetchResult.newCursor) {
					state.cursor = fetchResult.newCursor;
				}
			} catch (error) {
				const errorMsg =
					error instanceof Error ? error.message : "Unknown error";

				state.errors.push({
					resource: resource.id,
					error: errorMsg,
					timestamp: new Date().toISOString(),
				});

				log.warn("Error processing resource", {
					resource: resource.id,
					error: errorMsg,
				});

				if (!config.continueOnError) {
					throw error;
				}
			}
		}

		// ======================================================================
		// Phase 4: Garbage Collection (if GC sync)
		// ======================================================================
		if (state.syncType === "gc" && !isCancelled()) {
			updateProgress("cleanup", "Running garbage collection...", 85);

			const gcResult = await longActivities.garbageCollect({
				connectorId: input.connectorId,
				provider: input.provider,
				credentials: connectorConfig.credentials,
				userId: input.userId,
				organizationId: input.organizationId,
			});

			state.stats.itemsDeleted = gcResult.deleted;
			state.stats.vectorsDeleted = gcResult.vectorsDeleted;
		}

		// ======================================================================
		// Phase 5: Finalize
		// ======================================================================
		updateProgress("storing", "Saving sync state...", 95);

		// Save final cursor
		if (state.cursor) {
			await activities.saveSyncCursor({ cursor: state.cursor });
		}

		// Update connector status
		await activities.updateConnectorStatus({
			connectorId: input.connectorId,
			status: "ACTIVE",
			lastSyncAt: new Date().toISOString(),
			userId: input.userId,
			organizationId: input.organizationId,
		});

		// Schedule next sync
		const nextSyncAt = calculateNextSync(state.syncType, connectorConfig);

		if (nextSyncAt) {
			await activities.scheduleNextSync({
				connectorId: input.connectorId,
				syncType: getNextSyncType(state.syncType),
				scheduledAt: nextSyncAt,
				userId: input.userId,
				organizationId: input.organizationId,
			});
		}

		state.stats.durationMs = Date.now() - state.startTime;
		state.status = isCancelled() ? "cancelled" : "completed";

		updateProgress(
			"completed",
			`Sync completed: ${state.stats.itemsProcessed} items processed`,
			100,
		);

		log.info("Connector sync completed", {
			executionId: state.executionId,
			stats: state.stats,
		});

		if (input.syncJobId) {
			await activities.updateSyncJobActivity({
				jobId: input.syncJobId,
				status: isCancelled() ? "CANCELLED" : "COMPLETED",
				totalItems: state.stats.itemsProcessed,
				processedItems: state.stats.itemsProcessed,
				failedItems: state.errors.length,
				completedAt: new Date().toISOString(),
				error: null,
				stats: {
					...state.stats,
					errors: state.errors,
				},
			});
		}

		return buildOutput(state, true, undefined, nextSyncAt);
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : "Unknown error";

		log.error("Connector sync failed", {
			executionId: state.executionId,
			error: errorMessage,
		});

		state.status = "failed";
		state.stats.durationMs = Date.now() - state.startTime;

		updateProgress("failed", `Sync failed: ${errorMessage}`);

		// Update connector status to error
		try {
			await activities.updateConnectorStatus({
				connectorId: input.connectorId,
				status: "ERROR",
				lastError: errorMessage,
				userId: input.userId,
				organizationId: input.organizationId,
			});
		} catch {
			// Ignore status update errors
		}

		if (input.syncJobId) {
			try {
				await activities.updateSyncJobActivity({
					jobId: input.syncJobId,
					status: "FAILED",
					totalItems: state.stats.itemsProcessed,
					processedItems: state.stats.itemsProcessed,
					failedItems: state.errors.length || 1,
					completedAt: new Date().toISOString(),
					error: errorMessage,
					stats: {
						...state.stats,
						errors: state.errors,
					},
				});
			} catch {
				// Ignore sync job update errors
			}
		}

		return buildOutput(state, false, errorMessage);
	}
}

// =============================================================================
// Scheduled Sync Workflow
// =============================================================================

/**
 * Long-running workflow that manages the sync schedule for a connector.
 * Runs Full → Incremental → Incremental → ... → GC → repeat
 */
export async function connectorScheduledSyncWorkflow(input: {
	connectorId: string;
	provider: string;
	userId: string;
	organizationId?: string;
	fullSyncIntervalHours: number;
	incrementalSyncIntervalMinutes: number;
	gcIntervalHours: number;
}): Promise<void> {
	let cancelled = false;
	let syncCount = 0;

	setHandler(cancelSignal, () => {
		cancelled = true;
	});

	// Initial full sync
	if (!cancelled) {
		await connectorSyncWorkflow({
			connectorId: input.connectorId,
			provider: input.provider,
			syncType: "full",
			userId: input.userId,
			organizationId: input.organizationId,
		});
		syncCount++;
	}

	// Continuous incremental syncs with periodic GC
	while (!cancelled) {
		// Wait for incremental interval
		await sleep(input.incrementalSyncIntervalMinutes * 60 * 1000);

		if (cancelled) {
			break;
		}

		// Determine sync type
		const hoursSinceStart =
			(syncCount * input.incrementalSyncIntervalMinutes) / 60;
		const shouldGc = hoursSinceStart >= input.gcIntervalHours;
		const shouldFullSync = hoursSinceStart >= input.fullSyncIntervalHours;

		let syncType: "full" | "incremental" | "gc" = "incremental";
		if (shouldFullSync) {
			syncType = "full";
			syncCount = 0; // Reset counter
		} else if (shouldGc) {
			syncType = "gc";
		}

		await connectorSyncWorkflow({
			connectorId: input.connectorId,
			provider: input.provider,
			syncType,
			userId: input.userId,
			organizationId: input.organizationId,
		});

		syncCount++;

		// continueAsNew when the server suggests it (~4K events / ~4MB).
		// Gated by patched() so in-flight executions started under the prior
		// `syncCount >= 100` threshold replay deterministically.
		const shouldContinueAsNew = patched(
			"connector-sync-can-suggested-2026-04",
		)
			? workflowInfo().continueAsNewSuggested
			: syncCount >= 100;

		if (shouldContinueAsNew) {
			await continueAsNew<typeof connectorScheduledSyncWorkflow>(input);
		}
	}
}

// =============================================================================
// Helper Functions
// =============================================================================

function buildOutput(
	state: ConnectorSyncState,
	success: boolean,
	error?: string,
	nextSyncAt?: string,
): ConnectorSyncOutput {
	return {
		executionId: state.executionId,
		connectorId: state.connectorId,
		provider: state.provider,
		syncType: state.syncType,
		success,
		stats: state.stats,
		nextSyncAt,
		error,
	};
}

function batchArray<T>(array: T[], batchSize: number): T[][] {
	const batches: T[][] = [];
	for (let i = 0; i < array.length; i += batchSize) {
		batches.push(array.slice(i, i + batchSize));
	}
	return batches;
}

function calculateNextSync(
	_syncType: "full" | "incremental" | "gc",
	config: { syncConfig?: { incrementalSyncIntervalMinutes?: number } },
): string | undefined {
	if (!config.syncConfig?.incrementalSyncIntervalMinutes) {
		return undefined;
	}

	const intervalMs =
		config.syncConfig.incrementalSyncIntervalMinutes * 60 * 1000;
	return new Date(Date.now() + intervalMs).toISOString();
}

function getNextSyncType(
	_currentType: "full" | "incremental" | "gc",
): "full" | "incremental" | "gc" {
	// After full sync, do incremental
	// After incremental, do incremental (GC is scheduled separately)
	// After GC, do incremental
	return "incremental";
}
