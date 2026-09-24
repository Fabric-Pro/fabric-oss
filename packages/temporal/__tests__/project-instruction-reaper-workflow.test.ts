/**
 * Behavioural test for `projectInstructionReaperWorkflow` on a time-skipping
 * test server, bundling the REAL workflows barrel. Each hourly tick reaps
 * snapshots as before and then, behind a `patched()` gate that keeps the
 * histories already recorded replayable, the sync-run receipts whose
 * workflow run ended without completing them (Fizzy #2672).
 *
 * Run with:
 *   pnpm --filter @repo/temporal test __tests__/project-instruction-reaper-workflow.test.ts
 */
import { resolve } from "node:path";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import {
	bundleWorkflowCode,
	Worker,
	type WorkflowBundleWithSourceMap,
} from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const WORKFLOWS_PATH = resolve(__dirname, "..", "src", "workflows");
const WORKFLOW_NAME = "projectInstructionReaperWorkflow";

let env: TestWorkflowEnvironment;
let workflowBundle: WorkflowBundleWithSourceMap;

beforeAll(async () => {
	env = await TestWorkflowEnvironment.createTimeSkipping();
	workflowBundle = await bundleWorkflowCode({
		workflowsPath: WORKFLOWS_PATH,
	});
}, 120_000);

afterAll(async () => {
	await env?.teardown();
});

describe("projectInstructionReaperWorkflow", () => {
	it("reaps snapshots, then stranded sync receipts, and returns both results", async () => {
		const taskQueue = `instruction-reaper-${Date.now()}`;
		const order: string[] = [];
		const snapshots = { rejected: 1, snapshotsPruned: 2 };
		const syncReceipts = {
			candidates: 1,
			completed: 1,
			alreadyFinished: 0,
			stillRunning: 0,
			unknown: 0,
			errorCount: 0,
			hitCap: false,
		};
		const activities = {
			reapInstructionSnapshots: vi.fn(async () => {
				order.push("snapshots");
				return snapshots;
			}),
			reapStrandedInstructionSyncReceipts: vi.fn(async () => {
				order.push("syncReceipts");
				return syncReceipts;
			}),
		};
		const worker = await Worker.create({
			connection: env.nativeConnection,
			taskQueue,
			workflowBundle,
			activities,
		});

		const result = await worker.runUntil(
			env.client.workflow.execute(WORKFLOW_NAME, {
				taskQueue,
				workflowId: `instruction-reaper-test-${Date.now()}`,
				args: [],
			}),
		);

		expect(order).toEqual(["snapshots", "syncReceipts"]);
		expect(result).toEqual({ ...snapshots, syncReceipts });
	}, 60_000);
});
