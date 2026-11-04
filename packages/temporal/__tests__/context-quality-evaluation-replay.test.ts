import { resolve } from "node:path";
import { Context, heartbeat } from "@temporalio/activity";
import { CancelledFailure } from "@temporalio/common";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { bundleWorkflowCode, Worker } from "@temporalio/worker";
import { beforeAll, describe, expect, it } from "vitest";
import { CONTEXT_QUALITY_TASK_QUEUE } from "../src/task-queues";

let bundle: Awaited<ReturnType<typeof bundleWorkflowCode>>;
beforeAll(async () => {
	bundle = await bundleWorkflowCode({
		workflowsPath: resolve(
			import.meta.dirname,
			"../src/workflows/context-quality-evaluation.ts",
		),
	});
}, 60000);
const input = {
	evaluationRunId: "example-run",
	organizationId: "example-org",
	projectId: "example-project",
	requesterUserId: "example-user",
};
describe("metadata-only context evaluation workflow and replay", () => {
	it.each(["complete", "cancel"])(
		"records and replays %s without snapshots, outputs or credentials",
		async (scenario) => {
			const env = await TestWorkflowEnvironment.createTimeSkipping();
			const calls: { name: string; input: unknown }[] = [];
			let started!: () => void;
			const entered = new Promise<void>((resolve) => {
				started = resolve;
			});
			try {
				const workflowWorker = await Worker.create({
					connection: env.nativeConnection,
					workflowBundle: bundle,
					taskQueue: "example-evaluation",
				});
				const activityWorker = await Worker.create({
					connection: env.nativeConnection,
					taskQueue: CONTEXT_QUALITY_TASK_QUEUE,
					maxHeartbeatThrottleInterval: "100ms",
					defaultHeartbeatThrottleInterval: "50ms",
					activities: {
						executeSavedContextQualityEvaluation: async (
							value: unknown,
						) => {
							calls.push({ name: "execute", input: value });
							started();
							if (scenario === "cancel") {
								const ticker = setInterval(
									() =>
										heartbeat({
											phase: "context-quality-evaluation",
										}),
									20,
								);
								try {
									await Context.current().cancelled;
									throw new CancelledFailure(
										"Context evaluation cancelled.",
									);
								} finally {
									clearInterval(ticker);
								}
							}
							return { status: "SUCCEEDED" };
						},
						settleCancelledContextQualityEvaluation: async (
							value: unknown,
						) => {
							calls.push({ name: "settle", input: value });
							return { status: "CANCELLED" };
						},
					},
				});
				const handle = await env.client.workflow.start(
					"contextQualityEvaluationWorkflow",
					{
						workflowId: `example-evaluation-${scenario}`,
						taskQueue: "example-evaluation",
						args: [input],
					},
				);
				await workflowWorker.runUntil(
					activityWorker.runUntil(
						(async () => {
							await entered;
							if (scenario === "cancel") {
								await handle.cancel();
								await expect(handle.result()).rejects.toThrow();
							} else {
								expect(await handle.result()).toEqual({
									status: "SUCCEEDED",
								});
							}
						})(),
					),
				);
				expect(calls.map((call) => call.name)).toEqual(
					scenario === "cancel" ? ["execute", "settle"] : ["execute"],
				);
				expect(
					calls.every(
						(call) =>
							JSON.stringify(call.input) ===
							JSON.stringify(input),
					),
				).toBe(true);
				const history = await handle.fetchHistory();
				const schedules = (history.events ?? []).flatMap((event) =>
					event.activityTaskScheduledEventAttributes
						? [event.activityTaskScheduledEventAttributes]
						: [],
				);
				expect(
					schedules.every(
						(schedule) =>
							schedule.taskQueue?.name ===
							CONTEXT_QUALITY_TASK_QUEUE,
					),
				).toBe(true);
				expect(JSON.stringify(history)).not.toContain("recordedAnswer");
				expect(JSON.stringify(history)).not.toContain(
					"snapshotPayload",
				);
				await Worker.runReplayHistory(
					{ workflowBundle: bundle },
					history,
					`example-evaluation-${scenario}`,
				);
			} finally {
				await env.teardown();
			}
		},
		60000,
	);
});
