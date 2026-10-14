/**
 * Shared start, settle and compensate steps for a PM sync enqueue.
 *
 * Every enqueue stamps the item PENDING and then starts a workflow. A start
 * that throws does not prove the workflow never started: a client-side
 * timeout or a lost response can throw after Temporal accepted the request,
 * and the item then shows FAILED while the sync is running. So a failed start
 * is settled by where it failed:
 *
 *   1. Only a failure our own code proves happened before `workflow.start()`
 *      was called (the Temporal client could not be acquired) marks the
 *      attempt FAILED outright.
 *   2. Any error that escapes `workflow.start()` is uncertain, whatever its
 *      type or gRPC status. The client's interceptors run after the service
 *      answers (the OpenTelemetry interceptor sets span attributes and ends
 *      the span after awaiting the start), so a plain error can surface after
 *      the execution was created; and the SDK retries the call, so a final
 *      rejection (PERMISSION_DENIED, UNAUTHENTICATED) does not prove an
 *      earlier send whose response was lost did not apply. Every such error
 *      is reconciled by describing the exact workflow id the attempt used
 *      (`describePmSyncWorkflow`): running leaves the row PENDING; a workflow
 *      Temporal has never heard of (or a closed one) marks it FAILED; a
 *      describe that itself fails leaves the row PENDING for the stuck-sync
 *      watchdog.
 *
 * The FAILED write (`compensatePmSyncStart`) is scoped to the attempt: it
 * matches the item id, the attempt id that this enqueue's PENDING stamp
 * wrote, and status PENDING. A newer attempt's stamp, or a run that already
 * settled the row, is left alone; zero matching rows is a no-op.
 *
 * Used by `@repo/api`'s `enqueuePmSync` (through `enqueuePmSyncCore`), by the
 * activity-side `enqueuePmSyncFromActivity`, and by the test-case retry, which
 * settles a failed start the same way but rolls its stamp back to the status
 * it replaced instead of writing FAILED (`retryTestCasePmSync`).
 */

import { randomUUID } from "node:crypto";
import { db, PmSyncStatus } from "@repo/database";
import { type Client, WorkflowNotFoundError } from "@temporalio/client";

/** Row tables that carry PM-sync state. */
export type PmSyncRowTable = "userStory" | "testCase";

/**
 * The workflow id for a story-family PM sync. One id per item, so two
 * near-simultaneous enqueues de-duplicate (`USE_EXISTING`) instead of both
 * taking the CREATE path, and so the reconcile step and the stuck-sync
 * watchdog can both describe it.
 */
export function pmSyncWorkflowId(itemType: string, itemId: string): string {
	return `pm-sync-${itemType}-${itemId}`;
}

/**
 * The start policies that go with `pmSyncWorkflowId`: attach to a running
 * sync for the item, start a fresh one once the previous run has closed.
 */
export const PM_SYNC_START_POLICIES = {
	workflowIdReusePolicy: "ALLOW_DUPLICATE",
	workflowIdConflictPolicy: "USE_EXISTING",
} as const;

/**
 * The workflow id for a single test case's push (`testCaseSyncWorkflow` with
 * one case): single-case Sync now, auto-sync and Retry all use it, so no two
 * of those run for one case at once. A multi-case push (Sync now on several
 * cases) has its own id and can overlap them; the create claim keeps that
 * from creating a case twice. It is the id Sync now has always used, so a
 * run started before this was shared is still found by it.
 */
export function testCaseSyncWorkflowId(
	projectId: string,
	testCaseId: string,
): string {
	return `test-case-sync-${projectId}-${testCaseId}`;
}

export interface PmSyncPendingStamp {
	attemptId: string;
	data: {
		lastPmSyncStatus: typeof PmSyncStatus.PENDING;
		lastPmSyncAttemptAt: Date;
		lastPmSyncAttemptId: string;
		pmSyncPendingSince: Date;
	};
}

/**
 * The PENDING stamp for a new attempt: a fresh attempt id, and the
 * pending-since bound. A fresh enqueue starts the bound now; the stuck-sync
 * watchdog passes the bound it observed so its retries never move it.
 * Pure: the caller writes `data` itself, so a caller that must check
 * something immediately before the write (a chat turn's stop) can.
 */
export function newPmSyncPendingStamp(pendingSince?: Date): PmSyncPendingStamp {
	const now = new Date();
	const attemptId = randomUUID();
	return {
		attemptId,
		data: {
			lastPmSyncStatus: PmSyncStatus.PENDING,
			lastPmSyncAttemptAt: now,
			lastPmSyncAttemptId: attemptId,
			pmSyncPendingSince: pendingSince ?? now,
		},
	};
}

export interface CompensatePmSyncStartInput {
	table: PmSyncRowTable;
	itemId: string;
	attemptId: string;
	message: string;
}

