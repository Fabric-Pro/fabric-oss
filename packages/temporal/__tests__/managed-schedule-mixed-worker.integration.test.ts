import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Context } from "@temporalio/activity";
import { historyToJSON } from "@temporalio/common/lib/proto-utils";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { bundleWorkflowCode, Worker } from "@temporalio/worker";
import { expect, it } from "vitest";
import type { dispatchManagedAgentScheduledExecution } from "../src/activities/schedule-trigger";
import { buildWorkflowBundleOptions } from "../src/lib/workflow-bundle-options";

it.skipIf(process.env.RUN_TEMPORAL_INTEGRATION !== "1")(
	"an old worker cannot execute managed schedule tasks and a capable worker resumes the native retry",
	async () => {
		const address = process.env.TEMPORAL_ADDRESS ?? "";
		if (!/^127\.0\.0\.1:\d+$/.test(address)) {
			throw Error("An explicit loopback Temporal address is required");
		}
		const namespace = process.env.TEMPORAL_NAMESPACE ?? "default";
		const env = await TestWorkflowEnvironment.createFromExistingServer({
			address,
			namespace,
			client: { identity: "example-client" },
		});
		const workflowId = `example-schedule-mixed-${randomUUID()}`;
		const source = resolve(
			import.meta.dirname,
			"../src/workflows/schedule-trigger.ts",
		);
		let legacyHandlerCalls = 0;
		let managedHandlerCalls = 0;
		const old = await Worker.create({
			connection: env.nativeConnection,
			namespace,
			identity: "example-old-schedule-worker",
			taskQueue: workflowId,
			activities: {
				signalSupervisorForScheduledExecution: async () => {
					legacyHandlerCalls++;
					return { success: true, executionId: "example-legacy-row" };
				},
			},
		});
		const workflow = await Worker.create({
			connection: env.nativeConnection,
			namespace,
			identity: "example-schedule-workflow-worker",
			taskQueue: workflowId,
			enableNonLocalActivities: false,
			workflowBundle: await bundleWorkflowCode(
				buildWorkflowBundleOptions(source),
			),
		});
		const handle = await env.client.workflow.start(
			"managedAgentRunScheduleWorkflow",
			{
				workflowId,
				taskQueue: workflowId,
				args: [
					{
						managedRunSchedule: 1,
						userId: "example-user",
						organizationId: "example-org",
						supervisorWorkflowId: "",
						deploymentId: "example-deployment",
						triggerId: "fabric-run-schedule-example-deployment",
						triggerType: "SCHEDULE",
						occurrenceWorkflowId: "example-untrusted-occurrence",
						occurrenceFirstRunId: "example-untrusted-first-run",
					},
				],
			},
		);
		const oldRun = old.run();
		let oldStopped = false;
		try {
			const result = await workflow.runUntil(async () => {
				const deadline = Date.now() + 15_000;
				let observedUnregistered = false;
				while (Date.now() < deadline) {
					const description =
						await env.client.workflowService.describeWorkflowExecution(
							{
								namespace,
								execution: {
									workflowId,
									runId: handle.firstExecutionRunId,
								},
							},
						);
					if (description.workflowExecutionInfo?.closeTime) {
						throw Error(
							"Managed occurrence closed before a capable Activity worker was started",
						);
					}
					const pending = description.pendingActivities?.find(
						(activity) =>
							activity.activityType?.name ===
							"dispatchManagedAgentScheduledExecution",
					);
					if (
						pending?.lastFailure?.message?.includes(
							"not registered",
						)
					) {
						observedUnregistered = true;
						break;
					}
					await new Promise((done) => setTimeout(done, 100));
				}
				expect(observedUnregistered).toBe(true);
				expect(legacyHandlerCalls).toBe(0);
				expect(managedHandlerCalls).toBe(0);
				old.shutdown();
				await oldRun;
				oldStopped = true;
				const capable = await Worker.create({
					connection: env.nativeConnection,
					namespace,
					identity: "example-capable-schedule-worker",
					taskQueue: workflowId,
					activities: {
						dispatchManagedAgentScheduledExecution: async (
							input: Parameters<
								typeof dispatchManagedAgentScheduledExecution
							>[0],
						) => {
							managedHandlerCalls++;
							expect(Context.current().info.activityType).toBe(
								"dispatchManagedAgentScheduledExecution",
							);
							expect(input).toMatchObject({
								managedRunSchedule: 1,
								userId: "example-user",
								organizationId: "example-org",
								occurrenceWorkflowId: workflowId,
								occurrenceFirstRunId:
									handle.firstExecutionRunId,
							});
							return {
								success: true,
								executionId: "example-execution-row",
							};
						},
					},
				});
				return capable.runUntil(handle.result());
			});
			expect(result).toEqual({
				success: true,
				executionId: "example-execution-row",
			});
			expect(legacyHandlerCalls).toBe(0);
			expect(managedHandlerCalls).toBe(1);
			const history = await handle.fetchHistory();
			const scheduled = history.events?.flatMap((event) =>
				event.activityTaskScheduledEventAttributes
					? [event.activityTaskScheduledEventAttributes]
					: [],
			);
			expect(scheduled).toHaveLength(1);
			expect(scheduled?.[0].activityType?.name).toBe(
				"dispatchManagedAgentScheduledExecution",
			);
			expect(scheduled?.[0].retryPolicy?.maximumAttempts ?? 0).toBe(0);
			const attempts = history.events?.flatMap(
				(event) =>
					event.activityTaskStartedEventAttributes?.attempt ?? [],
			);
			expect(attempts?.at(-1)).toBeGreaterThanOrEqual(2);
			await Worker.runReplayHistory(
				{
					workflowBundle: await bundleWorkflowCode(
						buildWorkflowBundleOptions(source),
					),
				},
				history,
				workflowId,
			);
			if (process.env.MIXED_SCHEDULE_HISTORY_DIR) {
				await mkdir(process.env.MIXED_SCHEDULE_HISTORY_DIR, {
					recursive: true,
				});
				await writeFile(
					resolve(
						process.env.MIXED_SCHEDULE_HISTORY_DIR,
						"managed-fenced.json",
					),
					JSON.stringify(
						{
							workflowId,
							workflowType: "managedAgentRunScheduleWorkflow",
							firstExecutionRunId: handle.firstExecutionRunId,
							activityAttempts: attempts?.at(-1),
							legacyHandlerCalls,
							managedHandlerCalls,
							observedUnregisteredActivity: true,
							source: await readFile(source, "utf8"),
							history: JSON.parse(historyToJSON(history)),
						},
						null,
						2,
					),
				);
			}
		} finally {
			if (!oldStopped) {
				old.shutdown();
				await oldRun;
			}
			if ((await handle.describe()).status.name === "RUNNING") {
				await handle.terminate("Example mixed worker fixture cleanup");
			}
			await env.teardown();
		}
	},
	60_000,
);
