/**
 * Reconciliation before "Sync now" (design 2026-09-23 §5.6, the §5.3.0
 * read / describe / lock-and-revalidate shape, Fizzy #2657). There is no
 * reaper: a run whose execution died without recording holds the
 * configuration (`activeRunKey`) until the next "Sync now" finds its receipt
 * unfinished, asks Temporal about that exact execution, and completes it.
 *
 *  1. Read, no lock: the configuration's unfinished receipts (at most 20).
 *  2. Describe, no lock, bounded (5 s each, 20 s in total): each receipt's
 *     exact execution. A failed or timed-out describe is `unknown`, never
 *     closed.
 *  3. Lock 1 and revalidate (`completeInterruptedContextRepositorySyncRuns`):
 *     the same receipts must still be the unfinished ones; the closed and
 *     not-found ones are completed FAILED / INTERRUPTED and release the key.
 *  4. State moved between 1 and 3 → start again, at most 3 times.
 *
 * `running` or `unknown` for any receipt, or a key still held afterwards,
 * means "Sync now" must not start: the answer is `already_running` (the safe
 * side; the tab says it is checking a previous run).
 */
import {
	completeInterruptedContextRepositorySyncRuns,
	listUnfinishedContextRepositorySyncRuns,
} from "@repo/database";
import { describeContextSyncExecutions } from "../../../lib/context-repository-sync-workflow";

const CONTEXT_SYNC_RECONCILE_ATTEMPTS = 3;

export type ContextSyncReconcileResult =
	/** Nothing holds the configuration; a run may start. */
	| { status: "clear"; completed: string[] }
	/** A run is (or may be) in progress; do not start. */
	| { status: "busy"; completed: string[] }
	/** The configuration disappeared while reconciling. */
	| { status: "not-configured" };

export async function reconcileContextRepositorySync(input: {
	projectId: string;
	organizationId: string;
	syncId: string;
	/** `activeRunKey` as the caller's read of the configuration saw it. */
	activeRunKey: string | null;
}): Promise<ContextSyncReconcileResult> {
	const completed: string[] = [];
	for (
		let attempt = 0;
		attempt < CONTEXT_SYNC_RECONCILE_ATTEMPTS;
		attempt++
	) {
		const unfinished = (
			await listUnfinishedContextRepositorySyncRuns(input.syncId)
		).map((run) => run.id);
		if (
			unfinished.length === 0 &&
			input.activeRunKey === null &&
			attempt === 0
		) {
			// Nothing to reconcile and nothing held: no lock needed. A run
			// that begins after this read is refused by the start itself
			// (one workflow id per project, conflict policy FAIL).
			return { status: "clear", completed };
		}

		const states = await describeContextSyncExecutions({
			projectId: input.projectId,
			syncId: input.syncId,
			runKeys: unfinished,
		});
		const closed = unfinished.filter((runKey) => {
			const state = states.get(runKey);
			return state === "closed" || state === "not-found";
		});
		const blocked = unfinished.some((runKey) => {
			const state = states.get(runKey);
			return state === "running" || state === "unknown";
		});

		const result = await completeInterruptedContextRepositorySyncRuns({
			syncId: input.syncId,
			projectId: input.projectId,
			organizationId: input.organizationId,
			observedUnfinished: unfinished,
			closed,
		});
		if (result.status === "not-configured") {
			return result;
		}
		if (result.status === "changed") {
			continue;
		}
		completed.push(...result.completed);
		return {
			status: blocked || result.activeRunKey !== null ? "busy" : "clear",
			completed,
		};
	}
	// Still moving after three passes: something else is starting or
	// finishing a run right now. Refuse on the safe side.
	return { status: "busy", completed };
}
