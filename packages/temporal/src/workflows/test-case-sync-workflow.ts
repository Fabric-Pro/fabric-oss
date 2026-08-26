/**
 * Test Case Sync Workflow
 *
 * The test-case counterpart of `storySyncWorkflow`: pushes Fabric test cases to
 * an external PM tool and pulls/imports PM items back into test cases. It rides
 * the SAME generic MCP engine — capability discovery, `executeMcpTool`, the
 * shared `detectAndStampPmPushConflict` drift guard — with NO per-tool fork. All
 * cross-provider step serialization lives in the pure `test-case-serializer`
 * (imported here as values because it is dependency-free and therefore safe for
 * the deterministic workflow bundle).
 *
 * Determinism: no `Date.now()` / `new Date()` / `Math.random()` in this body —
 * timestamps are stamped inside activities; the start-site `Date.now()` for the
 * workflowId lives in the API procedure. New command-producing logic is gated
 * behind `patched()`: the drift-guard sequence behind
 * `patched("test-case-sync-v1")` and the execution-result push (step 3b) behind
 * its own `patched("test-case-execution-sync-v1")`.
 */

import {
	ActivityFailure,
	ApplicationFailure,
	defineQuery,
	defineSignal,
	log,
	patched,
	proxyActivities,
	setHandler,
} from "@temporalio/workflow";

import type { executeMcpTool as ExecuteMcpToolFn } from "../activities/orchestrator/execution/execute-mcp-tool";
import type { detectAndStampPmPushConflict as DetectAndStampPmPushConflictFn } from "../activities/pm-integration/detect-pm-push-conflict";
import type { recordPmSyncFailure as RecordPmSyncFailureFn } from "../activities/pm-integration/record-pm-sync-state";
import type {
	discoverPMToolCapabilities as DiscoverPMToolCapabilitiesFn,
	fetchPMItemsByIds as FetchPMItemsByIdsFn,
	listWorkItemsFromPM as ListWorkItemsFromPMFn,
} from "../activities/pm-integration/story-sync";
import {
	buildTestCaseCreateArgs,
	buildTestCaseDescription,
	buildTestCaseUpdateArgs,
	extractCreatedTestCaseRefs,
	formatTestCaseStepsForProvider,
} from "../activities/pm-integration/test-case-serializer";
import type {
	createOrUpdateTestCaseFromPMItem as CreateOrUpdateTestCaseFromPMItemFn,
	getTestCasesToSync as GetTestCasesToSyncFn,
	updateTestCaseExternalRefs as UpdateTestCaseExternalRefsFn,
} from "../activities/pm-integration/test-case-sync";
import type { TestResultValue } from "../activities/pm-integration/test-execution-serializer";
import type { pushTestCaseExecutionToPM as PushTestCaseExecutionToPMFn } from "../activities/pm-integration/test-execution-sync";

// =============================================================================
// Types
// =============================================================================

export interface TestCaseSyncWorkflowInput {
	projectId: string;
	/** Identifies the PM provider (MCPServer.id). Always present. */
	mcpServerId: string;
	/** Null on the GitLab REST fallback path (no MCPConfig). */
	mcpConfigId: string | null;
	containerId: string;
	containerName?: string;
	additionalContext?: Record<string, string>;
	userId: string;
	organizationId?: string;
	/** Push only: limit to these test case ids (else all matching the filter). */
	testCaseIds?: string[];
	unsyncedOnly?: boolean;
	direction: "push" | "pull";
	/** Pull only: import only these specific PM external IDs (selective pull). */
	pmExternalIds?: string[];
}

export interface TestCaseSyncProgress {
	status: "initializing" | "syncing" | "completed" | "cancelled" | "failed";
	totalCases: number;
	syncedCount: number;
	failedCount: number;
	/** Items skipped because the PM side drifted; stamped CONFLICT for review. */
	conflictedCount: number;
	currentTestCaseId?: string;
	currentIdentifier?: string;
	message: string;
	results: Array<{
		testCaseId: string;
		identifier: string;
		success: boolean;
		outcome?: "synced" | "conflict" | "failed";
		externalId?: string;
		externalUrl?: string;
		error?: string;
	}>;
}

export interface TestCaseSyncWorkflowOutput {
	success: boolean;
	totalCases: number;
	syncedCount: number;
	failedCount: number;
	conflictedCount?: number;
	results: TestCaseSyncProgress["results"];
	error?: string;
}

