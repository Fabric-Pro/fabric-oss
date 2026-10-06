/**
 * Background job retention + watchdog activities (Job Hub).
 *
 * Both are side-effect holders for their otherwise-deterministic workflows:
 * env reads, clock reads, and Prisma calls live here so the workflows replay
 * cleanly. Mirrors `audit-log-retention.ts`.
 */

import {
	failOrphanedCodeIndex,
	failStaleBackgroundJobs,
	failStaleProjectScans,
	findQuietIndexingCodeIndexes,
	purgeExpiredBackgroundJobs,
	type QuietIndexingCodeIndex,
} from "@repo/database";
import { logger } from "@repo/logs";
import type { Client } from "@temporalio/client";
import { getTemporalClient } from "../client";

/**
 * How long a finished job stays visible in the Job Hub.
 *
 * Must agree with the API-side reader in
 * `packages/api/modules/jobs/lib/retention.ts` — the panel filters on the same
 * window this purge enforces, so a mismatch would either show rows that are
 * about to vanish or delete rows the panel still lists.
 */
const DEFAULT_RETENTION_DAYS = 7;
const MIN_RETENTION_DAYS = 1;
const MAX_RETENTION_DAYS = 30;

/**
 * How long a job may go without reporting progress before it is presumed dead.
 *
 * Must exceed the worst-case SILENT stretch of any instrumented activity, which
 * is its `startToCloseTimeout` multiplied by its retry attempts — not one
 * attempt. The binding case is code indexing's embed batch: 15 minutes x 5
 * attempts. Activities in that class heartbeat at the top of every attempt, so
 * the real gap is one attempt; this default is the backstop if one is missed.
 * Too low and the watchdog fails jobs that are merely mid-step.
 */
const DEFAULT_STALE_MINUTES = 45;

/**
 * How long a project scan may sit RUNNING before it is presumed dead.
 *
 * Duplicated rather than imported. The same number exists as
 * `PROJECT_SCAN_STALL_MINUTES` in
 * `packages/api/modules/capabilities/thresholds.ts`, where the readiness gate
 * uses it to decide when a scan has stopped counting as in flight — and neither
 * `@repo/temporal` nor `@repo/database` may depend on `@repo/api`. Change one,
 * change the other.
 *
 * The two are the same number rather than staggered the way the background-job
 * pair is, because a scan has no second signal to stagger against: it records
 * nothing after `startedAt`, so a read-time window set just under this one would
 * be guessing, not describing a live run. The watchdog's five-minute cron
 * already puts the actual close between 90 and 95 minutes, and that gap is
 * exactly what the read-time gate covers on its own.
 *
 * Not env-overridable on purpose: an override here would silently drift from the
 * gate, and a page that gives up before the sweep does is the confusion this
 * whole mechanism exists to remove.
 */
const PROJECT_SCAN_STALE_MINUTES = 90;

/**
 * How long a code-index row must sit INDEXING without a write before the sweep
 * asks Temporal about it.
 *
 * A pre-filter, not the verdict. The API never writes INDEXING —
 * `initCodeIndexActivity` does, on a worker — so every INDEXING row had a
 * started workflow, and `describe()` is what decides whether it still has one.
 * The window only keeps the sweep from describing every healthy run on every
 * tick; it can be short because a wrong answer here costs a describe call, not
 * a failed run.
 */
const CODE_INDEX_QUIET_MINUTES = 10;

/**
 * Bounds on one code-index sweep. The watchdog gives the whole activity two
 * minutes with no heartbeat, shared with the two sweeps before it: 25 rows at
 * 5 in flight, each describe capped at 5 seconds, is at most ~25 seconds. Rows
 * past the limit wait for the next tick, oldest first.
 */
const CODE_INDEX_SWEEP_LIMIT = 25;
const CODE_INDEX_SWEEP_CONCURRENCY = 5;
const CODE_INDEX_DESCRIBE_TIMEOUT_MS = 5_000;

const ORPHANED_CODE_INDEX_ERROR =
	"Indexing stopped unexpectedly: the indexing run is no longer active. Re-index to try again.";

