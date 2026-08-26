/**
 * Behavioral (TestWorkflowEnvironment) tests for
 * `publishingNotificationReconcileWorkflow` — Publishing Suite 1C-2d-2a.
 * Fizzy #2213.
 *
 * WHY A REAL EXECUTION AND NOT A MIRRORED BODY. The first cut of this file
 * re-implemented the workflow as a four-line local function and asserted that
 * those four lines did what those four lines say. It could not fail: emptying
 * the production module left it green, and so did deleting the module outright.
 * A test that stays green when the code under test is gone is not coverage of
 * that code, however trivial the body is — and this workflow is the ALERT that
 * tells an operator publishing work is stuck, so its one property (the activity
 * runs, once, and a failure is surfaced rather than swallowed) is exactly the
 * one that must not be able to rot unnoticed.
 *
 * Mirrors `src/workflows/__tests__/publishing-suggestion-workflow.test.ts` and
 * `__tests__/daily-brief-workflow-convergence.test.ts`: spins up a local
 * time-skipping Temporal test server, bundles the REAL workflow code from the
 * workflows barrel, injects a mocked activity, and asserts observable behavior.
 * Bundling the barrel also means these cases fail if the workflow is ever
 * dropped from `src/workflows/index.ts` — `execute()` by name is what proves
 * the export, so the registration needs no separate case.
 *
 * REPLAY DETERMINISM IS NOT COVERED ELSEWHERE YET, and the first cut of this
 * file said it was. Exporting from the barrel is necessary but NOT sufficient:
 * `scripts/fetch-replay-histories.ts` builds fixtures by querying dev for
 * executions PER WORKFLOW TYPE inside a `--since-days` window, and
 * `replay-validation.test.ts` iterates the fixture directories that produces.
 * A workflow type that has never run in dev yields no directory and therefore
 * no coverage. This one enters replay validation only after the schedule lands,
 * it runs in dev, and a later fetch picks it up — so at ship time it is outside
 * that job, and these cases are the only behavioral coverage it has.
 *
 * Offline note: `TestWorkflowEnvironment.createTimeSkipping()` downloads a
 * Temporal test-server binary on first use. In a network-restricted environment
 * `beforeAll` will fail; run once online to populate the binary cache.
 *
 * Run with:
 *   pnpm --filter @repo/temporal exec vitest run __tests__/publishing-reconcile/reconcile-workflow.test.ts
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ActivityFailure, WorkflowFailedError } from "@temporalio/client";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import {
	bundleWorkflowCode,
	Worker,
	type WorkflowBundleWithSourceMap,
} from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
	AbandonStalePublishingCyclesOutput,
	DrainDeferredNotificationsOutput,
	ReclaimPublishingNotificationStatesOutput,
} from "../../src/activities";
import {
	PUBLISHING_RECONCILE_DRAIN_PATCH,
	PUBLISHING_RECONCILE_LEDGER_PATCH,
	type PublishingNotificationReconcileOutput,
} from "../../src/workflows/publishing-notification-reconcile";

// `__dirname` is __tests__/publishing-reconcile, so the barrel is two levels up
// and across into src. Webpack resolves the .ts graph internally.
const WORKFLOWS_PATH = resolve(__dirname, "..", "..", "src", "workflows");
const WORKFLOW_NAME = "publishingNotificationReconcileWorkflow";

/**
 * Typed against the activity's real return shape rather than left as a bare
 * object literal: a field added to `AbandonStalePublishingCyclesOutput` by
 * 1C-2d-2b would otherwise make this fixture a silent subset, and the
 * "returns the activity output verbatim" case would keep passing against a
 * payload that no longer resembles the one the workflow returns in production.
 */
const CYCLES: AbandonStalePublishingCyclesOutput = {
	scanned: 3,
	abandoned: 1,
	lost: 0,
	batches: 1,
	usedBatchBudget: false,
	moreWorkRemains: false,
	enrolled: 0,
	nullClockResidual: 0,
	nullClockResidualCapped: false,
	// An ARBITRARY fixture value that happens to equal today's staleness bound,
	// NOT a copy of it. The workflow neither computes staleness nor reads this
	// field — it returns the activity's payload verbatim, which is exactly what
	// the case below asserts — so nothing here moves when the bound moves.
	// Called out because Task 10's whole-repo sweep for the bound finds this
	// line, and a reader who classified it as a fourth representation would go
	// looking for an import that should not exist.
	staleAfterMs: 7_200_000,
};

