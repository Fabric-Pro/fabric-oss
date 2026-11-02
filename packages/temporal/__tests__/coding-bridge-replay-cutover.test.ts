import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { bundleWorkflowCode, Worker } from "@temporalio/worker";
import { beforeAll, describe, expect, it } from "vitest";
import { withCodingLifecycleActivities } from "./fixtures/coding-lifecycle-activities";

let workflowBundle: Awaited<ReturnType<typeof bundleWorkflowCode>>;
beforeAll(async () => {
	workflowBundle = await bundleWorkflowCode({
		workflowsPath: resolve(
			import.meta.dirname,
			"../src/workflows/coding-run-workflow.ts",
		),
	});
}, 60_000);

describe("native bridge cutover history compatibility", () => {
	it.each(["legacy-before-bridge", "native-before-cutover-gate"])(
		"replays the genuine synthetic SDK history %s",
		async (name) => {
			const history = JSON.parse(
				await readFile(
					resolve(
						import.meta.dirname,
						"__fixtures__/coding-bridge-histories",
						`${name}.json`,
					),
					"utf8",
				),
			);
			await expect(
				Worker.runReplayHistory(
					{ workflowBundle },
					history,
					`example-${name}`,
				),
			).resolves.toBeUndefined();
		},
		30_000,
	);

	it.each([
		{ kind: "IMPLEMENT", status: "completed" },
		{ kind: "SPIKE", status: "demo_ready" },
	])(
		"keeps new $kind runs on legacy workflow commands until the operator opts in",
		async ({ kind, status }) => {
			const env = await TestWorkflowEnvironment.createTimeSkipping({
				client: { identity: "example-client" },
			});
			const requests: Record<string, unknown>[] = [];
			try {
				const worker = await Worker.create({
					connection: env.nativeConnection,
					taskQueue: "example-cutover-queue",
					identity: "example-worker",
					workflowBundle,
					activities: withCodingLifecycleActivities({
						updateCodingRunStatusActivity: async () => {},
						addCodingRunEventActivity: async () => {},
						buildImplementationPrompt: async () => "Synthetic work",
						buildSpikePrompt: async () => "Synthetic spike",
						createExecutionSession: async (
							request: Record<string, unknown>,
						) => {
							requests.push(request);
							return { sessionId: "example-session" };
						},
						sendExecutionPrompt: async () => {},
						pollExecutionStatus: async () => ({
							providerStatus: "completed",
							fabricStatus: "COMPLETED",
							branchName: "feat/example",
							hasPullRequest: false,
						}),
						syncCodingRunArtifacts: async () => ({}),
						syncSpikeArtifacts: async () => ({
							spikeBranch: "fabric-spike/example-run",
							demoFrameId: "example-frame",
						}),
						cleanupWeaveResourcesActivity: async () => {},
						cancelExecutionSession: async () => {},
					}),
				});
				const handle = await env.client.workflow.start(
					"codingRunWorkflow",
					{
						workflowId: `example-legacy-cutover-${kind}`,
						taskQueue: "example-cutover-queue",
						args: [
							{
								codingRunId: "example-run",
								projectId: "example-project",
								storyId: "example-story",
								userId: "example-user",
								organizationId: "example-org",
								provider: "BACKGROUND_AGENTS",
								repositoryOwner: "example-org",
								repositoryName: "example-repo",
								storyTitle: "Example feature",
								targetBranch: "main",
								kind,
							},
						],
					},
				);
				expect(await worker.runUntil(handle.result())).toMatchObject({
					status,
				});
				expect(requests).toHaveLength(1);
				// Legacy sessions start from the target branch for every run kind.
				expect(requests[0]).toMatchObject({
					fabricAgentsBridgeEnabled: false,
					branch: "main",
				});
				expect(requests[0]).not.toHaveProperty("llmConnection");
				expect(requests[0]).not.toHaveProperty("headBranch");
				await Worker.runReplayHistory(
					{ workflowBundle },
					await handle.fetchHistory(),
					`example-legacy-cutover-${kind}`,
				);
			} finally {
				await env.teardown();
			}
		},
		60_000,
	);
});

it("cancels native creation before dispatching a prompt and replays the cancellation history", async () => {
	const env = await TestWorkflowEnvironment.createTimeSkipping();
	const workflowId = "example-cancel-native-creation";
	const order: string[] = [];
	try {
		const worker = await Worker.create({
			connection: env.nativeConnection,
			workflowBundle,
			taskQueue: workflowId,
			activities: withCodingLifecycleActivities({
				buildImplementationPrompt: async () => "Synthetic work",
				createExecutionSession: async () => {
					await env.client.workflow
						.getHandle(workflowId)
						.signal("cancelCodingRun");
					return { sessionId: "example-session" };
				},
				sendExecutionPrompt: async () => {
					order.push("prompt");
				},
				cancelExecutionSession: async () => {
					order.push("confirmed-stop");
				},
				updateCodingRunStatusActivity: async ({
					status,
				}: {
					status: string;
				}) => {
					order.push(status);
				},
				addCodingRunEventActivity: async () => {},
				cleanupWeaveResourcesActivity: async () => ({
					destroyed: true,
					alreadyTerminal: false,
				}),
			}),
		});
		const handle = await env.client.workflow.start("codingRunWorkflow", {
			workflowId,
			taskQueue: workflowId,
			args: [
				{
					codingRunId: "example-run",
					projectId: "example-project",
					storyId: "example-story",
					userId: "example-user",
					organizationId: "example-org",
					provider: "BACKGROUND_AGENTS",
					repositoryOwner: "example-org",
					repositoryName: "example-repo",
					storyTitle: "Example",
					targetBranch: "main",
					fabricAgentsBridgeEnabled: true,
				},
			],
		});
		expect(await worker.runUntil(handle.result())).toMatchObject({
			status: "cancelled",
		});
		expect(order).not.toContain("prompt");
		expect(order).not.toContain("RUNNING");
		expect(order.indexOf("confirmed-stop")).toBeLessThan(
			order.indexOf("CANCELLED"),
		);
		await Worker.runReplayHistory(
			{ workflowBundle },
			await handle.fetchHistory(),
			workflowId,
		);
	} finally {
		await env.teardown();
	}
}, 60_000);

