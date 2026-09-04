/**
 * PM Sync Log write helper (synchronous, NON-FATAL).
 *
 * Records exactly ONE `pm_sync_log` row at a sync-outcome boundary. It is a
 * thin composer: it resolves the Temporal-context fields (`batchId` /
 * `correlationId`) inside the activity layer and delegates the actual insert
 * to `createPmSyncLog` (`@repo/database`).
 *
 * Behaviour:
 *  - **Synchronous** inside the existing sync activities — no new infra. The
 *    caller `await`s this at the outcome boundary alongside its own DB writes.
 *  - **NON-FATAL:** the `createPmSyncLog` call is wrapped in try/catch. A
 *    log-write failure is logged via `@repo/logs` and the helper RESOLVES
 *    NORMALLY — it must NEVER throw or degrade the caller's real sync result.
 *    This is the one sanctioned exception to `global/error-handling.md`'s
 *    "no silent failures" rule: the failure IS observed (fire-and-forget
 *    telemetry), it just doesn't propagate. Audit/sync logging that breaks
 *    the thing it observes is worse than a dropped log line.
 *  - **`batchId` + `correlationId`** are both derived from the Temporal
 *    workflow `runId` read ONCE here in the activity layer (mirrors
 *    `readActivityCorrelationId()` in `audit-log-retention.ts`). They fall
 *    back to `null` when called outside an activity (unit-test path). The
 *    `runId` is NOT generated in any workflow body — doing so would be a
 *    replay-determinism trap.
 *  - **No SKIP path** (D4): `status` is typed to `SUCCESS | FAILURE |
 *    CONFLICT` only (via `PmSyncLogStatus`). There is no branch that writes
 *    for a skipped / nothing-to-do outcome — skipped items emit no row.
 */

import { type CreatePmSyncLogInput, createPmSyncLog } from "@repo/database";
import { logger } from "@repo/logs";
import { activityInfo } from "@temporalio/activity";

/**
 * Caller-supplied fields for {@link recordPmSyncLog}. This is exactly
 * {@link CreatePmSyncLogInput} minus the two fields the helper resolves itself
 * from the Temporal context. Deriving from the query-layer type keeps the two
 * in lock-step: a column added to the query input shows up here automatically.
 */
export type RecordPmSyncLogInput = Omit<
	CreatePmSyncLogInput,
	"batchId" | "correlationId"
>;

/**
 * The Temporal workflow `runId` doubles as both the `batchId` (groups every
 * row from one workflow run) and the `correlationId` (joins log rows to
 * traces). Read it ONCE; both fields derive from the single read. Falls back
 * to `null` outside an activity context (unit tests / non-Temporal callers),
 * mirroring `readActivityCorrelationId()` in `audit-log-retention.ts`.
 */
function readRunId(): string | null {
	try {
		return activityInfo().workflowExecution?.runId ?? null;
	} catch {
		return null;
	}
}

/**
 * Record one `pm_sync_log` row for a SUCCESS / FAILURE / CONFLICT outcome.
 *
 * Resolves normally even if the underlying write throws — see the NON-FATAL
 * contract in the file header. Returns `void`: callers neither need nor should
 * branch on the log-write result.
 */
export async function recordPmSyncLog(
	input: RecordPmSyncLogInput,
): Promise<void> {
	const runId = readRunId();
	try {
		// `await` INSIDE the try so an async rejection is caught here rather than
		// escaping to the caller's sync path.
		await createPmSyncLog({
			...input,
			batchId: runId,
			correlationId: runId,
		} as CreatePmSyncLogInput);
	} catch (error) {
		// Non-fatal: the failure is logged (not silently dropped) but never
		// rethrown — a dropped audit row must not break the sync it observes.
		logger.warn("pm.sync.log.write_failed", {
			entityType: input.entityType,
			entityId: input.entityId,
			direction: input.direction,
			status: input.status,
			pmTool: input.pmTool,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}
