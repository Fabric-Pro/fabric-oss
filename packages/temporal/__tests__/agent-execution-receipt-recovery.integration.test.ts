import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { bundleWorkflowCode, Worker } from "@temporalio/worker";
import { describe, expect, it } from "vitest";

const address = process.env.TEMPORAL_ADMISSION_TEST_ADDRESS;
describe.skipIf(!address)("receipt recovery on real loopback Temporal", () => {
	it("runs the bounded activity and replays its genuine history", async () => {
		if (!address || !/^(127\.0\.0\.1|localhost):\d+$/.test(address)) {
			throw new Error(
				"An explicit loopback Temporal service is required",
			);
		}
		const env = await TestWorkflowEnvironment.createFromExistingServer({
			address,
			namespace: "default",
		});
		const taskQueue = `example-receipt-recovery-${randomUUID()}`;
		const expected = {
			scanned: 3,
			recovered: 1,
			refused: 1,
			unresolved: 1,
			skipped: 0,
		};
		try {
			const workflowBundle = await bundleWorkflowCode({
				workflowsPath: resolve(
					__dirname,
					"../src/workflows/agent-execution-receipt-recovery.ts",
				),
			});
			const worker = await Worker.create({
				connection: env.nativeConnection,
				namespace: "default",
				taskQueue,
				workflowBundle,
				activities: {
					recoverAgentExecutionReceipts: async () => expected,
				},
			});
			const handle = await env.client.workflow.start(
				"agentExecutionReceiptRecoveryWorkflow",
				{ workflowId: taskQueue, taskQueue, args: [] },
			);
			expect(await worker.runUntil(handle.result())).toEqual(expected);
			const history = await handle.fetchHistory();
			expect(
				history.events?.some(
					(event) => !!event.activityTaskScheduledEventAttributes,
				),
			).toBe(true);
			await Worker.runReplayHistory({ workflowBundle }, history);
		} finally {
			await env.teardown();
		}
	}, 30000);
});
