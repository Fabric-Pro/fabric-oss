import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { bundleWorkflowCode, Worker } from "@temporalio/worker";
import { beforeAll, describe, expect, it } from "vitest";

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
					activities: {
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
					},
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
