/**
 * Behavioural tests for `projectInstructionProposalBranchWorkflow` (Fizzy
 * #2738 spec §6, plan Task 10) on a time-skipping test server, bundling the
 * REAL workflows barrel (which also proves registration). The workflow runs
 * on the test's own queue; its activities run on the queue it routes them
 * to, `fabric-worker`, served by a second worker, with mocked activities.
 *
 * The precedence cases drive the loop with the REAL `decideBranchWork` over
 * a small in-memory branch that the mocked activities change, so the order
 * asserted is the spec's order as the database decides it and the workflow
 * runs it. Timings are read from the test server's clock. Every identifier
 * is synthetic.
 *
 * Run with:
 *   pnpm --filter @repo/temporal test __tests__/instruction-proposal-branch-workflow.test.ts
 */
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
	type BranchWork,
	type BranchWorkInput,
	decideBranchWork,
} from "@repo/database";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import {
	bundleWorkflowCode,
	Worker,
	type WorkflowBundleWithSourceMap,
} from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type {
	BranchWorkItem,
	CheckBranchProposalReadinessResult,
	NextBranchWorkResult,
	ProposalBranchWorkflowResult,
} from "../src/activities/lib/instruction-branch-types";
import { INSTRUCTION_SYNC_ACTIVITY_TASK_QUEUE } from "../src/task-queues";
import type { ProposalBranchWorkflowInput } from "../src/workflows/instruction-proposal-branch";

const WORKFLOWS_PATH = resolve(__dirname, "..", "src", "workflows");
const WORKFLOW_NAME = "projectInstructionProposalBranchWorkflow";
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const BRANCH_ID = "branch_example";
const INPUT: ProposalBranchWorkflowInput = {
	branchId: BRANCH_ID,
	projectId: "proj_example",
	organizationId: "org_example",
};
const IDS = { branchId: BRANCH_ID, organizationId: "org_example" };

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

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type Call = { name: string; at: number; input: unknown };

/** Every branch activity as a recording mock; `overrides` answer for real. */
function activities(
	read: () => Promise<NextBranchWorkResult>,
	overrides: Record<string, (input: never) => Promise<unknown>> = {},
) {
	const calls: Call[] = [];
	const record =
		(name: string, answer: (input: never) => Promise<unknown>) =>
		async (input: never) => {
			calls.push({ name, at: await env.currentTimeMs(), input });
			return answer(input);
		};
	const defaults: Record<string, (input: never) => Promise<unknown>> = {
		nextBranchWorkItem: read,
		recoverBranchOperation: async () => ({ outcome: "observed" }),
		runBranchConfirmations: async () => ({ outcome: "confirmed" }),
		settleBranch: async () => ({ outcome: "canceled" }),
		releaseBranch: async () => ({ outcome: "released" }),
		classifyBranch: async () => ({ outcome: "done" }),
		rehomeBranchProposals: async () => ({ moved: 0, wakeBranchIds: [] }),
		revertBranchProposal: async () => ({ outcome: "reverted" }),
		retryBranchOpening: async () => ({ outcome: "blocked" }),
		lookupBranchPullRequest: async () => ({ outcome: "absent" }),
		createBranchPullRequest: async () => ({ outcome: "opened" }),
		claimBranchProposal: async () => ({ kind: "none" }),
		appendBranchProposal: async () => ({ outcome: "appended" }),
		checkBranchProposalReadiness: async () => ({ kind: "ready" }),
	};
	const acts = Object.fromEntries(
		Object.entries({ ...defaults, ...overrides }).map(([name, fn]) => [
			name,
			vi.fn(record(name, fn)),
		]),
	);
	return {
		acts,
		calls,
		names: () => calls.map((c) => c.name),
	};
}

let seq = 0;