/**
 * Mark the attempt FAILED, but only while the row is still PENDING for this
 * attempt. Returns how many rows changed: 0 means a newer attempt stamped the
 * row or a run already settled it, and both are left as they are.
 */
export async function compensatePmSyncStart(
	input: CompensatePmSyncStartInput,
): Promise<number> {
	const where = {
		id: input.itemId,
		lastPmSyncAttemptId: input.attemptId,
		lastPmSyncStatus: PmSyncStatus.PENDING,
	};
	const data = {
		lastPmSyncStatus: PmSyncStatus.FAILED,
		lastPmSyncError:
			`Failed to enqueue PM sync (Temporal unreachable): ${input.message}`.slice(
				0,
				500,
			),
		lastPmSyncAttemptAt: new Date(),
	};
	const result =
		input.table === "testCase"
			? await db.testCase.updateMany({ where, data })
			: await db.userStory.updateMany({ where, data });
	return result.count;
}

function hasName(error: unknown, name: string): boolean {
	return error instanceof Error && error.name === name;
}

/**
 * The describe's RPC deadline. A describe that cannot answer within it is
 * `unknown`, which leaves the row PENDING; waiting longer only holds up the
 * caller (a user request, or a watchdog tick).
 */
const PM_SYNC_DESCRIBE_DEADLINE_MS = 10_000;

export type PmSyncWorkflowState =
	| "running"
	| "closed"
	| "not-found"
	| "unknown";

/**
 * Describe the workflow id, under `PM_SYNC_DESCRIBE_DEADLINE_MS` when the
 * client supports deadlines. `not-found` only for Temporal's typed
 * `WorkflowNotFoundError`; any other describe failure (including the
 * deadline) is `unknown`.
 */
export async function describePmSyncWorkflow(
	client: Pick<Client, "workflow"> & Partial<Pick<Client, "withDeadline">>,
	workflowId: string,
): Promise<PmSyncWorkflowState> {
	return (await describePmSyncWorkflowRun(client, workflowId)).state;
}

/**
 * `describePmSyncWorkflow`, plus the run's decoded memo, so a caller can
 * tell whether the run under the id is the one it started (the test-case
 * retry names its attempt there). `memo` is set only for a described run.
 */
export async function describePmSyncWorkflowRun(
	client: Pick<Client, "workflow"> & Partial<Pick<Client, "withDeadline">>,
	workflowId: string,
): Promise<{ state: PmSyncWorkflowState; memo?: Record<string, unknown> }> {
	try {
		const describe = () => client.workflow.getHandle(workflowId).describe();
		const description = client.withDeadline
			? await client.withDeadline(
					Date.now() + PM_SYNC_DESCRIBE_DEADLINE_MS,
					describe,
				)
			: await describe();
		return {
			state: description.status.name === "RUNNING" ? "running" : "closed",
			memo: description.memo ?? {},
		};
	} catch (error) {
		if (
			error instanceof WorkflowNotFoundError ||
			hasName(error, "WorkflowNotFoundError")
		) {
			return { state: "not-found" };
		}
		return { state: "unknown" };
	}
}

/**
 * How a failed start was settled:
 *   - `failed`: the client could not be acquired, so `workflow.start()` was
 *     never called; or the describe found no running workflow for the id.
 *     The attempt-scoped FAILED write was issued;
 *   - `running`: the workflow id is running, so the row stays PENDING and
 *     that run settles it;
 *   - `uncertain`: the start may have gone through and the describe could
 *     not tell; the row stays PENDING for the stuck-sync watchdog.
 */
export type PmSyncStartSettlement = "failed" | "running" | "uncertain";

export interface SettleFailedPmSyncStartInput {
	/**
	 * The client the start used; `null` when acquiring it failed, before
	 * `workflow.start()` was called.
	 */
	client:
		| (Pick<Client, "workflow"> & Partial<Pick<Client, "withDeadline">>)
		| null;
	workflowId: string;
	/**
	 * The attempt-scoped FAILED write. Must not throw: callers log and
	 * swallow a failed write inside it, as the row is reconciled later.
	 */
	compensate: () => Promise<unknown>;
}

export async function settleFailedPmSyncStart(
	input: SettleFailedPmSyncStartInput,
): Promise<PmSyncStartSettlement> {
	// The only proof that nothing was sent: `workflow.start()` was never
	// called because the client could not be acquired. Whatever escaped the
	// call itself is reconciled below, never trusted by its type.
	if (input.client === null) {
		await input.compensate();
		return "failed";
	}
	const state = await describePmSyncWorkflow(input.client, input.workflowId);
	if (state === "running") {
		return "running";
	}
	if (state === "unknown") {
		return "uncertain";
	}
	// `not-found`: the start never took. `closed`: if this attempt's run went
	// out and finished, it already moved the row off PENDING, so the
	// attempt-scoped write below changes nothing; otherwise the closed run is
	// an older one and this attempt never started.
	await input.compensate();
	return "failed";
}
