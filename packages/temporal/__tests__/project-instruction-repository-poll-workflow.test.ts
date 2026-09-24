/**
 * Behavioural tests for `projectInstructionRepositoryPollWorkflow` on a
 * time-skipping test server, bundling the REAL workflows barrel (which also
 * proves registration). The poll's activities name no task queue of their
 * own, so they run on the workflow's queue and one worker serves both.
 *
 * The budget cases advance server time from inside the activities with
 * `env.sleep`, the pattern the SDK documents for simulating a long activity.
 * The test server does not skip time while an activity runs without a
 * sleep, so every long activity sleeps, and every sleep stays under that
 * activity's start-to-close (90 s for a check, 30 s for a claim). A slow
 * check ends 10 s before the poll's deadline when that is sooner than 85 s,
 * as the real check stops itself before its deadline (Decision 50).
 *
 * How many completions one workflow task sees depends on how the server
 * batches them, so a wave's size can vary between one and the free lanes.
 * The assertions below hold for every batching: totals, bounds, and the
 * first wave, which always starts with four free lanes.
 *
 * Run with:
 *   pnpm --filter @repo/temporal test __tests__/project-instruction-repository-poll-workflow.test.ts
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
import {
	type ClaimedInstructionSyncCheck,
	INSTRUCTION_SYNC_CHECK_RESERVE_MS,
	INSTRUCTION_SYNC_POLL_BUDGET_MS,
	INSTRUCTION_SYNC_POLL_CLAIM_CAP,
	type InstructionSyncCheckInput,
	type InstructionSyncCheckOutcome,
	type InstructionSyncCheckResult,
	type InstructionSyncPollInput,
	type InstructionSyncPollResult,
	REPOSITORY_SYNC_SUBJECT_KINDS,
} from "../src/lib/instruction-sync-types";

const WORKFLOWS_PATH = resolve(__dirname, "..", "src", "workflows");
const WORKFLOW_NAME = "projectInstructionRepositoryPollWorkflow";
/** The lease the claim query writes (Decision 31). */
const LEASE_MS = 2 * 60 * 1000;
const ZERO: InstructionSyncPollResult = {
	claimed: 0,
	started: 0,
	alreadyRunning: 0,
	evaluated: 0,
	suppressed: 0,
	refMissing: 0,
	permissionRevoked: 0,
	transient: 0,
	stale: 0,
	failed: 0,
	deferred: 0,
	claimFailed: 0,
};

type Kind = ClaimedInstructionSyncCheck["kind"];
type ClaimInput = { kind: Kind; limit: number };
type Claim = (input: ClaimInput) => Promise<ClaimedInstructionSyncCheck[]>;

/**
 * A second kind only these tests know (Decision 52). The workflow treats a
 * kind as an opaque name it passes to the claim, so the cast is safe here.
 */
const FAKE = "fake" as unknown as Kind;

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

function claimed(
	id: string,
	kind: Kind,
	leaseUntilMs: number,
): ClaimedInstructionSyncCheck {
	return {
		kind,
		id,
		projectId: `proj_${id}`,
		organizationId: "org_1",
		userId: "user_1",
		generation: 1,
		repositoryIntegrationId: "int_1",
		ref: "main",
		lastEvaluatedCommitSha: null,
		lastEvaluatedGeneration: null,
		suppressedCommitSha: null,
		suppressedGeneration: null,
		failureCount: 0,
		leaseUntil: new Date(leaseUntilMs).toISOString(),
	};
}

/**
 * A claim over a fixed queue of due rows: each call takes up to its limit,
 * tagged with the kind it was asked for and leased for two minutes from
 * server time, as the claim query does.
 */
function due(...ids: string[]) {
	const queue = [...ids];
	return vi.fn<Claim>(async (input) => {
		const now = await env.currentTimeMs();
		return queue
			.splice(0, input.limit)
			.map((id) => claimed(id, input.kind, now + LEASE_MS));
	});
}

/** A claim whose due rows never run out. */
function backlog(prefix: string) {
	let n = 0;
	return vi.fn<Claim>(async (input) => {
		const now = await env.currentTimeMs();
		return Array.from({ length: input.limit }, () => {
			n++;
			return claimed(`${prefix}${n}`, input.kind, now + LEASE_MS);
		});
	});
}

/** One claim activity that answers each kind with its own handler. */
function byKind(handlers: Record<string, Claim>) {
	return vi.fn<Claim>(async (input) => {
		const handler = handlers[input.kind];
		if (!handler) {
			throw new Error(`no handler for kind ${input.kind}`);
		}
		return handler(input);
	});
}

