import { resolve } from "node:path";
import { ApplicationFailure } from "@temporalio/common";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { bundleWorkflowCode, Worker } from "@temporalio/worker";
import { beforeAll, describe, expect, it } from "vitest";

let bundle: Awaited<ReturnType<typeof bundleWorkflowCode>>;
beforeAll(async () => {
	bundle = await bundleWorkflowCode({
		workflowsPath: resolve(
			import.meta.dirname,
			"../src/workflows/coding-run-follow-up.ts",
		),
	});
}, 60_000);
const input = {
	codingRunId: "example-run",
	projectId: "example-project",
	organizationId: "example-org",
	userId: "example-user",
	sessionId: "example-session",
	promptId: "example-prompt",
	content: "Continue",
	providerMetadata: {
		executionRuntime: "fabric-agent-server",
		executionTarget: {
			url: "https://example.com",
			profileId: "example-profile",
		},
	},
};

describe("native session continuation workflow", () => {
	it("observes the existing session, syncs artifacts, and replays without creating another session", async () => {
		const env = await TestWorkflowEnvironment.createTimeSkipping();
		const calls: Array<{ kind: string; input: unknown }> = [];
		const statuses: string[] = [];
		try {
			const worker = await Worker.create({
				connection: env.nativeConnection,
				workflowBundle: bundle,
				taskQueue: "example-continuation",
				activities: {
					deliverCodingRunFollowUp: async (value: unknown) => {
						calls.push({ kind: "send", input: value });
						return { messageId: "example-message" };
					},
					pollExecutionStatus: async (value: unknown) => {
						calls.push({ kind: "poll", input: value });
						return {
							providerStatus: "completed",
							fabricStatus: "COMPLETED",
							branchName: "feat/example",
							pullRequestUrl:
								"https://github.com/example-org/example-repo/pull/1",
							pullRequestArtifact: null,
						};
					},
					syncCodingRunArtifacts: async (value: unknown) => {
						calls.push({ kind: "artifacts", input: value });
						return {
							pullRequestUrl:
								"https://github.com/example-org/example-repo/pull/1",
							branchName: "feat/example",
						};
					},
					updateCodingRunStatusActivity: async (value: {
						status: string;
					}) => {
						statuses.push(value.status);
					},
					addCodingRunEventActivity: async () => {},
					cancelExecutionSession: async () => {
						calls.push({ kind: "stop", input: null });
					},
				},
			});
			const handle = await env.client.workflow.start(
				"codingRunFollowUpWorkflow",
				{
					workflowId: "example-continuation",
					taskQueue: "example-continuation",
					args: [input],
				},
			);
			await worker.runUntil(handle.result());
			expect(statuses).toEqual(["COMPLETED"]);
			expect(calls.map((call) => call.kind)).toEqual([
				"send",
				"poll",
				"artifacts",
				"stop",
			]);
			expect(calls[0]?.input).toEqual(input);
			expect(calls[1]?.input).toMatchObject({
				sessionId: input.sessionId,
				providerMetadata: input.providerMetadata,
			});
			await Worker.runReplayHistory(
				{ workflowBundle: bundle },
				await handle.fetchHistory(),
				"example-continuation",
			);
		} finally {
			await env.teardown();
		}
	}, 60_000);
	it.each(["delivery-denied", "stop-unknown", "cancel-during-poll"])(
		"retains truthful lifecycle state for %s",
		async (scenario) => {
			const env = await TestWorkflowEnvironment.createTimeSkipping();
			const statuses: string[] = [];
			let artifactCalls = 0;
			let stopCalls = 0;
			const workflowId = `example-continuation-${scenario}`;
			try {
				const worker = await Worker.create({
					connection: env.nativeConnection,
					workflowBundle: bundle,
					taskQueue: workflowId,
					activities: {
						deliverCodingRunFollowUp: async () => {
							if (scenario === "delivery-denied") {
								throw ApplicationFailure.nonRetryable(
									"Access revoked",
									"INVALID_SESSION",
								);
							}
							return { messageId: "example-message" };
						},
						pollExecutionStatus: async () => {
							if (scenario === "cancel-during-poll") {
								await env.client.workflow
									.getHandle(workflowId)
									.signal("cancelCodingRun");
							}
							return {
								providerStatus: "completed",
								fabricStatus: "COMPLETED",
								branchName: null,
								pullRequestUrl: null,
								pullRequestArtifact: null,
							};
						},
						syncCodingRunArtifacts: async () => {
							artifactCalls++;
							return { pullRequestUrl: null, branchName: null };
						},
						updateCodingRunStatusActivity: async ({
							status,
						}: {
							status: string;
						}) => {
							statuses.push(status);
						},
						addCodingRunEventActivity: async () => {},
						cancelExecutionSession: async () => {
							stopCalls++;
							if (scenario === "stop-unknown") {
								throw ApplicationFailure.nonRetryable(
									"Unconfirmed shutdown",
									"RECOVERY_REQUIRED",
								);
							}
						},
					},
				});
				const handle = await env.client.workflow.start(
					"codingRunFollowUpWorkflow",
					{ workflowId, taskQueue: workflowId, args: [input] },
				);
				await worker.runUntil(async () => {
					if (scenario === "delivery-denied") {
						await expect(handle.result()).rejects.toBeDefined();
					} else {
						await handle.result();
					}
				});
				expect(stopCalls).toBe(1);
				expect(statuses).toEqual([
					scenario === "stop-unknown"
						? "AWAITING_REVIEW"
						: scenario === "delivery-denied"
							? "FAILED"
							: "CANCELLED",
				]);
				if (scenario === "cancel-during-poll") {
					expect(artifactCalls).toBe(0);
				}
			} finally {
				await env.teardown();
			}
		},
		60_000,
	);
});

it("replays the watchdog's confirmed-cleanup gate without marking uncertain native work stale", async () => {
	const workflowBundle = await bundleWorkflowCode({
		workflowsPath: resolve(
			import.meta.dirname,
			"../src/workflows/weave-execution-watchdog.ts",
		),
	});
	const env = await TestWorkflowEnvironment.createTimeSkipping();
	let staleMarks = 0;
	try {
		const worker = await Worker.create({
			connection: env.nativeConnection,
			workflowBundle,
			taskQueue: "example-native-watchdog",
			activities: {
				findStaleWeaveSessions: async () => ({
					rows: [
						{
							kind: "coding_run",
							id: input.codingRunId,
							sessionId: input.sessionId,
							provider: "BACKGROUND_AGENTS",
							providerMetadata: input.providerMetadata,
							requiresConfirmedCleanup: true,
							userId: input.userId,
							organizationId: input.organizationId,
							workflowId: "example-old-workflow",
							startedAtMs: 0,
						},
					],
				}),
				cancelWeaveExecutionViaSignal: async () => true,
				terminateWeaveWorkflow: async () => {},
				cleanupWeaveResourcesActivity: async () => ({
					destroyed: false,
					alreadyTerminal: false,
				}),
				markWeaveExecutionStale: async () => {
					staleMarks++;
				},
			},
		});
		const handle = await env.client.workflow.start(
			"weaveExecutionWatchdogWorkflow",
			{
				workflowId: "example-native-watchdog",
				taskQueue: "example-native-watchdog",
				args: [{}],
			},
		);
		await worker.runUntil(handle.result());
		expect(staleMarks).toBe(0);
		await Worker.runReplayHistory(
			{ workflowBundle },
			await handle.fetchHistory(),
			"example-native-watchdog",
		);
	} finally {
		await env.teardown();
	}
}, 60_000);
