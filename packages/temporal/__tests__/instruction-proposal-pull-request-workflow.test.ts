/**
 * Behavioural tests for `projectInstructionProposalPullRequestWorkflow`
 * (Fizzy #2563 spec §6) on a time-skipping test server, bundling the REAL
 * workflows barrel (which also proves registration). The workflow runs on
 * the test's own queue; its activities run on the queue it routes them to,
 * `fabric-worker`, served by a second worker.
 *
 * Timings are read from the test server's clock inside the activities, so
 * the readiness sleeps and the 6 h validation clock are asserted in server
 * time. Each run's own history is replayed against the bundle at the end of
 * the timing cases, as the poll workflow's tests do.
 *
 * Run with:
 *   pnpm --filter @repo/temporal test __tests__/instruction-proposal-pull-request-workflow.test.ts
 */
import { resolve } from "node:path";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import {
	bundleWorkflowCode,
	Worker,
	type WorkflowBundleWithSourceMap,
} from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type {
	CloseProposalInput,
	CloseProposalResult,
	OpenProposalOperationInput,
	OpenProposalResult,
	ProposalOperationInput,
	ProposalOperationWorkflowResult,
	ProposalReadinessInput,
	ProposalReadinessResult,
} from "../src/lib/instruction-proposal-pull-request-types";
import { INSTRUCTION_SYNC_ACTIVITY_TASK_QUEUE } from "../src/task-queues";

const WORKFLOWS_PATH = resolve(__dirname, "..", "src", "workflows");
const WORKFLOW_NAME = "projectInstructionProposalPullRequestWorkflow";
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const INPUT: ProposalOperationInput = {
	snapshotId: "snap_1",
	projectId: "proj_1",
	organizationId: "org_1",
	operationId: "op_1",
};

let env: TestWorkflowEnvironment;
let workflowBundle: WorkflowBundleWithSourceMap;

beforeAll(async () => {
	env = await TestWorkflowEnvironment.createTimeSkipping();
	workflowBundle = await bundleWorkflowCode({
		workflowsPath: WORKFLOWS_PATH,
	});
}, 120_000);

afterAll(async () => {
	await env?.teardown();
});

type ReadinessCall = { at: number; input: ProposalReadinessInput };

/**
 * A readiness activity that records each call's server time and answers
 * from `answer`, given the milliseconds since its first call. A call that
 * carries `deadlineReached` answers `stop`, as the real activity does once
 * it has written BLOCKED `VALIDATION_TIMEOUT`.
 */
function readiness(answer: (elapsedMs: number) => ProposalReadinessResult) {
	const calls: ReadinessCall[] = [];
	const fn = vi.fn(
		async (
			input: ProposalReadinessInput,
		): Promise<ProposalReadinessResult> => {
			const at = await env.currentTimeMs();
			calls.push({ at, input });
			if (input.deadlineReached) {
				return { kind: "stop" };
			}
			return answer(at - (calls[0]?.at ?? at));
		},
	);
	return { fn, calls };
}

/** A readiness activity that answers from a fixed list, repeating the last. */
function answers(...list: ProposalReadinessResult[]) {
	let n = 0;
	return readiness(() => {
		const next = list[Math.min(n, list.length - 1)];
		n++;
		if (!next) {
			throw new Error("no readiness answer");
		}
		return next;
	});
}

const pending = (validationFailed = false): ProposalReadinessResult => ({
	kind: "pending",
	validationFailed,
});

function mocks(
	check: ReturnType<typeof readiness>["fn"],
	opened: OpenProposalResult["kind"] = "open",
	closed: CloseProposalResult["kind"] = "closed",
) {
	return {
		checkInstructionProposalReadiness: check,
		openInstructionProposalPullRequest: vi.fn(
			async (
				_input: OpenProposalOperationInput,
			): Promise<OpenProposalResult> => ({
				kind: opened,
			}),
		),
		closeInstructionProposalPullRequest: vi.fn(
			async (
				_input: CloseProposalInput,
			): Promise<CloseProposalResult> => ({
				kind: closed,
			}),
		),
	};
}

let seq = 0;

