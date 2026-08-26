/**
 * Behavioral (TestWorkflowEnvironment) coverage for the reviewer-email branch of
 * `generateAndSendNewsletterWorkflow` (Fizzy #2172).
 *
 * A source scan can find a `try {` before the call, but it cannot prove the
 * matching `catch` encloses it — and that enclosure is the whole point. The
 * workflow's outer catch finalizes the send as FAILED via
 * `finalizeNewsletterSend` WITHOUT `expectStatus`, which takes the
 * unconditional update branch and overwrites PENDING_APPROVAL. If a mail
 * failure ever reached it, a missing RESEND_API_KEY would trade a perfectly
 * reviewable parked draft for a dead one.
 *
 * So: run the workflow for real with an activity that throws, and assert the
 * send still parks.
 *
 * Mirrors `publishing-suggestion-workflow.test.ts` — local time-skipping test
 * server, the REAL bundled workflow code, mocked activities.
 *
 * Offline note: `createTimeSkipping()` downloads a test-server binary on first
 * use; run once online to populate the cache.
 *
 * Run with:
 *   pnpm --filter @repo/temporal test newsletter-approval-email
 */

import { resolve } from "node:path";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import {
	bundleWorkflowCode,
	Worker,
	type WorkflowBundleWithSourceMap,
} from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GenerateAndSendNewsletterInput } from "../generate-and-send-newsletter";

const WORKFLOWS_PATH = resolve(__dirname, "..");
const WORKFLOW_NAME = "generateAndSendNewsletterWorkflow";

const BASE_INPUT: GenerateAndSendNewsletterInput = {
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
}

interface RunOpts {
	/** Make the reviewer-email activity reject, as a mail outage would. */
	failApprovalEmail?: boolean;
}

interface RunCaptures {
	result: { status: string; sentCount: number };
	approvalEmailCount: number;
	finalizeCalls: FinalizeCall[];
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

async function runWorkflow(opts: RunOpts = {}): Promise<RunCaptures> {
	const finalizeCalls: FinalizeCall[] = [];
	let approvalEmailCount = 0;

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
		curateNewsletterFromReleasesActivity: async () => CURATED,
		holdNewsletterForApprovalActivity: async () => {},
		sendNewsletterApprovalEmailsActivity: async () => {
			approvalEmailCount += 1;
			if (opts.failApprovalEmail) {
				throw new Error("mail is down");
			}
		},
		finalizeNewsletterSendActivity: async (args: { status: string }) => {
			finalizeCalls.push({ status: args.status });
			return { finalized: true };
		},
	};

	const taskQueue = `newsletter-approval-email-${taskQueueSeq++}`;
	const worker = await Worker.create({
		connection: env.nativeConnection,
		taskQueue,
		workflowBundle,
		activities,
	});

	const result = (await worker.runUntil(
		env.client.workflow.execute(WORKFLOW_NAME, {
			args: [BASE_INPUT],
			taskQueue,
			workflowId: `${taskQueue}-wf`,
		}),
	)) as { status: string; sentCount: number };

	return { result, approvalEmailCount, finalizeCalls };
}

describe("generateAndSendNewsletterWorkflow — reviewer email", () => {
	it("parks the draft and emails the reviewers", async () => {
		const { result, approvalEmailCount, finalizeCalls } =
			await runWorkflow();

		expect(result.status).toBe("PENDING_APPROVAL");
		expect(approvalEmailCount).toBe(1);
		expect(finalizeCalls).toEqual([]);
	});

	it("still parks the draft when the reviewer email fails outright", async () => {
		// The assertion that matters: a thrown mail activity must NOT reach the
		// outer catch, which would finalize the send as FAILED and take the
		// draft away from a reviewer who can still act on it in-app.
		const { result, finalizeCalls } = await runWorkflow({
			failApprovalEmail: true,
		});

		expect(result.status).toBe("PENDING_APPROVAL");
		expect(finalizeCalls).toEqual([]);
		expect(finalizeCalls.some((c) => c.status === "FAILED")).toBe(false);
	});
});