/**
 * Typed for the same reason `CYCLES` is: 1C-2d-2b-2 adds a fifth transition key
 * and a fourth statement key, and an untyped literal would let this fixture
 * become a silent subset of what the workflow actually returns.
 */
const LEDGER: ReclaimPublishingNotificationStatesOutput = {
	counts: {
		EXPIRE_DEFERRED: 2,
		EXPIRE_SENDING: 1,
		FAIL_SENDING_AT_BOUND: 0,
		RECLAIM_SENDING_LEASE: 3,
	},
	batches: { EXPIRE_DEFERRED: 1, RECONCILE_SENDING: 1 },
	usedBatchBudget: [],
	moreWorkRemains: [],
	// An ARBITRARY fixture instant, not a clock this test reads. The workflow
	// neither computes it nor inspects it — it returns the activity's payload
	// verbatim, which is what the case below asserts.
	sweptAt: "2026-09-01T12:00:00.000Z",
};

/**
 * Typed for the same reason its two siblings are: a field added to the drain's
 * output would otherwise make this fixture a silent subset, and the "returns
 * every activity output verbatim" case would keep passing against a payload that
 * no longer resembles the one the workflow returns in production.
 */
const DRAIN: DrainDeferredNotificationsOutput = {
	mailConfigured: true,
	scanned: 4,
	sent: 3,
	skipped: {
		RECONCILE_TENANT_CHANGED: 0,
		RECONCILE_NOTIFICATIONS_DISABLED: 1,
		RECONCILE_RECIPIENT_UNAUTHORIZED: 0,
		NO_EMAIL_ADDRESS: 0,
	},
	dischargedAtBound: 0,
	failed: 0,
	held: 0,
	notClaimable: 0,
	sentPastDedupeWindow: 0,
	batches: 1,
	usedBatchBudget: false,
	moreWorkRemains: false,
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

let taskQueueSeq = 0;

interface RunCaptures {
	output: PublishingNotificationReconcileOutput;
	/** One entry per ATTEMPT, holding the arguments that attempt received. */
	calls: unknown[][];
	/** The same, for the ledger activity. */
	reclaimCalls: unknown[][];
	/** The same, for the drain activity. */
	drainCalls: unknown[][];
}

/**
 * BOTH activity implementations are injectable as of 1C-2d-2b-1. `reclaim`
 * defaults to returning the LEDGER fixture, so the 2a cases that only care
 * about the cycle half read exactly as they did.
 */
async function runWorkflow(
	abandon: () => Promise<AbandonStalePublishingCyclesOutput>,
	calls: unknown[][] = [],
	reclaim: () => Promise<ReclaimPublishingNotificationStatesOutput> = async () =>
		LEDGER,
	reclaimCalls: unknown[][] = [],
	drain: () => Promise<DrainDeferredNotificationsOutput> = async () => DRAIN,
	drainCalls: unknown[][] = [],
): Promise<RunCaptures> {
	const activities = {
		abandonStalePublishingCycles: async (...args: unknown[]) => {
			calls.push(args);
			return abandon();
		},
		reclaimPublishingNotificationStates: async (...args: unknown[]) => {
			reclaimCalls.push(args);
			return reclaim();
		},
		drainDeferredPublishingNotifications: async (...args: unknown[]) => {
			drainCalls.push(args);
			return drain();
		},
	};

	const taskQueue = `publishing-reconcile-${taskQueueSeq++}`;
	const worker = await Worker.create({
		connection: env.nativeConnection,
		taskQueue,
		workflowBundle,
		activities,
	});

	const output = (await worker.runUntil(
		env.client.workflow.execute(WORKFLOW_NAME, {
			args: [],
			taskQueue,
			workflowId: `${taskQueue}-wf`,
		}),
	)) as PublishingNotificationReconcileOutput;

	return { output, calls, reclaimCalls, drainCalls };
}

/** Every error in a `cause` chain, outermost first. */
function causeChain(error: unknown): unknown[] {
	const chain: unknown[] = [];
	let current = error;
	while (current instanceof Error) {
		chain.push(current);
		current = current.cause;
	}
	return chain;
}

describe("publishingNotificationReconcileWorkflow", () => {
	it("calls each activity exactly once, with no arguments", async () => {
		const { calls, reclaimCalls, drainCalls } = await runWorkflow(
			async () => CYCLES,
		);

		expect(calls).toHaveLength(1);
		expect(calls[0]).toEqual([]);
		expect(reclaimCalls).toHaveLength(1);
		expect(reclaimCalls[0]).toEqual([]);
		expect(drainCalls).toHaveLength(1);
		expect(drainCalls[0]).toEqual([]);
	});

	it("returns every activity output verbatim", async () => {
		const { output } = await runWorkflow(async () => CYCLES);

		expect(output).toEqual({
			cycles: CYCLES,
			ledger: LEDGER,
			drain: DRAIN,
		});
	});

	// THE CASES 2a COULD NOT WRITE, because none is expressible against a
	// workflow with one activity. They are the executable form of the ordering
	// rule: the ALERT first, then the transitions, then the send.
	it("runs the cycle sweep, then the ledger reclaim, then the drain", async () => {
		const order: string[] = [];
		const { output } = await runWorkflow(
			async () => {
				order.push("cycles");
				return CYCLES;
			},
			[],
			async () => {
				order.push("ledger");
				return LEDGER;
			},
			[],
			async () => {
				order.push("drain");
				return DRAIN;
			},
		);

		// The ALERT first — ABANDONED is what surfaces work that is stuck, and a
		// failure further down must not be able to suppress it. And PASS 1 BEFORE
		// THE MAIL GATE, which is the ordering parent §9.9 is entirely about: the
		// gate lives inside the third activity, so expiry and reclamation happen
		// on a keyless worker rather than being skipped on precisely the
		// deployments that produced the backlog. Reorder the awaits and this goes
		// red.
		expect(order).toEqual(["cycles", "ledger", "drain"]);
		expect(output.drain).toEqual(DRAIN);
	});

	it("does not run the drain when the ledger reclaim throws", async () => {
		const drainCalls: unknown[][] = [];

		const failure = await runWorkflow(
			async () => CYCLES,
			[],
			async () => {
				throw new Error("ledger reclaim failed");
			},
			[],
			async () => DRAIN,
			drainCalls,
		).then(
			() => {
				throw new Error(
					"expected the workflow to fail, but it completed",
				);
			},
			(error: unknown) => error,
		);

		expect(causeChain(failure).map((e) => (e as Error).message)).toContain(
			"ledger reclaim failed",
		);
		// NO try/catch around the second call either. Without this, the ordering
		// case above is satisfied by a workflow that catches and continues — which
		// would report a green run over a failed pass, the silent-failure shape
		// this project has already been bitten by.
		expect(drainCalls).toHaveLength(0);
	});

	// THE MARKER, PINNED BY VALUE. A live execution always takes the patched
	// branch, so every case in this file would stay green if the string changed
	// — and changing it re-breaks replay of every history recorded under the old
	// one, which is a failure that surfaces in a different job, on a different
	// PR, as "Activity machine does not handle this event".
	//
	// This does NOT test the false branch. Doing that needs a recorded history
	// from before the second activity existed, which only the replay-validation
	// job has; the guard's whole purpose is to make that job pass. What this
	// pins is the one input to it that a future edit could silently move.
	it("guards the ledger call with a stable patch marker", () => {
		expect(PUBLISHING_RECONCILE_LEDGER_PATCH).toBe(
			"publishing-reconcile-ledger-pass-1",
		);

		const source = readFileSync(
			resolve(
				__dirname,
				"..",
				"..",
				"src",
				"workflows",
				"publishing-notification-reconcile.ts",
			),
			"utf8",
		);
		// Asserted on the SOURCE because the marker's effect is invisible to a
		// live execution: the second activity must sit behind the guard, and the
		// first must not.
		//
		// WHITESPACE-INSENSITIVE ON PURPOSE. The first cut of this assertion
		// carried the formatter's exact line break, so it went red on a reflow
		// and would have stayed green on the one edit it exists to catch. A
		// guard whose failure depends on where a formatter wrapped is not a
		// guard — the same lesson the SQL precedence check in
		// `publishing-reconcile-sweep.test.ts` records.
		const body = source.slice(source.indexOf("export async function"));
		expect(
			/patched\(\s*PUBLISHING_RECONCILE_LEDGER_PATCH\s*\)\s*\?\s*await\s+reclaimPublishingNotificationStates\(\)/.test(
				body,
			),
		).toBe(true);
		// And the FIRST activity must NOT be behind it — a marker whose false
		// branch skipped an activity every recorded history DOES contain is the
		// mirror image of the divergence this prevents.
		expect(
			/const\s+cycles\s*=\s*await\s+abandonStalePublishingCycles\(\)/.test(
				body,
			),
		).toBe(true);
	});

	it("guards the drain call with its OWN marker, not the ledger's", () => {
		// TWO CHANGES, TWO MARKERS. Reusing the ledger's would make it answer
		// `true` for histories that contain the ledger call and NOT the drain call,
		// and the replayer would then look for a ScheduleActivityTask those
		// histories do not have — the divergence a marker exists to prevent,
		// produced by the marker itself. Pinned by VALUE for the same reason the
		// first one is: a live execution always takes the patched branch, so no
		// behavioural case in this file can see the string move.
		expect(PUBLISHING_RECONCILE_DRAIN_PATCH).toBe(
			"publishing-reconcile-drain-pass-3",
		);
		expect(PUBLISHING_RECONCILE_DRAIN_PATCH).not.toBe(
			PUBLISHING_RECONCILE_LEDGER_PATCH,
		);

		const source = readFileSync(
			resolve(
				__dirname,
				"..",
				"..",
				"src",
				"workflows",
				"publishing-notification-reconcile.ts",
			),
			"utf8",
		);
		const body = source.slice(source.indexOf("export async function"));
		// Whitespace-insensitive, for the reason recorded on the case above.
		expect(
			/patched\(\s*PUBLISHING_RECONCILE_DRAIN_PATCH\s*\)\s*\?\s*await\s+drainDeferredPublishingNotifications\(\)/.test(
				body,
			),
		).toBe(true);
	});

	it("does not read the mail configuration in the WORKFLOW", () => {
		// The gate belongs to the third ACTIVITY. Hoisted here it would be process
		// state read inside a deterministic context — recorded into history once
		// and replayed forever — and it would return before pass 1 on a keyless
		// worker, stranding stale rows on exactly the deployments that produced
		// them. Asserted on the source because a live execution with a key
		// configured cannot tell the two placements apart.
		const source = readFileSync(
			resolve(
				__dirname,
				"..",
				"..",
				"src",
				"workflows",
				"publishing-notification-reconcile.ts",
			),
			"utf8",
		);
		const body = source.slice(source.indexOf("export async function"));
		expect(body).not.toContain("isMailConfigured");
		expect(source).not.toContain('from "@repo/mail"');
	});

	it("does not run the ledger reclaim when the cycle sweep throws", async () => {
		const reclaimCalls: unknown[][] = [];

		const failure = await runWorkflow(
			async () => {
				throw new Error("cycle sweep failed");
			},
			[],
			async () => LEDGER,
			reclaimCalls,
		).then(
			() => {
				throw new Error(
					"expected the workflow to fail, but it completed",
				);
			},
			(error: unknown) => error,
		);

		expect(causeChain(failure).map((e) => (e as Error).message)).toContain(
			"cycle sweep failed",
		);
		// NO try/catch: the alert failing stops the run rather than being swallowed
		// into a partial success. Without this assertion the ordering case above is
		// satisfied by a workflow that catches and continues — which is the exact
		// shape Decision 20 rejects, and the one that would report a green sweep
		// over a failed alert. Across all THREE attempts, not just the first.
		expect(reclaimCalls).toHaveLength(0);
	});

	it("surfaces an activity failure rather than reporting success", async () => {
		// No try/catch in the workflow: one that reported success while its work
		// threw would be the silent failure this shape exists to avoid. The next
		// hourly tick re-runs it from scratch — every transition is idempotent
		// and every batch commits independently.
		//
		// ASSERTED ON THE CAUSE CHAIN, NOT THE TOP-LEVEL MESSAGE. A real
		// execution reports `WorkflowFailedError: Workflow execution failed` and
		// carries the activity's own error nested beneath it; the mirrored body
		// this file replaced asserted `.rejects.toThrow("cycle sweep failed")`,
		// a message Temporal never puts at the top level. Walking the chain is
		// also the stronger claim: it proves the workflow failed IN THE ACTIVITY
		// with the activity's own error, which a bare `.rejects` cannot
		// distinguish from a workflow that failed for some unrelated reason.
		const calls: unknown[][] = [];

		const failure = await runWorkflow(async () => {
			throw new Error("cycle sweep failed");
		}, calls).then(
			() => {
				throw new Error(
					"expected the workflow to fail, but it completed",
				);
			},
			(error: unknown) => error,
		);

		const chain = causeChain(failure);
		expect(failure).toBeInstanceOf(WorkflowFailedError);
		expect(chain.some((e) => e instanceof ActivityFailure)).toBe(true);
		expect(chain.map((e) => (e as Error).message)).toContain(
			"cycle sweep failed",
		);

		// Bounded, not infinite: `maximumAttempts` is 3. Asserted here because a
		// retry policy widened to `maximumAttempts: 0` (unlimited) would leave
		// everything above green while turning a wedged sweep into a run that
		// never surfaces at all.
		expect(calls).toHaveLength(3);
	});
});
