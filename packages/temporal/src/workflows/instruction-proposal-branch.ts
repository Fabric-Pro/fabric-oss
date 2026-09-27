/**
 * Coding Instructions member proposal branch: one workflow per branch
 * (Fizzy #2738 spec §6, Decision 9).
 *
 * Id `project-instruction-proposal-branch-<branchId>`, type
 * `projectInstructionProposalBranchWorkflow`, on `project-instructions`;
 * its activities run on `fabric-worker` (queues as #2563). It owns every git
 * write on its branch: appends, reverts, the create, close and settlement,
 * and the settlement confirmations. It is started by `signalWithStart(wake)`
 * (the API after a command commits, the sweeper when the database shows
 * work); a `wake` signal only increments a counter.
 *
 * Loop. Each iteration reads `nextBranchWorkItem` (read-only, one database
 * snapshot) and runs the first applicable item, in the spec's fixed order:
 * recover, confirm, close, release, classify, rehome, revert, retry,
 * lookup, create, append, wait, idle. The order lives in the database's
 * `decideBranchWork`; this loop only runs what it answers.
 *
 * - `wait`: #2563's readiness for the validating head, sleeping 5, 10, 20,
 *   40, then 60 s between answers (interrupted by a wake); its 6 h clock is
 *   the activity's, on the database clock.
 * - `idle` with a timer: sleeps until the earliest due item (or a wake),
 *   then reads again. `idle` without one ends the run, but only when the
 *   signal counter is unchanged since that read: a wake during the read is
 *   another iteration, never lost.
 * - A recovery that could not fetch the history, and a claim that found
 *   nothing to claim, wrote nothing a later read would differ by: the loop
 *   backs off (or waits for a wake) before it reads again, so it never
 *   spins.
 *
 * Every 200 iterations the run continues as new, carrying only the ids.
 * An activity that fails after its retries fails the run; the sweeper's
 * Close, Recover or Restart wakes the branch again while its database shows
 * work (spec §8).
 *
 * Imports only the SDK, the pure branch vocabulary, the #2563 readiness
 * sleeps, the task-queue constant and type-only activity signatures, as the
 * workflow sandbox requires.
 */
import {
	condition,
	continueAsNew,
	defineSignal,
	proxyActivities,
	setHandler,
} from "@temporalio/workflow";
import type * as branchActivities from "../activities/instruction-proposal-branches";
import {
	BRANCH_ACTIVITY_TIMEOUTS,
	BRANCH_ITERATIONS_PER_RUN,
	BRANCH_LOOP_ACTIVITY_TIMEOUTS,
	type ProposalBranchWorkflowResult,
} from "../activities/lib/instruction-branch-types";
import { PROPOSAL_READINESS_SLEEPS_S } from "../lib/instruction-proposal-pull-request-types";
import { INSTRUCTION_SYNC_ACTIVITY_TASK_QUEUE } from "../task-queues";

/** The branch workflow's input (spec §6 "Identity"): ids only. */
export type ProposalBranchWorkflowInput = {
	branchId: string;
	projectId: string;
	organizationId: string;
	/**
	 * Iterations before this run continues as new; `BRANCH_ITERATIONS_PER_RUN`
	 * when absent. Never carried into the next run.
	 */
	iterations?: number;
};

/** `wake`: read the database again (spec §6 "Start"). No arguments. */
export const wakeSignal = defineSignal<[]>("wake");

/**
 * Covers timeouts and worker loss. Every activity returns typed outcomes
 * and records its own failures, so a retry only follows a crash.
 */
const RETRY = {
	maximumAttempts: 3,
	initialInterval: "10 seconds",
	backoffCoefficient: 2,
} as const;

const L = BRANCH_LOOP_ACTIVITY_TIMEOUTS;
const A = BRANCH_ACTIVITY_TIMEOUTS;

function options(t: { startToCloseMs: number; heartbeatMs?: number }) {
	return {
		taskQueue: INSTRUCTION_SYNC_ACTIVITY_TASK_QUEUE,
		startToCloseTimeout: t.startToCloseMs,
		...(t.heartbeatMs !== undefined
			? { heartbeatTimeout: t.heartbeatMs }
			: {}),
		retry: RETRY,
	};
}

// Destructured, not read off the proxy object, so the activity-registration
// parity guard (`workflows/__tests__/activity-registration-parity.test.ts`)
// can see each name statically.
const { nextBranchWorkItem } = proxyActivities<typeof branchActivities>(
	options(L.read),
);
const { checkBranchProposalReadiness } = proxyActivities<
	typeof branchActivities
