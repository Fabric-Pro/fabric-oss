/**
 * Behavioural tests for `instructionProposalPullRequestSweepWorkflow`
 * (Fizzy #2563 spec §9) on a time-skipping test server, bundling the REAL
 * workflows barrel (which also proves registration). The sweeper's
 * activities name no task queue of their own, so they run on the workflow's
 * queue (`fabric-worker` under the schedule) and one worker serves both.
 *
 * The budget case advances server time from inside the activities with
 * `env.sleep`, as the repository poll's tests do; every sleep stays under
 * the activity's heartbeat timeout.
 *
 * Run with:
 *   pnpm --filter @repo/temporal test __tests__/instruction-proposal-pull-request-sweep.test.ts
 */
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import {
	bundleWorkflowCode,
	Worker,
	type WorkflowBundleWithSourceMap,
} from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type {
	AttachBranchInput,
	BranchAttachItem,
	BranchSweepItem,
	BranchSweepLimits,
	DueBranchSweep,
	ReconcileBranchInput,
	ReconcileBranchResult,
	WakeBranchInput,
} from "../src/activities/lib/instruction-branch-types";
import type {
	CloseProposalInput,
	CloseProposalResult,
	DispatchProposalInput,
	DispatchProposalResult,
	DueProposalSweep,
	MergeSyncDispatchResult,
	ProposalOperationInput,
	ProposalSweepItem,
	ProposalSweepLimits,
	ProposalSweepResult,
	ReconcileProposalInput,
	ReconcileProposalResult,
	RecoverProposalInput,
	RecoverProposalResult,
} from "../src/lib/instruction-proposal-pull-request-types";