/**
 * A check that takes 85 s of server time, or ends 10 s before the poll's
 * deadline when that is sooner.
 */
async function slowCheck(
	input: InstructionSyncCheckInput,
): Promise<InstructionSyncCheckResult> {
	const left = Date.parse(input.deadlineAt) - (await env.currentTimeMs());
	await env.sleep(Math.min(85_000, left - 10_000));
	return { outcome: "evaluated" };
}

function pollMocks(overrides: Record<string, unknown> = {}) {
	return {
		sweepInstructionSyncTempDirs: vi.fn(async () => ({ removed: 0 })),
		claimDueInstructionSyncChecks: due(),
		checkInstructionSyncRemoteHead: vi.fn(
			async (
				_input: InstructionSyncCheckInput,
			): Promise<InstructionSyncCheckResult> => ({
				outcome: "evaluated",
			}),
		),
		...overrides,
	};
}

let seq = 0;

/**
 * Runs one poll to completion. `args` is empty, as the schedule sends,
 * unless a test passes `{ kinds }` (Decision 52).
 *
 * There is no case for a worker that serves no activities: the time-skipping
 * test server does not advance time while an activity task sits unserved,
 * so such a run would wait out its 240 s budget in real time. The hung-check
 * case below exercises the same schedule-to-close instead.
 */
async function run(
	activities: Record<string, unknown>,
	args: [InstructionSyncPollInput?] = [],
): Promise<{
	result: InstructionSyncPollResult;
	runId: string;
	workflowId: string;
}> {
	const taskQueue = `instruction-poll-${seq++}`;
	const workflowId = `${taskQueue}-wf`;
	const worker = await Worker.create({
		connection: env.nativeConnection,
		taskQueue,
		workflowBundle,
		activities,
	});
	let runId = "";
	const result = await worker.runUntil(
		(async () => {
			const handle = await env.client.workflow.start(WORKFLOW_NAME, {
				args,
				taskQueue,
				workflowId,
			});
			runId = handle.firstExecutionRunId;
			return handle.result();
		})(),
	);
	return { result: result as InstructionSyncPollResult, runId, workflowId };
}

/** Replays the run's own history against the current bundle (Decision 12). */
async function expectReplays(workflowId: string): Promise<void> {
	const history = await env.client.workflow
		.getHandle(workflowId)
		.fetchHistory();
	await expect(
		Worker.runReplayHistory({ workflowBundle }, history, workflowId),
	).resolves.toBeUndefined();
}