async function run(
	activities: Record<string, unknown>,
	input: ProposalOperationInput = INPUT,
): Promise<{
	result: ProposalOperationWorkflowResult;
	workflowId: string;
	firstRunId: string;
}> {
	const taskQueue = `instruction-proposal-${seq++}`;
	const workflowId = `${taskQueue}-wf`;
	const workflowWorker = await Worker.create({
		connection: env.nativeConnection,
		taskQueue,
		workflowBundle,
	});
	const activityWorker = await Worker.create({
		connection: env.nativeConnection,
		taskQueue: INSTRUCTION_SYNC_ACTIVITY_TASK_QUEUE,
		activities,
	});
	const handle = await env.client.workflow.start(WORKFLOW_NAME, {
		args: [input],
		taskQueue,
		workflowId,
	});
	// `result()` follows a continue-as-new to the last run's result.
	const result = await workflowWorker.runUntil(
		activityWorker.runUntil(handle.result()),
	);
	return {
		result: result as ProposalOperationWorkflowResult,
		workflowId,
		firstRunId: handle.firstExecutionRunId,
	};
}

/** Replays a run's own history (the latest run unless named) against the current bundle. */
async function expectReplays(
	workflowId: string,
	runId?: string,
): Promise<void> {
	const history = await env.client.workflow
		.getHandle(workflowId, runId)
		.fetchHistory();
	await expect(
		Worker.runReplayHistory({ workflowBundle }, history, workflowId),
	).resolves.toBeUndefined();
}

type Duration = { seconds?: unknown; nanos?: number | null } | null | undefined;

function seconds(duration: Duration): number {
	if (!duration) {
		return 0;
	}
	const whole = duration.seconds as
		| { toNumber?: () => number }
		| number
		| string
		| null
		| undefined;
	const value =
		typeof whole === "object" && whole !== null && whole.toNumber
			? whole.toNumber()
			: Number(whole ?? 0);
	return value + (duration.nanos ?? 0) / 1e9;
}

/** Each scheduled activity's type, queue, timeouts and retry policy. */
async function scheduled(workflowId: string) {
	const history = await env.client.workflow
		.getHandle(workflowId)
		.fetchHistory();
	return (history.events ?? []).flatMap((event) => {
		const a = event.activityTaskScheduledEventAttributes;
		if (!a) {
			return [];
		}
		return [
			{
				type: a.activityType?.name,
				taskQueue: a.taskQueue?.name,
				startToClose: seconds(a.startToCloseTimeout),
				heartbeat: seconds(a.heartbeatTimeout),
				retry: {
					initialInterval: seconds(a.retryPolicy?.initialInterval),
					backoffCoefficient: a.retryPolicy?.backoffCoefficient,
					maximumAttempts: a.retryPolicy?.maximumAttempts,
				},
			},
		];
	});
}

