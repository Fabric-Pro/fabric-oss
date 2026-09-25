/**
 * Coding Instructions proposal pull request: one proposal's operation
 * workflow (Fizzy #2563 spec §6).
 *
 * Started once per operation, by admission, a human retry or the sweeper's
 * restart, with the id `instructionProposalPullRequestWorkflowId(operationId)`
 * and `workflowIdConflictPolicy: "FAIL"`, so a second start while one runs
 * is adoption, never a second opener. The workflow itself runs on
 * `project-instructions`; its activities run on `fabric-worker`, whose slots
 * the repository sync shares, so a clone or push never holds one of the two
 * upload-validation slots.
 *
 * 1. Readiness until `ready` or `stop`, sleeping 5, 10, 20, 40, then 60 s
 *    between `pending` answers. A 6 h clock runs from the start and restarts
 *    when the workflow observes a transition into FAILED (a FAILED answer
 *    after a different one; the snapshot has no status-change column, spec
 *    §4.4). When it runs out, one call carries `deadlineReached`, which
 *    writes BLOCKED `VALIDATION_TIMEOUT` for a row still pending and answers
 *    `stop`.
 * 2. Open, with the attempt readiness returned (plan Decision 7): the claim
 *    compares it under the row lock, so a Temporal retry after an earlier
 *    attempt claimed answers `not_claimable` and the run ends.
 * 3. On `close_requested`, close (settlement, spec §6.2).
 * 4. End. Observing an open pull request is the sweeper's.
 *
 * Every 200 readiness calls the run continues as new with the original
 * input and the readiness state (the clock's absolute deadline, whether the
 * last answer was FAILED, the sleep index), so a long validation keeps its
 * history bounded and resumes exactly where it stopped.
 *
 * `Date.now()` is workflow time inside the sandbox, so the clock replays
 * deterministically. Imports only the SDK, the pure proposal types, the task
 * queue constant and type-only activity signatures, as the workflow sandbox
 * requires.
 */
import { continueAsNew, proxyActivities, sleep } from "@temporalio/workflow";
import type * as proposalActivities from "../activities/instruction-proposal-pull-requests";
import {
	PROPOSAL_ACTIVITY_TIMEOUTS,
	PROPOSAL_READINESS_CALLS_PER_RUN,
	PROPOSAL_READINESS_SLEEPS_S,
	PROPOSAL_VALIDATION_CLOCK_MS,
	type ProposalOperationInput,
	type ProposalOperationWorkflowInput,
	type ProposalOperationWorkflowResult,
	type ProposalReadinessCarry,
} from "../lib/instruction-proposal-pull-request-types";
import { INSTRUCTION_SYNC_ACTIVITY_TASK_QUEUE } from "../task-queues";

/**
 * Spec §6: covers timeouts and worker loss. Every activity returns typed
 * outcomes and records its own failures, so a retry only follows a crash.
 */
const RETRY = {
	maximumAttempts: 3,
	initialInterval: "10 seconds",
	backoffCoefficient: 2,
} as const;

// Destructured, not read off the proxy object, so the activity-registration
// parity guard (`workflows/__tests__/activity-registration-parity.test.ts`)
// can see each name statically.
const { checkInstructionProposalReadiness } = proxyActivities<
	typeof proposalActivities
>({
	taskQueue: INSTRUCTION_SYNC_ACTIVITY_TASK_QUEUE,
	startToCloseTimeout: PROPOSAL_ACTIVITY_TIMEOUTS.readiness.startToCloseMs,
	retry: RETRY,
});

const { openInstructionProposalPullRequest } = proxyActivities<
	typeof proposalActivities
>({
	taskQueue: INSTRUCTION_SYNC_ACTIVITY_TASK_QUEUE,
	// Build, push and create; the activity heartbeats on a ticker, so the
	// heartbeat timeout detects a dead worker, not a slow push.
	startToCloseTimeout: PROPOSAL_ACTIVITY_TIMEOUTS.open.startToCloseMs,
	heartbeatTimeout: PROPOSAL_ACTIVITY_TIMEOUTS.open.heartbeatMs,
	retry: RETRY,
});