describe("projectInstructionRepositoryPollWorkflow (spec §6.1, §8.2)", () => {
	it("sweeps first, claims as many rows as lanes are free, and checks each with the poll's run id and one shared deadline (Decisions 49 and 50)", async () => {
		const claim = due("a", "b");
		const check = vi.fn(
			async (
				_input: InstructionSyncCheckInput,
			): Promise<InstructionSyncCheckResult> => ({
				outcome: "evaluated",
			}),
		);
		const mocks = pollMocks({
			claimDueInstructionSyncChecks: claim,
			checkInstructionSyncRemoteHead: check,
		});
		const startedAt = await env.currentTimeMs();
		const { result, runId } = await run(mocks);

		expect(result).toEqual({ ...ZERO, claimed: 2, evaluated: 2 });
		expect(mocks.sweepInstructionSyncTempDirs).toHaveBeenCalledTimes(1);
		expect(
			mocks.sweepInstructionSyncTempDirs.mock.invocationCallOrder[0],
		).toBeLessThan(claim.mock.invocationCallOrder[0] ?? 0);
		// Four free lanes, one kind: one claim of four. It came back short, so
		// nothing more is due and the kind is not claimed again this tick.
		expect(claim.mock.calls).toEqual([
			[{ kind: "instructions", limit: 4 }],
		]);

		const deadlineAt = check.mock.calls[0]?.[0].deadlineAt ?? "";
		for (const id of ["a", "b"]) {
			expect(check).toHaveBeenCalledWith({
				...claimed(id, "instructions", 0),
				leaseUntil: expect.any(String),
				pollRunId: runId,
				deadlineAt,
			});
		}
		// The budget's end: four minutes after the run began.
		expect(Date.parse(deadlineAt) - startedAt).toBeGreaterThanOrEqual(
			INSTRUCTION_SYNC_POLL_BUDGET_MS,
		);
		expect(Date.parse(deadlineAt) - startedAt).toBeLessThan(
			INSTRUCTION_SYNC_POLL_BUDGET_MS + 5_000,
		);
	});

	it("claims each registered subject kind by default, and hands each check its claimed kind (Decision 46)", async () => {
		const mocks = pollMocks({ claimDueInstructionSyncChecks: due("a") });
		await run(mocks);

		// Every kind is claimed once in the first wave; each came back short,
		// so each is closed and the run ends.
		expect(
			mocks.claimDueInstructionSyncChecks.mock.calls.map(
				([input]) => input.kind,
			),
		).toEqual([...REPOSITORY_SYNC_SUBJECT_KINDS]);
		expect(mocks.checkInstructionSyncRemoteHead).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "instructions", id: "a" }),
		);
	});

	it("only sweeps when nothing is due", async () => {
		const mocks = pollMocks();
		const { result } = await run(mocks);
		expect(result).toEqual(ZERO);
		expect(mocks.claimDueInstructionSyncChecks).toHaveBeenCalledTimes(1);
		expect(mocks.checkInstructionSyncRemoteHead).not.toHaveBeenCalled();
	});

	it("counts every outcome, and a thrown check once as failed without retrying it", async () => {
		const outcomes: Record<string, InstructionSyncCheckOutcome> = {
			s1: "started",
			s2: "already_running",
			s3: "evaluated",
			s4: "suppressed",
			s5: "ref_missing",
			s6: "permission_revoked",
			s7: "transient",
			s8: "stale",
		};
		const check = vi.fn(
			async (
				input: InstructionSyncCheckInput,
			): Promise<InstructionSyncCheckResult> => {
				const outcome = outcomes[input.id];
				if (!outcome) {
					throw new Error("ls-remote crashed");
				}
				return { outcome };
			},
		);
		const { result } = await run(
			pollMocks({
				claimDueInstructionSyncChecks: due(
					"s1",
					"s2",
					"s3",
					"s4",
					"s5",
					"s6",
					"s7",
					"s8",
					"s9",
				),
				checkInstructionSyncRemoteHead: check,
			}),
		);

		expect(result).toEqual({
			claimed: 9,
			started: 1,
			alreadyRunning: 1,
			evaluated: 1,
			suppressed: 1,
			refMissing: 1,
			permissionRevoked: 1,
			transient: 1,
			stale: 1,
			failed: 1,
			deferred: 0,
			claimFailed: 0,
		});
		// One attempt: the lease, not a retry, brings a crashed check back.
		expect(
			check.mock.calls.filter(([input]) => input.id === "s9"),
		).toHaveLength(1);
	});

	it("checks at most four rows at a time", async () => {
		let inFlight = 0;
		let maxInFlight = 0;
		const { result } = await run(
			pollMocks({
				claimDueInstructionSyncChecks: due(
					"s1",
					"s2",
					"s3",
					"s4",
					"s5",
					"s6",
					"s7",
					"s8",
				),
				checkInstructionSyncRemoteHead: vi.fn(
					async (): Promise<InstructionSyncCheckResult> => {
						inFlight++;
						maxInFlight = Math.max(maxInFlight, inFlight);
						await delay(50);
						inFlight--;
						return { outcome: "evaluated" };
					},
				),
			}),
		);
		expect(result.evaluated).toBe(8);
		expect(maxInFlight).toBeLessThanOrEqual(4);
		expect(maxInFlight).toBeGreaterThanOrEqual(2);
	});

	it("carries on after a failed sweep, which it does not retry", async () => {
		const sweep = vi.fn(async (): Promise<{ removed: number }> => {
			throw new Error("EACCES");
		});
		const { result } = await run(
			pollMocks({
				sweepInstructionSyncTempDirs: sweep,
				claimDueInstructionSyncChecks: due("a"),
			}),
		);
		expect(result).toEqual({ ...ZERO, claimed: 1, evaluated: 1 });
		expect(sweep).toHaveBeenCalledTimes(1);
	});

	it("retries a failed claim, up to three attempts", async () => {
		let calls = 0;
		const { result } = await run(
			pollMocks({
				claimDueInstructionSyncChecks: vi.fn(
					async (): Promise<ClaimedInstructionSyncCheck[]> => {
						calls++;
						if (calls < 3) {
							throw new Error("connection reset");
						}
						return [];
					},
				),
			}),
		);
		expect(result).toEqual(ZERO);
		expect(calls).toBe(3);
	});

	it("keeps every lane busy with per-wave claims until the reserve, never claiming more than the lanes free, and the run replays (Decisions 32 and 49)", async () => {
		const claim = backlog("r");
		const check = vi.fn(slowCheck);
		const { result, workflowId } = await run(
			pollMocks({
				claimDueInstructionSyncChecks: claim,
				checkInstructionSyncRemoteHead: check,
			}),
		);

		// Lanes fill at about 0 s, 85 s and 170 s (70 s left, over the
		// reserve; those checks end at about 230 s, 10 s before the deadline).
		// At 230 s only 10 s remain, so nothing more is claimed.
		expect(result).toEqual({ ...ZERO, claimed: 12, evaluated: 12 });
		expect(check).toHaveBeenCalledTimes(12);
		const limits = claim.mock.calls.map(([input]) => input.limit);
		expect(limits[0]).toBe(4);
		expect(Math.max(...limits)).toBeLessThanOrEqual(4);
		// Every claimed row was dispatched: none waited for a lane.
		expect(limits.reduce((sum, limit) => sum + limit, 0)).toBe(12);
		await expectReplays(workflowId);
	});

	it("stops claiming at the tick's claim cap while budget remains, leaving the rest to the next tick, and the run replays (Fizzy #2685)", async () => {
		// Instant checks: the budget alone would let this backlog run for
		// the whole four minutes, so only the cap can end the claiming.
		const claim = backlog("c");
		const startedAt = await env.currentTimeMs();
		const { result, workflowId } = await run(
			pollMocks({ claimDueInstructionSyncChecks: claim }),
		);
		const elapsed = (await env.currentTimeMs()) - startedAt;

		expect(result).toEqual({
			...ZERO,
			claimed: INSTRUCTION_SYNC_POLL_CLAIM_CAP,
			evaluated: INSTRUCTION_SYNC_POLL_CLAIM_CAP,
		});
		// Budget was left: the run ended well before the reserve, not at it.
		expect(elapsed).toBeLessThan(
			INSTRUCTION_SYNC_POLL_BUDGET_MS - INSTRUCTION_SYNC_CHECK_RESERVE_MS,
		);
		const limits = claim.mock.calls.map(([input]) => input.limit);
		expect(Math.max(...limits)).toBeLessThanOrEqual(4);
		// No claim asked for a row past the cap.
		expect(limits.reduce((sum, limit) => sum + limit, 0)).toBe(
			INSTRUCTION_SYNC_POLL_CLAIM_CAP,
		);
		await expectReplays(workflowId);
	}, 120_000);

	it("does not dispatch a claimed row with less lease left than the check's 90 s start-to-close, and claims nothing more that tick (Decision 49)", async () => {
		const claim = vi.fn<Claim>(async (input) => {
			const now = await env.currentTimeMs();
			return [
				claimed("fresh", input.kind, now + LEASE_MS),
				claimed("short", input.kind, now + 60_000),
			];
		});
		const check = vi.fn(
			async (
				_input: InstructionSyncCheckInput,
			): Promise<InstructionSyncCheckResult> => ({
				outcome: "evaluated",
			}),
		);
		const { result } = await run(
			pollMocks({
				claimDueInstructionSyncChecks: claim,
				checkInstructionSyncRemoteHead: check,
			}),
		);

		expect(result).toEqual({
			...ZERO,
			claimed: 2,
			evaluated: 1,
			deferred: 1,
		});
		expect(check).toHaveBeenCalledTimes(1);
		expect(check).toHaveBeenCalledWith(
			expect.objectContaining({ id: "fresh" }),
		);
		expect(claim).toHaveBeenCalledTimes(1);
	});

	it("defers a whole wave whose claim returned under the reserve, and claims nothing more (Decisions 32 and 49)", async () => {
		let firstClaimAt: number | undefined;
		let slowAttempts = 0;
		const rows = backlog("r");
		const claim = vi.fn<Claim>(async (input) => {
			const now = await env.currentTimeMs();
			firstClaimAt ??= now;
			if (now - firstClaimAt >= 160_000) {
				// The third wave: its first attempt fails after 20 s, and its
				// retry returns rows after another 20 s, with fresh leases.
				slowAttempts++;
				await env.sleep(20_000);
				if (slowAttempts === 1) {
					throw new Error("connection reset");
				}
			}
			return rows(input);
		});
		const check = vi.fn(slowCheck);
		const { result } = await run(
			pollMocks({
				claimDueInstructionSyncChecks: claim,
				checkInstructionSyncRemoteHead: check,
			}),
		);

		// The lanes free at about 170 s. The claim fails at about 190 s and its
		// retry returns at about 211 s, with 29 s left: under the reserve, so
		// no lane dispatches, however many rows the wave held, and the run
		// makes no further claim.
		expect(slowAttempts).toBe(2);
		expect(check).toHaveBeenCalledTimes(8);
		expect(result.evaluated).toBe(8);
		expect(result.deferred).toBe(result.claimed - 8);
		expect(result.deferred).toBeGreaterThanOrEqual(1);
		expect(result.deferred).toBeLessThanOrEqual(4);
		expect(result.claimFailed).toBe(0);
	});

	it("rotates claims across subject kinds, so a deep backlog of slow checks in one kind never keeps another kind's due rows waiting (Decision 52)", async () => {
		const instructions = backlog("i");
		const fake = due("f1", "f2");
		const claim = byKind({ instructions, fake });
		const fakeCheckedAt: number[] = [];
		const check = vi.fn(
			async (
				input: InstructionSyncCheckInput,
			): Promise<InstructionSyncCheckResult> => {
				if (input.kind === FAKE) {
					fakeCheckedAt.push(await env.currentTimeMs());
					return { outcome: "evaluated" };
				}
				return slowCheck(input);
			},
		);
		const startedAt = await env.currentTimeMs();
		const { result, workflowId } = await run(
			pollMocks({
				claimDueInstructionSyncChecks: claim,
				checkInstructionSyncRemoteHead: check,
			}),
			[{ kinds: ["instructions", FAKE] }],
		);

		// The first wave has four free lanes and two open kinds: two each.
		expect(claim.mock.calls.slice(0, 2)).toEqual([
			[{ kind: "instructions", limit: 2 }],
			[{ kind: FAKE, limit: 2 }],
		]);
		// Both fake rows were checked while the first slow checks still ran.
		expect(fakeCheckedAt).toHaveLength(2);
		for (const at of fakeCheckedAt) {
			expect(at - startedAt).toBeLessThan(85_000);
		}
		// Twelve slow checks fill the lanes until the reserve, as with one
		// kind, plus the two fake rows.
		expect(result).toEqual({ ...ZERO, claimed: 14, evaluated: 14 });
		await expectReplays(workflowId);
	});

	it("isolates a claim that throws to its own kind: the other kind is still claimed and checked, and the failure is counted (Decision 52)", async () => {
		const instructions = vi.fn<Claim>(async () => {
			throw new Error("relation does not exist");
		});
		const fake = due("f1", "f2");
		const check = vi.fn(
			async (
				_input: InstructionSyncCheckInput,
			): Promise<InstructionSyncCheckResult> => ({
				outcome: "evaluated",
			}),
		);
		const { result } = await run(
			pollMocks({
				claimDueInstructionSyncChecks: byKind({ instructions, fake }),
				checkInstructionSyncRemoteHead: check,
			}),
			[{ kinds: ["instructions", FAKE] }],
		);

		expect(result).toEqual({
			...ZERO,
			claimed: 2,
			evaluated: 2,
			claimFailed: 1,
		});
		// Three attempts, then the kind is closed for the tick.
		expect(instructions).toHaveBeenCalledTimes(3);
		expect(check).toHaveBeenCalledWith(
			expect.objectContaining({ kind: FAKE, id: "f1" }),
		);
		expect(check).toHaveBeenCalledWith(
			expect.objectContaining({ kind: FAKE, id: "f2" }),
		);
	});

	it("ends at its budget when checks outlast it, because each check's schedule-to-close is the budget left, and the run replays (Decision 32)", async () => {
		// Checks that would run 1 s past the budget's end, as a check whose
		// JavaScript Temporal cannot stop might (Decision 50).
		const check = vi.fn(
			async (
				input: InstructionSyncCheckInput,
			): Promise<InstructionSyncCheckResult> => {
				const left =
					Date.parse(input.deadlineAt) - (await env.currentTimeMs());
				await env.sleep(Math.min(85_000, left + 1_000));
				return { outcome: "evaluated" };
			},
		);
		const { result, workflowId } = await run(
			pollMocks({
				claimDueInstructionSyncChecks: backlog("r"),
				checkInstructionSyncRemoteHead: check,
			}),
		);

		// The lanes dispatched at about 170 s had 70 s of budget left as their
		// schedule-to-close. Temporal failed them at the budget's end, before
		// they answered, and nothing was left to claim with.
		expect(result).toEqual({
			...ZERO,
			claimed: 12,
			evaluated: 8,
			failed: 4,
		});
		const { startTime, closeTime } = await env.client.workflow
			.getHandle(workflowId)
			.describe();
		const elapsed =
			(closeTime?.getTime() ?? Number.POSITIVE_INFINITY) -
			startTime.getTime();
		expect(elapsed).toBeGreaterThanOrEqual(INSTRUCTION_SYNC_POLL_BUDGET_MS);
		expect(elapsed).toBeLessThan(INSTRUCTION_SYNC_POLL_BUDGET_MS + 5_000);
		await expectReplays(workflowId);
	});
});
