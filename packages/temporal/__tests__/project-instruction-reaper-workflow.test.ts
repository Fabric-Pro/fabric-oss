/**
 * Behavioural test for `projectInstructionReaperWorkflow` on a time-skipping
 * test server, bundling the REAL workflows barrel. Each hourly tick reaps
 * snapshots as before and then, each behind a `patched()` gate that keeps
 * the histories already recorded replayable, the Coding Instructions
 * sync-run receipts whose workflow run ended without completing them
 * (Fizzy #2672) and the Living Memory ones (Fizzy #2784).
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
	it("reaps snapshots, then stranded sync receipts of both syncs, and returns every result", async () => {
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
		const contextSyncReceipts = {
			...syncReceipts,
			candidates: 2,
			completed: 2,
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
			reapStrandedContextSyncReceipts: vi.fn(async () => {
				order.push("contextSyncReceipts");
				return contextSyncReceipts;
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

		expect(order).toEqual([
			"snapshots",
			"syncReceipts",
			"contextSyncReceipts",
		]);
		expect(result).toEqual({
			...snapshots,
			syncReceipts,
			contextSyncReceipts,
		});
	}, 60_000);
});
