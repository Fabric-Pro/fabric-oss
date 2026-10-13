/**
 * The live Slack monitor and a spent ChatGPT plan (Fizzy #2770).
 *
 * A thread the analysis could not run because every plan was spent used to be
 * recorded as a channel failure. Nothing on the live path ever resets that
 * count, so a few spent windows pinned a "needs relink" box on a healthy
 * channel. A spent plan is now not a channel failure; any other failure still
 * is. The refused thread used to wait for its next message too; it is now
 * held and flushed again once the plan resets, exactly once.
 *
 * Local time-skipping test server, the REAL bundled workflow code, mocked
 * activities.
 */

import { resolve } from "node:path";
import { ApplicationFailure } from "@temporalio/common";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import {
	bundleWorkflowCode,
	Worker,
	type WorkflowBundleWithSourceMap,
} from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
	SlackChannelMonitorInput,
	SlackMessageReceivedPayload,
} from "../slack-channel-monitor";

const WORKFLOWS_PATH = resolve(__dirname, "..");

let env: TestWorkflowEnvironment;
let workflowBundle: WorkflowBundleWithSourceMap;

beforeAll(async () => {
	env = await TestWorkflowEnvironment.createTimeSkipping();
	workflowBundle = await bundleWorkflowCode({
		workflowsPath: WORKFLOWS_PATH,
	});
}, 180_000);

afterAll(async () => {
	await env?.teardown();
});

const message = (ts: string): SlackMessageReceivedPayload => ({
	channelId: "C1",
	externalEventId: `Ev${ts}`,
	ts,
	text: `message ${ts}`,
	sender: "U1",
	occurredAt: "2026-10-12T10:00:00.000Z",
});

let taskQueueSeq = 0;

async function flush(failures: Record<string, Error>) {
	const recorded: { channelId: string; errorMessage: string }[] = [];
	const activities = {
		analyzeSlackThreadActivity: async (input: { threadRootTs: string }) => {
			const failure = failures[input.threadRootTs];
			if (failure) {
				throw failure;
			}
			return { success: true };
		},
		recordSlackChannelFailureForKeyActivity: async (input: {
			channelId: string;
			errorMessage: string;
		}) => {
			recorded.push(input);
		},
		updateSlackChannelMonitorLastRunActivity: async () => {},
		estimatePlanPoolResetActivity: async () => ({
			waitMs: 60 * 60_000,
			jitterMs: 0,
		}),
	};

	const taskQueue = `slack-monitor-plan-spent-${taskQueueSeq++}`;
	const worker = await Worker.create({
		connection: env.nativeConnection,
		taskQueue,
		workflowBundle,
		activities,
	});
	await worker.runUntil(async () => {
		const handle = await env.client.workflow.start(
			"slackChannelMonitorWorkflow",
			{
				args: [
					{
						projectId: "proj-1",
						userId: "user-1",
						organizationId: "org-1",
						debounceMs: 1_000,
						pendingQueue: [
							message("1700000100.000000"),
							message("1700000200.000000"),
						],
					},
				],
				taskQueue,
				workflowId: `${taskQueue}-wf`,
			},
		);
		// Cancel drains the queue once, then the run ends.
		await handle.signal("cancelSlackChannelMonitor");
		await handle.result();
	});
	return recorded;
}

type Analyze = (input: { threadRootTs: string }) => Promise<unknown>;