/**
 * The indexing workflow id for a repo, for rows written before `workflowId`
 * was recorded.
 *
 * Duplicated rather than imported: the same format is `codeIndexWorkflowId` in
 * `packages/api/modules/projects/lib/code-indexing-trigger.ts`, and
 * `@repo/temporal` may not depend on `@repo/api`. Change one, change the other —
 * a wrong id reads as "not found", and not found is failed.
 */
function codeIndexWorkflowId(
	projectId: string,
	repositoryIntegrationId: string | null,
): string {
	return `code-index-${projectId}-${repositoryIntegrationId ?? "legacy"}`;
}

/**
 * Whether a code-index row's workflow is still running.
 *
 * Only a definite answer counts as dead: the latest run under the id is closed
 * (completed, failed, terminated, timed out, cancelled), or Temporal has never
 * heard of the workflow. A describe that errors any other way,
 * or does not answer in time, counts as live, as in
 * `isGenerationWorkflowLiveActivity` — a stale row costs a confusing status for
 * one more tick, a wrongly-failed row costs a run the user is waiting on.
 */
async function isCodeIndexWorkflowLive(
	client: Client,
	workflowId: string,
): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<"timeout">((resolve) => {
		timer = setTimeout(
			() => resolve("timeout"),
			CODE_INDEX_DESCRIBE_TIMEOUT_MS,
		);
	});
	try {
		const description = await Promise.race([
			client.workflow.getHandle(workflowId).describe(),
			deadline,
		]);
		if (description === "timeout") {
			return true;
		}
		return description.status.name === "RUNNING";
	} catch (error) {
		const name = error instanceof Error ? error.name : "";
		return name !== "WorkflowNotFoundError";
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Fail code-index rows left INDEXING by a workflow that is no longer running.
 *
 * The workflow's own guard closes the row on every failure it sees, but some
 * endings never reach workflow code: a terminate, a run timeout, a cancel from
 * the Temporal UI, a fail write that itself was lost, a history recorded
 * before the guard existed. Each leaves the row "Indexing…" for good, and the
 * settings page polls it forever.
 *
 * Each row is failed with a compare-and-set on the `updatedAt` it was read
 * with, so a row written to since — a re-index's init, a progress tick — is
 * left for the next tick to judge afresh. Returns the number of rows failed.
 */
async function failOrphanedCodeIndexes(): Promise<number> {
	const rows = await findQuietIndexingCodeIndexes({
		quietMinutes: CODE_INDEX_QUIET_MINUTES,
		limit: CODE_INDEX_SWEEP_LIMIT,
	});
	if (rows.length === 0) {
		return 0;
	}

	let client: Client;
	try {
		client = await getTemporalClient();
	} catch {
		// No answer for any row is "live" for every row.
		return 0;
	}

	let failed = 0;
	const sweepRow = async (row: QuietIndexingCodeIndex) => {
		const workflowId =
			row.workflowId ??
			codeIndexWorkflowId(row.projectId, row.repositoryIntegrationId);
		if (await isCodeIndexWorkflowLive(client, workflowId)) {
			return;
		}
		// Awaited before the `+=`: `failed += await …` reads `failed` before
		// the await and drops the counts of the other rows in flight.
		const written = await failOrphanedCodeIndex({
			id: row.id,
			observedUpdatedAt: row.updatedAt,
			error: ORPHANED_CODE_INDEX_ERROR,
		});
		failed += written;
	};

	let cursor = 0;
	const worker = async () => {
		while (cursor < rows.length) {
			await sweepRow(rows[cursor++]);
		}
	};
	await Promise.all(
		Array.from(
			{ length: Math.min(CODE_INDEX_SWEEP_CONCURRENCY, rows.length) },
			worker,
		),
	);
	return failed;
}

function resolveRetentionDays(): number {
	const raw = process.env.FABRIC_JOB_RETENTION_DAYS;
	const parsed = raw ? Number.parseInt(raw.trim(), 10) : Number.NaN;
	if (!Number.isFinite(parsed)) {
		return DEFAULT_RETENTION_DAYS;
	}
	return Math.min(MAX_RETENTION_DAYS, Math.max(MIN_RETENTION_DAYS, parsed));
}

function resolveStaleMinutes(): number {
	const raw = process.env.FABRIC_JOB_STALE_MINUTES;
	const parsed = raw ? Number.parseInt(raw.trim(), 10) : Number.NaN;
	if (!Number.isFinite(parsed) || parsed < 1) {
		return DEFAULT_STALE_MINUTES;
	}
	return parsed;
}

export interface PurgeExpiredBackgroundJobsOutput {
	deletedCount: number;
	retentionDays: number;
	batches: number;
}

/**
 * Delete job rows past the retention window, in batches with a safety cap.
 *
 * Idempotent in effect: a retry after partial progress simply deletes whatever
 * still falls past the cutoff.
 */
export async function purgeExpiredBackgroundJobsActivity(): Promise<PurgeExpiredBackgroundJobsOutput> {
	const retentionDays = resolveRetentionDays();
	const { deleted, batches } = await purgeExpiredBackgroundJobs({
		retentionDays,
	});

	logger.info("[BackgroundJobRetention] Purge complete", {
		deletedCount: deleted,
		retentionDays,
		batches,
	});

	return { deletedCount: deleted, retentionDays, batches };
}

export interface FailStaleBackgroundJobsOutput {
	failedCount: number;
	staleMinutes: number;
	failedScanCount: number;
	scanStaleMinutes: number;
	failedCodeIndexCount: number;
}

/**
 * Fail work whose worker died mid-run — background jobs, project scans and
 * code-index rows.
 *
 * Nothing else will ever close those rows: the closing write lives in the
 * activity that never got to run. Without this they sit in the panel as
 * permanently "Running" and the navigation badge never returns to zero —
 * exactly the silent-stall confusion the Job Hub exists to end.
 *
 * Project scans ride this activity rather than a schedule of their own. They
 * are a second table with the same disease and the same cure, and a second
 * schedule would mean a second cadence to keep aligned with the read-time gate
 * for no gain. The two sweeps are independent `updateMany`s and each is
 * idempotent in effect, so a retry after a partial pass simply finds nothing
 * left past its threshold.
 *
 * Code-index rows are a third table with the same disease, but judged by
 * asking Temporal rather than by age (see `failOrphanedCodeIndexes`). That
 * sweep runs last and on its own error budget: a Temporal or database hiccup
 * there costs only its own tick, never the two sweeps above.
 */
export async function failStaleBackgroundJobsActivity(): Promise<FailStaleBackgroundJobsOutput> {
	const staleMinutes = resolveStaleMinutes();
	const failedCount = await failStaleBackgroundJobs({ staleMinutes });

	if (failedCount > 0) {
		logger.warn("[BackgroundJobWatchdog] Failed stale jobs", {
			failedCount,
			staleMinutes,
		});
	}

	const failedScanCount = await failStaleProjectScans({
		staleMinutes: PROJECT_SCAN_STALE_MINUTES,
	});

	// Logged separately from the job sweep so an operator can tell which table
	// went quiet — the two have different failure modes behind them.
	if (failedScanCount > 0) {
		logger.warn("[BackgroundJobWatchdog] Failed stale project scans", {
			failedScanCount,
			scanStaleMinutes: PROJECT_SCAN_STALE_MINUTES,
		});
	}

	let failedCodeIndexCount = 0;
	try {
		failedCodeIndexCount = await failOrphanedCodeIndexes();
	} catch (error) {
		logger.warn("[BackgroundJobWatchdog] Code index sweep failed", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
	if (failedCodeIndexCount > 0) {
		logger.warn("[BackgroundJobWatchdog] Failed orphaned code indexes", {
			failedCodeIndexCount,
		});
	}

	return {
		failedCount,
		staleMinutes,
		failedScanCount,
		scanStaleMinutes: PROJECT_SCAN_STALE_MINUTES,
		failedCodeIndexCount,
	};
}
