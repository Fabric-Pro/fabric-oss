/**
 * Meeting auto-analysis on a spent ChatGPT plan (Fizzy #2770 A4): the
 * automatic scan may run on an organization's shared plan accounts. When
 * every one is spent, the workflow waits for the estimated reset and analyzes
 * the transcript once more instead of marking it FAILED for good; any other
 * failure is still marked FAILED at once.
 *
 * Time-skipping makes the hours pass instantly; the activities are stubs.
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

const WORKFLOW_PATH = resolve(
	__dirname,
	"..",
	"auto-analyze-meeting-transcript.ts",
);
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
	transcriptRecordId: "tr-rec-1",
	contextId: "ctx-1",
	meetingId: "meeting-1",
	transcriptId: "transcript-1",
	linkedMeetingId: "linked-1",
	meetingSubject: "Weekly planning",
	transcriptText: "We should add an export button.",
};

type Outcome = {
	success: boolean;
	changeCount: number;
	pendingProposalId?: string;
};

async function run(
	attempts: Array<() => Outcome>,
	input: Record<string, unknown> = INPUT,
) {
	const taskQueue = `meeting-plan-wait-${++taskQueueSeq}`;
	let calls = 0;
	const estimates: unknown[] = [];
	const failed: unknown[] = [];
	const worker = await Worker.create({
		connection: env.nativeConnection,
		taskQueue,
		workflowBundle: bundle,
		activities: {
			autoAnalyzeMeetingTranscriptActivity: async () => {
				const attempt = attempts[calls++];
				if (!attempt) {
					throw new Error("called too often");
				}
				return attempt();
			},
			markMeetingTranscriptAnalysisFailedActivity: async (
				input: unknown,
			) => {
				failed.push(input);
			},
			estimatePlanPoolResetActivity: async (input: unknown) => {
				estimates.push(input);
				return { waitMs: 3 * HOUR, jitterMs: 0 };
			},
		},
	});
	const handle = await env.client.workflow.start(
		"autoAnalyzeMeetingTranscriptWorkflow",
		{ taskQueue, workflowId: `${taskQueue}-wf`, args: [input] },
	);
	const startedAt = await env.currentTimeMs();
	const output = (await worker.runUntil(handle.result())) as Outcome & {
		skippedReason?: string;
	};
	const elapsedMs = (await env.currentTimeMs()) - startedAt;
	return { output, calls: () => calls, estimates, failed, elapsedMs };
}

const spent = (): Outcome => {
	throw ApplicationFailure.nonRetryable(
		"Every ChatGPT plan this work may use has no usage left in this window.",
		"SubscriptionPlanExhaustedError",
	);
};

describe("autoAnalyzeMeetingTranscriptWorkflow — a spent ChatGPT plan", () => {
	it("waits for the reset and analyzes the transcript once more", async () => {
		const { output, calls, estimates, failed, elapsedMs } = await run([
			spent,
			() => ({
				success: true,
				changeCount: 1,
				pendingProposalId: "pbp-1",
			}),
		]);
		expect(output).toMatchObject({
			success: true,
			pendingProposalId: "pbp-1",
		});
		expect(calls()).toBe(2);
		expect(estimates).toEqual([
			{ organizationId: "org-1", userId: "user-1" },
		]);
		expect(failed).toEqual([]);
		expect(elapsedMs).toBeGreaterThanOrEqual(3 * HOUR);
	}, 60_000);

	it("marks the transcript FAILED when the plans are still spent after the wait", async () => {
		const { output, calls, failed } = await run([spent, spent]);
		expect(output).toMatchObject({
			success: false,
			skippedReason: "analysis_failed",
		});
		expect(calls()).toBe(2);
		expect(failed).toHaveLength(1);
	}, 60_000);

	it("does not hold a person's own request: it fails at once, without waiting", async () => {
		const { output, calls, estimates, failed } = await run([spent], {
			...INPUT,
			userInitiated: true,
		});
		expect(output).toMatchObject({
			success: false,
			skippedReason: "analysis_failed",
		});
		expect(calls()).toBe(1);
		expect(estimates).toEqual([]);
		expect(failed).toHaveLength(1);
	}, 60_000);

	it("marks any other failure FAILED at once, without waiting", async () => {
		const { calls, estimates, failed } = await run([
			() => {
				throw ApplicationFailure.nonRetryable(
					"bad input",
					"ValidationError",
				);
			},
		]);
		expect(calls()).toBe(1);
		expect(estimates).toEqual([]);
		expect(failed).toHaveLength(1);
	}, 60_000);
});
