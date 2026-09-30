/**
 * Code Indexing Workflow
 *
 * Durable workflow for AST-aware code indexing (Phase 2).
 *
 * Pipeline:
 * 1. Clone repo (shallow, single-branch)
 * 2. Scan for secrets and redact
 * 3. Walk file tree, filter indexable files
 * 4. Extract symbols for symbol-level code search
 * 5. Process files in batches (chunk + embed + upsert to Qdrant)
 * 6. Generate file-level summaries (Layer 1)
 * 7. Update ProjectCodeIndex with stats
 * 8. Clean up temp clone directory
 *
 * Steps 1-3 run as one activity (`prepareRepositoryActivity`) so the host-local
 * clone is only read on the worker host that made it. New runs reconstruct the
 * pinned commit and redact it inside each symbol/embed/summary/finalize activity,
 * then dispose its private checkout. Only batch offsets cross workflow history.
 *
 * continueAsNew strategy: pass only a lightweight cursor (batchIndex,
 * accumulated stats). On resumption, re-clone and re-walk to reconstruct
 * file paths — avoids serializing the full file list and depending on
 * host-local temp directories that may not survive across workers.
 *
 * NOTE: This workflow is currently triggered manually only — when a project's
 * repository URL is set/updated (see `update-project.ts`). There is no
 * GitHub push webhook that re-runs indexing on commit, so the index goes
 * stale until a user manually re-runs it. Adding a push-event webhook is
 * tracked separately (requires GitHub App install flow + per-repo branch
 * policy + push-debounce). Until then, `code_search` may return results
 * from an older commit than what's currently on the default branch.
 */

import {
	ContinueAsNew,
	continueAsNew,
	isCancellation,
	patched,
	proxyActivities,
	workflowInfo,
} from "@temporalio/workflow";
import type * as activities from "../activities";
import type {
	CloneRepositoryInput,
	CloneRepositoryOutput,
	CodeIndexRunOwner,
	FileManifestEntry,
	PrepareRepositoryOutput,
	RepositoryMaterializationInput,
	ScanForSecretsOutput,
	WalkFileTreeOutput,
} from "../activities/code-indexing";
import type { ExtractedSymbol } from "../activities/code-indexing/extract-symbols";
import {
	isIncrementalRun,
	selectChangedFiles,
} from "./code-indexing-incremental";

// Long-running activities (clone, chunk+embed) get generous timeouts
const longRunning = proxyActivities<typeof activities>({
	startToCloseTimeout: "10 minutes",
	heartbeatTimeout: "2 minutes",
	retry: {
		initialInterval: "2s",
		maximumInterval: "60s",
		backoffCoefficient: 2,
		maximumAttempts: 3,
	},
});

// Clone + secret scan + walk in one activity (`prepareRepositoryActivity`), so
// the host-local clone is only ever read on the host that made it. Longer
// start-to-close than `longRunning` because it covers all three steps.
const preparing = proxyActivities<typeof activities>({
	startToCloseTimeout: "30 minutes",
	heartbeatTimeout: "2 minutes",
	retry: {
		initialInterval: "2s",
		maximumInterval: "60s",
		backoffCoefficient: 2,
		maximumAttempts: 3,
	},
});

// New consumers include a pinned clone and scan before their existing work.
const materializing = proxyActivities<typeof activities>({
	startToCloseTimeout: "30 minutes",
	heartbeatTimeout: "2 minutes",
	retry: {
		initialInterval: "2s",
		maximumInterval: "60s",
		backoffCoefficient: 2,
		maximumAttempts: 3,
	},
});
const materializingEmbeddings = proxyActivities<typeof activities>({
	startToCloseTimeout: "30 minutes",
	heartbeatTimeout: "3 minutes",
	retry: {
		initialInterval: "5s",
		maximumInterval: "120s",
		backoffCoefficient: 3,
		maximumAttempts: 5,
	},
});

// Short activities (DB updates, cleanup)
const shortRunning = proxyActivities<typeof activities>({
	startToCloseTimeout: "30 seconds",
	retry: {
		initialInterval: "1s",
		maximumInterval: "10s",
		backoffCoefficient: 2,
		maximumAttempts: 5,
	},
});

// Embedding activities get rate-limit-aware retry
const embeddingActivities = proxyActivities<typeof activities>({
	startToCloseTimeout: "15 minutes",
	heartbeatTimeout: "3 minutes",
	retry: {
		initialInterval: "5s",
		maximumInterval: "120s",
		backoffCoefficient: 3,
		maximumAttempts: 5,
	},
});

