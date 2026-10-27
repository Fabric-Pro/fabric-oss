import { resolve } from "node:path";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { bundleWorkflowCode, Worker } from "@temporalio/worker";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { ApprovalCommand, ApprovalReceipt } from "../approval-gate";
import type { PendingApprovalInfo } from "../types";

let env: TestWorkflowEnvironment;
let bundle: Awaited<ReturnType<typeof bundleWorkflowCode>>;
beforeAll(async () => {
	env = await TestWorkflowEnvironment.createTimeSkipping({
		server: process.env.TEMPORAL_TEST_SERVER_PATH
			? {
					executable: {
						type: "existing-path",
						path: process.env.TEMPORAL_TEST_SERVER_PATH,
					},
				}
			: undefined,
	});
	bundle = await bundleWorkflowCode({
		workflowsPath: resolve(__dirname, "fixtures/approval-workflow.ts"),
	});
}, 180_000);
afterAll(async () => {
	await env?.teardown();
});

it("persists decisions, rejects stale/concurrent updates, and replays the recorded history", async () => {
	const taskQueue = "approval-replay";
	const worker = await Worker.create({
		connection: env.nativeConnection,
		taskQueue,
		workflowBundle: bundle,
	});
	await worker.runUntil(async () => {
		const handle = await env.client.workflow.start("approvalWorkflow", {
			taskQueue,
			workflowId: taskQueue,
		});
		const pending =
			await handle.query<PendingApprovalInfo>("pendingApproval");
		if (!pending.requestId || !pending.runId) {
			throw new Error("Checkpoint was not bound");
		}
		const command: ApprovalCommand = {
			approvalId: pending.approvalId,
			requestId: pending.requestId,
			runId: pending.runId,
			organizationId: "example-org",
			decidedBy: "example-user",
			approved: true,
		};
		// Legacy unbound decisions and approve-all must not satisfy this explicit gate.
		await handle.signal("approval", { approved: true });
		await handle.signal("autoApproveAll");
		expect(
			(await handle.query<PendingApprovalInfo>("pendingApproval"))
				.approvalId,
		).toBe("approval-1");
		const results = await Promise.all(
			[true, false].map((approved) =>
				handle.executeUpdate<ApprovalReceipt, [ApprovalCommand]>(
					"decideApproval",
					{ args: [{ ...command, approved }] },
				),
			),
		);
		expect(results.filter((r) => r.accepted)).toHaveLength(1);
		expect(
			(await handle.query<PendingApprovalInfo>("pendingApproval"))
				.approvalId,
		).toBe("approval-2");
		expect(
			await handle.executeUpdate("decideApproval", { args: [command] }),
		).toMatchObject({ accepted: false, reason: "stale" });
		const second =
			await handle.query<PendingApprovalInfo>("pendingApproval");
		expect(
			await handle.executeUpdate("decideApproval", {
				args: [
					{
						...command,
						approvalId: second.approvalId,
						requestId: second.requestId,
						approved: false,
					},
				],
			}),
		).toMatchObject({ accepted: true, approved: false });
		const decisions = await handle.result();
		expect(decisions).toHaveLength(2);
		const history = await handle.fetchHistory();
		await Worker.runReplayHistory(
			{ workflowBundle: bundle },
			history,
			taskQueue,
		);
	});
}, 180_000);

it("expires an unattended checkpoint without authorizing a tool", async () => {
	const taskQueue = "approval-expiry";
	const worker = await Worker.create({
		connection: env.nativeConnection,
		taskQueue,
		workflowBundle: bundle,
	});
	await worker.runUntil(async () => {
		const handle = await env.client.workflow.start("approvalWorkflow", {
			taskQueue,
			workflowId: taskQueue,
		});
		expect(await handle.result()).toEqual([null, null]);
		await Worker.runReplayHistory(
			{ workflowBundle: bundle },
			await handle.fetchHistory(),
			taskQueue,
		);
	});
}, 180_000);

it("cancels a waiting checkpoint without carrying an approval forward", async () => {
	const taskQueue = "approval-cancel";
	const worker = await Worker.create({
		connection: env.nativeConnection,
		taskQueue,
		workflowBundle: bundle,
	});
	await worker.runUntil(async () => {
		const handle = await env.client.workflow.start("approvalWorkflow", {
			taskQueue,
			workflowId: taskQueue,
		});
		await handle.signal("cancel");
		expect(await handle.result()).toEqual([null]);
		await Worker.runReplayHistory(
			{ workflowBundle: bundle },
			await handle.fetchHistory(),
			taskQueue,
		);
	});
}, 180_000);

it("replays pre-update approval signal histories with the new controller", async () => {
	const legacyBundle = await bundleWorkflowCode({
		workflowsPath: resolve(
			__dirname,
			"fixtures/approval-legacy-workflow.ts",
		),
	});
	const taskQueue = "approval-legacy-replay";
	const worker = await Worker.create({
		connection: env.nativeConnection,
		taskQueue,
		workflowBundle: legacyBundle,
	});
	const history = await worker.runUntil(async () => {
		const handle = await env.client.workflow.start("approvalWorkflow", {
			taskQueue,
			workflowId: taskQueue,
		});
		await handle.query("pendingApproval");
		await handle.signal("approval", { approved: true });
		await handle.query("pendingApproval");
		await handle.signal("approval", { approved: false });
		expect(await handle.result()).toEqual([
			{ approved: true },
			{ approved: false },
		]);
		return handle.fetchHistory();
	});
	await Worker.runReplayHistory(
		{ workflowBundle: bundle },
		history,
		taskQueue,
	);
}, 180_000);
