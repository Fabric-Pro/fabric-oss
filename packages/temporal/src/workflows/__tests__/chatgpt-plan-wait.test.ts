/**
 * `withChatGptPlanWait` (Fizzy #2770): a background step that fails because
 * every ChatGPT plan is spent waits on a durable timer until the estimated
 * reset (capped at six hours), tries once more, and fails for good the
 * second time; any other failure passes straight through. A history recorded
 * before the helper existed replays unchanged, and only the workflows whose
 * steps may run on a shared plan import it.
 *
 * A probe workflow written for the test calls the helper around one
 * activity; time-skipping makes the hours pass instantly.
 */

import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { ApplicationFailure } from "@temporalio/common";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import {
	bundleWorkflowCode,
	Worker,
	type WorkflowBundleWithSourceMap,
} from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const WORKFLOWS_PATH = resolve(__dirname, "..");
const HELPER_PATH = join(WORKFLOWS_PATH, "lib", "chatgpt-plan-wait.ts");
const HOUR = 60 * 60_000;

// The probe reports how long it waited, by its own (replay-safe) clock.
const PROBE = `
import { proxyActivities } from "@temporalio/workflow";
import { withChatGptPlanWait } from "HELPER";

const { probeStep } = proxyActivities<{ probeStep: () => Promise<string> }>({
	startToCloseTimeout: "1 minute",
	retry: {
		maximumAttempts: 1,
		nonRetryableErrorTypes: ["SubscriptionPlanExhaustedError"],
	},
});

export async function planWaitProbe(): Promise<{ result: string; waitedMs: number }> {
	const started = Date.now();
	const result = await withChatGptPlanWait(() => probeStep(), {
		organizationId: "org-1",
		userId: "user-1",
	});
	return { result, waitedMs: Date.now() - started };
}
`;

let env: TestWorkflowEnvironment;
let bundle: WorkflowBundleWithSourceMap;
let unpatchedBundle: WorkflowBundleWithSourceMap;
let taskQueueSeq = 0;