>(options(L.readiness));
const { recoverBranchOperation } = proxyActivities<typeof branchActivities>(
	options(A.recover),
);
const { runBranchConfirmations } = proxyActivities<typeof branchActivities>(
	options(L.confirm),
);
const { settleBranch } = proxyActivities<typeof branchActivities>(
	options(L.settle),
);
const { releaseBranch } = proxyActivities<typeof branchActivities>(
	options(A.release),
);
const { classifyBranch } = proxyActivities<typeof branchActivities>(
	options(L.classify),
);
const { rehomeBranchProposals } = proxyActivities<typeof branchActivities>(
	options(L.rehome),
);
const { revertBranchProposal } = proxyActivities<typeof branchActivities>(
	options(A.revert),
);
const { retryBranchOpening } = proxyActivities<typeof branchActivities>(
	options(A.retry),
);
const { lookupBranchPullRequest } = proxyActivities<typeof branchActivities>(
	options(A.lookup),
);
const { createBranchPullRequest } = proxyActivities<typeof branchActivities>(
	options(A.create),
);
const { claimBranchProposal } = proxyActivities<typeof branchActivities>(
	options(A.claim),
);
const { appendBranchProposal } = proxyActivities<typeof branchActivities>(
	options(A.append),
);

/** The readiness sleep after `n` answers that were not `ready`: 5, 10, 20, 40, then 60 s. */
export function branchReadinessSleepMs(n: number): number {
	const last = PROPOSAL_READINESS_SLEEPS_S.length - 1;
	return (PROPOSAL_READINESS_SLEEPS_S[Math.min(n, last)] ?? 60) * 1000;
}

/**
 * The wait after `n` consecutive answers that changed nothing (a recovery
 * without history, a claim without a head): 30 s doubling to 15 min.
 */
export function branchStallSleepMs(n: number): number {
	return Math.min(30_000 * 2 ** Math.min(n, 5), 15 * 60_000);
}

/** The shortest idle timer: a due time already passed is read again after 1 s. */
const MIN_TIMER_MS = 1_000;

export async function projectInstructionProposalBranchWorkflow(
	input: ProposalBranchWorkflowInput,
): Promise<ProposalBranchWorkflowResult> {
	let signals = 0;
	setHandler(wakeSignal, () => {
		signals++;
	});
	const ids = {
		branchId: input.branchId,
		organizationId: input.organizationId,
	};
	const perRun = input.iterations ?? BRANCH_ITERATIONS_PER_RUN;
	/** Sleeps `ms` unless a wake arrives after `seen`. */
	const pause = (seen: number, ms: number) =>
		condition(() => signals !== seen, Math.max(ms, MIN_TIMER_MS));
	let waiting = null as { snapshotId: string; answers: number } | null;
	let stalls = 0;

	for (let iteration = 0; ; iteration++) {
		if (iteration >= perRun) {
			await continueAsNew<
				typeof projectInstructionProposalBranchWorkflow
			>({
				branchId: input.branchId,
				projectId: input.projectId,
				organizationId: input.organizationId,
			});
		}
		const seen = signals;
		const { work, branchAttempt } = await nextBranchWorkItem(ids);
		if (work.kind !== "wait") {
			waiting = null;
		}
		let stalled = false;
		switch (work.kind) {
			case "recover": {
				const recovered = await recoverBranchOperation({
					...ids,
					operationId: work.operationId,
				});
				stalled = recovered.outcome === "retry_later";
				break;
			}
			case "confirm":
				await runBranchConfirmations(ids);
				break;
			case "close":
				await settleBranch({ ...ids, branchAttempt });
				break;
			case "release":
				await releaseBranch({ ...ids, branchAttempt });
				break;
			case "classify":
				await classifyBranch({
					...ids,
					factsRevision: work.factsRevision,
				});
				break;
			case "rehome":
				await rehomeBranchProposals({
					...ids,
					snapshotIds: work.snapshotIds,
				});
				break;
			case "revert":
				await revertBranchProposal({
					...ids,
					snapshotId: work.snapshotId,
					proposalAttempt: work.proposalAttempt,
				});
				break;
			case "retry":
				await retryBranchOpening({ ...ids, branchAttempt });
				break;
			case "lookup":
				await lookupBranchPullRequest(ids);
				break;
			case "create":
				await createBranchPullRequest({ ...ids, branchAttempt });
				break;
			case "append": {
				const claim = await claimBranchProposal(ids);
				if (claim.kind === "claimed") {
					await appendBranchProposal({
						...ids,
						snapshotId: claim.snapshotId,
						proposalAttempt: claim.proposalAttempt,
						branchAttempt: claim.branchAttempt,
					});
				} else {
					stalled = claim.kind === "none";
				}
				break;
			}
			case "wait": {
				const head: { snapshotId: string; answers: number } =
					waiting !== null && waiting.snapshotId === work.snapshotId
						? waiting
						: { snapshotId: work.snapshotId, answers: 0 };
				waiting = head;
				const answer = await checkBranchProposalReadiness({
					...ids,
					projectId: input.projectId,
					snapshotId: work.snapshotId,
				});
				if (answer.kind !== "ready") {
					// `stop` too: a deadline answer has moved the head, and any
					// other `stop` must not turn the loop into a hot loop.
					await pause(seen, branchReadinessSleepMs(head.answers));
					head.answers++;
				}
				break;
			}
			case "idle": {
				if (work.wakeInMs === null) {
					if (signals === seen) {
						return { ended: "idle" };
					}
					break;
				}
				await pause(seen, work.wakeInMs);
				break;
			}
		}
		if (stalled) {
			await pause(seen, branchStallSleepMs(stalls));
			stalls++;
		} else {
			stalls = 0;
		}
	}
}
