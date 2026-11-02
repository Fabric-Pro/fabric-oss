import { resolve } from "node:path";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { bundleWorkflowCode, Worker } from "@temporalio/worker";
import { beforeAll, describe, expect, it } from "vitest";

let legacy: Awaited<ReturnType<typeof bundleWorkflowCode>>;
let current: typeof legacy;
beforeAll(async () => {
	const workflowsPath = resolve(
		import.meta.dirname,
		"helpers/chat-replay-test-workflow.ts",
	);
	legacy = await bundleWorkflowCode({ workflowsPath });
	current = await bundleWorkflowCode({
		workflowsPath,
		workflowInterceptorModules: [
			resolve(
				import.meta.dirname,
				"../src/workflows/chat-replay-workflow-interceptor.ts",
			),
		],
	});
}, 60000);
describe("chat replay query history compatibility", () => {
	it.each([false, true, "old-worker"] as const)(
		"replays unchanged commands with durable failure metadata=%s",
		async (failed) => {
			const env = await TestWorkflowEnvironment.createTimeSkipping({
				client: { identity: "example-client" },
			});
			try {
				let call = 0;
				const worker = await Worker.create({
					connection: env.nativeConnection,
					taskQueue: "example-replay-queue",
					identity: "example-worker",
					workflowBundle: failed ? current : legacy,
					activities: {
						runAgentIteration: async () => ({
							response: `Example ${++call}`,
							...(failed === true && call === 1
								? { __fabricChatReplayUnavailable: true }
								: {}),
						}),
					},
				});
				const history = await worker.runUntil(async () => {
					const handle = await env.client.workflow.start(
						"orchestratorExecutionWorkflow",
						{
							workflowId: `orch-example-${failed}`,
							taskQueue: "example-replay-queue",
						},
					);
					expect(await handle.result()).toEqual([
						{ response: "Example 1" },
						{ response: "Example 2" },
					]);
					if (failed) {
						expect(await handle.query("chatReplayStatus")).toEqual({
							version: 1,
							unavailable: true,
						});
					}
					return handle.fetchHistory();
				});
				expect(
					history.events?.filter(
						(event) => event.markerRecordedEventAttributes,
					),
				).toEqual([]);
				await Worker.runReplayHistory(
					{ workflowBundle: legacy },
					history,
				);
				await expect(
					Worker.runReplayHistory(
						{ workflowBundle: current },
						history,
					),
				).resolves.toBeUndefined();
			} finally {
				await env.teardown();
			}
		},
		60000,
	);
});

it("replays a synthetic run whose earlier prefix was produced without journal metadata", async () => {
	const env = await TestWorkflowEnvironment.createTimeSkipping({
		client: { identity: "example-client" },
	});
	try {
		const worker = await Worker.create({
			connection: env.nativeConnection,
			taskQueue: "example-legacy-prefix",
			workflowBundle: legacy,
			activities: {
				runAgentIteration: async () => ({
					response: "Unjournaled prefix",
				}),
			},
		});
		const history = await worker.runUntil(async () => {
			const handle = await env.client.workflow.start(
				"orchestratorExecutionWorkflow",
				{
					workflowId: "orch-example-legacy-prefix",
					taskQueue: "example-legacy-prefix",
					args: [true],
				},
			);
			await handle.result();
			return handle.fetchHistory();
		});
		expect(
			history.events?.filter(
				(event) => event.markerRecordedEventAttributes,
			),
		).toEqual([]);
		await expect(
			Worker.runReplayHistory({ workflowBundle: current }, history),
		).resolves.toBeUndefined();
	} finally {
		await env.teardown();
	}
}, 60000);
