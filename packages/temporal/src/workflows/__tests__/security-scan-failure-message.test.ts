/**
 * A failed scan must record why it failed (Fizzy #2502).
 *
 * A production scan failed with the banner "Activity task failed" — Temporal's
 * wrapper text for a step whose retries ran out. The real cause sat one level
 * down in the error's `.cause` chain, so neither the user nor the server log
 * said what broke. These run the real workflow and assert on the message
 * `failScanActivity` receives, which is what the banner and the log line show.
 */

import { resolve } from "node:path";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import {
	bundleWorkflowCode,
	Worker,
	type WorkflowBundleWithSourceMap,
} from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
	SecurityAccessibilityScanInput,
	SecurityAccessibilityScanOutput,
} from "../security-accessibility-scan";

const WORKFLOWS_PATH = resolve(__dirname, "..");
const WORKFLOW_NAME = "securityAccessibilityScanWorkflow";

let env: TestWorkflowEnvironment;
let workflowBundle: WorkflowBundleWithSourceMap;
let taskQueueSeq = 0;

beforeAll(async () => {
	env = await TestWorkflowEnvironment.createTimeSkipping();
	workflowBundle = await bundleWorkflowCode({
		workflowsPath: WORKFLOWS_PATH,
	});
}, 180_000);

afterAll(async () => {
	await env?.teardown();
});

async function runScan(failingStep: {
	activity: "gatherScanContextActivity" | "persistScanResultsActivity";
	error: string;
}): Promise<{
	failMessage: string | undefined;
	result: SecurityAccessibilityScanOutput;
}> {
	let failMessage: string | undefined;
	const fail = async () => {
		throw new Error(failingStep.error);
	};

	const activities = {
		markScanRunningActivity: async () => undefined,
		gatherScanContextActivity: async () => ({
			projectName: "Example project",
			items: [{ key: "doc:1", label: "Doc", text: "Some content" }],
			scannedItemKeys: ["doc:1"],
			securityRules: [],
			accessibilityRules: [],
			severityRubric: undefined,
			knowledgePacks: [],
			semgrepEnabled: false,
			gitHistoryEnabled: false,
			autoReviewEnabled: false,
		}),
		resolveScanCommitActivity: async () => ({
			codeScanMode: "FULL",
			baseSha: null,
			targetSha: null,
		}),
		runSecurityScanActivity: async () => ({ findings: [] }),
		runAccessibilityScanActivity: async () => ({ findings: [] }),
		persistScanResultsActivity: async () => ({
			securityFindingCount: 0,
			accessibilityFindingCount: 0,
		}),
		failScanActivity: async (input: { message: string }) => {
			failMessage = input.message;
		},
		[failingStep.activity]: fail,
	};

	const input: SecurityAccessibilityScanInput = {
		scanId: "scan-1",
		projectId: "proj-1",
		targetType: "PROJECT",
		mode: "FULL",
		userId: "user-1",
		organizationId: "org-1",
		securityRequested: true,
		accessibilityRequested: true,
		branch: "master",
	};

	taskQueueSeq += 1;
	const taskQueue = `security-scan-failure-${taskQueueSeq}`;
	const worker = await Worker.create({
		connection: env.nativeConnection,
		taskQueue,
		workflowBundle,
		activities,
	});

	const result = await worker.runUntil(
		env.client.workflow.execute(WORKFLOW_NAME, {
			taskQueue,
			workflowId: `security-scan-failure-${taskQueueSeq}`,
			args: [input],
		}),
	);
	return { failMessage, result: result as SecurityAccessibilityScanOutput };
}

describe("securityAccessibilityScanWorkflow failure message", () => {
	it("records the failed step and its cause once the persist retries run out", async () => {
		const { failMessage, result } = await runScan({
			activity: "persistScanResultsActivity",
			error: "Unique constraint failed on the fields: (`fingerprint`)",
		});

		expect(result.success).toBe(false);
		expect(failMessage).toBe(
			"Saving the scan results failed: Unique constraint failed on the fields: (`fingerprint`)",
		);
		expect(result.error).toBe(failMessage);
	}, 60_000);

	it("names the context-gather step when that is what failed", async () => {
		const { failMessage } = await runScan({
			activity: "gatherScanContextActivity",
			error: "Project proj-1 not found",
		});

		expect(failMessage).toBe(
			"Gathering the project content failed: Project proj-1 not found",
		);
	}, 60_000);
});