async function run(
	acts: Record<string, unknown>,
	input: ProposalBranchWorkflowInput = INPUT,
	during?: (workflowId: string) => Promise<void>,
): Promise<{
	result: ProposalBranchWorkflowResult;
	workflowId: string;
	firstRunId: string;
}> {
	const taskQueue = `instruction-proposal-branch-${seq++}`;
	const workflowId = `project-instruction-proposal-branch-${BRANCH_ID}-${seq}`;
	const workflowWorker = await Worker.create({
		connection: env.nativeConnection,
		taskQueue,
		workflowBundle,
	});
	const activityWorker = await Worker.create({
		connection: env.nativeConnection,
		taskQueue: INSTRUCTION_SYNC_ACTIVITY_TASK_QUEUE,
		activities: acts,
	});
	const handle = await env.client.workflow.start(WORKFLOW_NAME, {
		args: [input],
		taskQueue,
		workflowId,
	});
	// `result()` follows a continue-as-new to the last run's result; time
	// skips only while it is awaited.
	const result = await workflowWorker.runUntil(
		activityWorker.runUntil(
			(async () => {
				await during?.(workflowId);
				return handle.result();
			})(),
		),
	);
	return {
		result: result as ProposalBranchWorkflowResult,
		workflowId,
		firstRunId: handle.firstExecutionRunId,
	};
}

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

/** A read that answers the listed items in turn, repeating the last. */
function script(...items: Array<BranchWorkItem | NextBranchWorkResult>) {
	let n = 0;
	return async (): Promise<NextBranchWorkResult> => {
		const next = items[Math.min(n, items.length - 1)];
		n++;
		if (!next) {
			throw new Error("no scripted item");
		}
		return "work" in next ? next : { work: next, branchAttempt: 3 };
	};
}

const idle = (wakeInMs: number | null = null): BranchWorkItem => ({
	kind: "idle",
	wakeInMs,
});

// ---------------------------------------------------------------------------
// A small branch the mocked activities change, read by the real decider
// ---------------------------------------------------------------------------

type ModelBranch = BranchWorkInput["branch"] & { attempt: number };
type Model = {
	branch: ModelBranch;
	ops: Array<BranchWorkInput["ops"][number]>;
	proposals: Array<BranchWorkInput["proposals"][number]>;
};

function modelBranch(over: Partial<ModelBranch> = {}): ModelBranch {
	return {
		id: BRANCH_ID,
		state: "OPEN",
		untracked: false,
		retiredAt: null,
		failure: null,
		closeIntent: null,
		createIssuedAt: null,
		pullRequestExternalId: "7",
		headSha: "a".repeat(40),
		membership: null,
		confirmationDueAt: null,
		nextAttemptAt: null,
		retryRequestedAt: null,
		settledAt: null,
		deletedAt: null,
		factsRevision: 1,
		attempt: 3,
		...over,
	};
}

function proposalEntry(
	snapshotId: string,
	sequence: number,
	state: BranchWorkInput["proposals"][number]["state"],
	over: Partial<BranchWorkInput["proposals"][number]> = {},
): BranchWorkInput["proposals"][number] {
	return {
		snapshotId,
		sequence,
		state,
		status: "READY",
		proposalStatus: "PENDING",
		withdrawRequestedAt: null,
		failure: null,
		nextAttemptAt: null,
		assignment: 1,
		attempt: 2,
		...over,
	};
}

/** `nextBranchWorkItem` as the activity answers it, over the model, on the server's clock. */
function readModel(model: Model) {
	return async (): Promise<NextBranchWorkResult> => {
		const now = new Date(await env.currentTimeMs());
		const work: BranchWork = decideBranchWork({
			branch: model.branch,
			ops: model.ops,
			proposals: model.proposals,
			now,
		});
		return {
			work:
				work.kind === "idle"
					? {
							kind: "idle",
							wakeInMs:
								work.wakeAt === null
									? null
									: Math.max(
											0,
											work.wakeAt.getTime() -
												now.getTime(),
										),
						}
					: work,
			branchAttempt: model.branch.attempt,
		};
	};
}