it.each(["not-created", "not-created-cancelled", "ambiguous"])(
	"replays the native creation failure history: %s",
	async (scenario) => {
		const { ApplicationFailure } = await import("@temporalio/common");
		const env = await TestWorkflowEnvironment.createTimeSkipping();
		const statuses: Array<{ status: string; data?: unknown }> = [];
		const workflowId = `example-creation-${scenario}`;
		try {
			const worker = await Worker.create({
				connection: env.nativeConnection,
				workflowBundle,
				taskQueue: workflowId,
				activities: withCodingLifecycleActivities({
					buildImplementationPrompt: async () => "Implement",
					createExecutionSession: async () => {
						if (scenario === "not-created-cancelled") {
							await env.client.workflow
								.getHandle(workflowId)
								.signal("cancelCodingRun");
						}
						throw ApplicationFailure.nonRetryable(
							"Example creation failed",
							scenario === "ambiguous"
								? "Error"
								: "CODING_SESSION_NOT_CREATED",
						);
					},
					updateCodingRunStatusActivity: async (value: {
						status: string;
					}) => {
						statuses.push(value);
					},
					addCodingRunEventActivity: async () => {},
					cleanupWeaveResourcesActivity: async () => ({
						destroyed: true,
						alreadyTerminal: true,
					}),
				}),
			});
			const handle = await env.client.workflow.start(
				"codingRunWorkflow",
				{
					workflowId,
					taskQueue: workflowId,
					args: [
						{
							codingRunId: "example-run",
							projectId: "example-project",
							storyId: "example-story",
							userId: "example-user",
							organizationId: "example-org",
							provider: "BACKGROUND_AGENTS",
							repositoryOwner: "example-org",
							repositoryName: "example-repo",
							storyTitle: "Example",
							fabricAgentsBridgeEnabled: true,
						},
					],
				},
			);
			await worker.runUntil(handle.result());
			expect(statuses.at(-1)?.status).toBe(
				scenario === "ambiguous"
					? "AWAITING_REVIEW"
					: scenario === "not-created-cancelled"
						? "CANCELLED"
						: "FAILED",
			);
			const history = await handle.fetchHistory();
			const create = history.events?.find(
				(event) =>
					event.activityTaskScheduledEventAttributes?.activityType
						?.name === "createExecutionSession",
			);
			expect(
				create?.activityTaskScheduledEventAttributes?.retryPolicy
					?.maximumAttempts,
			).toBe(1);
			await Worker.runReplayHistory(
				{ workflowBundle },
				history,
				workflowId,
			);
		} finally {
			await env.teardown();
		}
	},
	60_000,
);

it("classifies the installed SDK's unregistered remote creation failure and replays its bounded retries", async () => {
	const env = await TestWorkflowEnvironment.createTimeSkipping();
	const statuses: Array<{ status: string; data?: { lastError?: string } }> =
		[];
	const workflowId = "example-unregistered-remote-create";
	try {
		const worker = await Worker.create({
			connection: env.nativeConnection,
			workflowBundle,
			taskQueue: workflowId,
			activities: withCodingLifecycleActivities({
				buildImplementationPrompt: async () => "Implement",
				updateCodingRunStatusActivity: async (input) => {
					statuses.push(input);
				},
				addCodingRunEventActivity: async () => {},
				cleanupRemoteWeaveResourcesActivity: async () => ({
					destroyed: true,
					alreadyTerminal: true,
				}),
			}),
		});
		const handle = await env.client.workflow.start(
			"remoteCodingRunWorkflow",
			{
				workflowId,
				taskQueue: workflowId,
				args: [
					{
						codingRunId: "example-run",
						projectId: "example-project",
						storyId: "example-story",
						userId: "example-user",
						organizationId: "example-org",
						provider: "BACKGROUND_AGENTS",
						repositoryOwner: "example-org",
						repositoryName: "example-repo",
						storyTitle: "Example",
						fabricAgentsBridgeEnabled: true,
						providerMetadata: {
							executionRuntime: "fabric-agent-server",
							executionTarget: {
								connectionId: "example-connection",
							},
						},
					},
				],
			},
		);
		expect(await worker.runUntil(handle.result())).toMatchObject({
			status: "failed",
		});
		expect(statuses.at(-1)).toMatchObject({
			status: "FAILED",
			data: { lastError: expect.stringContaining("not created") },
		});
		expect(statuses.map((value) => value.status)).not.toContain(
			"AWAITING_REVIEW",
		);
		const history = await handle.fetchHistory();
		const creates = history.events?.filter(
			(event) =>
				event.activityTaskScheduledEventAttributes?.activityType
					?.name === "createRemoteExecutionSession",
		);
		expect(creates).toHaveLength(3);
		for (const event of creates ?? []) {
			expect(
				event.activityTaskScheduledEventAttributes?.retryPolicy
					?.maximumAttempts,
			).toBe(1);
		}
		await Worker.runReplayHistory({ workflowBundle }, history, workflowId);
	} finally {
		await env.teardown();
	}
}, 60_000);