const WORKFLOWS_PATH = resolve(__dirname, "..", "src", "workflows");
const WORKFLOW_NAME = "instructionProposalPullRequestSweepWorkflow";
const MINUTE_MS = 60 * 1000;
const ZERO: ProposalSweepResult = {
	selected: 0,
	processed: 0,
	deferred: 0,
	rateLimited: 0,
	outOfBudget: 0,
	failed: 0,
	selectFailed: false,
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

function item(
	id: string,
	overrides: Partial<ProposalSweepItem> = {},
): ProposalSweepItem {
	return {
		snapshotId: `snap_${id}`,
		projectId: "proj_1",
		organizationId: "org_1",
		operationId: `op_${id}`,
		attempt: 3,
		integrationId: "int_1",
		running: false,
		...overrides,
	};
}

function ids(row: ProposalSweepItem): ProposalOperationInput {
	return {
		snapshotId: row.snapshotId,
		projectId: row.projectId,
		organizationId: row.organizationId,
		operationId: row.operationId,
	};
}

function sweep(due: Partial<DueProposalSweep>): DueProposalSweep {
	return {
		close: [],
		recover: [],
		mergeSync: [],
		observe: [],
		restart: [],
		...due,
	};
}

/** The snapshot id an activity input names. */
const idOf = (input: { snapshotId: string }) => input.snapshotId;

function branchItem(
	id: string,
	overrides: Partial<BranchSweepItem> = {},
): BranchSweepItem {
	return {
		branchId: `branch_${id}`,
		projectId: "proj_1",
		organizationId: "org_1",
		attempt: 4,
		integrationId: "int_1",
		...overrides,
	};
}

function attachItem(id: string): BranchAttachItem {
	return {
		snapshotId: `snap_${id}`,
		projectId: "proj_1",
		organizationId: "org_1",
	};
}

function branchSweep(due: Partial<DueBranchSweep>): DueBranchSweep {
	return {
		close: [],
		recover: [],
		mergeSync: [],
		observe: [],
		restart: [],
		attach: [],
		...due,
	};
}

function sweepMocks(
	due:
		| DueProposalSweep
		| ((limits: ProposalSweepLimits) => Promise<DueProposalSweep>),
	overrides: Record<string, unknown> = {},
	branches: DueBranchSweep = branchSweep({}),
) {
	return {
		selectDueInstructionProposalOperations: vi.fn(
			async (limits: ProposalSweepLimits): Promise<DueProposalSweep> =>
				typeof due === "function" ? due(limits) : due,
		),
		// The member proposal branch sub-batches (Fizzy #2738 spec §8).
		selectDueInstructionProposalBranches: vi.fn(
			async (_limits: BranchSweepLimits): Promise<DueBranchSweep> =>
				branches,
		),
		wakeInstructionProposalBranch: vi.fn(
			async (_input: WakeBranchInput) => ({ woken: true }),
		),
		attachInstructionProposalToBranch: vi.fn(
			async (input: AttachBranchInput) => ({
				kind: "joined",
				branchId: `branch_for_${input.snapshotId}`,
			}),
		),
		reconcileInstructionProposalBranch: vi.fn(
			async (
				_input: ReconcileBranchInput,
			): Promise<ReconcileBranchResult> => ({
				state: "OPEN",
			}),
		),
		dispatchBranchMergeSync: vi.fn(async () => ({ outcome: "dispatched" })),
		closeInstructionProposalPullRequest: vi.fn(
			async (
				_input: CloseProposalInput,
			): Promise<CloseProposalResult> => ({
				kind: "closed",
			}),
		),
		recoverInstructionProposalPullRequest: vi.fn(
			async (
				_input: RecoverProposalInput,
			): Promise<RecoverProposalResult> => ({
				kind: "unchanged",
			}),
		),
		reconcileInstructionProposalPullRequest: vi.fn(
			async (
				_input: ReconcileProposalInput,
			): Promise<ReconcileProposalResult> => ({ kind: "open" }),
		),
		dispatchInstructionProposalMergeSync: vi.fn(
			async (
				_input: ProposalOperationInput,
			): Promise<MergeSyncDispatchResult> => ({
				kind: "dispatched",
			}),
		),
		dispatchInstructionProposalPullRequest: vi.fn(
			async (
				_input: DispatchProposalInput,
			): Promise<DispatchProposalResult> => ({
				kind: "started",
			}),
		),
		deferInstructionProposalOperation: vi.fn(
			async (_input: DispatchProposalInput) => ({ deferred: true }),
		),
		// Never the sweeper's to call: registered so that a call would be seen.
		openInstructionProposalPullRequest: vi.fn(async () => ({
			kind: "open",
		})),
		checkInstructionProposalReadiness: vi.fn(async () => ({
			kind: "stop",
		})),
		...overrides,
	};
}

let seq = 0;

async function run(
	activities: Record<string, unknown>,
): Promise<{ result: ProposalSweepResult; workflowId: string }> {
	const taskQueue = `instruction-proposal-sweep-${seq++}`;
	const workflowId = `${taskQueue}-wf`;
	const worker = await Worker.create({
		connection: env.nativeConnection,
		taskQueue,
		workflowBundle,
		activities,
	});
	const result = await worker.runUntil(
		env.client.workflow.execute(WORKFLOW_NAME, {
			args: [],
			taskQueue,
			workflowId,
		}),
	);
	return { result: result as ProposalSweepResult, workflowId };
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

async function scheduled(workflowId: string) {
	const history = await env.client.workflow
		.getHandle(workflowId)
		.fetchHistory();
	return (history.events ?? []).flatMap((event) => {
		const a = event.activityTaskScheduledEventAttributes;
		return a
			? [
					{
						type: a.activityType?.name ?? "",
						taskQueue: a.taskQueue?.name,
						startToClose: seconds(a.startToCloseTimeout),
						scheduleToClose: seconds(a.scheduleToCloseTimeout),
						heartbeat: seconds(a.heartbeatTimeout),
						retry: {
							initialInterval: seconds(
								a.retryPolicy?.initialInterval,
							),
							backoffCoefficient:
								a.retryPolicy?.backoffCoefficient,
							maximumAttempts: a.retryPolicy?.maximumAttempts,
						},
					},
				]
			: [];
	});
}

/** The tick's budget end, as ms after the run started (spec §9: 4 min). */
async function deadlineOffsetMs(
	workflowId: string,
	deadlineAt: string,
): Promise<number> {
	const history = await env.client.workflow
		.getHandle(workflowId)
		.fetchHistory();
	const started = history.events?.[0]?.eventTime;
	const startedMs = seconds(started as Duration) * 1000;
	return Date.parse(deadlineAt) - startedMs;
}

/** The patch ids a history's markers record (the SDK's `core_patch` markers). */
function patchMarkers(history: {
	events?: Array<{
		markerRecordedEventAttributes?: {
			markerName?: string | null;
			details?: Record<
				string,
				{ payloads?: Array<{ data?: Uint8Array | null }> | null }
			> | null;
		} | null;
	}> | null;
}): string[] {
	return (history.events ?? []).flatMap((event) => {
		const marker = event.markerRecordedEventAttributes;
		if (!marker) {
			return [];
		}
		const payloads = Object.values(marker.details ?? {}).flatMap(
			(detail) => detail.payloads ?? [],
		);
		return [
			`${marker.markerName}:${payloads
				.map((p) =>
					Buffer.from(p.data ?? new Uint8Array()).toString("utf8"),
				)
				.join(",")}`,
		];
	});
}

/**
 * The first argument of every scheduled activity of `type`, in the order
 * the workflow scheduled them (the history's, which is deterministic; the
 * order a worker runs concurrent activities in is not).
 */
async function scheduledInputs(
	workflowId: string,
	type: string,
): Promise<unknown[]> {
	const history = await env.client.workflow
		.getHandle(workflowId)
		.fetchHistory();
	return (history.events ?? []).flatMap((event) => {
		const a = event.activityTaskScheduledEventAttributes;
		if (!a || a.activityType?.name !== type) {
			return [];
		}
		const data = a.input?.payloads?.[0]?.data;
		return [
			JSON.parse(Buffer.from(data ?? new Uint8Array()).toString("utf8")),
		];
	});
}

async function expectReplays(workflowId: string): Promise<void> {
	const history = await env.client.workflow
		.getHandle(workflowId)
		.fetchHistory();
	await expect(
		Worker.runReplayHistory({ workflowBundle }, history, workflowId),
	).resolves.toBeUndefined();
}

describe("instructionProposalPullRequestSweepWorkflow (spec §9)", () => {
	it("selects with the spec's limits, then runs Close, Recover, Merge sync, Observe and Restart in that order", async () => {
		const due = sweep({
			close: [item("c")],
			recover: [item("r")],
			mergeSync: [item("m")],
			observe: [item("o")],
			restart: [item("s")],
		});
		const acts = sweepMocks(due);

		const { result, workflowId } = await run(acts);

		expect(
			acts.selectDueInstructionProposalOperations,
		).toHaveBeenCalledWith({
			close: 10,
			recover: 10,
			mergeSync: 10,
			observe: 20,
			restart: 10,
		});
		expect((await scheduled(workflowId)).map((a) => a.type)).toEqual([
			"selectDueInstructionProposalOperations",
			"selectDueInstructionProposalBranches",
			"closeInstructionProposalPullRequest",
			"recoverInstructionProposalPullRequest",
			"dispatchInstructionProposalMergeSync",
			"reconcileInstructionProposalPullRequest",
			"dispatchInstructionProposalPullRequest",
		]);
		const [c, r, m, o, s] = [
			item("c"),
			item("r"),
			item("m"),
			item("o"),
			item("s"),
		];
		// Every action carries the tick's one absolute deadline: the end of
		// its 4-minute budget, which the activity stops 10 s before.
		const deadlineAt = (
			acts.closeInstructionProposalPullRequest.mock.calls[0]?.[0] as {
				deadlineAt?: string;
			}
		).deadlineAt as string;
		const offset = await deadlineOffsetMs(workflowId, deadlineAt);
		expect(offset).toBeGreaterThanOrEqual(4 * MINUTE_MS);
		expect(offset).toBeLessThan(4 * MINUTE_MS + 2_000);
		expect(acts.closeInstructionProposalPullRequest).toHaveBeenCalledWith({
			...ids(c),
			expectedAttempt: 3,
			deadlineAt,
		});
		expect(acts.recoverInstructionProposalPullRequest).toHaveBeenCalledWith(
			{
				...ids(r),
				expectedAttempt: 3,
				deadlineAt,
			},
		);
		expect(acts.dispatchInstructionProposalMergeSync).toHaveBeenCalledWith({
			...ids(m),
			deadlineAt,
		});
		expect(
			acts.reconcileInstructionProposalPullRequest,
		).toHaveBeenCalledWith({
			...ids(o),
			expectedAttempt: 3,
			deadlineAt,
		});
		expect(
			acts.dispatchInstructionProposalPullRequest,
		).toHaveBeenCalledWith({
			...ids(s),
			attempt: 3,
			deadlineAt,
		});
		expect(result).toEqual({ ...ZERO, selected: 5, processed: 5 });
		await expectReplays(workflowId);
	}, 60_000);

	it("runs every call on the workflow's own queue with its spec §6 timeouts and heartbeat, retry 3 / 10 s / 2, inside the budget", async () => {
		const acts = sweepMocks(
			sweep({
				close: [item("c")],
				recover: [item("r")],
				mergeSync: [item("m")],
				observe: [item("o")],
				restart: [item("s"), item("x", { running: true })],
			}),
		);
		const { workflowId } = await run(acts);
		const calls = await scheduled(workflowId);
		// Declared start-to-close and heartbeat, in seconds. The server caps
		// a start-to-close at the call's schedule-to-close, the budget left.
		const declared: Record<string, [number, number]> = {
			selectDueInstructionProposalOperations: [60, 0],
			selectDueInstructionProposalBranches: [60, 0],
			closeInstructionProposalPullRequest: [10 * 60, 60],
			recoverInstructionProposalPullRequest: [5 * 60, 60],
			dispatchInstructionProposalMergeSync: [60, 30],
			reconcileInstructionProposalPullRequest: [3 * 60, 60],
			dispatchInstructionProposalPullRequest: [60, 30],
			deferInstructionProposalOperation: [60, 0],
		};
		expect(new Set(calls.map((call) => call.type))).toEqual(
			new Set(Object.keys(declared)),
		);
		for (const call of calls) {
			const [startToClose, heartbeat] = declared[call.type] ?? [0, 0];
			expect(call.startToClose).toBeCloseTo(
				Math.min(startToClose, call.scheduleToClose),
			);
			expect(call.heartbeat).toBe(heartbeat);
			expect(call.taskQueue).toMatch(/^instruction-proposal-sweep-/);
			expect(call.retry).toEqual({
				initialInterval: 10,
				backoffCoefficient: 2,
				maximumAttempts: 3,
			});
			expect(call.scheduleToClose).toBeGreaterThan(0);
			expect(call.scheduleToClose).toBeLessThanOrEqual(240);
		}
	}, 60_000);

	it("keeps at most four items in flight", async () => {
		let inFlight = 0;
		let most = 0;
		const acts = sweepMocks(
			sweep({
				restart: Array.from({ length: 10 }, (_, i) => item(`s${i}`)),
			}),
			{
				dispatchInstructionProposalPullRequest: vi.fn(async () => {
					inFlight++;
					most = Math.max(most, inFlight);
					await env.sleep(5_000);
					inFlight--;
					return { kind: "started" };
				}),
			},
		);
		const { result } = await run(acts);
		expect(most).toBe(4);
		expect(result).toEqual({ ...ZERO, selected: 10, processed: 10 });
	}, 60_000);

	it("starts nothing new with under 30 s of its 4-minute budget left", async () => {
		// Each item takes 25 s, inside the dispatch's 30 s heartbeat timeout
		// (server time moves under `env.sleep`, the SDK's heartbeat throttle
		// in real time, so a mock cannot heartbeat through a longer one):
		// every lane starts items at 0, 25, ... 200 s (40 s left, so the
		// call's schedule-to-close still fits it), and none at 225 s (15 s).
		const acts = sweepMocks(
			sweep({
				restart: Array.from({ length: 40 }, (_, i) => item(`s${i}`)),
			}),
			{
				dispatchInstructionProposalPullRequest: vi.fn(async () => {
					await env.sleep(25_000);
					return { kind: "started" };
				}),
			},
		);
		const { result } = await run(acts);
		expect(
			acts.dispatchInstructionProposalPullRequest,
		).toHaveBeenCalledTimes(36);
		expect(result).toEqual({
			...ZERO,
			selected: 40,
			processed: 36,
			outOfBudget: 4,
		});
	}, 120_000);

	it("skips a rate-limited integration's later items for the rest of the tick", async () => {
		// The first item answers with a rate limit at once; the three beside
		// it hold their lanes a little longer, so the first lane takes every
		// later item and must skip int_a's.
		const slow = async () => {
			await delay(500);
			return { kind: "closed" } as CloseProposalResult;
		};
		const acts = sweepMocks(
			sweep({
				close: [
					item("a1", { integrationId: "int_a" }),
					item("b1", { integrationId: "int_b" }),
					item("b2", { integrationId: "int_b" }),
					item("b3", { integrationId: "int_b" }),
				],
				mergeSync: [item("a4", { integrationId: "int_a" })],
				observe: [
					item("a2", { integrationId: "int_a" }),
					item("b4", { integrationId: "int_b" }),
				],
				restart: [
					item("a3", { integrationId: "int_a" }),
					item("n1", { integrationId: null }),
				],
			}),
			{
				closeInstructionProposalPullRequest: vi.fn(
					async (
						input: CloseProposalInput,
					): Promise<CloseProposalResult> =>
						input.snapshotId === "snap_a1"
							? {
									kind: "pending",
									rateLimitedIntegrationId: "int_a",
								}
							: slow(),
				),
			},
		);

		const { result } = await run(acts);

		expect(acts.closeInstructionProposalPullRequest).toHaveBeenCalledTimes(
			4,
		);
		expect(
			acts.reconcileInstructionProposalPullRequest.mock.calls.map(
				([input]) => idOf(input),
			),
		).toEqual(["snap_b4"]);
		expect(
			acts.dispatchInstructionProposalMergeSync,
		).not.toHaveBeenCalled();
		expect(
			acts.dispatchInstructionProposalPullRequest.mock.calls.map(
				([input]) => idOf(input),
			),
		).toEqual(["snap_n1"]);
		expect(result).toEqual({
			...ZERO,
			selected: 9,
			processed: 6,
			rateLimited: 3,
		});
	}, 60_000);

	it("hands Recover's absent_handoff to Restart's action, and its close_requested to close, in the same item", async () => {
		const answers: Record<string, RecoverProposalResult> = {
			snap_r1: { kind: "absent_handoff" },
			snap_r2: { kind: "close_requested" },
			snap_r3: { kind: "unchanged" },
		};
		const acts = sweepMocks(
			sweep({
				recover: [
					item("r1", { attempt: 5 }),
					item("r2", { attempt: 6, recoverClause: 1 }),
					item("r3"),
				],
			}),
			{
				recoverInstructionProposalPullRequest: vi.fn(
					async (input: RecoverProposalInput) =>
						answers[input.snapshotId] ?? { kind: "unchanged" },
				),
			},
		);

		const { result } = await run(acts);

		const deadlineAt = expect.any(String);
		expect(acts.dispatchInstructionProposalPullRequest.mock.calls).toEqual([
			[{ ...ids(item("r1")), attempt: 5, deadlineAt }],
		]);
		expect(acts.closeInstructionProposalPullRequest.mock.calls).toEqual([
			[{ ...ids(item("r2")), expectedAttempt: 6, deadlineAt }],
		]);
		expect(result).toEqual({ ...ZERO, selected: 3, processed: 3 });
	}, 60_000);

	it("dispatches the merge sync in the same item when Observe finds the pull request merged", async () => {
		const acts = sweepMocks(
			sweep({ observe: [item("o1"), item("o2"), item("o3")] }),
			{
				reconcileInstructionProposalPullRequest: vi.fn(
					async (
						input: ReconcileProposalInput,
					): Promise<ReconcileProposalResult> =>
						input.snapshotId === "snap_o1"
							? { kind: "merged" }
							: input.snapshotId === "snap_o2"
								? { kind: "closed" }
								: { kind: "open" },
				),
			},
		);
		await run(acts);
		expect(acts.dispatchInstructionProposalMergeSync.mock.calls).toEqual([
			[{ ...ids(item("o1")), deadlineAt: expect.any(String) }],
		]);
	}, 60_000);

	it("defers a row whose operation workflow is running, conditional on the attempt read at selection, and does nothing else with it", async () => {
		const running = { running: true, attempt: 8 };
		const acts = sweepMocks(
			sweep({
				close: [item("c", running)],
				recover: [item("r", running)],
				mergeSync: [item("m", running)],
				observe: [item("o", running)],
				restart: [item("s", running)],
			}),
		);
		const { result } = await run(acts);
		expect(
			acts.deferInstructionProposalOperation.mock.calls
				.map(([input]) => input)
				.sort((a, b) => a.snapshotId.localeCompare(b.snapshotId)),
		).toEqual(
			["c", "m", "o", "r", "s"].map((id) => ({
				...ids(item(id)),
				attempt: 8,
			})),
		);
		for (const name of [
			"closeInstructionProposalPullRequest",
			"recoverInstructionProposalPullRequest",
			"dispatchInstructionProposalMergeSync",
			"reconcileInstructionProposalPullRequest",
			"dispatchInstructionProposalPullRequest",
		] as const) {
			expect(acts[name]).not.toHaveBeenCalled();
		}
		expect(result).toEqual({
			...ZERO,
			selected: 5,
			processed: 5,
			deferred: 5,
		});
	}, 60_000);

	it("never settles or re-issues: close only for the Close sub-batch and Recover's close_requested, never retryCreate, never open", async () => {
		const recoverAnswers: Record<string, RecoverProposalResult> = {
			snap_r1: { kind: "blocked" },
			snap_r2: { kind: "failed" },
			snap_r3: { kind: "adopted" },
			snap_r4: { kind: "unchanged" },
		};
		const observeAnswers: Record<string, ReconcileProposalResult> = {
			snap_o1: { kind: "open" },
			snap_o2: { kind: "closed" },
			snap_o3: { kind: "failed" },
		};
		const acts = sweepMocks(
			sweep({
				// A due confirmation on a row that is not CLOSE_REQUESTED.
				close: [item("c1")],
				recover: [
					item("r1", { recoverClause: 1 }),
					item("r2", { recoverClause: 2 }),
					item("r3", { recoverClause: 1 }),
					item("r4", { recoverClause: 2 }),
				],
				mergeSync: [item("m1")],
				observe: [item("o1"), item("o2"), item("o3")],
				restart: [item("s1")],
			}),
			{
				recoverInstructionProposalPullRequest: vi.fn(
					async (input: RecoverProposalInput) =>
						recoverAnswers[input.snapshotId] ?? {
							kind: "unchanged",
						},
				),
				reconcileInstructionProposalPullRequest: vi.fn(
					async (input: ReconcileProposalInput) =>
						observeAnswers[input.snapshotId] ?? { kind: "open" },
				),
			},
		);

		const { workflowId } = await run(acts);

		expect(
			acts.closeInstructionProposalPullRequest.mock.calls.map(([input]) =>
				idOf(input),
			),
		).toEqual(["snap_c1"]);
		expect(acts.openInstructionProposalPullRequest).not.toHaveBeenCalled();
		expect(acts.checkInstructionProposalReadiness).not.toHaveBeenCalled();
		const history = await env.client.workflow
			.getHandle(workflowId)
			.fetchHistory();
		expect(JSON.stringify(history)).not.toContain("retryCreate");
		expect(
			new Set((await scheduled(workflowId)).map((a) => a.type)),
		).toEqual(
			new Set([
				"selectDueInstructionProposalOperations",
				"selectDueInstructionProposalBranches",
				"closeInstructionProposalPullRequest",
				"recoverInstructionProposalPullRequest",
				"dispatchInstructionProposalMergeSync",
				"reconcileInstructionProposalPullRequest",
				"dispatchInstructionProposalPullRequest",
			]),
		);
	}, 60_000);

	it("Observe visits every OPEN row within N ticks for 3N rows (limit 20, 60 rows, 3 ticks)", async () => {
		// A model of the Observe selection (spec §9): OPEN rows last checked
		// 10 min ago or never, oldest first, then by id, up to the limit; a
		// reconcile stamps the row's check time.
		const rows = Array.from({ length: 60 }, (_, i) => ({
			id: `o${String(i).padStart(2, "0")}`,
			lastCheckedAt: null as number | null,
		}));
		const visits: string[] = [];
		const acts = sweepMocks(
			async (limits) => {
				const now = await env.currentTimeMs();
				const due = rows
					.filter(
						(row) =>
							row.lastCheckedAt === null ||
							now - row.lastCheckedAt >= 10 * MINUTE_MS,
					)
					.sort(
						(a, b) =>
							(a.lastCheckedAt ?? -1) - (b.lastCheckedAt ?? -1) ||
							a.id.localeCompare(b.id),
					)
					.slice(0, limits.observe);
				return sweep({ observe: due.map((row) => item(row.id)) });
			},
			{
				reconcileInstructionProposalPullRequest: vi.fn(
					async (
						input: ReconcileProposalInput,
					): Promise<ReconcileProposalResult> => {
						const row = rows.find(
							(r) => `snap_${r.id}` === input.snapshotId,
						);
						if (row) {
							row.lastCheckedAt = await env.currentTimeMs();
							visits.push(row.id);
						}
						return { kind: "open" };
					},
				),
			},
		);

		for (let tick = 0; tick < 3; tick++) {
			const { result } = await run(acts);
			expect(result).toEqual({ ...ZERO, selected: 20, processed: 20 });
			await env.sleep(5 * MINUTE_MS);
		}

		expect(visits).toHaveLength(60);
		expect(new Set(visits)).toEqual(new Set(rows.map((row) => row.id)));
	}, 120_000);

	it("counts an item whose activity keeps throwing as failed after three attempts, and carries on", async () => {
		const acts = sweepMocks(sweep({ observe: [item("o1"), item("o2")] }), {
			reconcileInstructionProposalPullRequest: vi.fn(
				async (
					input: ReconcileProposalInput,
				): Promise<ReconcileProposalResult> => {
					if (input.snapshotId === "snap_o1") {
						throw new Error("provider exploded");
					}
					return { kind: "open" };
				},
			),
		});
		const { result } = await run(acts);
		expect(
			acts.reconcileInstructionProposalPullRequest.mock.calls.filter(
				([input]) => input.snapshotId === "snap_o1",
			),
		).toHaveLength(3);
		expect(result).toEqual({
			...ZERO,
			selected: 2,
			processed: 1,
			failed: 1,
		});
	}, 60_000);

	it("ends the tick when the selection keeps failing", async () => {
		const acts = sweepMocks(sweep({}), {
			selectDueInstructionProposalOperations: vi.fn(async () => {
				throw new Error("database unavailable");
			}),
		});
		const { result } = await run(acts);
		expect(
			acts.selectDueInstructionProposalOperations,
		).toHaveBeenCalledTimes(3);
		expect(result).toEqual({ ...ZERO, selectFailed: true });
	}, 60_000);
	// -----------------------------------------------------------------------
	// Member proposal branches (Fizzy #2738 spec §8), behind
	// `patched("instruction-proposal-branch-sweep-v1")`
	// -----------------------------------------------------------------------

	it("selects the branch rows after #2563's, with their limits, and runs each sub-batch's branch rows after its #2563 rows, Attach last", async () => {
		const acts = sweepMocks(
			sweep({
				close: [item("c")],
				recover: [item("r")],
				mergeSync: [item("m")],
				observe: [item("o")],
				restart: [item("s")],
			}),
			{},
			branchSweep({
				close: [branchItem("c")],
				recover: [branchItem("r")],
				mergeSync: [branchItem("m")],
				observe: [branchItem("o")],
				restart: [branchItem("s")],
				attach: [attachItem("a")],
			}),
		);
		const { result, workflowId } = await run(acts);
		expect(acts.selectDueInstructionProposalBranches).toHaveBeenCalledWith({
			close: 10,
			recover: 10,
			mergeSync: 10,
			observe: 20,
			restart: 10,
			attach: 10,
		});
		// One lane at a time would show the exact queue; four lanes start
		// the first four in queue order, so the order of scheduling is the
		// queue's.
		expect((await scheduled(workflowId)).map((a) => a.type)).toEqual([
			"selectDueInstructionProposalOperations",
			"selectDueInstructionProposalBranches",
			"closeInstructionProposalPullRequest",
			"wakeInstructionProposalBranch",
			"recoverInstructionProposalPullRequest",
			"wakeInstructionProposalBranch",
			"dispatchInstructionProposalMergeSync",
			"dispatchBranchMergeSync",
			"reconcileInstructionProposalPullRequest",
			"reconcileInstructionProposalBranch",
			"dispatchInstructionProposalPullRequest",
			"wakeInstructionProposalBranch",
			"attachInstructionProposalToBranch",
		]);
		const deadlineAt = expect.any(String);
		const wake = (id: string) => ({
			branchId: `branch_${id}`,
			projectId: "proj_1",
			organizationId: "org_1",
			deadlineAt,
		});
		// Close's, Recover's, then Restart's, as scheduled.
		expect(
			await scheduledInputs(workflowId, "wakeInstructionProposalBranch"),
		).toEqual([wake("c"), wake("r"), wake("s")]);
		expect(acts.wakeInstructionProposalBranch).toHaveBeenCalledTimes(3);
		expect(acts.dispatchBranchMergeSync).toHaveBeenCalledWith({
			branchId: "branch_m",
			organizationId: "org_1",
			deadlineAt,
		});
		expect(acts.reconcileInstructionProposalBranch).toHaveBeenCalledWith({
			branchId: "branch_o",
			organizationId: "org_1",
			expectedAttempt: 4,
			deadlineAt,
		});
		expect(acts.attachInstructionProposalToBranch).toHaveBeenCalledWith({
			...attachItem("a"),
			deadlineAt,
		});
		expect(result).toEqual({ ...ZERO, selected: 11, processed: 11 });
		await expectReplays(workflowId);
	}, 60_000);

	it("Observe wakes a branch whose pull request ended, so its workflow classifies it; an open one is not woken", async () => {
		const states: Record<string, ReconcileBranchResult["state"]> = {
			branch_o1: "MERGED",
			branch_o2: "CLOSED",
			branch_o3: "OPEN",
		};
		const acts = sweepMocks(
			sweep({}),
			{
				reconcileInstructionProposalBranch: vi.fn(
					async (input: ReconcileBranchInput) => ({
						state: states[input.branchId] ?? "OPEN",
					}),
				),
			},
			branchSweep({
				observe: [branchItem("o1"), branchItem("o2"), branchItem("o3")],
			}),
		);
		const { result } = await run(acts);
		expect(
			acts.wakeInstructionProposalBranch.mock.calls
				.map(([i]) => i.branchId)
				.sort(),
		).toEqual(["branch_o1", "branch_o2"]);
		expect(acts.dispatchBranchMergeSync).not.toHaveBeenCalled();
		expect(result).toEqual({ ...ZERO, selected: 3, processed: 3 });
	}, 60_000);

	it("never writes git for a branch: only wake, reconcile, merge sync and attach, never a branch workflow activity", async () => {
		const forbidden = {
			appendBranchProposal: vi.fn(),
			revertBranchProposal: vi.fn(),
			settleBranch: vi.fn(),
			createBranchPullRequest: vi.fn(),
			releaseBranch: vi.fn(),
			classifyBranch: vi.fn(),
		};
		const acts = sweepMocks(
			sweep({}),
			forbidden,
			branchSweep({
				close: [branchItem("c")],
				recover: [branchItem("r")],
				restart: [branchItem("s")],
			}),
		);
		await run(acts);
		for (const fn of Object.values(forbidden)) {
			expect(fn).not.toHaveBeenCalled();
		}
		expect(acts.wakeInstructionProposalBranch).toHaveBeenCalledTimes(3);
	}, 60_000);

	it("skips a rate-limited integration's branch rows too, and runs Attach, which names no integration", async () => {
		const acts = sweepMocks(
			sweep({ close: [item("a1", { integrationId: "int_a" })] }),
			{
				closeInstructionProposalPullRequest: vi.fn(async () => ({
					kind: "pending",
					rateLimitedIntegrationId: "int_a",
				})),
				wakeInstructionProposalBranch: vi.fn(async () => {
					await delay(300);
					return { woken: true };
				}),
			},
			branchSweep({
				recover: [
					branchItem("x", { integrationId: "int_b" }),
					branchItem("y", { integrationId: "int_b" }),
					branchItem("z", { integrationId: "int_b" }),
				],
				restart: [branchItem("a2", { integrationId: "int_a" })],
				attach: [attachItem("n")],
			}),
		);
		const { result } = await run(acts);
		expect(
			acts.wakeInstructionProposalBranch.mock.calls.map(
				([i]) => i.branchId,
			),
		).not.toContain("branch_a2");
		expect(acts.attachInstructionProposalToBranch).toHaveBeenCalledTimes(1);
		expect(result).toEqual({
			...ZERO,
			selected: 6,
			processed: 5,
			rateLimited: 1,
		});
	}, 60_000);

	it("a branch selection that keeps failing leaves #2563's rows to run", async () => {
		const acts = sweepMocks(sweep({ restart: [item("s")] }), {
			selectDueInstructionProposalBranches: vi.fn(async () => {
				throw new Error("database unavailable");
			}),
		});
		const { result } = await run(acts);
		expect(acts.selectDueInstructionProposalBranches).toHaveBeenCalledTimes(
			3,
		);
		expect(
			acts.dispatchInstructionProposalPullRequest,
		).toHaveBeenCalledTimes(1);
		expect(result).toEqual({ ...ZERO, selected: 1, processed: 1 });
	}, 60_000);

	it("replays a tick recorded before the patch on the pre-patch path: no marker, no branch selection", async () => {
		const legacyBundle = await bundleWorkflowCode({
			workflowsPath: resolve(
				__dirname,
				"helpers",
				"legacy-proposal-sweep",
			),
		});
		const acts = sweepMocks(
			sweep({
				close: [item("c")],
				recover: [item("r")],
				mergeSync: [item("m")],
				observe: [item("o")],
				restart: [item("s")],
			}),
			{},
			branchSweep({ restart: [branchItem("never")] }),
		);
		const taskQueue = `instruction-proposal-sweep-${seq++}`;
		const workflowId = `${taskQueue}-legacy`;
		const worker = await Worker.create({
			connection: env.nativeConnection,
			taskQueue,
			workflowBundle: legacyBundle,
			activities: acts,
		});
		await worker.runUntil(
			env.client.workflow.execute(WORKFLOW_NAME, {
				args: [],
				taskQueue,
				workflowId,
			}),
		);
		const history = await env.client.workflow
			.getHandle(workflowId)
			.fetchHistory();
		expect(patchMarkers(history)).toEqual([]);
		expect(
			acts.selectDueInstructionProposalBranches,
		).not.toHaveBeenCalled();
		// The current workflow replays it: `patched` answers false on a
		// history without the marker, so it schedules exactly what the
		// legacy tick did.
		await expect(
			Worker.runReplayHistory({ workflowBundle }, history, workflowId),
		).resolves.toBeUndefined();
	}, 120_000);

	it("records the patch marker on a new tick, and its history replays", async () => {
		const acts = sweepMocks(sweep({}), {}, branchSweep({}));
		const { workflowId } = await run(acts);
		const history = await env.client.workflow
			.getHandle(workflowId)
			.fetchHistory();
		const markers = patchMarkers(history);
		expect(markers).toHaveLength(1);
		expect(markers[0]).toContain("instruction-proposal-branch-sweep-v1");
		await expectReplays(workflowId);
	}, 60_000);
});