describe("projectInstructionProposalPullRequestWorkflow (spec §6)", () => {
	it("sleeps 5, 10, 20, 40, 60, 60 s between pending answers, then opens with the attempt readiness returned", async () => {
		const check = answers(
			pending(),
			pending(),
			pending(),
			pending(),
			pending(),
			pending(),
			pending(),
			{ kind: "ready", attempt: 7 },
		);
		const acts = mocks(check.fn);

		const { result, workflowId } = await run(acts);

		const gaps = check.calls
			.slice(1)
			.map((call, i) =>
				Math.round((call.at - (check.calls[i]?.at ?? 0)) / 1000),
			);
		expect(gaps).toEqual([5, 10, 20, 40, 60, 60, 60]);
		expect(
			check.calls.every((call) => call.input.deadlineReached === false),
		).toBe(true);
		expect(acts.openInstructionProposalPullRequest).toHaveBeenCalledTimes(
			1,
		);
		expect(acts.openInstructionProposalPullRequest).toHaveBeenCalledWith({
			...INPUT,
			expectedAttempt: 7,
		});
		expect(acts.closeInstructionProposalPullRequest).not.toHaveBeenCalled();
		expect(result).toEqual({ readiness: "ready", opened: "open" });
		await expectReplays(workflowId);
	}, 60_000);

	it("ends without opening when readiness answers stop", async () => {
		const acts = mocks(answers({ kind: "stop" }).fn);
		const { result } = await run(acts);
		expect(result).toEqual({ readiness: "stop" });
		expect(acts.openInstructionProposalPullRequest).not.toHaveBeenCalled();
		expect(acts.closeInstructionProposalPullRequest).not.toHaveBeenCalled();
	}, 60_000);

	it("runs close, with the ids alone, when open answers close_requested", async () => {
		const acts = mocks(
			answers({ kind: "ready", attempt: 2 }).fn,
			"close_requested",
			"canceled",
		);
		const { result } = await run(acts);
		expect(acts.closeInstructionProposalPullRequest).toHaveBeenCalledTimes(
			1,
		);
		// No expectedAttempt: close reads the attempt the cancel wrote.
		expect(acts.closeInstructionProposalPullRequest).toHaveBeenCalledWith(
			INPUT,
		);
		expect(result).toEqual({
			readiness: "ready",
			opened: "close_requested",
			closed: "canceled",
		});
	}, 60_000);

	it("ends on a not_claimable answer without a second open or a close", async () => {
		const acts = mocks(
			answers({ kind: "ready", attempt: 4 }).fn,
			"not_claimable",
		);
		const { result } = await run(acts);
		expect(acts.openInstructionProposalPullRequest).toHaveBeenCalledTimes(
			1,
		);
		expect(acts.closeInstructionProposalPullRequest).not.toHaveBeenCalled();
		expect(result).toEqual({ readiness: "ready", opened: "not_claimable" });
	}, 60_000);

	it("passes a human retry's retryCreate through to open, beside the attempt readiness returned", async () => {
		const acts = mocks(answers({ kind: "ready", attempt: 9 }).fn);
		const input = { ...INPUT, retryCreate: { expectedAttempt: 8 } };
		await run(acts, input);
		expect(acts.openInstructionProposalPullRequest).toHaveBeenCalledWith({
			...input,
			expectedAttempt: 9,
		});
	}, 60_000);

	it("at the 6 h deadline sends one call with deadlineReached, and ends there", async () => {
		const check = readiness(() => pending());
		const acts = mocks(check.fn);

		const { result, workflowId } = await run(acts);

		const last = check.calls.at(-1);
		const first = check.calls[0];
		expect(last?.input.deadlineReached).toBe(true);
		expect(
			check.calls.filter((call) => call.input.deadlineReached),
		).toHaveLength(1);
		const elapsed = (last?.at ?? 0) - (first?.at ?? 0);
		expect(elapsed).toBeGreaterThanOrEqual(6 * HOUR_MS);
		expect(elapsed).toBeLessThanOrEqual(6 * HOUR_MS + 61_000);
		expect(acts.openInstructionProposalPullRequest).not.toHaveBeenCalled();
		expect(result).toEqual({ readiness: "stop" });
		await expectReplays(workflowId);
	}, 180_000);

	it("restarts the 6 h clock on a transition into FAILED only, not on repeated FAILED answers", async () => {
		// pending, then FAILED for ten minutes, pending again, FAILED again for
		// ten minutes, then pending. Only the two transitions into FAILED
		// restart the clock, so the deadline is 6 h after the second; were
		// every FAILED answer a restart it would be 6 h after the last one,
		// and were only the first a restart, 6 h after that.
		const check = readiness((elapsed) =>
			pending(
				(elapsed >= 10 * MINUTE_MS && elapsed < 20 * MINUTE_MS) ||
					(elapsed >= 30 * MINUTE_MS && elapsed < 40 * MINUTE_MS),
			),
		);
		const acts = mocks(check.fn);

		await run(acts);

		const first = check.calls[0]?.at ?? 0;
		const secondTransition = check.calls.find(
			(call) => call.at - first >= 30 * MINUTE_MS,
		);
		const deadlineCall = check.calls.find(
			(call) => call.input.deadlineReached,
		);
		expect(secondTransition).toBeDefined();
		expect(deadlineCall).toBe(check.calls.at(-1));
		const sinceTransition =
			(deadlineCall?.at ?? 0) - (secondTransition?.at ?? 0);
		expect(sinceTransition).toBeGreaterThanOrEqual(6 * HOUR_MS - 1_000);
		expect(sinceTransition).toBeLessThanOrEqual(6 * HOUR_MS + 61_000);
		expect(acts.openInstructionProposalPullRequest).not.toHaveBeenCalled();
	}, 180_000);

	/** A run's readiness calls, and how it ended: continued as new (with its next input) or completed. */
	async function runSummary(workflowId: string, runId?: string) {
		const history = await env.client.workflow
			.getHandle(workflowId, runId)
			.fetchHistory();
		const events = history.events ?? [];
		const readinessCalls = events.filter(
			(event) =>
				event.activityTaskScheduledEventAttributes?.activityType
					?.name === "checkInstructionProposalReadiness",
		).length;
		const continued =
			events.at(-1)?.workflowExecutionContinuedAsNewEventAttributes;
		const next = continued
			? await env.client.options.loadedDataConverter.payloadConverter.fromPayload(
					continued.input?.payloads?.[0] ?? {},
				)
			: null;
		return { readinessCalls, continued: Boolean(continued), next };
	}

	it("continues as new after 200 readiness calls, carrying the input, the sleep index and the clock, then opens", async () => {
		const input = { ...INPUT, retryCreate: { expectedAttempt: 8 } };
		const check = answers(...Array.from({ length: 205 }, () => pending()), {
			kind: "ready",
			attempt: 9,
		});
		const acts = mocks(check.fn);

		const { result, workflowId, firstRunId } = await run(acts, input);

		const first = await runSummary(workflowId, firstRunId);
		expect(first.readinessCalls).toBe(200);
		expect(first.continued).toBe(true);
		const clockStart = check.calls[0]?.at ?? 0;
		expect(first.next).toEqual({
			...input,
			readiness: {
				deadlineMs: expect.any(Number),
				wasFailed: false,
				pendingAnswers: 200,
			},
		});
		const carried = (first.next as { readiness: { deadlineMs: number } })
			.readiness.deadlineMs;
		expect(carried - clockStart).toBeGreaterThanOrEqual(
			6 * HOUR_MS - 1_000,
		);
		expect(carried - clockStart).toBeLessThanOrEqual(6 * HOUR_MS);
		const last = await runSummary(workflowId);
		expect(last.readinessCalls).toBe(6);
		expect(last.continued).toBe(false);

		// The sleeps keep their place across the boundary: 60 s, not 5 s.
		const gaps = check.calls
			.slice(1)
			.map((call, i) =>
				Math.round((call.at - (check.calls[i]?.at ?? 0)) / 1000),
			);
		expect(gaps.slice(0, 5)).toEqual([5, 10, 20, 40, 60]);
		expect(gaps.slice(198, 202)).toEqual([60, 60, 60, 60]);
		expect(
			check.calls.every(
				(call) =>
					call.input.deadlineReached === false &&
					!("readiness" in call.input),
			),
		).toBe(true);
		expect(acts.openInstructionProposalPullRequest).toHaveBeenCalledWith({
			...input,
			expectedAttempt: 9,
		});
		expect(result).toEqual({ readiness: "ready", opened: "open" });
		await expectReplays(workflowId, firstRunId);
		await expectReplays(workflowId);
	}, 180_000);

	it("keeps the 6 h clock and the FAILED flag across the boundary: a FAILED answer after it is no new transition", async () => {
		// FAILED from the first answer: the clock (re)starts there once. Were
		// the flag or the deadline lost at the continue, the next run's first
		// FAILED answer would restart it, about 3 h 20 min later.
		const check = readiness(() => pending(true));
		const acts = mocks(check.fn);

		const { result, workflowId, firstRunId } = await run(acts);

		const first = await runSummary(workflowId, firstRunId);
		expect(first.continued).toBe(true);
		expect(first.next).toMatchObject({
			readiness: { wasFailed: true, pendingAnswers: 200 },
		});
		const deadlineCall = check.calls.find(
			(call) => call.input.deadlineReached,
		);
		expect(deadlineCall).toBe(check.calls.at(-1));
		const elapsed = (deadlineCall?.at ?? 0) - (check.calls[0]?.at ?? 0);
		expect(check.calls.length).toBeGreaterThan(200);
		expect(elapsed).toBeGreaterThanOrEqual(6 * HOUR_MS - 1_000);
		expect(elapsed).toBeLessThanOrEqual(6 * HOUR_MS + 61_000);
		expect(result).toEqual({ readiness: "stop" });
		await expectReplays(workflowId, firstRunId);
		await expectReplays(workflowId);
	}, 180_000);

	it("routes its activities to fabric-worker with the spec's timeouts and retry policy", async () => {
		const acts = mocks(
			answers(pending(), { kind: "ready", attempt: 1 }).fn,
			"close_requested",
		);
		const { workflowId } = await run(acts);

		const retry = {
			initialInterval: 10,
			backoffCoefficient: 2,
			maximumAttempts: 3,
		};
		const byType = new Map(
			(await scheduled(workflowId)).map((a) => [a.type, a]),
		);
		expect(byType.get("checkInstructionProposalReadiness")).toMatchObject({
			taskQueue: "fabric-worker",
			startToClose: 30,
			retry,
		});
		expect(byType.get("openInstructionProposalPullRequest")).toEqual({
			type: "openInstructionProposalPullRequest",
			taskQueue: "fabric-worker",
			startToClose: 15 * 60,
			heartbeat: 60,
			retry,
		});
		// Settlement's longest documented sequence runs past 60 s; the
		// activity heartbeats on a ticker and stops itself 10 s early.
		expect(byType.get("closeInstructionProposalPullRequest")).toEqual({
			type: "closeInstructionProposalPullRequest",
			taskQueue: "fabric-worker",
			startToClose: 10 * 60,
			heartbeat: 60,
			retry,
		});
	}, 60_000);
});
