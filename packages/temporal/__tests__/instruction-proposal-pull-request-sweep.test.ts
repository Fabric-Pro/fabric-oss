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

function sweepMocks(
	due:
		| DueProposalSweep
		| ((limits: ProposalSweepLimits) => Promise<DueProposalSweep>),
	overrides: Record<string, unknown> = {},
) {
	return {
		selectDueInstructionProposalOperations: vi.fn(
			async (limits: ProposalSweepLimits): Promise<DueProposalSweep> =>
				typeof due === "function" ? due(limits) : due,
		),
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
});
