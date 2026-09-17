/**
 * Coding Instructions lifecycle reaper workflow (Fizzy #2550).
 *
 * Scheduled hourly (unconditional; see `packages/temporal/src/schedules.ts`)
 * and delegating entirely to `reapInstructionSnapshots`, which closes out
 * uploads abandoned in RECEIVING and prunes the failure path that only ever
 * ran at the end of a SUCCESSFUL validation run.
 *
 * The body is deterministic — no `Date.now()`, no env reads, no IO — so
 * replay stays clean. The sweep's clock read lives in the activity, where it
 * belongs.
 */

import { proxyActivities } from "@temporalio/workflow";
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

export async function projectInstructionReaperWorkflow(): Promise<
	Awaited<ReturnType<typeof reapInstructionSnapshots>>
> {
	return await reapInstructionSnapshots();
}