export interface CodeIndexingWorkflowInput {
	projectId: string;
	userId: string;
	organizationId?: string | null;
	repositoryUrl: string;
	branch?: string;
	token?: string;
	integrationId?: string;
	provider: "GITHUB" | "AZURE_DEVOPS" | "GITLAB";
	repoName: string;
	/** For incremental: only process changed files */
	incremental?: boolean;
	/** Changed files for incremental indexing */
	changedFiles?: string[];
	/**
	 * Lightweight continuation cursor — only carries scalar stats, not file lists.
	 * On resumption the workflow re-clones and re-walks to get file paths.
	 */
	_cursor?: {
		batchIndex: number;
		totalChunks: number;
		totalSymbols: number;
		errorCount: number;
		/** Pinned commit SHA — continuation re-clones at this exact commit */
		commitSha: string;
		startTime: number;
		/**
		 * Number of times this index has continued-as-new to recover from a lost
		 * clone (worker redeploy/crash wiped host-local temp between checkpoints).
		 * Bounded by MAX_RECOVERY_ATTEMPTS so a persistent error still fails the
		 * index instead of looping forever. Additive/optional for replay-safety.
		 */
		recoveryAttempts?: number;
		/** Keep pre-materialization continuation cursors on their original ordering. */
		workerLocalRepository?: boolean;
	};
}

export interface CodeIndexingWorkflowOutput {
	success: boolean;
	filesIndexed: number;
	chunksCreated: number;
	summariesCreated: number;
	totalSymbols: number;
	indexDurationMs: number;
	error?: string;
}

const BATCH_SIZE = 50;
const BATCHES_BEFORE_CONTINUE_AS_NEW = 20;
/**
 * Max continue-as-new recoveries from a lost clone before the index is allowed
 * to fail. Guards the durable-resume loop against spinning forever on a genuine
 * persistent error (as opposed to a transient worker redeploy/crash).
 */
const MAX_RECOVERY_ATTEMPTS = 3;

/**
 * The most informative message in an error's cause chain. An activity failure
 * reaches the workflow as an `ActivityFailure` whose own message is the fixed
 * "Activity task failed"; the reason a user can act on is in `cause`.
 */
function failureMessage(error: unknown): string {
	let current: unknown = error;
	let best: string | null = null;
	for (let depth = 0; depth < 8 && current != null; depth++) {
		const message =
			current instanceof Error ? current.message : String(current);
		if (message && !/^Activity task failed\.?$/i.test(message)) {
			best = message;
		}
		current = current instanceof Error ? current.cause : undefined;
	}
	return best ?? String(error);
}

export async function codeIndexingWorkflow(
	input: CodeIndexingWorkflowInput,
): Promise<CodeIndexingWorkflowOutput> {
	try {
		return await runCodeIndexing(input);
	} catch (error) {
		// continueAsNew() works by throwing ContinueAsNew — never intercept it.
		// A cancellation is finalized by the cancel procedure, which owns the row.
		if (error instanceof ContinueAsNew || isCancellation(error)) {
			throw error;
		}
		// Any other error escaping the body would otherwise fail the workflow and
		// leave the ProjectCodeIndex row in INDEXING forever. Patched because it
		// adds commands to the failure path of histories recorded before it; the
		// marker is only written when a failure actually reaches here.
		if (patched("code-index-fail-on-throw-v1")) {
			await markCodeIndexFailed(input, failureMessage(error));
		}
		throw error;
	}
}

/**
 * The indexing chain this run belongs to, for the ProjectCodeIndex writers and
 * the Job Hub fence.
 *
 * The workflow id is stable per repo and a re-index starts with
 * TERMINATE_EXISTING, which does not stop an activity the terminated run has
 * in flight; the activities use this to keep such a late write off the
 * successor's index row and Job Hub row. Every activity that writes either
 * one gets it. `firstExecutionRunId` is the same in every continueAsNew
 * continuation. `startTime` is NOT: despite its SDK doc comment, each run of
 * the chain reports its own start (observed with @temporalio 1.23 against the
 * test server). The ordering stays sound, because every run of a chain starts
 * before the TERMINATE_EXISTING successor that replaced it. Both come from
 * history, so replay reads the same values. Only activity arguments carry
 * them — no command is added or reordered.
 */
function codeIndexOwner(): CodeIndexRunOwner {
	const info = workflowInfo();
	return {
		runId: info.firstExecutionRunId,
		startedAt: info.startTime.toISOString(),
	};
}

/** Best-effort terminal FAILED for this run's row; never masks the caller's error. */
async function markCodeIndexFailed(
	input: CodeIndexingWorkflowInput,
	error: string,
): Promise<void> {
	const owner = codeIndexOwner();
	try {
		await shortRunning.failCodeIndexActivity({
			projectId: input.projectId,
			repositoryIntegrationId: input.integrationId ?? null,
			branch: input.branch,
			error,
			owner,
		});
	} catch {
		// The activity already exhausted its retries; nothing more to do here.
	}
}