// =============================================================================
// Signals & Queries
// =============================================================================

export const cancelTestCaseSyncSignal = defineSignal("cancelSync");
export const testCaseSyncProgressQuery =
	defineQuery<TestCaseSyncProgress>("progress");

// =============================================================================
// Activity Proxies
// =============================================================================

const { executeMcpTool } = proxyActivities<{
	executeMcpTool: typeof ExecuteMcpToolFn;
}>({
	startToCloseTimeout: "30 seconds",
	heartbeatTimeout: "30 seconds",
	retry: {
		initialInterval: "1s",
		backoffCoefficient: 2,
		maximumAttempts: 3,
	},
});

const {
	getTestCasesToSync,
	createOrUpdateTestCaseFromPMItem,
	updateTestCaseExternalRefs,
	listWorkItemsFromPM,
	fetchPMItemsByIds,
	recordPmSyncFailure,
} = proxyActivities<{
	getTestCasesToSync: typeof GetTestCasesToSyncFn;
	createOrUpdateTestCaseFromPMItem: typeof CreateOrUpdateTestCaseFromPMItemFn;
	updateTestCaseExternalRefs: typeof UpdateTestCaseExternalRefsFn;
	listWorkItemsFromPM: typeof ListWorkItemsFromPMFn;
	fetchPMItemsByIds: typeof FetchPMItemsByIdsFn;
	recordPmSyncFailure: typeof RecordPmSyncFailureFn;
}>({
	startToCloseTimeout: "60 seconds",
	heartbeatTimeout: "30 seconds",
	retry: {
		initialInterval: "2s",
		maximumInterval: "30s",
		backoffCoefficient: 2,
		maximumAttempts: 5,
	},
});

// Fail-fast proxy for PM-connectivity-bound activities — bound the preflight +
// the best-effort drift guard so a degraded PM tool aborts quickly instead of
// grinding through the heavy 60s × 5 budget per item.
const { discoverPMToolCapabilities, detectAndStampPmPushConflict } =
	proxyActivities<{
		discoverPMToolCapabilities: typeof DiscoverPMToolCapabilitiesFn;
		detectAndStampPmPushConflict: typeof DetectAndStampPmPushConflictFn;
	}>({
		startToCloseTimeout: "25 seconds",
		heartbeatTimeout: "20 seconds",
		retry: {
			initialInterval: "1s",
			maximumInterval: "5s",
			backoffCoefficient: 2,
			maximumAttempts: 2,
		},
	});

// Execution (run/result) push — best-effort. A deferred or failed execution push
// must NEVER fail the case sync (the case already synced), so keep the budget
// small and swallow errors at the call site. The live ADO Test Results POST is
// DEFERRED — see pushTestCaseExecutionToPM.
const { pushTestCaseExecutionToPM } = proxyActivities<{
	pushTestCaseExecutionToPM: typeof PushTestCaseExecutionToPMFn;
}>({
	startToCloseTimeout: "25 seconds",
	heartbeatTimeout: "20 seconds",
	retry: {
		initialInterval: "1s",
		maximumInterval: "5s",
		backoffCoefficient: 2,
		maximumAttempts: 2,
	},
});

// =============================================================================
// Workflow Implementation
// =============================================================================

