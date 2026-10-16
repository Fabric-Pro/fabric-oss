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
import {
	untilRunDeadline,
	withChatGptPlanWait,
	withChatGptPlanWaitResuming,
} from "HELPER";

const { probeStep } = proxyActivities<{
	probeStep: (resume?: unknown) => Promise<string>;
}>({
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

// A run with an execution timeout waits only within it, leaving room for
// the retry (Fizzy #2770).
export async function planWaitProbeDeadline(): Promise<{ result: string; waitedMs: number }> {
	const started = Date.now();
	const result = await withChatGptPlanWait(() => probeStep(), {
		organizationId: "org-1",
		userId: null,
		maxWaitMs: untilRunDeadline(30 * 60_000),
	});
	return { result, waitedMs: Date.now() - started };
}

// A fan-out step resumes from the progress its spent failure reported.
export async function planWaitProbeResuming(): Promise<{ result: string; waitedMs: number }> {
	const started = Date.now();
	const result = await withChatGptPlanWaitResuming<unknown, string>(
		(resume) => probeStep(resume),
		{ organizationId: "org-1", userId: null },
	);
	return { result, waitedMs: Date.now() - started };
}

// Work whose final plan-spent failure ends it says so (Fizzy #3050).
export async function planWaitProbeNotice(): Promise<{ result: string; waitedMs: number }> {
	const started = Date.now();
	const result = await withChatGptPlanWait(() => probeStep(), {
		organizationId: "org-1",
		userId: "user-1",
		stoppedNotice: { work: "DAILY_BRIEF", projectId: "proj-1" },
	});
	return { result, waitedMs: Date.now() - started };
}

export async function planWaitProbeNoticeCapped(): Promise<{ result: string; waitedMs: number }> {
	const started = Date.now();
	const result = await withChatGptPlanWait(() => probeStep(), {
		organizationId: "org-1",
		userId: null,
		maxWaitMs: 60 * 60_000,
		stoppedNotice: {
			work: "SLACK_BACKFILL",
			projectId: "proj-1",
			initiatorUserId: "user-2",
		},
	});
	return { result, waitedMs: Date.now() - started };
}

// A run with a deadline of its own never waits past it.
export async function planWaitProbeCapped(): Promise<{ result: string; waitedMs: number }> {
	const started = Date.now();
	const result = await withChatGptPlanWait(() => probeStep(), {
		organizationId: "org-1",
		userId: "user-1",
		maxWaitMs: 60 * 60_000,
	});
	return { result, waitedMs: Date.now() - started };
}
`;

let env: TestWorkflowEnvironment;
let bundle: WorkflowBundleWithSourceMap;
let unpatchedBundle: WorkflowBundleWithSourceMap;
let noNoticeBundle: WorkflowBundleWithSourceMap;
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
	// The helper as it was before the stopped notice (Fizzy #3050).
	const noNotice = helper.replace(
		"patched(CHATGPT_PLAN_STOPPED_NOTICE_PATCH)",
		"false",
	);
	if (noNotice === helper) {
		throw new Error("the stopped-notice guard moved; update this test");
	}
	noNoticeBundle = await bundleProbe(noNotice);
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
	workflowType?:
		| "planWaitProbe"
		| "planWaitProbeCapped"
		| "planWaitProbeDeadline"
		| "planWaitProbeResuming"
		| "planWaitProbeNotice"
		| "planWaitProbeNoticeCapped";
	/** The stopped notice activity; records and succeeds by default. */
	notify?: () => Promise<void>;
	/** The run's own execution timeout, when it has one. */
	executionTimeoutMs?: number;
}

async function run(scenario: Scenario) {
	const taskQueue = `chatgpt-plan-wait-${++taskQueueSeq}`;
	let calls = 0;
	const estimates: unknown[] = [];
	const stepArgs: unknown[] = [];
	const notices: unknown[] = [];
	const worker = await Worker.create({
		connection: env.nativeConnection,
		taskQueue,
		workflowBundle: scenario.workflowBundle ?? bundle,
		activities: {
			probeStep: async (resume?: unknown) => {
				stepArgs.push(resume ?? null);
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
			notifyPlanWaitWorkStoppedActivity: async (input: unknown) => {
				notices.push(input);
				await scenario.notify?.();
			},
		},
	});
	const handle = await env.client.workflow.start(
		scenario.workflowType ?? "planWaitProbe",
		{
			taskQueue,
			workflowId: `${taskQueue}-wf`,
			...(scenario.executionTimeoutMs !== undefined && {
				workflowExecutionTimeout: scenario.executionTimeoutMs,
			}),
		},
	);
	const outcome = await worker.runUntil(
		handle.result().then(
			(value) => ({ ok: true as const, value }),
			(error: unknown) => ({ ok: false as const, error }),
		),
	);
	const history = await handle.fetchHistory();
	return {
		outcome,
		calls: () => calls,
		estimates,
		history,
		stepArgs,
		notices,
	};
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

	it("fails at once, without a timer, when the reset is past the run's own deadline", async () => {
		const { outcome, calls } = await run({
			steps: [
				() => {
					throw spent();
				},
				() => "done",
			],
			waitMs: 2 * HOUR,
			workflowType: "planWaitProbeCapped",
		});
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) {
			expect(failureType(outcome.error)).toBe(
				"SubscriptionPlanExhaustedError",
			);
		}
		expect(calls()).toBe(1);
	}, 60_000);

	it("waits within the run's own deadline", async () => {
		const { outcome, calls } = await run({
			steps: [
				() => {
					throw spent();
				},
				() => "done",
			],
			waitMs: HOUR / 2,
			workflowType: "planWaitProbeCapped",
		});
		expect(outcome).toMatchObject({ ok: true, value: { result: "done" } });
		expect(calls()).toBe(2);
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

	it("waits within a run's execution timeout, leaving the reserve", async () => {
		const { outcome, calls } = await run({
			steps: [
				() => {
					throw spent();
				},
				() => "done",
			],
			waitMs: HOUR,
			workflowType: "planWaitProbeDeadline",
			executionTimeoutMs: 2 * HOUR,
		});
		expect(outcome).toMatchObject({ ok: true, value: { result: "done" } });
		expect(calls()).toBe(2);
	}, 60_000);

	it("fails at once when the reset would leave less than the reserve", async () => {
		const { outcome, calls } = await run({
			steps: [
				() => {
					throw spent();
				},
				() => "done",
			],
			// 2h timeout - 30m reserve leaves 90 minutes; the reset is 100 away.
			waitMs: 100 * 60_000,
			workflowType: "planWaitProbeDeadline",
			executionTimeoutMs: 2 * HOUR,
		});
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) {
			expect(failureType(outcome.error)).toBe(
				"SubscriptionPlanExhaustedError",
			);
		}
		expect(calls()).toBe(1);
	}, 60_000);

	it("waits as long as the reset takes when the run has no execution timeout", async () => {
		const { outcome, calls } = await run({
			steps: [
				() => {
					throw spent();
				},
				() => "done",
			],
			waitMs: 3 * HOUR,
			workflowType: "planWaitProbeDeadline",
		});
		expect(outcome).toMatchObject({ ok: true, value: { result: "done" } });
		expect(calls()).toBe(2);
	}, 60_000);

	it("hands the retry the progress the spent failure carried", async () => {
		const { outcome, stepArgs } = await run({
			steps: [
				() => {
					throw ApplicationFailure.create({
						message: "Every ChatGPT plan is spent.",
						type: "SubscriptionPlanExhaustedError",
						nonRetryable: true,
						details: [{ done: ["item-1", "item-2"] }],
					});
				},
				() => "done",
			],
			waitMs: HOUR,
			workflowType: "planWaitProbeResuming",
		});
		expect(outcome).toMatchObject({ ok: true, value: { result: "done" } });
		expect(stepArgs).toEqual([null, { done: ["item-1", "item-2"] }]);
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

describe("the stopped notice (Fizzy #3050)", () => {
	const spentTwice = [
		() => {
			throw spent();
		},
		() => {
			throw spent();
		},
	];

	it("announces the final refusal, then fails with the plan's own error", async () => {
		const { outcome, notices } = await run({
			steps: spentTwice,
			waitMs: HOUR,
			workflowType: "planWaitProbeNotice",
		});
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) {
			expect(failureType(outcome.error)).toBe(
				"SubscriptionPlanExhaustedError",
			);
		}
		expect(notices).toEqual([
			{
				work: "DAILY_BRIEF",
				projectId: "proj-1",
				runId: expect.stringMatching(/-wf:/),
				organizationId: "org-1",
				initiatorUserId: "user-1",
			},
		]);
	}, 60_000);

	it("announces a reset past the run's own cap, naming the initiator it was given", async () => {
		const { outcome, notices, calls } = await run({
			steps: spentTwice,
			waitMs: 3 * HOUR,
			workflowType: "planWaitProbeNoticeCapped",
		});
		expect(outcome.ok).toBe(false);
		expect(calls()).toBe(1);
		expect(notices).toEqual([
			expect.objectContaining({
				work: "SLACK_BACKFILL",
				initiatorUserId: "user-2",
			}),
		]);
	}, 60_000);

	it("still fails with the plan's error when the notice itself fails", async () => {
		const { outcome, notices } = await run({
			steps: spentTwice,
			waitMs: HOUR,
			workflowType: "planWaitProbeNotice",
			notify: async () => {
				throw new Error("notifications down");
			},
		});
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) {
			expect(failureType(outcome.error)).toBe(
				"SubscriptionPlanExhaustedError",
			);
		}
		expect(notices.length).toBeGreaterThanOrEqual(1);
	}, 60_000);

	it("announces nothing when the retry succeeds, or for a caller that did not ask", async () => {
		const recovered = await run({
			steps: [
				() => {
					throw spent();
				},
				() => "done",
			],
			waitMs: HOUR,
			workflowType: "planWaitProbeNotice",
		});
		expect(recovered.outcome.ok).toBe(true);
		expect(recovered.notices).toEqual([]);

		const unasked = await run({ steps: spentTwice, waitMs: HOUR });
		expect(unasked.outcome.ok).toBe(false);
		expect(unasked.notices).toEqual([]);
	}, 60_000);

	it("replays a final failure recorded before the notice existed", async () => {
		const recorded = await run({
			steps: spentTwice,
			waitMs: HOUR,
			workflowType: "planWaitProbeNotice",
			workflowBundle: noNoticeBundle,
		});
		expect(recorded.outcome.ok).toBe(false);
		expect(recorded.notices).toEqual([]);
		await expect(
			Worker.runReplayHistory(
				{ workflowBundle: bundle },
				recorded.history,
				"replay-probe-notice",
			),
		).resolves.toBeUndefined();
	}, 60_000);
});

describe("which workflows may wait for a plan", () => {
	// Default-deny, like PLAN_POOL_BACKGROUND_JOB_TYPES: a workflow waits for
	// a ChatGPT plan only when its steps may run on a shared one.
	it("is exactly the workflows whose unattended steps may run on a shared plan", () => {
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
			// Bulk runs a person starts, on the shared plans (Fizzy #2770):
			// Atlas, the document children of batch generation and project
			// setup (only when the parent asks), the setup's code analysis,
			// and the scans with their grouping and review.
			"atlas.ts",
			"auto-analyze-meeting-transcript.ts",
			// Reads a child's pause for a plan reset and pauses the batch.
			"batch-document-generation.ts",
			"context-summarization-workflow.ts",
			"daily-brief-generation-workflow.ts",
			"document-generation-child.ts",
			"document-refresh.ts",
			"existing-project-setup.ts",
			"generate-and-send-newsletter.ts",
			"parlume-notes.ts",
			"publishing-suggestion-generation-workflow.ts",
			"scan-finding-review.ts",
			"security-accessibility-scan.ts",
			"security-finding-grouping.ts",
			// Channel monitoring is on the shared plans; its backfill waits
			// rather than skip the threads a spent plan refused.
			"slack-channel-backfill.ts",
			"template-instance-execution.ts",
			"workflow-builder-execution.ts",
		]);
	});
});