/** Runs a monitor with one queued message, `steps` driven inside it. */
async function monitor(
	analyze: Analyze,
	steps: (run: {
		calls: string[];
		signal: (payload: SlackMessageReceivedPayload) => Promise<void>;
	}) => Promise<void>,
	resetWaitMs = 60 * 60_000,
	input: Partial<SlackChannelMonitorInput> = {},
) {
	const calls: string[] = [];
	const activities = {
		analyzeSlackThreadActivity: async (input: { threadRootTs: string }) => {
			calls.push(input.threadRootTs);
			return analyze(input);
		},
		recordSlackChannelFailureForKeyActivity: async () => {},
		updateSlackChannelMonitorLastRunActivity: async () => {},
		estimatePlanPoolResetActivity: async () => ({
			waitMs: resetWaitMs,
			jitterMs: 0,
		}),
	};

	const taskQueue = `slack-monitor-plan-retry-${taskQueueSeq++}`;
	const worker = await Worker.create({
		connection: env.nativeConnection,
		taskQueue,
		workflowBundle,
		activities,
	});
	await worker.runUntil(async () => {
		const handle = await env.client.workflow.start(
			"slackChannelMonitorWorkflow",
			{
				args: [
					{
						projectId: "proj-1",
						userId: "user-1",
						organizationId: "org-1",
						debounceMs: 1_000,
						pendingQueue: [message("1700000100.000000")],
						...input,
					},
				],
				taskQueue,
				workflowId: `${taskQueue}-wf`,
			},
		);
		await steps({
			calls,
			signal: (payload) => handle.signal("slackMessageReceived", payload),
		});
		await handle.signal("cancelSlackChannelMonitor");
		await handle.result();
	});
	return calls;
}

const planSpent = () =>
	ApplicationFailure.create({
		message: "Every ChatGPT plan is spent.",
		type: "SubscriptionPlanExhaustedError",
		nonRetryable: true,
	});

describe("slackChannelMonitorWorkflow on a spent ChatGPT plan", () => {
	it("does not record a spent plan as a channel failure", async () => {
		const recorded = await flush({ "1700000100.000000": planSpent() });

		expect(recorded).toEqual([]);
	}, 120_000);

	it("still records any other failure", async () => {
		const recorded = await flush({
			"1700000100.000000": planSpent(),
			"1700000200.000000": ApplicationFailure.create({
				message: "conversations.replies failed",
				nonRetryable: true,
			}),
		});

		expect(recorded).toHaveLength(1);
		expect(recorded[0]?.channelId).toBe("C1");
	}, 120_000);
});

describe("slackChannelMonitorWorkflow retries a refused thread after the reset", () => {
	it("flushes the refused thread again once the plan resets", async () => {
		let refused = false;
		const calls = await monitor(
			async () => {
				if (!refused) {
					refused = true;
					throw planSpent();
				}
				return { success: true };
			},
			async ({ calls }) => {
				await env.sleep("30 minutes");
				expect(calls).toHaveLength(1);
				await env.sleep("2 hours");
			},
		);

		expect(calls).toEqual(["1700000100.000000", "1700000100.000000"]);
	}, 120_000);

	it("does not retry in a loop while the plan stays spent", async () => {
		const calls = await monitor(
			async () => {
				throw planSpent();
			},
			async () => {
				await env.sleep("1 hour");
			},
			// An estimate of zero is held to the five-minute floor.
			0,
		);

		expect(calls.length).toBeGreaterThan(1);
		expect(calls.length).toBeLessThanOrEqual(13);
	}, 120_000);

	it("does not retry a thread a later message already flushed", async () => {
		let refused = false;
		const calls = await monitor(
			async () => {
				if (!refused) {
					refused = true;
					throw planSpent();
				}
				return { success: true };
			},
			async ({ signal }) => {
				await env.sleep("10 minutes");
				await signal({
					...message("1700000300.000000"),
					threadTs: "1700000100.000000",
				});
				await env.sleep("3 hours");
			},
		);

		expect(calls).toEqual(["1700000100.000000", "1700000100.000000"]);
	}, 120_000);

	it("keeps held threads across continueAsNew and retries them at the reset", async () => {
		const calls = await monitor(
			async () => ({ success: true }),
			async ({ calls }) => {
				await env.sleep("10 minutes");
				expect(calls).toEqual([]);
				await env.sleep("1 hour");
			},
			60 * 60_000,
			{
				pendingQueue: [],
				planDeferred: {
					retryAtMs: (await env.currentTimeMs()) + 30 * 60_000,
					payloads: [message("1700000100.000000")],
				},
			},
		);

		expect(calls).toEqual(["1700000100.000000"]);
	}, 120_000);
});
