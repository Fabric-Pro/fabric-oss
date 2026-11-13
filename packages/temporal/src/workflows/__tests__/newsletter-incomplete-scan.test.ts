/**
 * A newsletter send whose release scan is incomplete is skipped, and the send
 * row records which repositories failed and why, so the send history can
 * show it.
 *
 * Local time-skipping test server, the REAL bundled workflow code, mocked
 * activities — as `newsletter-plan-spent.test.ts`.
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

const INPUT: GenerateAndSendNewsletterInput = {
	sendId: "send-1",
	projectId: "proj-1",
	organizationId: "org-1",
	userId: null,
	triggeredByUserId: "user-1",
	projectName: "Example Project",
	trigger: "SCHEDULED",
	detailLevel: "STANDARD",
	timeWindowStart: "2026-08-01T00:00:00.000Z",
	timeWindowEnd: "2026-08-08T00:00:00.000Z",
};

interface FinalizeCall {
	status: string;
	skipReason?: string | null;
	errorMessage?: string | null;
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

async function run(failures: { repoFullName: string; reason: string }[]) {
	const finalizeCalls: FinalizeCall[] = [];
	let curateCalls = 0;

	const activities = {
		collectGitHubReleasesActivity: async () => ({
			items: [
				{
					occurredAt: "2026-08-05T00:00:00.000Z",
					title: "v1.0.0",
					tagName: "v1.0.0",
					repoFullName: "example-org/healthy-repo",
					body: "Notes",
					url: "https://example.com/r/1",
				},
			],
			failures,
			activeRepoCount: 2,
		}),
		curateNewsletterFromReleasesActivity: async () => {
			curateCalls++;
			throw new Error("curation must not run on an incomplete scan");
		},
		finalizeNewsletterSendActivity: async (args: FinalizeCall) => {
			finalizeCalls.push({
				status: args.status,
				skipReason: args.skipReason,
				errorMessage: args.errorMessage,
				advanceLastSentAt: args.advanceLastSentAt,
			});
		},
	};

	const taskQueue = `newsletter-incomplete-scan-${taskQueueSeq++}`;
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
		}),
	)) as { status: string; sentCount: number };
	return { result, finalizeCalls, curateCalls };
}

describe("generateAndSendNewsletterWorkflow on an incomplete release scan", () => {
	it("skips the send and records the failing repository and its reason", async () => {
		const { result, finalizeCalls, curateCalls } = await run([
			{
				repoFullName: "example-org/example-repo",
				reason: "GitHub API error: Not Found",
			},
			// Benign: it does not make the scan incomplete, so it is not recorded.
			{
				repoFullName: "example-org/healthy-repo",
				reason: "latest: GitHub API error (latest): Bad Gateway",
			},
		]);

		expect(result).toEqual({ status: "SKIPPED_EMPTY", sentCount: 0 });
		expect(curateCalls).toBe(0);
		expect(finalizeCalls).toEqual([
			{
				status: "SKIPPED_EMPTY",
				skipReason: "INCOMPLETE_SCAN",
				errorMessage:
					"example-org/example-repo: GitHub API error: Not Found",
				advanceLastSentAt: undefined,
			},
		]);
	}, 120_000);
});
