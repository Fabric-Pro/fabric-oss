/**
 * Behavioural test for `projectInstructionReaperWorkflow` on a time-skipping
 * test server, bundling the REAL workflows barrel. Each hourly tick reaps
 * snapshots as before and then, each behind a `patched()` gate that keeps
 * the histories already recorded replayable, the Coding Instructions
 * sync-run receipts whose workflow run ended without completing them
 * (Fizzy #2672), the Living Memory ones (Fizzy #2784), and durable storage
 * cleanup receipts for deleted snapshots.
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
	it("reaps snapshots, both stranded sync receipt queues, then storage cleanup receipts", async () => {
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
		const storageCleanupReceipts = {
			candidates: 1,
			completed: 1,
			deferred: 0,
			objectsDeleted: 3,
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
			reapStrandedContextSyncReceipts: vi.fn(async () => {
				order.push("contextSyncReceipts");
				return contextSyncReceipts;
			}),
			reapInstructionStorageCleanupReceipts: vi.fn(async () => {
				order.push("storageCleanupReceipts");
				return storageCleanupReceipts;
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
			"storageCleanupReceipts",
		]);
		expect(result).toEqual({
			...snapshots,
			syncReceipts,
			contextSyncReceipts,
			storageCleanupReceipts,
		});
	}, 60_000);

	it.each([
		["snapshot reaper", true, false, false],
		["instruction sync receipt reaper", false, true, false],
		["context sync receipt reaper", false, false, true],
	])(
		"runs storage cleanup once when the %s fails",
		async (
			_name,
			failSnapshots,
			failSyncReceipts,
			failContextSyncReceipts,
		) => {
			const taskQueue = `instruction-reaper-failure-${Date.now()}`;
			const storageCleanupReceipts = vi.fn(async () => ({
				candidates: 0,
				completed: 0,
				deferred: 0,
				objectsDeleted: 0,
				errorCount: 0,
				hitCap: false,
			}));
			const activities = {
				reapInstructionSnapshots: vi.fn(async () => {
					if (failSnapshots) {
						throw new Error("snapshot failure");
					}
					return { rejected: 0, snapshotsPruned: 0 };
				}),
				reapStrandedInstructionSyncReceipts: vi.fn(async () => {
					if (failSyncReceipts) {
						throw new Error("instruction sync receipt failure");
					}
					return {
						candidates: 0,
						completed: 0,
						alreadyFinished: 0,
						stillRunning: 0,
						unknown: 0,
						errorCount: 0,
						hitCap: false,
					};
				}),
				reapStrandedContextSyncReceipts: vi.fn(async () => {
					if (failContextSyncReceipts) {
						throw new Error("context sync receipt failure");
					}
					return {
						candidates: 0,
						completed: 0,
						alreadyFinished: 0,
						stillRunning: 0,
						unknown: 0,
						errorCount: 0,
						hitCap: false,
					};
				}),
				reapInstructionStorageCleanupReceipts: storageCleanupReceipts,
			};
			const worker = await Worker.create({
				connection: env.nativeConnection,
				taskQueue,
				workflowBundle,
				activities,
			});

			await expect(
				worker.runUntil(
					env.client.workflow.execute(WORKFLOW_NAME, {
						taskQueue,
						workflowId: `instruction-reaper-failure-test-${Date.now()}`,
						args: [],
					}),
				),
			).rejects.toThrow("Workflow execution failed");
			expect(storageCleanupReceipts).toHaveBeenCalledTimes(1);
		},
		60_000,
	);

	it("does not run storage cleanup twice when cleanup itself fails", async () => {
		const taskQueue = `instruction-reaper-cleanup-failure-${Date.now()}`;
		const storageCleanupReceipts = vi.fn(async () => {
			throw new Error("storage cleanup failure");
		});
		const syncReceipts = {
			candidates: 0,
			completed: 0,
			alreadyFinished: 0,
			stillRunning: 0,
			unknown: 0,
			errorCount: 0,
			hitCap: false,
		};
		const worker = await Worker.create({
			connection: env.nativeConnection,
			taskQueue,
			workflowBundle,
			activities: {
				reapInstructionSnapshots: vi.fn(async () => ({
					rejected: 0,
					snapshotsPruned: 0,
				})),
				reapStrandedInstructionSyncReceipts: vi.fn(
					async () => syncReceipts,
				),
				reapStrandedContextSyncReceipts: vi.fn(
					async () => syncReceipts,
				),
				reapInstructionStorageCleanupReceipts: storageCleanupReceipts,
			},
		});

		await expect(
			worker.runUntil(
				env.client.workflow.execute(WORKFLOW_NAME, {
					taskQueue,
					workflowId: `instruction-reaper-cleanup-failure-test-${Date.now()}`,
					args: [],
				}),
			),
		).rejects.toThrow("Workflow execution failed");
		// The cleanup activity itself has two attempts. A wide predecessor catch
		// would schedule another pair after these two failures.
		expect(storageCleanupReceipts).toHaveBeenCalledTimes(2);
	}, 60_000);
});
