/**
 * Coding Instructions proposal pull requests: the five-minute sweeper
 * (Fizzy #2563 spec §9).
 *
 * The `instruction-proposal-pull-request-sweep` schedule starts this every
 * five minutes on `fabric-worker` with overlap SKIP and a 270 s execution
 * timeout (plan Decision 16). One tick:
 *
 * - selects the five sub-batches once (Close 10, Recover 10, Merge sync 10,
 *   Observe 20, Restart 10), each item carrying the attempt read at
 *   selection and whether its operation workflow is running;
 * - runs them in the table's order (Close first, so due confirmations
 *   precede ordinary recovery) through four lanes pulling from one queue,
 *   and starts no item with under 30 s of its 4-minute budget left;
 * - defers a row whose operation workflow is running by 30 min, conditional
 *   on that attempt, and does nothing else with it: the workflow finishes
 *   its own work, and a sweeper action beside it would race it;
 * - skips, for the rest of the tick, every later item of an integration an
 *   answer reported rate limited (the activity already delayed that row by
 *   `retryAfterSeconds`).
 *
 * Actions: Close runs close (due confirmations, then settlement for a
 * CLOSE_REQUESTED row, or the release of one acknowledged branch a BLOCKED
 * row only a human may retry left without an owner), fenced by the attempt
 * read at selection. Recover runs
 * recovery; its `close_requested` runs close and its `absent_handoff` runs
 * Restart's action in the same item. Merge sync runs the §9.1 dispatch.
 * Observe runs reconcile, and a `merged` answer runs the merge-sync dispatch
 * in the same item. Restart starts the operation workflow. The sweeper never
 * opens, never passes `retryCreate`, and never settles a row that is not
 * CLOSE_REQUESTED beyond that one release, which keeps the row's state:
 * settlement and re-issue belong to the open activity and a human's retry. A follow-up the budget no longer allows is left to the next
 * tick, whose Restart or Merge sync sub-batch selects the same row.
 *
 * Every call's schedule-to-close is the budget left, so a call no worker
 * serves cannot hold the run past it, and every action carries `deadlineAt`,
 * the budget's end, which the activity stops issuing effects 10 s before
 * (heartbeating throughout). `Date.now()` is workflow time inside
 * the sandbox, so the budget replays deterministically. Imports only the SDK,
 * the pure proposal types and type-only activity signatures. The activities
 * name no task queue: they run on the workflow's own, `fabric-worker`.
 */
import { log, proxyActivities } from "@temporalio/workflow";
import type * as proposalActivities from "../activities/instruction-proposal-pull-requests";
import {
	type DispatchProposalInput,
	type DueProposalSweep,
	PROPOSAL_SWEEP_BUDGET_MS,
	PROPOSAL_SWEEP_CONCURRENCY,
	PROPOSAL_SWEEP_LIMITS,
	PROPOSAL_SWEEP_RESERVE_MS,
	type ProposalOperationInput,
	type ProposalSweepItem,
	type ProposalSweepResult,
	PROPOSAL_ACTIVITY_TIMEOUTS as T,
} from "../lib/instruction-proposal-pull-request-types";

type SubBatch = keyof DueProposalSweep;

/** Spec §9's table order. */
const ORDER: readonly SubBatch[] = [
	"close",
	"recover",
	"mergeSync",
	"observe",
	"restart",
];

const RETRY = {
	maximumAttempts: 3,
	initialInterval: "10 seconds",
	backoffCoefficient: 2,
} as const;

/**
 * Proxies for calls made now: the schedule-to-close is the budget left at
 * this moment, so it cannot be fixed at module load, and it bounds every
 * activity's own start-to-close (spec §6, `PROPOSAL_ACTIVITY_TIMEOUTS`).
 * Destructured, not read off the proxy object, so the activity-registration
 * parity guard (`workflows/__tests__/activity-registration-parity.test.ts`)
 * can see each name statically.
 */
function sweepActivities(budgetLeftMs: number) {
	const within = { scheduleToCloseTimeout: budgetLeftMs, retry: RETRY };
	const {
		deferInstructionProposalOperation,
		selectDueInstructionProposalOperations,
	} = proxyActivities<typeof proposalActivities>({
		...within,
		startToCloseTimeout: T.select.startToCloseMs,
	});
	const { closeInstructionProposalPullRequest } = proxyActivities<
		typeof proposalActivities
	>({
		...within,
		startToCloseTimeout: T.close.startToCloseMs,
		heartbeatTimeout: T.close.heartbeatMs,
	});
	const { recoverInstructionProposalPullRequest } = proxyActivities<
		typeof proposalActivities
	>({
		...within,
		startToCloseTimeout: T.recover.startToCloseMs,
		heartbeatTimeout: T.recover.heartbeatMs,
	});
	const { reconcileInstructionProposalPullRequest } = proxyActivities<
		typeof proposalActivities
	>({
		...within,
		startToCloseTimeout: T.reconcile.startToCloseMs,
		heartbeatTimeout: T.reconcile.heartbeatMs,
	});
	const { dispatchInstructionProposalMergeSync } = proxyActivities<
		typeof proposalActivities
	>({
		...within,
		startToCloseTimeout: T.mergeSync.startToCloseMs,
		heartbeatTimeout: T.mergeSync.heartbeatMs,
	});
	const { dispatchInstructionProposalPullRequest } = proxyActivities<
		typeof proposalActivities
	>({
		...within,
		startToCloseTimeout: T.dispatch.startToCloseMs,
		heartbeatTimeout: T.dispatch.heartbeatMs,
	});
	return {
		closeInstructionProposalPullRequest,
		deferInstructionProposalOperation,
		dispatchInstructionProposalMergeSync,
		dispatchInstructionProposalPullRequest,
		reconcileInstructionProposalPullRequest,
		recoverInstructionProposalPullRequest,
		selectDueInstructionProposalOperations,
	};
}

