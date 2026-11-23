/**
 * Duplicate detection on a spent ChatGPT plan (Fizzy #3538): the verifier may
 * run on an organization's shared plan accounts. When every one is spent, the
 * scan activity fails with the plan's own error; the workflow does not retry
 * it, waits for the estimated reset, and makes that run once more. A second
 * refusal fails the run. Any other failure keeps the activity's own retries
 * and is not waited on.
 *
 * The activity stub throws the class the real activity throws, so Temporal
 * turns it into the ActivityFailure the workflow receives, under the
 * workflow's own retry policy. Time-skipping makes the hours pass instantly.
 */

import { resolve } from "node:path";
import { SubscriptionPlanExhaustedError } from "@repo/agent-types/chatgpt-plan-fetch";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import {
	bundleWorkflowCode,
	Worker,
	type WorkflowBundleWithSourceMap,
} from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const WORKFLOW_PATH = resolve(__dirname, "..", "detect-duplicates.ts");
const HOUR = 60 * 60_000;

let env: TestWorkflowEnvironment;
let bundle: WorkflowBundleWithSourceMap;
let taskQueueSeq = 0;

beforeAll(async () => {
	env = await TestWorkflowEnvironment.createTimeSkipping();
	bundle = await bundleWorkflowCode({ workflowsPath: WORKFLOW_PATH });
}, 180_000);

afterAll(async () => {
	await env?.teardown();
});

const INPUT = {
	projectId: "proj-1",
	userId: "user-1",
	organizationId: "org-1",
	targetStoryIds: ["story-1"],
};

type Run = {
	scanned: number;
	candidates: number;
	confirmed: number;
	truncated: number;
	verifierFailures: number;
};

const done = (truncated = 0): Run => ({
	scanned: 3,
	candidates: 2,
	confirmed: 1,
	truncated,
	verifierFailures: 0,
});

const spent = (): Run => {
	throw new SubscriptionPlanExhaustedError(
		"Every ChatGPT plan this work may use has no usage left in this window.",
		null,
	);
};

async function run(attempts: Array<() => Run>) {
	const taskQueue = `dup-plan-wait-${++taskQueueSeq}`;
	let calls = 0;
	/** Test-server time at each scan call, to measure the waits between. */
	const callTimes: number[] = [];
	const estimates: unknown[] = [];
	const notices: unknown[] = [];
	const worker = await Worker.create({
		connection: env.nativeConnection,
		taskQueue,
		workflowBundle: bundle,
		activities: {
			detectDuplicateStoriesActivity: async () => {
				callTimes.push(await env.currentTimeMs());
				const attempt = attempts[calls++];
				if (!attempt) {
					throw new Error("called too often");
				}
				return attempt();
			},
			estimatePlanPoolResetActivity: async (input: unknown) => {
				estimates.push(input);
				return { waitMs: 3 * HOUR, jitterMs: 0 };
			},
			notifyPlanWaitWorkStoppedActivity: async (input: unknown) => {
				notices.push(input);
			},
		},
	});
	const handle = await env.client.workflow.start("detectDuplicatesWorkflow", {
		taskQueue,
		workflowId: `${taskQueue}-wf`,
		args: [INPUT],
	});
	const outcome = await worker.runUntil(
		handle.result().then(
			(value) => ({ ok: true as const, value }),
			(error: unknown) => ({ ok: false as const, error }),
		),
	);
	const gapMs = (n: number) => (callTimes[n] ?? 0) - (callTimes[n - 1] ?? 0);
	return { outcome, calls: () => calls, estimates, notices, gapMs };
}

/** The activity failure's own type, under the workflow failure. */
function failureType(error: unknown): unknown {
	return (error as { cause?: { cause?: { type?: unknown } } }).cause?.cause
		?.type;
}

describe("detectDuplicatesWorkflow — a spent ChatGPT plan", () => {
	it("waits for the reset and runs the scan once more", async () => {
		const { outcome, calls, estimates, gapMs } = await run([
			spent,
			() => done(),
		]);
		expect(outcome).toEqual({
			ok: true,
			value: { scanned: 3, candidates: 2, confirmed: 1, truncated: 0 },
		});
		// One refused attempt (not retried) and one after the wait.
		expect(calls()).toBe(2);
		expect(estimates).toEqual([
			{ organizationId: "org-1", userId: "user-1" },
		]);
		expect(gapMs(1)).toBeGreaterThanOrEqual(3 * HOUR);
	}, 60_000);

	it("fails the run when the plans are still spent after the wait, with no notice", async () => {
		const { outcome, calls, estimates, notices } = await run([
			spent,
			spent,
		]);
		expect(outcome.ok).toBe(false);
		expect(failureType((outcome as { error: unknown }).error)).toBe(
			"SubscriptionPlanExhaustedError",
		);
		expect(calls()).toBe(2);
		expect(estimates).toHaveLength(1);
		expect(notices).toEqual([]);
	}, 60_000);

	it("does not wait on any other failure: the activity's own retries handle it", async () => {
		const { outcome, calls, estimates, gapMs } = await run([
			() => {
				throw new Error("embedding 500");
			},
			() => done(),
		]);
		// Retried by the activity's own policy; no reset was ever asked for.
		expect(outcome.ok).toBe(true);
		expect(calls()).toBe(2);
		expect(estimates).toEqual([]);
		// The retry policy's first backoff, not a plan wait.
		expect(gapMs(1)).toBeLessThan(HOUR);
	}, 60_000);

	it("waits on a later run of the loop too, keeping the earlier runs' totals", async () => {
		const { outcome, calls, estimates, gapMs } = await run([
			() => done(5),
			spent,
			() => ({ ...done(0), candidates: 5, confirmed: 4 }),
		]);
		expect(outcome).toEqual({
			ok: true,
			value: { scanned: 3, candidates: 7, confirmed: 5, truncated: 0 },
		});
		expect(calls()).toBe(3);
		expect(estimates).toHaveLength(1);
		expect(gapMs(1)).toBeLessThan(HOUR);
		expect(gapMs(2)).toBeGreaterThanOrEqual(3 * HOUR);
	}, 60_000);
});
