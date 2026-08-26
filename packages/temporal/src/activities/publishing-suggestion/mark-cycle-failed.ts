/**
 * Publishing Suggestion — Mark-Cycle-Failed Activity
 *
 * The Task 9 workflow's terminal-failure hook: called from the workflow's outer
 * catch to move a still-GENERATING cycle to FAILED. It runs as an ACTIVITY (not
 * in the workflow body) because it writes to the DB, and — unlike the workflow
 * sandbox — activities may freely use `new Date()`.
 *
 * F5 (projectId-scoped CAS): the WHERE clause pins BOTH `id` AND `projectId` AND
 * `status: "GENERATING"`, so:
 *   - a stale/version-skewed/malformed input can never fail ANOTHER project's
 *     cycle (projectId guard);
 *   - it never clobbers a run that a superseding/reclaiming cycle already took
 *     terminal (the GENERATING guard makes a lost race a silent no-op — count 0);
 *   - it advances NO coverage (it only stamps status/completedAt/error).
 *
 * `error` is truncated to the column bound (`@db.VarChar(500)`).
 */

import { db } from "@repo/database";
import { jobFail, jobFailRunningStep } from "../lib/job-progress";

export async function markCycleFailed(
	cycleId: string,
	projectId: string,
	err: string,
): Promise<void> {
	await db.publishingSuggestionCycle.updateMany({
		where: { id: cycleId, projectId, status: "GENERATING" },
		data: {
			status: "FAILED",
			completedAt: new Date(),
			error: err.slice(0, 500),
		},
	});

	// Job Hub (Fizzy #1850): the workflow's outer catch is the only
	// always-reached failure hook, so the row closes here. `err` is rendered
	// verbatim in the panel, which is why the workflow passes the cycle's own
	// message rather than a stack trace.
	//
	// AFTER the cycle write, deliberately: `jobFail` swallows its own errors, so
	// telemetry can never stop a cycle being marked FAILED — but it could still
	// delay it, and the cycle's terminal state is what everything else reads.
	//
	// The step first, then the close. Some failures are raised in WORKFLOW code
	// rather than inside the activity that owns the step — "all sources failed"
	// is thrown after the collector fan-out, when `collect` is still `running`
	// and no single collector is in a position to mark it. The close sweep would
	// record that as `skipped`, i.e. never reached, which is the opposite of what
	// happened. Marking it first leaves `skipped` meaning only what it says.
	await jobFailRunningStep(err, null);
	await jobFail(err, { sourceId: null });
}
