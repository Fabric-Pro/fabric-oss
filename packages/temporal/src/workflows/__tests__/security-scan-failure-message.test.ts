/**
 * A failed scan must record why it failed (Fizzy #2502).
 *
 * A production scan failed with the banner "Activity task failed" — Temporal's
 * wrapper text for a step whose retries ran out. The real cause sat one level
 * down in the error's `.cause` chain, so neither the user nor the server log
 * said what broke. These run the real workflow and assert on the message
 * `failScanActivity` receives, which is what the banner and the log line show.
 *
 * The cause was the gathered item text outgrowing Temporal's payload limits, so
 * the last cases check that the scanners are handed a content query instead of
 * the text, and that a gather result recorded before that still works.
 */

import { resolve } from "node:path";
import type { ScanContentItem } from "@repo/database";
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

function failWith(error: string) {
	return async () => {
		throw new Error(error);
	};
}

const CONTENT_QUERY = {
	projectId: "proj-1",
	targetType: "PROJECT",
	mode: "FULL",
	sinceCompletedAt: null,
};

type ScannerInput = { contentQuery?: unknown; items?: ScanContentItem[] };

async function runScan(
	overrides: Record<string, (...args: never[]) => Promise<unknown>>,
	gathered: { contentQuery: unknown } | { items: ScanContentItem[] } = {
		contentQuery: CONTENT_QUERY,
	},
): Promise<{
	failMessage: string | undefined;
	scannerInputs: ScannerInput[];
	result: SecurityAccessibilityScanOutput;
}> {
	let failMessage: string | undefined;
	const scannerInputs: ScannerInput[] = [];
	const scanner = async (input: ScannerInput) => {
		scannerInputs.push(input);
		return { findings: [] };
	};

	const activities = {
		markScanRunningActivity: async () => undefined,
		gatherScanContextActivity: async () => ({
			projectName: "Example project",
			...gathered,
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
		runSecurityScanActivity: scanner,
		runAccessibilityScanActivity: scanner,
		persistScanResultsActivity: async () => ({
			securityFindingCount: 0,
			accessibilityFindingCount: 0,
		}),
		failScanActivity: async (input: { message: string }) => {
			failMessage = input.message;
		},
		...overrides,
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
	return {
		failMessage,
		scannerInputs,
		result: result as SecurityAccessibilityScanOutput,
	};
}

describe("securityAccessibilityScanWorkflow failure message", () => {
	it("records the failed step and its cause once the persist retries run out", async () => {
		const { failMessage, result } = await runScan({
			persistScanResultsActivity: failWith(
				"Unique constraint failed on the fields: (`fingerprint`)",
			),
		});

		expect(result.success).toBe(false);
		expect(failMessage).toBe(
			"Saving the scan results failed: Unique constraint failed on the fields: (`fingerprint`)",
		);
		expect(result.error).toBe(failMessage);
	}, 60_000);

	it("names the context-gather step when that is what failed", async () => {
		const { failMessage } = await runScan({
			gatherScanContextActivity: failWith("Project proj-1 not found"),
		});

		expect(failMessage).toBe(
			"Gathering the project content failed: Project proj-1 not found",
		);
	}, 60_000);
});

describe("securityAccessibilityScanWorkflow scan content", () => {
	// The item text used to ride the gather result and both scanner inputs; 200
	// items of ~12 KB (2.34 MB) were rejected by Temporal's 2 MB payload limit.
	it("hands both scanners the content query, never the item text", async () => {
		const { scannerInputs, result } = await runScan({});

		expect(result.success).toBe(true);
		expect(scannerInputs).toHaveLength(2);
		for (const input of scannerInputs) {
			expect(input.contentQuery).toEqual(CONTENT_QUERY);
			expect(input.items).toBeUndefined();
		}
	}, 60_000);

	it("passes the items through from a gather result recorded before the content query", async () => {
		const items = [{ key: "doc:1", label: "Doc", text: "Some content" }];
		const { scannerInputs, result } = await runScan({}, { items });

		expect(result.success).toBe(true);
		for (const input of scannerInputs) {
			expect(input.items).toEqual(items);
			expect(input.contentQuery).toBeUndefined();
		}
	}, 60_000);
});
