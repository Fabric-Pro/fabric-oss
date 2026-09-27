/**
 * Behavioural tests for `instructionProposalPullRequestSweepWorkflow`
 * (Fizzy #2563 spec §9, member proposal branches Fizzy #2738 spec §8) on a
 * time-skipping test server, bundling the REAL workflows barrel (which also
 * proves registration). The sweeper's activities name no task queue of
 * their own, so they run on the workflow's queue (`fabric-worker` under the
 * schedule) and one worker serves both.
 *
 * A new tick selects and runs the member proposal branch rows only: the
 * #2563 (v1) operation lane was retired behind
 * `patched("instruction-proposal-v1-lane-removed")` (Fizzy #2748). That
 * lane's code stays in the workflow for one reason, replay: the last block
 * records ticks with two frozen copies of the workflow (before the branch
 * rows, and origin/master before the lane's removal) and replays each on
 * the current one, command for command.
 *
 * The budget cases advance server time from inside the activities with
 * `env.sleep`, as the repository poll's tests do; every sleep stays under
 * the activity's heartbeat timeout.
 *
 * Run with (from packages/temporal):
 *   pnpm exec vitest run __tests__/instruction-proposal-pull-request-sweep.test.ts
 */
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ApplicationFailure } from "@temporalio/activity";
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
import {
	BRANCH_SWEEP_PATCH,
	V1_LANE_REMOVED_PATCH,
} from "../src/workflows/instruction-proposal-pull-request-sweep";

const WORKFLOWS_PATH = resolve(__dirname, "..", "src", "workflows");
/** The sweeper before the branch sub-batches (Fizzy #2738): no marker at all. */
const PRE_BRANCH_SWEEP_PATH = resolve(
	__dirname,
	"helpers",
	"legacy-proposal-sweep",
);
/** origin/master before the #2563 lane's removal: both lanes, one marker. */
const PRE_V1_REMOVAL_SWEEP_PATH = resolve(
	__dirname,
	"helpers",
	"legacy-proposal-sweep-with-branches",
);
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

/** The retired #2563 lane's activities: a new tick calls none of them. */
const V1_LANE = [
	"selectDueInstructionProposalOperations",
	"closeInstructionProposalPullRequest",
	"recoverInstructionProposalPullRequest",
	"dispatchInstructionProposalMergeSync",
	"reconcileInstructionProposalPullRequest",
	"dispatchInstructionProposalPullRequest",
	"deferInstructionProposalOperation",
] as const;

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

/**
 * Every activity the sweeper proxies. `due` is what the #2563 selection
 * answers: only a tick recorded before `V1_LANE_REMOVED_PATCH` (the frozen
 * copies) ever asks; a new tick must never call it or any #2563 action.
 */
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
		checkInstructionProposalReadiness: vi.fn(async () => ({
			kind: "stop",
		})),
		...overrides,
	};
}

let seq = 0;

