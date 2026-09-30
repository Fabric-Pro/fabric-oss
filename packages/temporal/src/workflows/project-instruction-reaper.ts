/**
 * Coding Instructions lifecycle reaper workflow (Fizzy #2550).
 *
 * Scheduled hourly (unconditional; see `packages/temporal/src/schedules.ts`).
 * First `reapInstructionSnapshots`, which closes out uploads abandoned in
 * RECEIVING and prunes the failure path that only ever ran at the end of a
 * SUCCESSFUL validation run. Then `reapStrandedInstructionSyncReceipts`
 * (Fizzy #2672), which completes the repository-sync receipts whose workflow
 * run ended without completing them: a receipt outlives its configuration,
 * so nothing else ever would.
 *
 * Then `reapStrandedContextSyncReceipts` (Fizzy #2784), the same pass for
 * the Living Memory repository sync's receipts, which has no schedule of its
 * own: it runs on this hourly tick, after the Coding Instructions passes.
 *
 * The second and third steps are each behind `patched()`: a history recorded
 * before one existed completed right after the step before it, and must
 * replay that way.
 *
 * The body is deterministic — no `Date.now()`, no env reads, no IO — so
 * replay stays clean. The clock reads, the queries, the Temporal describes
 * and the writes all live in the activities, where they belong.
 */

import { patched, proxyActivities } from "@temporalio/workflow";
import type * as contextReceiptActivities from "../activities/project-context-sync-receipt-reaper";
import type * as syncReceiptActivities from "../activities/project-instruction-sync-receipt-reaper";
import type * as activities from "../activities/project-instructions-reaper";

const { reapInstructionSnapshots } = proxyActivities<typeof activities>({
	startToCloseTimeout: "15 minutes",
	// The activity heartbeats per candidate row, per project and per storage
	// page, and its own run budget stops it at ten minutes. Without a
	// heartbeat timeout a worker that dies mid-run holds the whole
	// start-to-close window before anything retries; with one, a dead worker
	// is detected in two minutes while a healthy run that is simply slow
	// keeps checking in. Two minutes rather than the 60s used elsewhere
	// because one unit of work here is a whole prefix sweep.
	heartbeatTimeout: "2 minutes",
	retry: {
		initialInterval: "30 seconds",
		maximumInterval: "5 minutes",
		backoffCoefficient: 2,
		maximumAttempts: 3,
	},
});

const { reapStrandedInstructionSyncReceipts } = proxyActivities<
	typeof syncReceiptActivities
>({
	// Its own four-minute run budget, checked between receipts, stops it
	// first; it heartbeats per receipt. Two attempts, not three: every
	// completion is idempotent and whatever is left is the next tick's work,
	// so a retry buys little and keeps the tick short.
	startToCloseTimeout: "5 minutes",
	heartbeatTimeout: "1 minute",
	retry: {
		initialInterval: "30 seconds",
		maximumInterval: "2 minutes",
		backoffCoefficient: 2,
		maximumAttempts: 2,
	},
});

const { reapStrandedContextSyncReceipts } = proxyActivities<
	typeof contextReceiptActivities
>({
	// The same bounds as the pass above: its own four-minute run budget stops
	// it first, it heartbeats per receipt, and every completion is idempotent.
	startToCloseTimeout: "5 minutes",
	heartbeatTimeout: "1 minute",
	retry: {
		initialInterval: "30 seconds",
		maximumInterval: "2 minutes",
		backoffCoefficient: 2,
		maximumAttempts: 2,
	},
});

type SnapshotReapResult = Awaited<ReturnType<typeof reapInstructionSnapshots>>;
type SyncReceiptReapResult = Awaited<
	ReturnType<typeof reapStrandedInstructionSyncReceipts>
>;

export async function projectInstructionReaperWorkflow(): Promise<
	SnapshotReapResult & {
		syncReceipts?: SyncReceiptReapResult;
		contextSyncReceipts?: SyncReceiptReapResult;
	}
> {
	const snapshots = await reapInstructionSnapshots();
	if (!patched("instruction-reaper-stranded-sync-receipts")) {
		return snapshots;
	}
	const syncReceipts = await reapStrandedInstructionSyncReceipts();
	if (!patched("instruction-reaper-stranded-context-sync-receipts")) {
		return { ...snapshots, syncReceipts };
	}
	const contextSyncReceipts = await reapStrandedContextSyncReceipts();
	return { ...snapshots, syncReceipts, contextSyncReceipts };
}
