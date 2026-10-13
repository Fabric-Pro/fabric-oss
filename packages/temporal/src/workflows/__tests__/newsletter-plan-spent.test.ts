/**
 * A scheduled newsletter whose curation finds every ChatGPT plan spent
 * (Fizzy #2770).
 *
 * The send runs under a 15-minute execution timeout. An uncapped plan wait of
 * hours timed the run out silently, leaving the send row unfinalized. The
 * wait is now capped at the run's deadline: a reset that fits is waited for,
 * and one that does not finalizes the send as skipped — not failed — without
 * advancing `lastSentAt`, so the next send covers the window.
 *
 * Local time-skipping test server, the REAL bundled workflow code, mocked
 * activities — as `newsletter-approval-chat.test.ts`.
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
import type { GenerateAndSendNewsletterInput } from "../generate-and-send-newsletter";

const WORKFLOWS_PATH = resolve(__dirname, "..");
const HOUR = 60 * 60_000;

const INPUT: GenerateAndSendNewsletterInput = {
	sendId: "send-1",
	projectId: "proj-1",
	organizationId: "org-1",
	userId: null,
	triggeredByUserId: "user-1",
	projectName: "Example Project",
	trigger: "SCHEDULED",
	detailLevel: "STANDARD",
	requireApproval: true,
	timeWindowStart: "2026-08-01T00:00:00.000Z",
	timeWindowEnd: "2026-08-08T00:00:00.000Z",
};

const CURATED = {
	content: {
		schemaVersion: 1 as const,
		headline: "August update",
		intro: "Things shipped.",
		hasMajorFeatures: true,
		highlights: [{ title: "Faster search", description: "Loads sooner." }],
	},
	aiUsageTokens: 10,
};

interface FinalizeCall {
	status: string;
	skipReason?: string | null;
	advanceLastSentAt?: boolean;
}

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

let taskQueueSeq = 0;

async function run(opts: { resetInMs: number; spentAttempts: number }) {
	const finalizeCalls: FinalizeCall[] = [];
	let curateCalls = 0;

	const activities = {
		collectGitHubReleasesActivity: async () => ({
			items: [
				{
					kind: "release",
					publishedAt: "2026-08-05T00:00:00.000Z",
					tagName: "v1.0.0",
					repoFullName: "example-org/example-repo",
					body: "Notes",
					url: "https://example.com/r/1",
				},
			],
			failures: [],
			activeRepoCount: 1,
		}),
		curateNewsletterFromReleasesActivity: async () => {
			curateCalls++;
			if (curateCalls <= opts.spentAttempts) {
				throw ApplicationFailure.create({
					message: "Every ChatGPT plan is spent.",
					type: "SubscriptionPlanExhaustedError",
					nonRetryable: true,
				});
			}
			return CURATED;
		},
		estimatePlanPoolResetActivity: async () => ({
			waitMs: opts.resetInMs,
			jitterMs: 0,
			resetKnown: true,
		}),
		holdNewsletterForApprovalActivity: async () => {},
		sendNewsletterApprovalEmailsActivity: async () => {},
		sendNewsletterApprovalChatMessagesActivity: async () => {},
		finalizeNewsletterSendActivity: async (args: FinalizeCall) => {
			finalizeCalls.push({
				status: args.status,
				skipReason: args.skipReason,
				advanceLastSentAt: args.advanceLastSentAt,
			});
			return { finalized: true };
		},
	};

	const taskQueue = `newsletter-plan-spent-${taskQueueSeq++}`;
	const worker = await Worker.create({
		connection: env.nativeConnection,
		taskQueue,
		workflowBundle,
		activities,
	});
	const result = (await worker.runUntil(
		env.client.workflow.execute("generateAndSendNewsletterWorkflow", {
			args: [INPUT],
			taskQueue,
			workflowId: `${taskQueue}-wf`,
			// What `dispatch-newsletter-send.ts` starts it with.
			workflowExecutionTimeout: "15m",
		}),
	)) as { status: string; sentCount: number };
	return { result, finalizeCalls, curateCalls };
}

describe("generateAndSendNewsletterWorkflow on a spent ChatGPT plan", () => {
	it("skips the send instead of overrunning its deadline when the reset is hours off", async () => {
		const { result, finalizeCalls, curateCalls } = await run({
			resetInMs: 3 * HOUR,
			spentAttempts: 1,
		});

		expect(result).toEqual({ status: "SKIPPED_EMPTY", sentCount: 0 });
		expect(curateCalls).toBe(1);
		expect(finalizeCalls).toEqual([
			{
				status: "SKIPPED_EMPTY",
				skipReason: "PLAN_SPENT",
				advanceLastSentAt: undefined,
			},
		]);
	}, 120_000);

	it("waits for a reset that fits in the run and carries on", async () => {
		const { result, finalizeCalls, curateCalls } = await run({
			resetInMs: 2 * 60_000,
			spentAttempts: 1,
		});

		expect(curateCalls).toBe(2);
		expect(result.status).toBe("PENDING_APPROVAL");
		expect(finalizeCalls).toEqual([]);
	}, 120_000);

	it("skips the send when the plan is still spent after the wait", async () => {
		const { result, finalizeCalls, curateCalls } = await run({
			resetInMs: 2 * 60_000,
			spentAttempts: 2,
		});

		expect(curateCalls).toBe(2);
		expect(result.status).toBe("SKIPPED_EMPTY");
		expect(finalizeCalls.map((call) => call.skipReason)).toEqual([
			"PLAN_SPENT",
		]);
	}, 120_000);
});