async function bundleProbe(helperSource: string) {
	// Under __tests__, which the starter-allowlist scan skips, so a parallel
	// run of that test never trips over this short-lived directory.
	const dir = mkdtempSync(join(__dirname, ".chatgpt-plan-wait-"));
	try {
		// One level deeper than lib/, so the helper's relative import moves too.
		writeFileSync(
			join(dir, "helper.ts"),
			helperSource.replace(
				'"../../activities/chatgpt-plan-wait"',
				'"../../../activities/chatgpt-plan-wait"',
			),
		);
		writeFileSync(
			join(dir, "probe.ts"),
			PROBE.replace("HELPER", "./helper"),
		);
		return await bundleWorkflowCode({
			workflowsPath: join(dir, "probe.ts"),
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

beforeAll(async () => {
	env = await TestWorkflowEnvironment.createTimeSkipping();
	const helper = readFileSync(HELPER_PATH, "utf8");
	bundle = await bundleProbe(helper);
	// The helper as it would behave in a history recorded before it existed.
	const unpatched = helper.replace(
		"patched(CHATGPT_PLAN_WAIT_PATCH)",
		"false",
	);
	if (unpatched === helper) {
		throw new Error("the patch guard moved; update this test");
	}
	unpatchedBundle = await bundleProbe(unpatched);
}, 180_000);

afterAll(async () => {
	await env?.teardown();
});

const spent = () =>
	ApplicationFailure.nonRetryable(
		"Every ChatGPT plan this work may use has no usage left in this window.",
		"SubscriptionPlanExhaustedError",
	);

interface Scenario {
	/** What each call of the step does, in order. */
	steps: Array<() => string>;
	waitMs: number;
	workflowBundle?: WorkflowBundleWithSourceMap;
}

async function run(scenario: Scenario) {
	const taskQueue = `chatgpt-plan-wait-${++taskQueueSeq}`;
	let calls = 0;
	const estimates: unknown[] = [];
	const worker = await Worker.create({
		connection: env.nativeConnection,
		taskQueue,
		workflowBundle: scenario.workflowBundle ?? bundle,
		activities: {
			probeStep: async () => {
				const step = scenario.steps[calls++];
				if (!step) {
					throw new Error("called too often");
				}
				return step();
			},
			estimatePlanPoolResetActivity: async (input: unknown) => {
				estimates.push(input);
				return { waitMs: scenario.waitMs, jitterMs: 0 };
			},
		},
	});
	const handle = await env.client.workflow.start("planWaitProbe", {
		taskQueue,
		workflowId: `${taskQueue}-wf`,
	});
	const outcome = await worker.runUntil(
		handle.result().then(
			(value) => ({ ok: true as const, value }),
			(error: unknown) => ({ ok: false as const, error }),
		),
	);
	const history = await handle.fetchHistory();
	return { outcome, calls: () => calls, estimates, history };
}

const failureType = (error: unknown): string | undefined => {
	let current = error as { cause?: unknown; type?: string } | undefined;
	while (current?.cause) {
		current = current.cause as { cause?: unknown; type?: string };
	}
	return current?.type;
};

describe("withChatGptPlanWait", () => {
	it("waits for the estimated reset on a durable timer, then tries once more", async () => {
		const { outcome, calls, estimates } = await run({
			steps: [
				() => {
					throw spent();
				},
				() => "done",
			],
			waitMs: 2 * HOUR,
		});
		expect(outcome).toMatchObject({ ok: true, value: { result: "done" } });
		if (outcome.ok) {
			expect(outcome.value.waitedMs).toBeGreaterThanOrEqual(2 * HOUR);
		}
		expect(calls()).toBe(2);
		expect(estimates).toEqual([
			{ organizationId: "org-1", userId: "user-1" },
		]);
	}, 60_000);

	it("never waits longer than six hours", async () => {
		const { outcome } = await run({
			steps: [
				() => {
					throw spent();
				},
				() => "done",
			],
			waitMs: 30 * HOUR,
		});
		expect(outcome.ok).toBe(true);
		if (outcome.ok) {
			expect(outcome.value.waitedMs).toBeGreaterThanOrEqual(6 * HOUR);
			expect(outcome.value.waitedMs).toBeLessThan(7 * HOUR);
		}
	}, 60_000);

	it("fails for good when the retry finds every plan spent too", async () => {
		const { outcome, calls } = await run({
			steps: [
				() => {
					throw spent();
				},
				() => {
					throw spent();
				},
			],
			waitMs: HOUR,
		});
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) {
			expect(failureType(outcome.error)).toBe(
				"SubscriptionPlanExhaustedError",
			);
		}
		expect(calls()).toBe(2);
	}, 60_000);

	it("lets any other failure through without waiting", async () => {
		const { outcome, calls, estimates } = await run({
			steps: [
				() => {
					throw ApplicationFailure.nonRetryable(
						"boom",
						"SomethingElse",
					);
				},
			],
			waitMs: HOUR,
		});
		expect(outcome.ok).toBe(false);
		expect(calls()).toBe(1);
		expect(estimates).toEqual([]);
	}, 60_000);

	it("retries at once, with no timer, when the estimate is zero", async () => {
		const { outcome, history } = await run({
			steps: [
				() => {
					throw spent();
				},
				() => "done",
			],
			waitMs: 0,
		});
		expect(outcome.ok).toBe(true);
		expect(
			history.events?.some((event) => event.timerStartedEventAttributes),
		).toBe(false);
	}, 60_000);

	it("replays a history recorded before the helper existed", async () => {
		const recorded = await run({
			steps: [() => "done"],
			waitMs: HOUR,
			workflowBundle: unpatchedBundle,
		});
		expect(recorded.outcome.ok).toBe(true);
		await expect(
			Worker.runReplayHistory(
				{ workflowBundle: bundle },
				recorded.history,
				"replay-probe",
			),
		).resolves.toBeUndefined();
	}, 60_000);
});

describe("which workflows may wait for a plan", () => {
	// Default-deny, like PLAN_POOL_BACKGROUND_JOB_TYPES: a workflow waits for
	// a ChatGPT plan only when its steps may run on a shared one.
	it("is exactly the daily brief, workflow-builder executions and meeting auto-analysis", () => {
		const importers = readdirSync(WORKFLOWS_PATH, { recursive: true })
			.map(String)
			.filter(
				(file) => file.endsWith(".ts") && !file.includes("__tests__"),
			)
			.filter((file) =>
				readFileSync(join(WORKFLOWS_PATH, file), "utf8").includes(
					"lib/chatgpt-plan-wait",
				),
			)
			.sort();
		expect(importers).toEqual([
			"auto-analyze-meeting-transcript.ts",
			"daily-brief-generation-workflow.ts",
			"workflow-builder-execution.ts",
		]);
	});
});