/** One tick on `bundle`: the current workflow unless a frozen copy is named. */
async function run(
	activities: Record<string, unknown>,
	bundle: WorkflowBundleWithSourceMap = workflowBundle,
): Promise<{ result: ProposalSweepResult; workflowId: string }> {
	const taskQueue = `instruction-proposal-sweep-${seq++}`;
	const workflowId = `${taskQueue}-wf`;
	const worker = await Worker.create({
		connection: env.nativeConnection,
		taskQueue,
		workflowBundle: bundle,
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

describe("instructionProposalPullRequestSweepWorkflow (spec §9, Fizzy #2738 spec §8)", () => {
	it("never selects or acts on a #2563 row: branch rows only, with their limits, in the table's order, Attach last", async () => {
		const acts = sweepMocks(
			// What a #2563 selection would answer; a new tick never asks.
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

		for (const name of V1_LANE) {
			expect(acts[name]).not.toHaveBeenCalled();
		}
		expect(acts.selectDueInstructionProposalBranches).toHaveBeenCalledWith({
			close: 10,
			recover: 10,
			mergeSync: 10,
			observe: 20,
			restart: 10,
			attach: 10,
		});
		// Four lanes start the first four in queue order, so the order of
		// scheduling is the queue's.
		expect((await scheduled(workflowId)).map((a) => a.type)).toEqual([
			"selectDueInstructionProposalBranches",
			"wakeInstructionProposalBranch",
			"wakeInstructionProposalBranch",
			"dispatchBranchMergeSync",
			"reconcileInstructionProposalBranch",
			"wakeInstructionProposalBranch",
			"attachInstructionProposalToBranch",
		]);
		// Every action carries the tick's one absolute deadline: the end of
		// its 4-minute budget, which the activity stops 10 s before.
		const [firstWake] = (await scheduledInputs(
			workflowId,
			"wakeInstructionProposalBranch",
		)) as Array<{ deadlineAt: string }>;
		const deadlineAt = firstWake?.deadlineAt as string;
		const offset = await deadlineOffsetMs(workflowId, deadlineAt);
		expect(offset).toBeGreaterThanOrEqual(4 * MINUTE_MS);
		expect(offset).toBeLessThan(4 * MINUTE_MS + 2_000);
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
		expect(result).toEqual({ ...ZERO, selected: 6, processed: 6 });
		await expectReplays(workflowId);
	}, 60_000);

	it("runs every call on the workflow's own queue with its timeouts and heartbeat, retry 3 / 10 s / 2, inside the budget", async () => {
		const acts = sweepMocks(
			sweep({}),
			{},
			branchSweep({
				close: [branchItem("c")],
				mergeSync: [branchItem("m")],
				observe: [branchItem("o")],
				attach: [attachItem("a")],
			}),
		);
		const { workflowId } = await run(acts);
		const calls = await scheduled(workflowId);
		// Declared start-to-close and heartbeat, in seconds. The server caps
		// a start-to-close at the call's schedule-to-close, the budget left.
		const declared: Record<string, [number, number]> = {
			selectDueInstructionProposalBranches: [60, 0],
			wakeInstructionProposalBranch: [60, 0],
			dispatchBranchMergeSync: [60, 30],
			reconcileInstructionProposalBranch: [3 * 60, 60],
			attachInstructionProposalToBranch: [60, 0],
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
			sweep({}),
			{
				wakeInstructionProposalBranch: vi.fn(async () => {
					inFlight++;
					most = Math.max(most, inFlight);
					await env.sleep(5_000);
					inFlight--;
					return { woken: true };
				}),
			},
			branchSweep({
				restart: Array.from({ length: 10 }, (_, i) =>
					branchItem(`s${i}`),
				),
			}),
		);
		const { result } = await run(acts);
		expect(most).toBe(4);
		expect(result).toEqual({ ...ZERO, selected: 10, processed: 10 });
	}, 60_000);

	it("starts nothing new with under 30 s of its 4-minute budget left", async () => {
		// Each wake takes 25 s, inside its 60 s start-to-close: every lane
		// starts items at 0, 25, ... 200 s (40 s left, so the call's
		// schedule-to-close still fits it), and none at 225 s (15 s).
		const acts = sweepMocks(
			sweep({}),
			{
				wakeInstructionProposalBranch: vi.fn(async () => {
					await env.sleep(25_000);
					return { woken: true };
				}),
			},
			branchSweep({
				restart: Array.from({ length: 40 }, (_, i) =>
					branchItem(`s${i}`),
				),
			}),
		);
		const { result } = await run(acts);
		expect(acts.wakeInstructionProposalBranch).toHaveBeenCalledTimes(36);
		expect(result).toEqual({
			...ZERO,
			selected: 40,
			processed: 36,
			outOfBudget: 4,
		});
	}, 120_000);

	it("Observe visits every OPEN branch within N ticks for 3N branches (limit 20, 60 branches, 3 ticks)", async () => {
		// A model of the branch Observe selection (spec §8): branches last
		// checked 10 min ago or never, oldest first, then by id, up to the
		// limit; a reconcile stamps the branch's check time.
		const branches = Array.from({ length: 60 }, (_, i) => ({
			id: `o${String(i).padStart(2, "0")}`,
			lastCheckedAt: null as number | null,
		}));
		const visits: string[] = [];
		const acts = sweepMocks(sweep({}), {
			selectDueInstructionProposalBranches: vi.fn(
				async (limits: BranchSweepLimits): Promise<DueBranchSweep> => {
					const now = await env.currentTimeMs();
					const due = branches
						.filter(
							(b) =>
								b.lastCheckedAt === null ||
								now - b.lastCheckedAt >= 10 * MINUTE_MS,
						)
						.sort(
							(a, b) =>
								(a.lastCheckedAt ?? -1) -
									(b.lastCheckedAt ?? -1) ||
								a.id.localeCompare(b.id),
						)
						.slice(0, limits.observe);
					return branchSweep({
						observe: due.map((b) => branchItem(b.id)),
					});
				},
			),
			reconcileInstructionProposalBranch: vi.fn(
				async (
					input: ReconcileBranchInput,
				): Promise<ReconcileBranchResult> => {
					const branch = branches.find(
						(b) => `branch_${b.id}` === input.branchId,
					);
					if (branch) {
						branch.lastCheckedAt = await env.currentTimeMs();
						visits.push(branch.id);
					}
					return { state: "OPEN" };
				},
			),
		});

		for (let tick = 0; tick < 3; tick++) {
			const { result } = await run(acts);
			expect(result).toEqual({ ...ZERO, selected: 20, processed: 20 });
			await env.sleep(5 * MINUTE_MS);
		}

		expect(visits).toHaveLength(60);
		expect(new Set(visits)).toEqual(new Set(branches.map((b) => b.id)));
	}, 120_000);

	it("counts an item whose activity keeps throwing as failed after three attempts, and carries on", async () => {
		const acts = sweepMocks(
			sweep({}),
			{
				reconcileInstructionProposalBranch: vi.fn(
					async (
						input: ReconcileBranchInput,
					): Promise<ReconcileBranchResult> => {
						if (input.branchId === "branch_o1") {
							throw new Error("provider exploded");
						}
						return { state: "OPEN" };
					},
				),
			},
			branchSweep({ observe: [branchItem("o1"), branchItem("o2")] }),
		);
		const { result } = await run(acts);
		expect(
			acts.reconcileInstructionProposalBranch.mock.calls.filter(
				([input]) => input.branchId === "branch_o1",
			),
		).toHaveLength(3);
		expect(result).toEqual({
			...ZERO,
			selected: 2,
			processed: 1,
			failed: 1,
		});
	}, 60_000);

	it("ends the tick when the branch selection keeps failing", async () => {
		const acts = sweepMocks(sweep({ restart: [item("s")] }), {
			selectDueInstructionProposalBranches: vi.fn(async () => {
				throw new Error("database unavailable");
			}),
		});
		const { result } = await run(acts);
		expect(acts.selectDueInstructionProposalBranches).toHaveBeenCalledTimes(
			3,
		);
		for (const name of V1_LANE) {
			expect(acts[name]).not.toHaveBeenCalled();
		}
		expect(result).toEqual({ ...ZERO, selectFailed: true });
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

	it("records both patch markers on a new tick, the branch rows' first, and its history replays", async () => {
		const acts = sweepMocks(sweep({}), {}, branchSweep({}));
		const { workflowId } = await run(acts);
		const history = await env.client.workflow
			.getHandle(workflowId)
			.fetchHistory();
		const markers = patchMarkers(history);
		expect(markers).toHaveLength(2);
		expect(markers[0]).toContain(BRANCH_SWEEP_PATCH);
		expect(markers[1]).toContain(V1_LANE_REMOVED_PATCH);
		await expectReplays(workflowId);
	}, 60_000);
});

// ---------------------------------------------------------------------------
// Replay: ticks recorded by earlier versions of the sweeper
// ---------------------------------------------------------------------------

/**
 * One tick the origin/master sweeper records before the #2563 lane's
 * removal. `check` pins that the tick took the path it is named for, so its
 * replay proves that path.
 */
type MasterTick = {
	acts: () => ReturnType<typeof sweepMocks>;
	check: (
		acts: ReturnType<typeof sweepMocks>,
		result: ProposalSweepResult,
	) => void;
};

const MASTER_TICKS: ReadonlyArray<[string, MasterTick]> = [
	[
		"every sub-batch of both lanes, the #2563 rows first, Attach last",
		{
			acts: () =>
				sweepMocks(
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
				),
			check: (acts, result) => {
				for (const name of V1_LANE.filter(
					(n) => n !== "deferInstructionProposalOperation",
				)) {
					expect(acts[name]).toHaveBeenCalledTimes(1);
				}
				expect(result).toEqual({
					...ZERO,
					selected: 11,
					processed: 11,
				});
			},
		},
	],
	[
		"a row whose operation workflow is running is deferred in every sub-batch",
		{
			acts: () => {
				const running = { running: true, attempt: 8 };
				return sweepMocks(
					sweep({
						close: [item("c", running)],
						recover: [item("r", running)],
						mergeSync: [item("m", running)],
						observe: [item("o", running)],
						restart: [item("s", running)],
					}),
				);
			},
			check: (acts, result) => {
				expect(
					acts.deferInstructionProposalOperation,
				).toHaveBeenCalledTimes(5);
				expect(result).toEqual({
					...ZERO,
					selected: 5,
					processed: 5,
					deferred: 5,
				});
			},
		},
	],
	[
		"Recover hands off to close and to Restart's action, and Observe to the merge-sync dispatch, in the same item",
		{
			acts: () => {
				const recovered: Record<string, RecoverProposalResult> = {
					snap_r1: { kind: "absent_handoff" },
					snap_r2: { kind: "close_requested" },
				};
				return sweepMocks(
					sweep({
						recover: [item("r1"), item("r2"), item("r3")],
						observe: [item("o1"), item("o2")],
					}),
					{
						recoverInstructionProposalPullRequest: vi.fn(
							async (input: RecoverProposalInput) =>
								recovered[input.snapshotId] ?? {
									kind: "unchanged",
								},
						),
						reconcileInstructionProposalPullRequest: vi.fn(
							async (
								input: ReconcileProposalInput,
							): Promise<ReconcileProposalResult> =>
								input.snapshotId === "snap_o1"
									? { kind: "merged" }
									: { kind: "open" },
						),
					},
				);
			},
			check: (acts) => {
				expect(
					acts.dispatchInstructionProposalPullRequest.mock.calls.map(
						([input]) => idOf(input),
					),
				).toEqual(["snap_r1"]);
				expect(
					acts.closeInstructionProposalPullRequest.mock.calls.map(
						([input]) => idOf(input),
					),
				).toEqual(["snap_r2"]);
				expect(
					acts.dispatchInstructionProposalMergeSync.mock.calls.map(
						([input]) => idOf(input),
					),
				).toEqual(["snap_o1"]);
			},
		},
	],
	[
		"a rate-limited integration's later items are skipped, its branch rows too",
		{
			acts: () =>
				sweepMocks(
					sweep({ close: [item("a1", { integrationId: "int_a" })] }),
					{
						closeInstructionProposalPullRequest: vi.fn(
							async () => ({
								kind: "pending",
								rateLimitedIntegrationId: "int_a",
							}),
						),
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
				),
			check: (acts, result) => {
				expect(
					acts.wakeInstructionProposalBranch.mock.calls.map(
						([i]) => i.branchId,
					),
				).not.toContain("branch_a2");
				expect(result).toEqual({
					...ZERO,
					selected: 6,
					processed: 5,
					rateLimited: 1,
				});
			},
		},
	],
	[
		"the #2563 selection keeps failing and ends the tick",
		{
			acts: () =>
				sweepMocks(sweep({}), {
					selectDueInstructionProposalOperations: vi.fn(async () => {
						throw new Error("database unavailable");
					}),
				}),
			check: (acts, result) => {
				expect(
					acts.selectDueInstructionProposalOperations,
				).toHaveBeenCalledTimes(3);
				expect(
					acts.selectDueInstructionProposalBranches,
				).not.toHaveBeenCalled();
				expect(result).toEqual({ ...ZERO, selectFailed: true });
			},
		},
	],
	[
		"the branch selection keeps failing and the #2563 rows still run",
		{
			acts: () =>
				sweepMocks(sweep({ restart: [item("s")] }), {
					selectDueInstructionProposalBranches: vi.fn(async () => {
						throw new Error("database unavailable");
					}),
				}),
			check: (acts, result) => {
				expect(
					acts.dispatchInstructionProposalPullRequest,
				).toHaveBeenCalledTimes(1);
				expect(result).toEqual({ ...ZERO, selected: 1, processed: 1 });
			},
		},
	],
	[
		"a #2563 item whose activity keeps throwing is failed after three attempts",
		{
			acts: () =>
				sweepMocks(sweep({ observe: [item("o1"), item("o2")] }), {
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
				}),
			check: (_acts, result) => {
				expect(result).toEqual({
					...ZERO,
					selected: 2,
					processed: 1,
					failed: 1,
				});
			},
		},
	],
	[
		"a tick straddling the deploy meets the retired stubs: each #2563 action fails once, non-retryably, and the branch rows still run",
		{
			acts: () => {
				// The selection ran before the deploy; every action after it
				// runs on the new worker, whose stubs refuse non-retryably.
				const retired = (name: string) =>
					vi.fn(async () => {
						throw ApplicationFailure.nonRetryable(
							`${name} belongs to the retired per-proposal pull-request path; nothing is left for it to do`,
							"PROPOSAL_OPERATION_LANE_RETIRED",
						);
					});
				return sweepMocks(
					sweep({
						close: [item("c")],
						recover: [item("r")],
						mergeSync: [item("m")],
						observe: [item("o")],
						restart: [item("s")],
					}),
					{
						closeInstructionProposalPullRequest: retired("close"),
						recoverInstructionProposalPullRequest:
							retired("recover"),
						dispatchInstructionProposalMergeSync:
							retired("mergeSync"),
						reconcileInstructionProposalPullRequest:
							retired("reconcile"),
						dispatchInstructionProposalPullRequest:
							retired("dispatch"),
					},
					branchSweep({ restart: [branchItem("s")] }),
				);
			},
			check: (acts, result) => {
				for (const name of [
					"closeInstructionProposalPullRequest",
					"recoverInstructionProposalPullRequest",
					"dispatchInstructionProposalMergeSync",
					"reconcileInstructionProposalPullRequest",
					"dispatchInstructionProposalPullRequest",
				] as const) {
					expect(acts[name]).toHaveBeenCalledTimes(1);
				}
				expect(
					acts.wakeInstructionProposalBranch,
				).toHaveBeenCalledTimes(1);
				expect(result).toEqual({
					...ZERO,
					selected: 6,
					processed: 1,
					failed: 5,
				});
			},
		},
	],
	[
		"the budget runs out: nothing new starts with under 30 s left",
		{
			acts: () =>
				sweepMocks(
					sweep({
						restart: Array.from({ length: 40 }, (_, i) =>
							item(`s${i}`),
						),
					}),
					{
						dispatchInstructionProposalPullRequest: vi.fn(
							async () => {
								await env.sleep(25_000);
								return { kind: "started" };
							},
						),
					},
				),
			check: (acts, result) => {
				expect(
					acts.dispatchInstructionProposalPullRequest,
				).toHaveBeenCalledTimes(36);
				expect(result).toEqual({
					...ZERO,
					selected: 40,
					processed: 36,
					outOfBudget: 4,
				});
			},
		},
	],
];

describe("replaying ticks recorded before a patch", () => {
	let preBranchBundle: WorkflowBundleWithSourceMap;
	let preV1RemovalBundle: WorkflowBundleWithSourceMap;

	beforeAll(async () => {
		[preBranchBundle, preV1RemovalBundle] = await Promise.all([
			bundleWorkflowCode({ workflowsPath: PRE_BRANCH_SWEEP_PATH }),
			bundleWorkflowCode({ workflowsPath: PRE_V1_REMOVAL_SWEEP_PATH }),
		]);
	}, 120_000);

	it("replays a tick recorded before the branch sub-batches on the pre-patch path: no marker, no branch selection", async () => {
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
		const { workflowId } = await run(acts, preBranchBundle);
		const history = await env.client.workflow
			.getHandle(workflowId)
			.fetchHistory();
		expect(patchMarkers(history)).toEqual([]);
		expect(
			acts.selectDueInstructionProposalBranches,
		).not.toHaveBeenCalled();
		// The current workflow replays it: both `patched` calls answer false
		// on a history without their markers, so it takes the #2563 lane
		// alone and schedules exactly what the legacy tick did.
		await expect(
			Worker.runReplayHistory({ workflowBundle }, history, workflowId),
		).resolves.toBeUndefined();
	}, 120_000);

	it.each(MASTER_TICKS)(
		"replays a tick origin/master recorded before the #2563 lane's removal, command for command: %s",
		async (_name, tick) => {
			const acts = tick.acts();
			const { result, workflowId } = await run(acts, preV1RemovalBundle);
			tick.check(acts, result);
			const history = await env.client.workflow
				.getHandle(workflowId)
				.fetchHistory();
			// Recorded with the branch rows' marker only: the current
			// workflow reads `V1_LANE_REMOVED_PATCH` as unpatched and takes
			// the #2563 lane exactly as the tick did.
			const markers = patchMarkers(history);
			expect(markers).toHaveLength(1);
			expect(markers[0]).toContain(BRANCH_SWEEP_PATCH);
			await expect(
				Worker.runReplayHistory(
					{ workflowBundle },
					history,
					workflowId,
				),
			).resolves.toBeUndefined();
		},
		120_000,
	);
});