async function runCodeIndexing(
	input: CodeIndexingWorkflowInput,
): Promise<CodeIndexingWorkflowOutput> {
	const wfInfo = workflowInfo();
	const workflowId = wfInfo.workflowId;
	const owner = codeIndexOwner();
	const isContinuation = !!input._cursor;
	const startTime = input._cursor?.startTime ?? Date.now();

	// The repo this run indexes — the key for its ProjectCodeIndex row.
	// integrationId is the ProjectRepositoryIntegration id (null = the project's
	// default repositoryUrl / legacy row).
	const repositoryIntegrationId = input.integrationId ?? null;
	const branch = input.branch;

	// =========================================================================
	// Feature gate: check FEATURE_CODE_INDEXING env var.
	// Always check — including on continuation — so toggling the flag off
	// stops in-flight jobs rather than letting them resume indefinitely.
	// =========================================================================
	const enabled = await shortRunning.checkCodeIndexingEnabledActivity();
	if (!enabled) {
		// Mark any existing INDEXING record as FAILED so it doesn't stay stuck
		await shortRunning.failCodeIndexActivity({
			projectId: input.projectId,
			repositoryIntegrationId,
			branch,
			error: "Code indexing disabled (FEATURE_CODE_INDEXING != true)",
			owner,
		});
		return {
			success: false,
			filesIndexed: 0,
			chunksCreated: 0,
			summariesCreated: 0,
			totalSymbols: 0,
			indexDurationMs: 0,
			error: "Code indexing is disabled (FEATURE_CODE_INDEXING != true)",
		};
	}

	// =========================================================================
	// Resolve token if not provided directly (backward-compatible with integrationId)
	// =========================================================================
	let token = input.token;
	if (!token && input.integrationId) {
		const resolved = await shortRunning.resolveRepoTokenActivity({
			integrationId: input.integrationId,
			projectId: input.projectId,
		});
		token = resolved.token ?? undefined;
	}

	if (!token) {
		await shortRunning.failCodeIndexActivity({
			projectId: input.projectId,
			repositoryIntegrationId,
			branch,
			error: "No repository token available",
			owner,
		});
		return {
			success: false,
			filesIndexed: 0,
			chunksCreated: 0,
			summariesCreated: 0,
			totalSymbols: 0,
			indexDurationMs: 0,
			error: "No repository token available",
		};
	}

	// =========================================================================
	// Incremental vs full: an incremental run (a webhook push carrying its
	// changed-file list) re-embeds only the changed files and purges stale
	// vectors for changed/removed files; a full run indexes everything. The
	// decision is a pure function of the workflow input, so it is stable across
	// continueAsNew resumptions.
	// =========================================================================
	const changedFiles = input.changedFiles ?? [];
	const incremental = isIncrementalRun(input.incremental, input.changedFiles);
	if (incremental) {
		console.log(
			`[codeIndexingWorkflow] Incremental indexing for ${changedFiles.length} changed file(s).`,
		);
	}

	// =========================================================================
	// Step 1: Initialize index record (skip on continuation — already set)
	// =========================================================================
	if (!isContinuation) {
		try {
			await shortRunning.initCodeIndexActivity({
				projectId: input.projectId,
				repositoryIntegrationId,
				branch,
				userId: input.userId,
				organizationId: input.organizationId,
				commitSha: "pending",
				workflowId,
				owner,
			});
		} catch {
			// Non-fatal
		}
	}

	// Read code embedding model preference from project settings
	const codeEmbeddingModel = await shortRunning.getCodeEmbeddingModelActivity(
		{
			projectId: input.projectId,
		},
	);

	// =========================================================================
	// Step 2: Clone repository
	// On continuation, pin to the original commitSha so all batches index
	// the same revision. On first run, clone the branch head.
	//
	// Patched: clone + secret scan + walk (+ the incremental changed subset)
	// run as ONE activity, because the clone is host-local temp and a separate
	// scan/walk activity scheduled on another worker host fails with ENOENT on
	// every retry. Unpatched (histories recorded before it): today's separate
	// clone → scan → walk activities.
	// =========================================================================
	const cloneInput: CloneRepositoryInput = {
		repositoryUrl: input.repositoryUrl,
		branch: input.branch,
		token,
		provider: input.provider,
		workflowRunId: wfInfo.runId,
		commitSha: input._cursor?.commitSha,
		integrationId: input.integrationId,
		projectId: input.projectId,
		userId: input.userId,
		organizationId: input.organizationId,
		owner,
	};
	const workerLocalRepository =
		patched("code-index-worker-local-consumers-v1") &&
		(!input._cursor || input._cursor.workerLocalRepository === true);
	const prepareRepo = patched("code-index-prepare-repo-v1");
	let prepared: PrepareRepositoryOutput | undefined;
	let cloneResult: CloneRepositoryOutput;
	try {
		if (prepareRepo) {
			prepared = await (workerLocalRepository
				? preparing.prepareRepositoryMetadataActivity
				: preparing.prepareRepositoryActivity)({
				...cloneInput,
				...(incremental ? { changedFiles } : {}),
			});
			cloneResult = prepared.clone;
		} else {
			cloneResult = await longRunning.cloneRepositoryActivity(cloneInput);
		}
	} catch (error) {
		const failure = prepareRepo
			? `Repository preparation failed: ${failureMessage(error)}`
			: `Clone failed: ${error instanceof Error ? error.message : String(error)}`;
		await shortRunning.failCodeIndexActivity({
			projectId: input.projectId,
			repositoryIntegrationId,
			branch,
			error: failure,
			owner,
		});
		return {
			success: false,
			filesIndexed: 0,
			chunksCreated: 0,
			summariesCreated: 0,
			totalSymbols: 0,
			indexDurationMs: Date.now() - startTime,
			error: failure,
		};
	}

	// Update index with commit SHA (only on first run)
	if (!isContinuation) {
		await shortRunning.initCodeIndexActivity({
			projectId: input.projectId,
			repositoryIntegrationId,
			branch,
			userId: input.userId,
			organizationId: input.organizationId,
			commitSha: cloneResult.commitSha,
			workflowId,
			owner,
		});
	}

	let scanResult: ScanForSecretsOutput;
	let treeResult: WalkFileTreeOutput;
	if (prepared) {
		// prepareRepositoryActivity already scanned (on every run, continuation
		// included) and walked the clone it made, on the same host.
		scanResult = prepared.scan;
		treeResult = prepared.tree;
	} else {
		// =====================================================================
		// Step 3: Scan for secrets — always run, even on continuation.
		// The re-cloned checkout has unsanitized content; skipping would index
		// raw secrets into Qdrant.
		// =====================================================================
		scanResult = await longRunning.scanForSecretsActivity({
			clonePath: cloneResult.clonePath,
			owner,
		});

		// =====================================================================
		// Step 4: Walk file tree (always — paths are host-local)
		// =====================================================================
		treeResult = await longRunning.walkFileTreeActivity({
			clonePath: cloneResult.clonePath,
			owner,
		});
	}
	const redactionManifest = scanResult.redactionManifest;

	if (treeResult.totalFiles === 0) {
		await shortRunning.cleanupCloneDirActivity({
			clonePath: cloneResult.clonePath,
		});
		await shortRunning.failCodeIndexActivity({
			projectId: input.projectId,
			repositoryIntegrationId,
			branch,
			error: "No indexable files found",
			owner,
		});
		return {
			success: false,
			filesIndexed: 0,
			chunksCreated: 0,
			summariesCreated: 0,
			totalSymbols: 0,
			indexDurationMs: Date.now() - startTime,
			error: "No indexable files found",
		};
	}

	// =========================================================================
	// On-disk manifest path (new). Gated by patched() so pre-manifest histories
	// replay the legacy in-memory path below. The walk wrote the indexable-file
	// list to disk and returned only counts; here we iterate that manifest by
	// index so no file list ever crosses the workflow payload boundary — robust
	// for any repo size. Self-contained (it returns), leaving the legacy path
	// below byte-for-byte unchanged for replay of pre-patch histories.
	// =========================================================================
	if (patched("code-index-ondisk-manifest-v1")) {
		const manifestPath = treeResult.manifestPath;
		if (!manifestPath || (prepared && incremental && !prepared.changed)) {
			// A new run always writes a manifest (and, when prepared for an
			// incremental run, the changed-subset manifest); its absence is a
			// walk-contract break. Fail cleanly rather than silently indexing
			// nothing.
			await shortRunning.cleanupCloneDirActivity({
				clonePath: cloneResult.clonePath,
			});
			await shortRunning.failCodeIndexActivity({
				projectId: input.projectId,
				repositoryIntegrationId,
				branch,
				error: "File manifest missing after walk",
				owner,
			});
			return {
				success: false,
				filesIndexed: 0,
				chunksCreated: 0,
				summariesCreated: 0,
				totalSymbols: 0,
				indexDurationMs: Date.now() - startTime,
				error: "File manifest missing after walk",
			};
		}

		const clonePath = cloneResult.clonePath;
		const repository: RepositoryMaterializationInput | undefined =
			workerLocalRepository
				? {
						...cloneInput,
						commitSha: cloneResult.commitSha,
						branch: cloneResult.branch,
					}
				: undefined;
		const batchMaterialization = (startIndex: number, changed = false) =>
			repository
				? {
						repository,
						repositoryBatch: {
							startIndex,
							count: BATCH_SIZE,
							...(changed && incremental ? { changedFiles } : {}),
						},
					}
				: {};
		const totalFiles = treeResult.totalFiles;

		// Durable-resume gate (evaluated once). When true, checkpoint more often
		// and recover from a lost clone by continuing-as-new instead of failing.
		// Pre-patch histories replay with this false → today's behavior exactly.
		const durableResume = patched("code-index-durable-resume-v1");
		const CHECKPOINT_EVERY = durableResume
			? 10
			: BATCHES_BEFORE_CONTINUE_AS_NEW;

		let batchIndex = input._cursor?.batchIndex ?? 0;
		let totalChunks = input._cursor?.totalChunks ?? 0;
		let totalSymbols = input._cursor?.totalSymbols ?? 0;
		let errorCount = input._cursor?.errorCount ?? 0;
		let recoveryAttempts = input._cursor?.recoveryAttempts ?? 0;
		let batchesSinceLastContinue = 0;

		// The manifest the embed/summary phases iterate: the full walk manifest,
		// or — on an incremental run — a changed-subset manifest the activity
		// writes to disk (so even a mass-change push never crosses the payload
		// boundary). Re-derived on every run (no isContinuation gate), so a
		// continuation rewrites it identically before resuming at the cursor.
		let embedManifestPath = manifestPath;
		let embedTotal = totalFiles;
		if (incremental) {
			// Prepared runs already wrote the subset on the clone's own host.
			const selected =
				prepared?.changed ??
				(await longRunning.selectChangedFilesFromManifestActivity({
					manifestPath,
					clonePath,
					changedFiles,
				}));
			embedManifestPath = selected.manifestPath;
			embedTotal = selected.count;
		}

		// One batch of files, always sliced off a manifest by index. The symbol
		// phase (full runs only) reads the full manifest; embed/summary read the
		// full manifest (full run) or the changed-subset manifest (incremental).
		const loadBatch = async (
			manifestSlicePath: string,
			startIndex: number,
		): Promise<FileManifestEntry[]> => {
			// New consumers reconstruct and slice within their own invocation.
			if (repository) {
				return [];
			}
			const slice = await longRunning.readFileManifestSliceActivity({
				manifestPath: manifestSlicePath,
				clonePath,
				startIndex,
				count: BATCH_SIZE,
			});
			return slice.files;
		};

		// Step 5: Extract symbols (full runs only, first attempt only). Delete the
		// project's old symbols once, then extract + persist per batch so the whole
		// repo's symbol set never crosses the workflow boundary.
		if (!isContinuation && !incremental) {
			try {
				await longRunning.deleteProjectCodeSymbolsActivity({
					projectId: input.projectId,
				});
				for (let i = 0; i < totalFiles; i += BATCH_SIZE) {
					const batch = await loadBatch(manifestPath, i);
					// Per-batch try/catch: one failing batch shouldn't abort the
					// rest of symbol extraction (it self-heals on the next reindex).
					try {
						const persisted = await (repository
							? materializing.extractAndPersistMaterializedSymbolsActivity
							: longRunning.extractAndPersistSymbolsActivity)({
							...batchMaterialization(i),
							files: batch,
							projectId: input.projectId,
							userId: input.userId,
							organizationId: input.organizationId,
							owner,
						});
						totalSymbols += persisted.insertedCount;
					} catch (_error) {
						errorCount++;
					}
				}
			} catch (_error) {
				errorCount++;
			}
		}

		// Step 6: Purge stale vectors for changed + removed files (incremental,
		// first attempt only) before re-embedding.
		if (incremental && !isContinuation) {
			try {
				await shortRunning.deleteChangedCodeVectorsActivity({
					projectId: input.projectId,
					repositoryIntegrationId,
					organizationId: input.organizationId,
					filePaths: changedFiles,
				});
			} catch (error) {
				console.log(
					`[codeIndexingWorkflow] Vector purge failed after retries; continuing: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
		}

		// Step 6b: chunk + embed in batches.
		while (batchIndex * BATCH_SIZE < embedTotal) {
			let batchResult: Awaited<
				ReturnType<
					typeof embeddingActivities.chunkAndEmbedBatchActivity
				>
			>;
			try {
				const batchFiles = await loadBatch(
					embedManifestPath,
					batchIndex * BATCH_SIZE,
				);

				batchResult = await (repository
					? materializingEmbeddings.chunkAndEmbedMaterializedBatchActivity
					: embeddingActivities.chunkAndEmbedBatchActivity)({
					...batchMaterialization(batchIndex * BATCH_SIZE, true),
					files: batchFiles,
					projectId: input.projectId,
					repositoryIntegrationId,
					userId: input.userId,
					organizationId: input.organizationId,
					repoName: input.repoName,
					codeEmbeddingModel,
					// Live-progress inputs (additive, replay-safe — no new
					// workflow command). The activity writes
					// indexedFileCount / totalFileCount best-effort.
					branch,
					filesProcessedSoFar: batchIndex * BATCH_SIZE,
					totalFileCount: embedTotal,
					owner,
				});
			} catch (error) {
				// The clone-read + embed activities already exhausted their own
				// Temporal retries. The likeliest reason they still failed on this
				// worker is a lost clone/manifest — a redeploy or crash wiped
				// host-local temp between checkpoints. Rather than failing the whole
				// index and discarding every batch since the last checkpoint,
				// continueAsNew from the CURRENT batchIndex (unchanged): the next run
				// re-clones + re-walks and retries this exact batch. Bounded by
				// MAX_RECOVERY_ATTEMPTS so a genuinely persistent error still fails
				// the index instead of looping forever. Unpatched: rethrow (today's
				// behavior — the error propagates and the index fails).
				if (durableResume && recoveryAttempts < MAX_RECOVERY_ATTEMPTS) {
					await shortRunning.cleanupCloneDirActivity({ clonePath });
					await continueAsNew<typeof codeIndexingWorkflow>({
						...input,
						_cursor: {
							batchIndex,
							totalChunks,
							totalSymbols,
							errorCount,
							commitSha: cloneResult.commitSha,
							startTime,
							recoveryAttempts: recoveryAttempts + 1,
							...(workerLocalRepository
								? { workerLocalRepository: true }
								: {}),
						},
					});
				}
				throw error;
			}

			// Batch succeeded — the clone is healthy, so clear the recovery budget
			// so the next checkpoint carries a fresh count.
			recoveryAttempts = 0;
			totalChunks += batchResult.chunksCreated;
			errorCount += batchResult.errors.length;
			batchIndex++;
			batchesSinceLastContinue++;

			// Prevent Temporal history from growing unbounded. Pass only the scalar
			// cursor — the next run re-clones, re-walks, and rewrites the manifest.
			if (
				batchesSinceLastContinue >= CHECKPOINT_EVERY &&
				batchIndex * BATCH_SIZE < embedTotal
			) {
				await shortRunning.cleanupCloneDirActivity({ clonePath });
				await continueAsNew<typeof codeIndexingWorkflow>({
					...input,
					_cursor: {
						batchIndex,
						totalChunks,
						totalSymbols,
						errorCount,
						commitSha: cloneResult.commitSha,
						startTime,
						// Only carry the recovery count on the durable-resume path so
						// the unpatched checkpoint cursor is byte-identical to pre-patch
						// histories (belt-and-suspenders for continueAsNew replay).
						...(durableResume ? { recoveryAttempts } : {}),
						...(workerLocalRepository
							? { workerLocalRepository: true }
							: {}),
					},
				});
			}
		}

		// Step 7: file summaries.
		let summariesCreated = 0;
		try {
			for (let i = 0; i < embedTotal; i += BATCH_SIZE) {
				const batch = await loadBatch(embedManifestPath, i);
				const summaryResult = await (repository
					? materializingEmbeddings.generateMaterializedFileSummariesActivity
					: embeddingActivities.generateFileSummariesActivity)({
					...batchMaterialization(i, true),
					files: batch,
					projectId: input.projectId,
					repositoryIntegrationId,
					userId: input.userId,
					organizationId: input.organizationId,
					repoName: input.repoName,
					codeEmbeddingModel,
					owner,
				});
				summariesCreated += summaryResult.summariesCreated;
			}
		} catch (_error) {
			errorCount++;
		}

		// Step 8: persist stats — the activity reads the manifest off disk to
		// build the stored file manifest, so it too stays off the payload boundary.
		const indexDurationMs = Date.now() - startTime;
		try {
			await (repository
				? materializing.updateMaterializedCodeIndexActivity
				: shortRunning.updateCodeIndexActivity)({
				...(repository ? { repository } : {}),
				projectId: input.projectId,
				repositoryIntegrationId,
				branch,
				userId: input.userId,
				organizationId: input.organizationId,
				commitSha: cloneResult.commitSha,
				filesIndexed: totalFiles,
				chunksCreated: totalChunks,
				summariesCreated,
				indexDurationMs,
				manifestPath,
				redactionManifest,
				incremental,
				owner,
			});
		} catch (error) {
			errorCount++;
			// The stats write is what moves the row out of INDEXING; when it
			// exhausts its retries, mark the row FAILED instead of leaving it
			// "indexing" forever. Same patch as the whole-body guard above.
			if (patched("code-index-fail-on-throw-v1")) {
				await markCodeIndexFailed(
					input,
					`Could not record index results: ${failureMessage(error)}`,
				);
			}
		}

		// Step 9: cleanup.
		await shortRunning.cleanupCloneDirActivity({ clonePath });

		return {
			success: errorCount === 0,
			filesIndexed: totalFiles,
			chunksCreated: totalChunks,
			summariesCreated,
			totalSymbols,
			indexDurationMs,
			error:
				errorCount > 0
					? `${errorCount} errors during indexing`
					: undefined,
		};
	}

	// =========================================================================
	// Legacy path (pre-manifest histories). Reached only when patched() above is
	// false, i.e. replaying an execution recorded before the on-disk manifest.
	// Such walk results always carry the inline file list. Left byte-for-byte as
	// the pre-patch code (only the source array is renamed) so its recorded
	// activity sequence replays identically.
	// =========================================================================
	const legacyWalkFiles = treeResult.files ?? [];
	const allFiles = legacyWalkFiles.map((f) => ({
		relativePath: f.relativePath,
		absolutePath: f.absolutePath,
	}));

	// On an incremental run, (re)embed only the changed files; a full run embeds
	// everything. Pure filter on workflow input + walk output, so it re-derives
	// identically after continueAsNew.
	const filesToEmbed = incremental
		? selectChangedFiles(allFiles, changedFiles)
		: allFiles;

	// =========================================================================
	// Step 5: Extract symbols for symbol-level code search
	// Delete old symbols first, then extract and persist new ones. Skipped on
	// incremental runs — it is a full delete-and-reinsert, so it would re-read
	// the whole repo on every push; symbol search refreshes on the next full
	// reindex.
	// =========================================================================
	let batchIndex = input._cursor?.batchIndex ?? 0;
	let totalChunks = input._cursor?.totalChunks ?? 0;
	let totalSymbols = input._cursor?.totalSymbols ?? 0;
	let errorCount = input._cursor?.errorCount ?? 0;
	let batchesSinceLastContinue = 0;

	if (!isContinuation && !incremental) {
		try {
			// `patched()` gates a determinism-changing rework of the symbol phase:
			// new runs delete once + extract+persist per batch (below); histories
			// recorded before this patch replay the original accumulate-then-persist
			// path in the else branch. Do NOT remove the else branch until all
			// pre-patch histories have aged out (deprecatePatch first).
			if (patched("code-index-symbols-per-batch-v1")) {
				// Delete the project's old symbols once, then extract + persist per
				// batch. Persisting inside the activity keeps the whole repo's
				// symbol set from ever crossing the workflow boundary — on a large
				// repo, accumulating every file's symbols in the workflow and
				// persisting them in a single call blows past Temporal's per-payload
				// size limit and bloats history. Only a count crosses back.
				// Clear the whole project once so files deleted from the repo
				// don't leave orphan symbols; per-batch idempotency is handled
				// inside the activity (scoped delete-then-insert).
				await longRunning.deleteProjectCodeSymbolsActivity({
					projectId: input.projectId,
				});
				for (let i = 0; i < allFiles.length; i += BATCH_SIZE) {
					const filesWithLanguage = legacyWalkFiles
						.slice(i, i + BATCH_SIZE)
						.map((f) => ({
							relativePath: f.relativePath,
							absolutePath: f.absolutePath,
							language: f.language,
						}));
					// Per-batch try/catch: one failing batch shouldn't abort the
					// rest of symbol extraction (it self-heals on the next reindex).
					try {
						const persisted =
							await longRunning.extractAndPersistSymbolsActivity({
								files: filesWithLanguage,
								projectId: input.projectId,
								userId: input.userId,
								organizationId: input.organizationId,
								owner,
							});
						totalSymbols += persisted.insertedCount;
					} catch (_error) {
						errorCount++;
					}
				}
			} else {
				// Legacy path — kept only for replay of pre-patch histories.
				const allExtractedSymbols: ExtractedSymbol[] = [];
				for (let i = 0; i < allFiles.length; i += BATCH_SIZE) {
					const filesWithLanguage = legacyWalkFiles
						.slice(i, i + BATCH_SIZE)
						.map((f) => ({
							relativePath: f.relativePath,
							absolutePath: f.absolutePath,
							language: f.language,
						}));
					const extractResult =
						await longRunning.extractSymbolsActivity({
							files: filesWithLanguage,
							projectId: input.projectId,
							userId: input.userId,
							organizationId: input.organizationId,
						});
					allExtractedSymbols.push(...extractResult.symbols);
				}
				const persistResult =
					await shortRunning.persistCodeSymbolsActivity({
						projectId: input.projectId,
						userId: input.userId,
						organizationId: input.organizationId,
						symbols: allExtractedSymbols,
						owner,
					});
				totalSymbols = persistResult.insertedCount;
			}
		} catch (_error) {
			errorCount++;
		}
	}

	// =========================================================================
	// Step 6: Process files in batches (chunk + embed)
	// =========================================================================

	// Purge stale vectors for changed + removed files before re-embedding, so a
	// modified file that shrank or a deleted file leaves no orphan chunks. The
	// activity retries transient failures (Temporal policy); a terminal failure
	// is caught so the rest of the index still builds (leaving at most some stale
	// chunks, corrected on the next touch of those files). Runs once (first
	// attempt), not on every continuation.
	if (incremental && !isContinuation) {
		try {
			await shortRunning.deleteChangedCodeVectorsActivity({
				projectId: input.projectId,
				repositoryIntegrationId,
				organizationId: input.organizationId,
				filePaths: changedFiles,
			});
		} catch (error) {
			console.log(
				`[codeIndexingWorkflow] Vector purge failed after retries; continuing: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}

	while (batchIndex * BATCH_SIZE < filesToEmbed.length) {
		const batchFiles = filesToEmbed.slice(
			batchIndex * BATCH_SIZE,
			(batchIndex + 1) * BATCH_SIZE,
		);

		const batchResult =
			await embeddingActivities.chunkAndEmbedBatchActivity({
				files: batchFiles,
				projectId: input.projectId,
				repositoryIntegrationId,
				userId: input.userId,
				organizationId: input.organizationId,
				repoName: input.repoName,
				codeEmbeddingModel,
				owner,
			});

		totalChunks += batchResult.chunksCreated;
		errorCount += batchResult.errors.length;
		batchIndex++;
		batchesSinceLastContinue++;

		// Prevent Temporal history from growing unbounded.
		// Pass only scalar cursor — the next run re-clones and re-walks.
		if (
			batchesSinceLastContinue >= BATCHES_BEFORE_CONTINUE_AS_NEW &&
			batchIndex * BATCH_SIZE < filesToEmbed.length
		) {
			// Clean up this run's clone before continuing
			await shortRunning.cleanupCloneDirActivity({
				clonePath: cloneResult.clonePath,
			});

			await continueAsNew<typeof codeIndexingWorkflow>({
				...input,
				_cursor: {
					batchIndex,
					totalChunks,
					totalSymbols,
					errorCount,
					commitSha: cloneResult.commitSha,
					startTime,
				},
			});
		}
	}

	// =========================================================================
	// Step 7: Generate file summaries (Layer 1)
	// =========================================================================
	let summariesCreated = 0;
	try {
		for (let i = 0; i < filesToEmbed.length; i += BATCH_SIZE) {
			const batch = filesToEmbed.slice(i, i + BATCH_SIZE);
			const summaryResult =
				await embeddingActivities.generateFileSummariesActivity({
					files: batch,
					projectId: input.projectId,
					repositoryIntegrationId,
					userId: input.userId,
					organizationId: input.organizationId,
					repoName: input.repoName,
					codeEmbeddingModel,
					owner,
				});
			summariesCreated += summaryResult.summariesCreated;
		}
	} catch (_error) {
		errorCount++;
	}

	// =========================================================================
	// Step 8: Update code index with stats
	// =========================================================================
	const indexDurationMs = Date.now() - startTime;
	const fileManifest = legacyWalkFiles.map((f) => ({
		path: f.relativePath,
		sha: "",
		language: f.language,
	}));

	try {
		await shortRunning.updateCodeIndexActivity({
			projectId: input.projectId,
			repositoryIntegrationId,
			branch,
			userId: input.userId,
			organizationId: input.organizationId,
			commitSha: cloneResult.commitSha,
			filesIndexed: allFiles.length,
			chunksCreated: totalChunks,
			summariesCreated,
			indexDurationMs,
			fileManifest,
			redactionManifest,
			incremental,
			owner,
		});
	} catch (error) {
		errorCount++;
		// Same as the manifest branch: a stats write that exhausted its retries
		// must not leave the row "indexing" forever. Evaluated lazily, so a
		// replayed pre-patch failure takes the original path.
		if (patched("code-index-fail-on-throw-v1")) {
			await markCodeIndexFailed(
				input,
				`Could not record index results: ${failureMessage(error)}`,
			);
		}
	}

	// =========================================================================
	// Step 9: Cleanup
	// =========================================================================
	await shortRunning.cleanupCloneDirActivity({
		clonePath: cloneResult.clonePath,
	});

	return {
		success: errorCount === 0,
		filesIndexed: allFiles.length,
		chunksCreated: totalChunks,
		summariesCreated,
		totalSymbols,
		indexDurationMs,
		error:
			errorCount > 0 ? `${errorCount} errors during indexing` : undefined,
	};
}