function idsOf(item: ProposalSweepItem): ProposalOperationInput {
	return {
		snapshotId: item.snapshotId,
		projectId: item.projectId,
		organizationId: item.organizationId,
		operationId: item.operationId,
	};
}

function dispatchInputOf(item: ProposalSweepItem): DispatchProposalInput {
	return { ...idsOf(item), attempt: item.attempt };
}

function errorName(error: unknown): string {
	return error instanceof Error ? error.name : typeof error;
}

export async function instructionProposalPullRequestSweepWorkflow(): Promise<ProposalSweepResult> {
	const deadline = Date.now() + PROPOSAL_SWEEP_BUDGET_MS;
	// Every action's absolute deadline (#2540's poll pattern): the attempt
	// stops issuing effects 10 s before the budget ends.
	const deadlineAt = new Date(deadline).toISOString();
	const budgetLeft = (): number => deadline - Date.now();
	const mayStart = (): boolean => budgetLeft() >= PROPOSAL_SWEEP_RESERVE_MS;
	const result: ProposalSweepResult = {
		selected: 0,
		processed: 0,
		deferred: 0,
		rateLimited: 0,
		outOfBudget: 0,
		failed: 0,
		selectFailed: false,
	};

	let due: DueProposalSweep;
	try {
		due = await sweepActivities(
			budgetLeft(),
		).selectDueInstructionProposalOperations(PROPOSAL_SWEEP_LIMITS);
	} catch (error) {
		result.selectFailed = true;
		log.warn(
			"Proposal pull-request sweep selection failed; ending the tick",
			{
				error: errorName(error),
			},
		);
		return result;
	}

	// One queue in the table's order. The selection already skips an id an
	// earlier sub-batch took; this keeps it so if a later one repeats it.
	const queue: Array<{ batch: SubBatch; item: ProposalSweepItem }> = [];
	const taken = new Set<string>();
	for (const batch of ORDER) {
		for (const item of due[batch]) {
			result.selected++;
			if (!taken.has(item.snapshotId)) {
				taken.add(item.snapshotId);
				queue.push({ batch, item });
			}
		}
	}

	const limited = new Set<string>();
	const isLimited = (item: ProposalSweepItem): boolean =>
		item.integrationId !== null && limited.has(item.integrationId);
	const noteLimit = (answer: { rateLimitedIntegrationId?: string }) => {
		if (answer.rateLimitedIntegrationId) {
			limited.add(answer.rateLimitedIntegrationId);
		}
	};

	const act = async (batch: SubBatch, item: ProposalSweepItem) => {
		const ids = { ...idsOf(item), deadlineAt };
		const dispatchInput = { ...dispatchInputOf(item), deadlineAt };
		const now = sweepActivities(budgetLeft());
		if (item.running) {
			await now.deferInstructionProposalOperation(dispatchInputOf(item));
			result.deferred++;
			return;
		}
		switch (batch) {
			case "close": {
				noteLimit(
					await now.closeInstructionProposalPullRequest({
						...ids,
						expectedAttempt: item.attempt,
					}),
				);
				return;
			}
			case "recover": {
				const recovered =
					await now.recoverInstructionProposalPullRequest({
						...ids,
						expectedAttempt: item.attempt,
					});
				noteLimit(recovered);
				if (!mayStart() || isLimited(item)) {
					return;
				}
				if (recovered.kind === "close_requested") {
					noteLimit(
						await sweepActivities(
							budgetLeft(),
						).closeInstructionProposalPullRequest({
							...ids,
							expectedAttempt: item.attempt,
						}),
					);
				} else if (recovered.kind === "absent_handoff") {
					await sweepActivities(
						budgetLeft(),
					).dispatchInstructionProposalPullRequest(dispatchInput);
				}
				return;
			}
			case "mergeSync": {
				await now.dispatchInstructionProposalMergeSync(ids);
				return;
			}
			case "observe": {
				const observed =
					await now.reconcileInstructionProposalPullRequest({
						...ids,
						expectedAttempt: item.attempt,
					});
				noteLimit(observed);
				if (observed.kind === "merged" && mayStart()) {
					await sweepActivities(
						budgetLeft(),
					).dispatchInstructionProposalMergeSync(ids);
				}
				return;
			}
			case "restart": {
				await now.dispatchInstructionProposalPullRequest(dispatchInput);
				return;
			}
		}
	};

	let next = 0;
	const lane = async (): Promise<void> => {
		while (next < queue.length) {
			if (!mayStart()) {
				result.outOfBudget += queue.length - next;
				next = queue.length;
				return;
			}
			const entry = queue[next++];
			if (!entry) {
				return;
			}
			if (isLimited(entry.item)) {
				result.rateLimited++;
				continue;
			}
			try {
				await act(entry.batch, entry.item);
				result.processed++;
			} catch (error) {
				result.failed++;
				log.warn(
					"Proposal pull-request sweep item failed; the next tick retries it",
					{
						batch: entry.batch,
						snapshotId: entry.item.snapshotId,
						error: errorName(error),
					},
				);
			}
		}
	};
	await Promise.all(
		Array.from({ length: PROPOSAL_SWEEP_CONCURRENCY }, () => lane()),
	);

	log.info("Proposal pull-request sweep finished", { ...result });
	return result;
}