const workNames = (names: string[]) =>
	names.filter((n) => n !== "nextBranchWorkItem");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("projectInstructionProposalBranchWorkflow (spec §6)", () => {
	it("recovers an issued operation before it settles or reverts anything, then reverts, then ends idle", async () => {
		const model: Model = {
			branch: modelBranch(),
			ops: [
				{
					id: "op_1",
					snapshotId: "snap_1",
					kind: "APPEND",
					executionSeq: 2,
					assignment: 1,
					branchId: BRANCH_ID,
					outcome: null,
				},
			],
			proposals: [
				proposalEntry("snap_1", 1, "OPEN"),
				proposalEntry("snap_2", 2, "CLOSE_REQUESTED", {
					withdrawRequestedAt: new Date(0),
				}),
			],
		};
		const h = activities(readModel(model), {
			recoverBranchOperation: async () => {
				const op = model.ops[0];
				if (op) {
					op.outcome = "acked";
				}
				return { outcome: "observed" };
			},
			revertBranchProposal: async () => {
				model.proposals = model.proposals.filter(
					(p) => p.snapshotId !== "snap_2",
				);
				return { outcome: "reverted" };
			},
		});

		const { result, workflowId } = await run(h.acts);

		expect(workNames(h.names())).toEqual([
			"recoverBranchOperation",
			"revertBranchProposal",
		]);
		expect(
			h.calls.find((c) => c.name === "recoverBranchOperation")?.input,
		).toEqual({
			...IDS,
			operationId: "op_1",
		});
		expect(
			h.calls.find((c) => c.name === "revertBranchProposal")?.input,
		).toEqual({
			...IDS,
			snapshotId: "snap_2",
			proposalAttempt: 2,
		});
		expect(result).toEqual({ ended: "idle" });
		await expectReplays(workflowId);
	}, 60_000);

	it("on a settling branch: recover, then close (settlement), never the revert first", async () => {
		const model: Model = {
			branch: modelBranch({
				state: "CLOSE_REQUESTED",
				closeIntent: "WITHDRAW",
			}),
			ops: [
				{
					id: "op_1",
					snapshotId: "snap_1",
					kind: "REVERT",
					executionSeq: 3,
					assignment: 1,
					branchId: BRANCH_ID,
					outcome: null,
				},
			],
			proposals: [
				proposalEntry("snap_1", 1, "CLOSE_REQUESTED", {
					withdrawRequestedAt: new Date(0),
				}),
			],
		};
		const h = activities(readModel(model), {
			recoverBranchOperation: async () => {
				const op = model.ops[0];
				if (op) {
					op.outcome = "unknown";
				}
				return { outcome: "unknown" };
			},
			settleBranch: async (input: never) => {
				const { branchAttempt } = input as { branchAttempt: number };
				expect(branchAttempt).toBe(model.branch.attempt);
				model.branch = modelBranch({
					state: "CANCELED",
					closeIntent: "WITHDRAW",
					settledAt: new Date(await env.currentTimeMs()),
					attempt: model.branch.attempt + 1,
				});
				model.proposals = [];
				return { outcome: "canceled" };
			},
		});

		const { result } = await run(h.acts);

		expect(workNames(h.names())).toEqual([
			"recoverBranchOperation",
			"settleBranch",
		]);
		expect(h.calls.find((c) => c.name === "settleBranch")?.input).toEqual({
			...IDS,
			branchAttempt: 3,
		});
		expect(result).toEqual({ ended: "idle" });
	}, 60_000);

	it("on a terminal branch: recover, then classify at the facts revision, then rehome", async () => {
		const model: Model = {
			branch: modelBranch({
				state: "MERGED",
				membership: {
					status: "pending",
					at: "2026-09-26T00:00:00Z",
					attempts: 0,
				},
				factsRevision: 4,
			}),
			ops: [
				{
					id: "op_1",
					snapshotId: "snap_1",
					kind: "APPEND",
					executionSeq: 2,
					assignment: 1,
					branchId: BRANCH_ID,
					outcome: null,
				},
			],
			proposals: [
				proposalEntry("snap_1", 1, "OPEN"),
				proposalEntry("snap_2", 2, "QUEUED"),
			],
		};
		const h = activities(readModel(model), {
			recoverBranchOperation: async () => {
				const op = model.ops[0];
				if (op) {
					op.outcome = "observed";
				}
				return { outcome: "observed" };
			},
			classifyBranch: async () => {
				model.branch = {
					...model.branch,
					membership: { status: "done" },
				};
				model.proposals = model.proposals.filter(
					(p) => p.snapshotId !== "snap_1",
				);
				return { outcome: "done" };
			},
			rehomeBranchProposals: async () => {
				model.proposals = [];
				return { moved: 1, wakeBranchIds: ["branch_next"] };
			},
		});

		const { result } = await run(h.acts);

		expect(workNames(h.names())).toEqual([
			"recoverBranchOperation",
			"classifyBranch",
			"rehomeBranchProposals",
		]);
		expect(h.calls.find((c) => c.name === "classifyBranch")?.input).toEqual(
			{
				...IDS,
				factsRevision: 4,
			},
		);
		expect(
			h.calls.find((c) => c.name === "rehomeBranchProposals")?.input,
		).toEqual({ ...IDS, snapshotIds: ["snap_2"] });
		expect(result).toEqual({ ended: "idle" });
	}, 60_000);

	it("an untracked branch is idle: nothing runs, not even recovery", async () => {
		const model: Model = {
			branch: modelBranch({ state: "CLOSED", untracked: true }),
			ops: [
				{
					id: "op_1",
					snapshotId: "snap_1",
					kind: "APPEND",
					executionSeq: 2,
					assignment: 1,
					branchId: BRANCH_ID,
					outcome: null,
				},
			],
			proposals: [],
		};
		const h = activities(readModel(model));
		const { result } = await run(h.acts);
		expect(h.names()).toEqual(["nextBranchWorkItem"]);
		expect(result).toEqual({ ended: "idle" });
	}, 60_000);

	it("claims then appends the head with the attempts the claim returned", async () => {
		let appended = false;
		const h = activities(
			async () => ({
				work: appended ? idle() : { kind: "append" },
				branchAttempt: 3,
			}),
			{
				claimBranchProposal: async () => ({
					kind: "claimed",
					snapshotId: "snap_1",
					proposalAttempt: 6,
					branchAttempt: 4,
				}),
				appendBranchProposal: async () => {
					appended = true;
					return { outcome: "appended" };
				},
			},
		);
		await run(h.acts);
		expect(workNames(h.names())).toEqual([
			"claimBranchProposal",
			"appendBranchProposal",
		]);
		expect(
			h.calls.find((c) => c.name === "appendBranchProposal")?.input,
		).toEqual({
			...IDS,
			snapshotId: "snap_1",
			proposalAttempt: 6,
			branchAttempt: 4,
		});
	}, 60_000);

	it("passes the attempt read with the item to close, release, retry and create", async () => {
		const h = activities(
			script(
				{ work: { kind: "close" }, branchAttempt: 11 },
				{ work: { kind: "release" }, branchAttempt: 12 },
				{ work: { kind: "retry" }, branchAttempt: 13 },
				{ work: { kind: "create" }, branchAttempt: 14 },
				{ work: { kind: "lookup" }, branchAttempt: 15 },
				{ work: { kind: "confirm" }, branchAttempt: 16 },
				{ work: idle(), branchAttempt: 16 },
			),
		);
		await run(h.acts);
		expect(
			h.calls
				.filter((c) => c.name !== "nextBranchWorkItem")
				.map((c) => [c.name, c.input]),
		).toEqual([
			["settleBranch", { ...IDS, branchAttempt: 11 }],
			["releaseBranch", { ...IDS, branchAttempt: 12 }],
			["retryBranchOpening", { ...IDS, branchAttempt: 13 }],
			["createBranchPullRequest", { ...IDS, branchAttempt: 14 }],
			["lookupBranchPullRequest", IDS],
			["runBranchConfirmations", IDS],
		]);
	}, 60_000);

	it("ends on idle when no wake arrived since that read", async () => {
		const h = activities(script(idle()));
		const { result } = await run(h.acts);
		expect(h.names()).toEqual(["nextBranchWorkItem"]);
		expect(result).toEqual({ ended: "idle" });
	}, 60_000);

	it("a wake that arrives during the read is another iteration, never lost", async () => {
		let reads = 0;
		let workflowId = "";
		const h = activities(async () => {
			reads++;
			if (reads === 1) {
				await env.client.workflow.getHandle(workflowId).signal("wake");
			}
			return { work: idle(), branchAttempt: 3 };
		});
		const { result } = await run(h.acts, INPUT, async (id) => {
			workflowId = id;
		});
		expect(reads).toBe(2);
		expect(result).toEqual({ ended: "idle" });
	}, 60_000);

	it("idle with a timer sleeps until it, then reads again", async () => {
		const h = activities(script(idle(30 * MINUTE_MS), idle()));
		const { result, workflowId } = await run(h.acts);
		const reads = h.calls.filter((c) => c.name === "nextBranchWorkItem");
		expect(reads).toHaveLength(2);
		const gap = (reads[1]?.at ?? 0) - (reads[0]?.at ?? 0);
		expect(gap).toBeGreaterThanOrEqual(30 * MINUTE_MS);
		expect(gap).toBeLessThan(30 * MINUTE_MS + 5_000);
		expect(result).toEqual({ ended: "idle" });
		await expectReplays(workflowId);
	}, 60_000);

	it("a wake cuts an idle timer short", async () => {
		const h = activities(script(idle(HOUR_MS), idle()));
		const { result } = await run(h.acts, INPUT, async (workflowId) => {
			// Time does not skip until `result()` is awaited: the first read
			// lands, then the wake arrives while the 1 h timer runs.
			while (h.calls.length === 0) {
				await delay(20);
			}
			await delay(200);
			await env.client.workflow.getHandle(workflowId).signal("wake");
		});
		const reads = h.calls.filter((c) => c.name === "nextBranchWorkItem");
		expect(reads).toHaveLength(2);
		expect((reads[1]?.at ?? 0) - (reads[0]?.at ?? 0)).toBeLessThan(
			10 * MINUTE_MS,
		);
		expect(result).toEqual({ ended: "idle" });
	}, 60_000);

	it("wait: readiness with #2563's backoff, 5, 10, 20, 40, 60, 60 s, then the head is read again", async () => {
		let answers = 0;
		const h = activities(
			async () => ({
				work:
					answers >= 7
						? idle()
						: { kind: "wait", snapshotId: "snap_1" },
				branchAttempt: 3,
			}),
			{
				checkBranchProposalReadiness:
					async (): Promise<CheckBranchProposalReadinessResult> => {
						answers++;
						return answers >= 7
							? { kind: "ready" }
							: { kind: "pending" };
					},
			},
		);
		const { workflowId } = await run(h.acts);
		const checks = h.calls.filter(
			(c) => c.name === "checkBranchProposalReadiness",
		);
		expect(checks).toHaveLength(7);
		expect(checks[0]?.input).toEqual({
			...IDS,
			projectId: "proj_example",
			snapshotId: "snap_1",
		});
		const gaps = checks
			.slice(1)
			.map((c, i) => Math.round((c.at - (checks[i]?.at ?? 0)) / 1000));
		expect(gaps).toEqual([5, 10, 20, 40, 60, 60]);
		await expectReplays(workflowId);
	}, 60_000);

	it("wait: a stop answer (the 6 h clock's BLOCKED VALIDATION_TIMEOUT) backs off too, then reads again", async () => {
		let answered = false;
		const h = activities(
			async () => ({
				work: answered
					? idle()
					: { kind: "wait", snapshotId: "snap_1" },
				branchAttempt: 3,
			}),
			{
				checkBranchProposalReadiness: async () => {
					answered = true;
					return { kind: "stop" };
				},
			},
		);
		const { result } = await run(h.acts);
		expect(workNames(h.names())).toEqual(["checkBranchProposalReadiness"]);
		expect(result).toEqual({ ended: "idle" });
	}, 60_000);

	it("backs off, 30 then 60 s, after a recovery that could not fetch the history, so it never spins", async () => {
		let tries = 0;
		const h = activities(
			async () => ({
				work:
					tries >= 3
						? idle()
						: { kind: "recover", operationId: "op_1" },
				branchAttempt: 3,
			}),
			{
				recoverBranchOperation: async () => {
					tries++;
					return { outcome: tries < 3 ? "retry_later" : "observed" };
				},
			},
		);
		await run(h.acts);
		const recovers = h.calls.filter(
			(c) => c.name === "recoverBranchOperation",
		);
		expect(recovers).toHaveLength(3);
		const gaps = recovers
			.slice(1)
			.map((c, i) => Math.round((c.at - (recovers[i]?.at ?? 0)) / 1000));
		expect(gaps).toEqual([30, 60]);
	}, 60_000);

	it("continues as new after 200 iterations, carrying only the ids", async () => {
		let reads = 0;
		const h = activities(async () => {
			reads++;
			return {
				work: reads <= 200 ? { kind: "confirm" } : idle(),
				branchAttempt: 3,
			};
		});
		const { result, workflowId, firstRunId } = await run(h.acts);
		const history = await env.client.workflow
			.getHandle(workflowId, firstRunId)
			.fetchHistory();
		const events = history.events ?? [];
		expect(
			events.filter(
				(e) =>
					e.activityTaskScheduledEventAttributes?.activityType
						?.name === "nextBranchWorkItem",
			),
		).toHaveLength(200);
		const continued =
			events.at(-1)?.workflowExecutionContinuedAsNewEventAttributes;
		expect(continued).toBeTruthy();
		const next =
			await env.client.options.loadedDataConverter.payloadConverter.fromPayload(
				continued?.input?.payloads?.[0] ?? {},
			);
		expect(next).toEqual(INPUT);
		expect(reads).toBe(201);
		expect(result).toEqual({ ended: "idle" });
		await expectReplays(workflowId, firstRunId);
	}, 180_000);

	it("never carries an iterations override into the next run", async () => {
		let reads = 0;
		const h = activities(async () => {
			reads++;
			return {
				work: reads <= 3 ? { kind: "confirm" } : idle(),
				branchAttempt: 3,
			};
		});
		const { workflowId, firstRunId } = await run(h.acts, {
			...INPUT,
			iterations: 3,
		});
		const history = await env.client.workflow
			.getHandle(workflowId, firstRunId)
			.fetchHistory();
		const continued =
			history.events?.at(
				-1,
			)?.workflowExecutionContinuedAsNewEventAttributes;
		const next =
			await env.client.options.loadedDataConverter.payloadConverter.fromPayload(
				continued?.input?.payloads?.[0] ?? {},
			);
		expect(next).toEqual(INPUT);
	}, 60_000);

	it("routes every activity to fabric-worker with its timeouts and retry 3 / 10 s / 2", async () => {
		const h = activities(
			script(
				{ kind: "recover", operationId: "op_1" },
				{ kind: "confirm" },
				{ kind: "close" },
				{ kind: "classify", factsRevision: 1 },
				{ kind: "rehome", snapshotIds: ["snap_2"] },
				{ kind: "revert", snapshotId: "snap_3", proposalAttempt: 2 },
				{ kind: "append" },
				idle(),
			),
			{
				claimBranchProposal: async () => ({
					kind: "claimed",
					snapshotId: "snap_1",
					proposalAttempt: 2,
					branchAttempt: 4,
				}),
			},
		);
		const { workflowId } = await run(h.acts);
		const history = await env.client.workflow
			.getHandle(workflowId)
			.fetchHistory();
		const seconds = (d: { seconds?: unknown } | null | undefined) =>
			Number(
				(d?.seconds as { toNumber?: () => number })?.toNumber?.() ??
					d?.seconds ??
					0,
			);
		const scheduled = Object.fromEntries(
			(history.events ?? []).flatMap((e) => {
				const a = e.activityTaskScheduledEventAttributes;
				return a
					? [
							[
								a.activityType?.name ?? "",
								{
									queue: a.taskQueue?.name,
									startToClose: seconds(
										a.startToCloseTimeout,
									),
									heartbeat: seconds(a.heartbeatTimeout),
									attempts: a.retryPolicy?.maximumAttempts,
								},
							],
						]
					: [];
			}),
		);
		expect(scheduled).toEqual({
			nextBranchWorkItem: {
				queue: "fabric-worker",
				startToClose: 60,
				heartbeat: 0,
				attempts: 3,
			},
			recoverBranchOperation: {
				queue: "fabric-worker",
				startToClose: 300,
				heartbeat: 60,
				attempts: 3,
			},
			runBranchConfirmations: {
				queue: "fabric-worker",
				startToClose: 300,
				heartbeat: 60,
				attempts: 3,
			},
			settleBranch: {
				queue: "fabric-worker",
				startToClose: 600,
				heartbeat: 60,
				attempts: 3,
			},
			classifyBranch: {
				queue: "fabric-worker",
				startToClose: 600,
				heartbeat: 60,
				attempts: 3,
			},
			rehomeBranchProposals: {
				queue: "fabric-worker",
				startToClose: 300,
				heartbeat: 60,
				attempts: 3,
			},
			revertBranchProposal: {
				queue: "fabric-worker",
				startToClose: 900,
				heartbeat: 60,
				attempts: 3,
			},
			claimBranchProposal: {
				queue: "fabric-worker",
				startToClose: 60,
				heartbeat: 0,
				attempts: 3,
			},
			appendBranchProposal: {
				queue: "fabric-worker",
				startToClose: 900,
				heartbeat: 60,
				attempts: 3,
			},
		});
	}, 60_000);
});
