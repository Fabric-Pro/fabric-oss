/**
 * A failed scan must record why it failed (Fizzy #2502).
 *
 * A production scan failed with the banner "Activity task failed" — Temporal's
 * wrapper text for a step whose retries ran out. The real cause sat one level
 * down in the error's `.cause` chain, so neither the user nor the server log
 * said what broke. These run the real workflow and assert on the message
 * `failScanActivity` receives, which is what the banner and the log line show.
 *
 * The cause was the gathered content outgrowing Temporal's payload limits, so
 * the last case runs a prod-sized project's budgeted content end to end.
 */

import { resolve } from "node:path";
import { applyScanItemCeilings, type ScanContentItem } from "@repo/database";
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

/** 458 features of ~11.7 KB, the shape of the prod project whose scan failed. */
function prodSizedItems(): ScanContentItem[] {
	return Array.from({ length: 458 }, (_, i) => ({
		key: `F-${i + 1}`,
		label: `Feature F-${i + 1} (FEATURE): Item ${i + 1}`,
		text: "x".repeat(11_600),
	}));
}

async function runScan(
	overrides: Record<string, (...args: never[]) => Promise<unknown>>,
	items: ScanContentItem[] = [
		{ key: "doc:1", label: "Doc", text: "Some content" },
	],
): Promise<{
	failMessage: string | undefined;
	scannedItemCount: number | undefined;
	result: SecurityAccessibilityScanOutput;
}> {
	let failMessage: string | undefined;
	let scannedItemCount: number | undefined;

	const activities = {
		markScanRunningActivity: async () => undefined,
		gatherScanContextActivity: async () => ({
			projectName: "Example project",
			items,
			scannedItemKeys: items.map((item) => item.key),
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
		runSecurityScanActivity: async (input: { items: unknown[] }) => {
			scannedItemCount = input.items.length;
			return { findings: [] };
		},
		runAccessibilityScanActivity: async () => ({ findings: [] }),
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
		scannedItemCount,
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

describe("securityAccessibilityScanWorkflow content size", () => {
	// Without the byte budget, the 200 items the item ceiling kept (2.34 MB) were
	// rejected at the gather result on Temporal Cloud; on the local test server
	// the two scanner inputs then overflow the 4 MB gRPC limit and the workflow
	// task retries forever. This runs the budgeted content through both hops.
	it("completes a prod-sized project once the content passes through the scan size ceilings", async () => {
		const { items } = applyScanItemCeilings(prodSizedItems());
		const { failMessage, scannedItemCount, result } = await runScan(
			{},
			items,
		);

		expect(failMessage).toBeUndefined();
		expect(result.success).toBe(true);
		expect(scannedItemCount).toBe(items.length);
	}, 120_000);
});
