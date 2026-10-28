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
			args: [2],
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
		// Stale decisions and approve-all must not satisfy this explicit gate.
		await handle.signal("approval", {
			approved: true,
			approvalId: "stale-approval",
		});
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
		const rollbackBundle = await bundleWorkflowCode({
			workflowsPath: resolve(
				__dirname,
				"fixtures/approval-legacy-workflow.ts",
			),
		});
		await expect(
			Worker.runReplayHistory(
				{ workflowBundle: rollbackBundle },
				history,
				"approval-rollback",
			),
		).rejects.toThrow(/nondeterminism/i);

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
			args: [2],
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
			args: [2],
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

it.each([false, true])(
	"replays staging histories including approve-all during an explicit wait: %s",
	async (approveAll) => {
		const legacyBundle = await bundleWorkflowCode({
			workflowsPath: resolve(
				__dirname,
				"fixtures/approval-legacy-workflow.ts",
			),
		});
		const taskQueue = `approval-legacy-replay-${approveAll}`;
		const worker = await Worker.create({
			connection: env.nativeConnection,
			taskQueue,
			workflowBundle: legacyBundle,
		});
		const history = await worker.runUntil(async () => {
			const handle = await env.client.workflow.start("approvalWorkflow", {
				taskQueue,
				workflowId: taskQueue,
				args: [],
			});
			await handle.query("pendingApproval");
			if (approveAll) {
				await handle.signal("autoApproveAll");
				await handle.query("pendingApproval");
			}
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
	},
	180_000,
);

it("replays signal-only histories from new legacy runs on the staging fixture", async () => {
	const taskQueue = "approval-switch-off";
	const worker = await Worker.create({
		connection: env.nativeConnection,
		taskQueue,
		workflowBundle: bundle,
	});
	const history = await worker.runUntil(async () => {
		const handle = await env.client.workflow.start("approvalWorkflow", {
			taskQueue,
			workflowId: taskQueue,
			args: [],
		});
		await handle.query("pendingApproval");
		await handle.signal("approval", {
			approvalId: "approval-1",
			approved: true,
		});
		await handle.query("pendingApproval");
		await handle.signal("approval", {
			approvalId: "approval-2",
			approved: false,
		});
		expect(await handle.result()).toEqual([
			{ approvalId: "approval-1", approved: true },
			{ approvalId: "approval-2", approved: false },
		]);
		return handle.fetchHistory();
	});
	expect(
		history.events?.some(
			(event) => event.workflowExecutionUpdateAcceptedEventAttributes,
		),
	).toBe(false);
	const legacy = await bundleWorkflowCode({
		workflowsPath: resolve(
			__dirname,
			"fixtures/approval-legacy-workflow.ts",
		),
	});
	await Worker.runReplayHistory(
		{ workflowBundle: legacy },
		history,
		taskQueue,
	);
	await Worker.runReplayHistory(
		{ workflowBundle: bundle },
		history,
		taskQueue,
	);
}, 180_000);

it.each(["signal", "approve-all", "timeout"] as const)(
	"replays non-explicit legacy waits settled by %s in both directions",
	async (settlement) => {
		const legacy = await bundleWorkflowCode({
			workflowsPath: resolve(
				__dirname,
				"fixtures/approval-legacy-workflow.ts",
			),
		});
		for (const [source, target, direction] of [
			[legacy, bundle, "forward"],
			[bundle, legacy, "rollback"],
		] as const) {
			const taskQueue = `approval-plan-${settlement}-${direction}`;
			const worker = await Worker.create({
				connection: env.nativeConnection,
				taskQueue,
				workflowBundle: source,
			});
			const history = await worker.runUntil(async () => {
				const handle = await env.client.workflow.start(
					"approvalWorkflow",
					{
						taskQueue,
						workflowId: taskQueue,
						args: [undefined, false],
					},
				);
				await handle.query("pendingApproval");
				if (settlement === "approve-all") {
					await handle.signal("autoApproveAll");
				} else if (settlement === "signal") {
					await handle.signal("approval", { approved: true });
					await handle.query("pendingApproval");
					await handle.signal("approval", { approved: false });
				}
				const auto = {
					approved: true,
					feedback: "Auto-approved (approve all)",
				};
				expect(await handle.result()).toEqual(
					settlement === "timeout"
						? [null, null]
						: settlement === "approve-all"
							? [auto, auto]
							: [{ approved: true }, { approved: false }],
				);
				return handle.fetchHistory();
			});
			await Worker.runReplayHistory(
				{ workflowBundle: target },
				history,
				taskQueue,
			);
		}
	},
	180_000,
);