const { closeInstructionProposalPullRequest } = proxyActivities<
	typeof proposalActivities
>({
	taskQueue: INSTRUCTION_SYNC_ACTIVITY_TASK_QUEUE,
	// Settlement's longest documented sequence, heartbeating on a ticker;
	// the activity stops itself 10 s before the bound (spec §6).
	startToCloseTimeout: PROPOSAL_ACTIVITY_TIMEOUTS.close.startToCloseMs,
	heartbeatTimeout: PROPOSAL_ACTIVITY_TIMEOUTS.close.heartbeatMs,
	retry: RETRY,
});

function readinessSleepMs(pendingAnswers: number): number {
	const last = PROPOSAL_READINESS_SLEEPS_S.length - 1;
	return (
		(PROPOSAL_READINESS_SLEEPS_S[Math.min(pendingAnswers, last)] ?? 60) *
		1000
	);
}

/**
 * Step 1: the attempt a `ready` answer carried, or null once readiness
 * answered `stop` (including the deadline call's). A continued run resumes
 * from `carry`; after `PROPOSAL_READINESS_CALLS_PER_RUN` calls this run
 * continues as new.
 */
async function awaitReadiness(
	input: ProposalOperationInput,
	carry: ProposalReadinessCarry | undefined,
): Promise<number | null> {
	let deadline =
		carry?.deadlineMs ?? Date.now() + PROPOSAL_VALIDATION_CLOCK_MS;
	let wasFailed = carry?.wasFailed ?? false;
	for (
		let pendingAnswers = carry?.pendingAnswers ?? 0, calls = 0;
		;
		pendingAnswers++, calls++
	) {
		if (calls === PROPOSAL_READINESS_CALLS_PER_RUN) {
			await continueAsNew<
				typeof projectInstructionProposalPullRequestWorkflow
			>({
				...input,
				readiness: { deadlineMs: deadline, wasFailed, pendingAnswers },
			});
		}
		const deadlineReached = Date.now() >= deadline;
		const answer = await checkInstructionProposalReadiness({
			...input,
			deadlineReached,
		});
		if (answer.kind === "stop") {
			return null;
		}
		if (answer.kind === "ready") {
			return answer.attempt;
		}
		if (deadlineReached) {
			// The activity answers `stop` to a deadline call; never loop past it.
			return null;
		}
		if (answer.validationFailed && !wasFailed) {
			deadline = Date.now() + PROPOSAL_VALIDATION_CLOCK_MS;
		}
		wasFailed = answer.validationFailed;
		if (Date.now() < deadline) {
			await sleep(readinessSleepMs(pendingAnswers));
		}
	}
}

export async function projectInstructionProposalPullRequestWorkflow(
	workflowInput: ProposalOperationWorkflowInput,
): Promise<ProposalOperationWorkflowResult> {
	// The carry is the workflow's own; activities see the operation alone.
	const { readiness, ...input } = workflowInput;
	const attempt = await awaitReadiness(input, readiness);
	if (attempt === null) {
		return { readiness: "stop" };
	}
	const opened = await openInstructionProposalPullRequest({
		...input,
		expectedAttempt: attempt,
	});
	if (opened.kind !== "close_requested") {
		return { readiness: "ready", opened: opened.kind };
	}
	// The ids alone: close reads the attempt the cancel wrote, and a human
	// retry's `retryCreate` is the open's, never the close's.
	const closed = await closeInstructionProposalPullRequest({
		snapshotId: input.snapshotId,
		projectId: input.projectId,
		organizationId: input.organizationId,
		operationId: input.operationId,
	});
	return { readiness: "ready", opened: opened.kind, closed: closed.kind };
}
