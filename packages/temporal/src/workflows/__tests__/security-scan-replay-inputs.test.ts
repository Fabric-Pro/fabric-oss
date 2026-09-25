/**
 * Changing what the scan workflow passes to an activity stays replay-safe
 * (Fizzy #2502).
 *
 * Two changes altered activity inputs without a patch marker: the failure
 * message handed to `failScanActivity`, and the scanners receiving a content
 * query instead of the item text. Whether the TypeScript SDK compares recorded
 * activity inputs on replay is disputed elsewhere in this package, so this
 * records a real failing scan, rewrites both recorded inputs, and replays it.
 */

import { resolve } from "node:path";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { bundleWorkflowCode, Worker } from "@temporalio/worker";
import { afterAll, beforeAll, expect, it } from "vitest";

const WORKFLOW_ID = "security-scan-replay-inputs";

let env: TestWorkflowEnvironment;

beforeAll(async () => {
	env = await TestWorkflowEnvironment.createTimeSkipping();
}, 180_000);

afterAll(async () => {
	await env?.teardown();
});

function rewriteInput(
	history: Awaited<ReturnType<typeof fetchHistory>>,
	activityName: string,
	rewrite: (input: Record<string, unknown>) => void,
): number {
	let rewritten = 0;
	for (const event of history.events ?? []) {
		const attrs = event.activityTaskScheduledEventAttributes;
		const payload = attrs?.input?.payloads?.[0];
		if (attrs?.activityType?.name !== activityName || !payload?.data) {
			continue;
		}
		const input = JSON.parse(Buffer.from(payload.data).toString());
		rewrite(input);
		payload.data = Buffer.from(JSON.stringify(input));
		rewritten += 1;
	}
	return rewritten;
}

function fetchHistory() {
	return env.client.workflow.getHandle(WORKFLOW_ID).fetchHistory();
}

it("replays a recorded scan whose activity inputs no longer match the code", async () => {
	const workflowBundle = await bundleWorkflowCode({
		workflowsPath: resolve(__dirname, ".."),
	});
	const worker = await Worker.create({
		connection: env.nativeConnection,
		taskQueue: WORKFLOW_ID,
		workflowBundle,
		activities: {
			markScanRunningActivity: async () => undefined,
			gatherScanContextActivity: async () => ({
				projectName: "Example project",
				contentQuery: {
					projectId: "proj-1",
					targetType: "PROJECT",
					sinceCompletedAt: null,
				},
				scannedItemKeys: [],
				securityRules: [],
				accessibilityRules: [],
				knowledgePacks: [],
				semgrepEnabled: false,
				gitHistoryEnabled: false,
				autoReviewEnabled: false,
			}),
			resolveScanCommitActivity: async () => ({ codeScanMode: "FULL" }),
			runSecurityScanActivity: async () => ({ findings: [] }),
			runAccessibilityScanActivity: async () => ({ findings: [] }),
			persistScanResultsActivity: async () => {
				throw new Error("Unique constraint failed");
			},
			failScanActivity: async () => undefined,
		},
	});
	await worker.runUntil(
		env.client.workflow.execute("securityAccessibilityScanWorkflow", {
			taskQueue: WORKFLOW_ID,
			workflowId: WORKFLOW_ID,
			args: [
				{
					scanId: "scan-1",
					projectId: "proj-1",
					targetType: "PROJECT",
					userId: "user-1",
					securityRequested: true,
					accessibilityRequested: true,
				},
			],
		}),
	);
	const history = await fetchHistory();

	// As recorded by code that predates both changes.
	expect(
		rewriteInput(history, "failScanActivity", (input) => {
			input.message = "Activity task failed";
		}),
	).toBe(1);
	expect(
		rewriteInput(history, "runSecurityScanActivity", (input) => {
			input.contentQuery = undefined;
			input.items = [{ key: "a", label: "A", text: "x" }];
		}),
	).toBe(1);

	await expect(
		Worker.runReplayHistory({ workflowBundle }, history, WORKFLOW_ID),
	).resolves.toBeUndefined();
}, 180_000);