export async function testCaseSyncWorkflow(
	input: TestCaseSyncWorkflowInput,
): Promise<TestCaseSyncWorkflowOutput> {
	const {
		projectId,
		mcpServerId,
		mcpConfigId,
		containerId,
		containerName,
		additionalContext,
		userId,
		organizationId,
		direction,
	} = input;

	let cancelled = false;
	const progress: TestCaseSyncProgress = {
		status: "initializing",
		totalCases: 0,
		syncedCount: 0,
		failedCount: 0,
		conflictedCount: 0,
		message: "Initializing test case sync...",
		results: [],
	};

	setHandler(cancelTestCaseSyncSignal, () => {
		log.info("Received cancel signal");
		cancelled = true;
		progress.status = "cancelled";
		progress.message = "Sync cancelled by user";
	});
	setHandler(testCaseSyncProgressQuery, () => progress);

	function parseMcpResponse(output: unknown): unknown {
		if (typeof output === "object" && output !== null) {
			const obj = output as Record<string, unknown>;
			if (Array.isArray(obj.content)) {
				const textContent = obj.content.find(
					(c: unknown) =>
						typeof c === "object" &&
						c !== null &&
						(c as Record<string, unknown>).type === "text",
				) as { text?: string } | undefined;
				if (textContent?.text) {
					try {
						return JSON.parse(textContent.text);
					} catch {
						return textContent.text;
					}
				}
			}
		}
		return output;
	}

	function mcpErrorDetail(output: unknown): string {
		const parsed = parseMcpResponse(output);
		if (typeof parsed === "string") {
			return parsed;
		}
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			"error" in parsed
		) {
			return String((parsed as Record<string, unknown>).error);
		}
		return "Unknown error";
	}

	try {
		log.info("Starting test case sync workflow", {
			projectId,
			mcpConfigId,
			containerId,
			direction,
		});

		// 1. Discover PM tool capabilities (doubles as a fast preflight).
		progress.message = "Discovering PM tool capabilities...";
		let capabilities: Awaited<
			ReturnType<typeof discoverPMToolCapabilities>
		>;
		try {
			capabilities = await discoverPMToolCapabilities({
				mcpConfigId,
				mcpServerId,
				userId,
				organizationId,
				containerId,
			});
		} catch (preflightError) {
			const detail = extractActivityError(preflightError);
			log.warn("PM preflight failed — aborting test case sync", {
				projectId,
				detail,
			});
			progress.status = "failed";
			progress.message =
				"Couldn't reach the PM tool to start the sync — nothing was changed. Please try again shortly.";
			return {
				success: false,
				totalCases: 0,
				syncedCount: 0,
				failedCount: 0,
				conflictedCount: 0,
				results: [],
				error: progress.message,
			};
		}

		if (!capabilities || !capabilities.hasPMCapabilities) {
			progress.status = "failed";
			progress.message = "PM tool does not have required capabilities";
			throw ApplicationFailure.nonRetryable(
				"PM tool does not support task creation/update",
				"TEST_CASE_SYNC_VALIDATION_ERROR",
			);
		}

		// Azure DevOps expects a project NAME; other tools need the container id.
		const isADO = capabilities.detectedType === "azure-devops";
		const containerValue = isADO
			? (containerName ?? containerId)
			: containerId;

		if (
			direction === "pull" &&
			!capabilities.taskList &&
			!capabilities.taskGet
		) {
			progress.status = "failed";
			progress.message =
				"PM tool does not support listing or fetching work items (required for pull)";
			throw ApplicationFailure.nonRetryable(
				"Pull requires a list or get work-items tool",
				"TEST_CASE_SYNC_VALIDATION_ERROR",
			);
		}

		// 2. Build the work list (PM items for pull, Fabric cases for push).
		type SyncRow = {
			id: string;
			identifier: string;
			title: string;
			description?: string | null;
			state?: string;
			priority?: string;
			tags?: string[];
			externalId?: string | null;
			externalUrl?: string | null;
			steps?: Array<{ action: string; expected: string }>;
			/** Current run result (push only) — drives the execution push. */
			currentResult?: TestResultValue | null;
		};
		let rows: SyncRow[];

		const isSelectivePull =
			!!input.pmExternalIds && input.pmExternalIds.length > 0;

		if (direction === "pull") {
			const FETCH_PAGE_SIZE = 50;
			const MAX_PAGES = 200;
			type PmItem = Awaited<
				ReturnType<typeof ListWorkItemsFromPMFn>
			>["items"][number];
			let allPmItems: PmItem[] = [];
			let selectiveFastPathAttempted = false;

			// Selective pull fast path: fetch the chosen ids directly.
			if (
				isSelectivePull &&
				capabilities.taskGet &&
				input.pmExternalIds
			) {
				progress.message = `Fetching ${input.pmExternalIds.length} selected work item(s)...`;
				const fetched = await fetchPMItemsByIds({
					mcpConfigId,
					mcpServerId,
					containerId: containerValue,
					externalIds: input.pmExternalIds,
					additionalContext,
					userId,
					organizationId,
				});
				allPmItems = fetched.items;
				selectiveFastPathAttempted = true;
			}

			// Generic paginated fetch.
			if (!selectiveFastPathAttempted && allPmItems.length === 0) {
				let currentPage = 1;
				let fetchMore = true;
				let effectivePageSize: number | undefined;
				while (fetchMore && currentPage <= MAX_PAGES) {
					progress.message = `Fetching PM work items (page ${currentPage})...`;
					const pageResult = await listWorkItemsFromPM({
						mcpConfigId,
						mcpServerId,
						containerId: containerValue,
						additionalContext,
						userId,
						organizationId,
						page: currentPage,
						pageSize: FETCH_PAGE_SIZE,
					});
					allPmItems.push(...pageResult.items);
					if (pageResult.items.length === 0) {
						fetchMore = false;
					} else if (pageResult.total != null) {
						fetchMore = allPmItems.length < pageResult.total;
					} else {
						if (
							effectivePageSize == null &&
							pageResult.items.length < FETCH_PAGE_SIZE
						) {
							effectivePageSize = pageResult.items.length;
						}
						fetchMore =
							pageResult.items.length >=
							(effectivePageSize ?? FETCH_PAGE_SIZE);
					}
					currentPage++;
				}
			}

			let pmItems = allPmItems;
			if (input.pmExternalIds && input.pmExternalIds.length > 0) {
				const filterSet = new Set(input.pmExternalIds);
				pmItems = pmItems.filter((item) => filterSet.has(item.id));
			}

			progress.totalCases = pmItems.length;
			if (pmItems.length === 0) {
				progress.status = "completed";
				progress.message = isSelectivePull
					? "No matching work items found for the selected IDs"
					: "No work items found in PM";
				return {
					success: true,
					totalCases: 0,
					syncedCount: 0,
					failedCount: 0,
					conflictedCount: 0,
					results: [],
				};
			}

			rows = pmItems.map((item) => ({
				id: item.id,
				identifier: item.id,
				title: item.title ?? `Work Item ${item.id}`,
				description: item.description ?? null,
				externalId: item.id,
				externalUrl: item.url ?? null,
			}));
		} else {
			progress.message = "Fetching test cases...";
			const cases = await getTestCasesToSync({
				projectId,
				organizationId,
				testCaseIds: input.testCaseIds,
				unsyncedOnly: input.unsyncedOnly ?? true,
				direction: "push",
			});
			rows = cases.map((c) => ({
				id: c.id,
				identifier: c.identifier,
				title: c.title,
				description: c.description,
				state: c.state,
				priority: c.priority,
				tags: c.tags,
				externalId: c.externalId,
				externalUrl: c.externalUrl,
				currentResult: c.currentResult,
				steps: c.steps.map((s) => ({
					action: s.action,
					expected: s.expected,
				})),
			}));
			progress.totalCases = rows.length;
			if (rows.length === 0) {
				progress.status = "completed";
				progress.message = "No test cases to sync";
				return {
					success: true,
					totalCases: 0,
					syncedCount: 0,
					failedCount: 0,
					conflictedCount: 0,
					results: [],
				};
			}
		}

		// 3. Sync each row.
		progress.status = "syncing";
		for (const row of rows) {
			if (cancelled) {
				break;
			}
			progress.currentTestCaseId = row.id;
			progress.currentIdentifier = row.identifier;
			progress.message = `Syncing ${row.identifier}...`;

			try {
				if (direction === "pull") {
					const result = await createOrUpdateTestCaseFromPMItem({
						projectId,
						externalId: row.externalId ?? row.id,
						title: row.title,
						description: row.description ?? null,
						externalUrl: row.externalUrl ?? undefined,
						externalMcpServerId: mcpServerId,
						userId,
						organizationId,
						toolKey: capabilities.detectedType,
					});
					progress.results.push({
						testCaseId: result.testCaseId,
						identifier: result.identifier,
						success: true,
						outcome: "synced",
						externalId: result.externalId,
						externalUrl: result.externalUrl,
					});
					progress.syncedCount++;
					continue;
				}

				// Push.
				const title = row.title;
				const description = buildTestCaseDescription(row);
				const stepsField = formatTestCaseStepsForProvider(
					row,
					capabilities.detectedType,
				);

				if (row.externalId && capabilities.taskUpdate) {
					// Drift guard: stamp CONFLICT + skip if the PM item changed
					// since our last sync. Gated behind patched() so future
					// changes to this command sequence stay replay-safe.
					let conflictDetected = false;
					if (patched("test-case-sync-v1")) {
						const conflictCheck =
							await detectAndStampPmPushConflict({
								itemId: row.id,
								itemType: "testCase",
								projectId,
								mcpConfigId,
								mcpServerId,
								containerId: containerValue,
								containerName,
								additionalContext,
								userId,
								organizationId,
								externalId: row.externalId,
								capabilities,
							});
						conflictDetected = conflictCheck.hasConflict;
					}
					if (conflictDetected) {
						progress.results.push({
							testCaseId: row.id,
							identifier: row.identifier,
							success: false,
							outcome: "conflict",
							externalId: row.externalId,
							externalUrl: row.externalUrl ?? undefined,
							error: "Changed in the PM tool since the last sync — resolve it in Review Center.",
						});
						progress.conflictedCount++;
						continue;
					}

					const updateArgs = buildTestCaseUpdateArgs({
						capabilities,
						externalId: row.externalId,
						title,
						description,
						stepsField,
						additionalContext,
					});
					const updateResult = await executeMcpTool({
						toolName: capabilities.taskUpdate.toolName,
						args: updateArgs,
						userId,
						organizationId,
						// Read-only mode write-gate keys off projectId
						projectId,
						mcpConfigId: mcpConfigId ?? undefined,
					});
					if (!updateResult.success) {
						throw new Error(
							`Failed to update work item ${row.externalId}: ${mcpErrorDetail(updateResult.output)}`,
						);
					}
					await updateTestCaseExternalRefs({
						testCaseId: row.id,
						projectId,
						externalId: row.externalId,
						externalUrl: row.externalUrl ?? undefined,
						externalMcpServerId: mcpServerId,
						// Stamp a post-push drift baseline so the NEXT push can
						// detect a PM-side edit (was a v1 gap → PM edits silently
						// overwritten). MCP path only (readback needs get).
						baseline: mcpConfigId
							? {
									mcpConfigId,
									capabilities,
									userId,
									organizationId,
									containerId: containerValue,
									containerName,
									additionalContext,
								}
							: undefined,
					});
					progress.results.push({
						testCaseId: row.id,
						identifier: row.identifier,
						success: true,
						outcome: "synced",
						externalId: row.externalId,
						externalUrl: row.externalUrl ?? undefined,
					});
					progress.syncedCount++;
				} else if (row.externalId && !capabilities.taskUpdate) {
					throw new Error(
						`Test case ${row.identifier} is linked to external ID ${row.externalId} but the PM tool does not support updates.`,
					);
				} else if (capabilities.taskCreation) {
					const createArgs = buildTestCaseCreateArgs({
						capabilities,
						containerValue,
						title,
						description,
						stepsField,
						additionalContext,
					});
					const createResult = await executeMcpTool({
						toolName: capabilities.taskCreation.toolName,
						args: createArgs,
						userId,
						organizationId,
						// Read-only mode write-gate keys off projectId
						projectId,
						mcpConfigId: mcpConfigId ?? undefined,
					});
					if (!createResult.success) {
						throw new Error(
							`Failed to create work item: ${mcpErrorDetail(createResult.output)}`,
						);
					}
					const { externalId, externalUrl } =
						extractCreatedTestCaseRefs(
							parseMcpResponse(createResult.output),
						);
					if (externalId) {
						await updateTestCaseExternalRefs({
							testCaseId: row.id,
							projectId,
							externalId,
							externalUrl: externalUrl || undefined,
							externalMcpServerId: mcpServerId,
							// Stamp a post-push drift baseline (see the update branch)
							// so a later push detects a PM-side edit on this new item.
							baseline: mcpConfigId
								? {
										mcpConfigId,
										capabilities,
										userId,
										organizationId,
										containerId: containerValue,
										containerName,
										additionalContext,
									}
								: undefined,
						});
					}
					progress.results.push({
						testCaseId: row.id,
						identifier: row.identifier,
						success: true,
						outcome: "synced",
						externalId: externalId || undefined,
						externalUrl: externalUrl || undefined,
					});
					progress.syncedCount++;
				} else {
					throw new Error("PM tool does not support task creation");
				}
			} catch (error) {
				const errorMessage = extractActivityError(error);
				log.error("Failed to sync test case", {
					testCaseId: row.id,
					identifier: row.identifier,
					error: errorMessage,
				});
				// Stamp FAILED on the case so it surfaces a Retry/Dismiss control
				// (push direction only — pull rows are PM ids, not Fabric cases).
				if (direction === "push") {
					// Best-effort: a Temporal-level failure of this FAILED-state
					// stamp must not turn a partial-success batch into a total
					// workflow failure (the item is already recorded as failed
					// below), so swallow it here.
					try {
						await recordPmSyncFailure({
							itemId: row.id,
							itemType: "testCase",
							errorMessage,
							errorClass: "push_failed",
							triggerSource: "manual-edit",
						});
					} catch (stampError) {
						log.warn("Failed to stamp test case FAILED state", {
							testCaseId: row.id,
							error: extractActivityError(stampError),
						});
					}
				}
				progress.results.push({
					testCaseId: row.id,
					identifier: row.identifier,
					success: false,
					outcome: "failed",
					error: errorMessage,
				});
				progress.failedCount++;
			}
		}

		// 3b. Execution sync (ADO Test Results) — push each successfully-synced
		// case's current result to the PM test-run/result API. Gated behind
		// patched() so in-flight replays don't diverge; ADO-only + best-effort (a
		// deferred/failed execution push never fails the case sync). The live ADO
		// Test Results POST is DEFERRED — see pushTestCaseExecutionToPM.
		if (
			direction === "push" &&
			isADO &&
			!cancelled &&
			patched("test-case-execution-sync-v1")
		) {
			const syncedExternalIdById = new Map(
				progress.results
					.filter((r) => r.success && r.externalId)
					.map((r) => [r.testCaseId, r.externalId as string]),
			);
			for (const row of rows) {
				if (cancelled) {
					break;
				}
				const externalId = syncedExternalIdById.get(row.id);
				if (!externalId) {
					continue;
				}
				const result = row.currentResult;
				// Only push a recorded outcome; a never-run case has nothing to sync.
				if (!result || result === "NOT_RUN") {
					continue;
				}
				try {
					await pushTestCaseExecutionToPM({
						testCaseId: row.id,
						projectId,
						externalId,
						result,
						mcpConfigId,
						mcpServerId,
						containerId: containerValue,
						containerName,
						additionalContext,
						userId,
						organizationId,
						detectedType: capabilities.detectedType,
					});
				} catch (execError) {
					log.warn("Execution push failed (non-fatal)", {
						testCaseId: row.id,
						error: extractActivityError(execError),
					});
				}
			}
		}

		// 4. Finalize.
		if (cancelled) {
			progress.status = "cancelled";
			progress.message = `Sync cancelled. ${progress.syncedCount} of ${progress.totalCases} test cases synced.`;
		} else if (
			progress.failedCount > 0 &&
			progress.syncedCount === 0 &&
			progress.conflictedCount === 0
		) {
			progress.status = "failed";
			progress.message = `Sync failed. All ${progress.failedCount} test cases failed.`;
		} else {
			progress.status = "completed";
			const parts: string[] = [];
			if (progress.syncedCount > 0) {
				parts.push(`${progress.syncedCount} synced`);
			}
			if (progress.conflictedCount > 0) {
				parts.push(`${progress.conflictedCount} need review`);
			}
			if (progress.failedCount > 0) {
				parts.push(`${progress.failedCount} failed`);
			}
			progress.message = parts.length
				? `Sync complete. ${parts.join(", ")}.`
				: "Sync complete.";
		}

		log.info("Test case sync workflow completed", {
			status: progress.status,
			syncedCount: progress.syncedCount,
			failedCount: progress.failedCount,
		});

		return {
			success: progress.failedCount === 0 && !cancelled,
			totalCases: progress.totalCases,
			syncedCount: progress.syncedCount,
			failedCount: progress.failedCount,
			conflictedCount: progress.conflictedCount,
			results: progress.results,
			error: cancelled ? "Cancelled by user" : undefined,
		};
	} catch (error) {
		if (error instanceof ApplicationFailure) {
			throw error;
		}
		const errorMessage = extractActivityError(error);
		log.error("Test case sync workflow failed", { error: errorMessage });
		progress.status = "failed";
		progress.message = errorMessage;
		throw ApplicationFailure.nonRetryable(
			errorMessage,
			"TEST_CASE_SYNC_FAILED",
		);
	}
}

/**
 * Unwrap Temporal's nested error wrappers (ActivityFailure → ApplicationFailure
 * → cause) to the actual message.
 */
function extractActivityError(error: unknown): string {
	if (!error) {
		return "Unknown error";
	}
	if (error instanceof ActivityFailure && error.cause) {
		return extractActivityError(error.cause);
	}
	if (error instanceof ApplicationFailure) {
		if (error.cause) {
			const causeMsg = extractActivityError(error.cause);
			if (causeMsg && causeMsg !== "Unknown error") {
				return causeMsg;
			}
		}
		return error.message;
	}
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}
