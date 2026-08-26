/**
 * Publishing Suggestion — persistCycleTerminal Activity Wrapper
 *
 * A thin activity wrapper around Task 3's `@repo/database` `persistCycleTerminal`
 * helper. The workflow cannot call the DB helper directly — importing it into the
 * Temporal sandbox would pull Prisma + `node:crypto` — so it must be proxied as an
 * activity. The CAS + tenant-binding semantics (F5) therefore live entirely in the
 * shared DB helper; this wrapper adds no logic of its own to them.
 *
 * It is no longer a pure passthrough, because it is also the generation run's
 * terminal step and therefore where its Job Hub row closes (Fizzy #1850).
 *
 * WHY HERE and not after delivery: notification and chat delivery run after the
 * cycle terminalizes, each behind its own `patched()` marker and its own
 * try/catch, so there is no statically-known last step to close a row from. The
 * job is scoped to GENERATION; delivery is reported by the refresh history's
 * Notified column instead.
 */

import {
	type PersistCycleTerminalInput,
	persistCycleTerminal as persistCycleTerminalDb,
} from "@repo/database";
import { jobComplete, jobStep } from "../lib/job-progress";

/**
 * Every job key here passes `sourceId: null` EXPLICITLY rather than leaving it
 * undefined, and that is what repairs a row the watchdog wrongly failed.
 *
 * `completableStatus` lets a close reopen a `FAILED` / `TimedOut` row only for
 * an explicit `sourceId`, because a workflow id reused across ticks could
 * otherwise resurrect an earlier tick's genuinely-dead job as green. That
 * reasoning does not apply here: `publishing-suggestion-<cycleId>` names one
 * cycle, a reclaim creates a NEW cycle with a new id, and the only reuse is a
 * retry of the SAME run. Without it, a healthy run stalled past
 * FABRIC_JOB_STALE_MINUTES — nothing in this workflow bounds how long it may
 * queue — would be failed by the watchdog and then complete invisibly, because
 * every later write targets RUNNING rows only.
 */
export async function persistCycleTerminal(
	input: PersistCycleTerminalInput,
): ReturnType<typeof persistCycleTerminalDb> {
	// ORDER MATTERS: the durable write happens first, and every job write comes
	// after it. This activity carries the tightest budget in the workflow — a
	// 30-second startToCloseTimeout — and telemetry queued ahead of the terminal
	// write would be competing for it with the one operation this activity
	// exists to perform. `safely()` protects a caller from a writer that THROWS;
	// nothing protects it from one that merely hangs.
	//
	// The only state given up is a visible `persist: running`, which nothing
	// could observe anyway: the write is sub-second, so the step goes straight
	// from `pending` to its terminal value.
	let result: Awaited<ReturnType<typeof persistCycleTerminalDb>>;
	try {
		result = await persistCycleTerminalDb(input);
	} catch (error) {
		// `skipUnreachedSteps` maps `pending` and `running` alike to `skipped` on
		// close, so without this an interrupted persist would be reported as never
		// reached — on the one card where a reader needs the opposite.
		await jobStep("persist", "failed", {
			sourceId: null,
			error: error instanceof Error ? error.message : String(error),
		});
		throw error;
	}

	// `collect` is completed here as well as in the summarizer: the
	// INSUFFICIENT_CONTEXT path skips the summarizer entirely, so without this
	// the step would still read `running` when the job closes. Idempotent —
	// `applyStepTransition` overwrites by key.
	await jobStep("collect", "completed", { sourceId: null });

	if (result.persisted) {
		await jobStep("persist", "completed", { sourceId: null });
		await jobComplete({
			sourceId: null,
			counts: { topicsSuggested: input.topics.length },
		});
		return result;
	}

	// CAS lost. `persisted: false` means a later dispatch reclaimed the cycle and
	// marked it FAILED while this run was still working, so this run's persist
	// never happened. `topicsSuggested: 0` would say it produced nothing, which
	// is a different and false claim; leaving `persist` unmarked lets the close
	// sweep record `skipped`, which says exactly what occurred.
	await jobComplete({ sourceId: null });
	return result;
}
