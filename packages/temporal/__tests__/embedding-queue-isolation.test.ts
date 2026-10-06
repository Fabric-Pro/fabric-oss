/**
 * Exercise the real Temporal commands without polling any activity queue.
 * A busy legacy queue must not be where a new proposal's first tracking write,
 * or a new background embedding, waits. Replay the same scheduled histories
 * with the legacy activity queue to protect executions already in flight.
 */
import { resolve } from "node:path";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import {
	bundleWorkflowCode,
	Worker,
	type WorkflowBundleWithSourceMap,
} from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

let env: TestWorkflowEnvironment;
let workflowBundle: WorkflowBundleWithSourceMap;
let sequence = 0;

beforeAll(async () => {
	env = await TestWorkflowEnvironment.createTimeSkipping();
	workflowBundle = await bundleWorkflowCode({
		workflowsPath: resolve(__dirname, "../src/workflows"),
	});
}, 120_000);

afterAll(async () => {
	await env?.teardown();
});

const tenant = {
	projectId: "example-project",
	userId: "example-user",
	organizationId: "example-org",
};

describe("embedding activity isolation", () => {
	it.each([
		{
			workflowType: "projectDocumentGenerationWorkflow",
			activity: "createAgentTask",
			queue: "project-document-generation",
			input: {
				...tenant,
				documentId: "example-document",
				documentType: "PROPOSAL",
				aiToken: "example-token",
			},
		},
		{
			workflowType: "batchDocumentGenerationWorkflow",
			activity: "createAgentTask",
			queue: "project-document-generation",
			input: {
				...tenant,
				aiToken: "example-token",
				documents: [
					{
						id: "example-document",
						type: "PROPOSAL",
						title: "Example proposal",
						prompt: "Example",
					},
				],
			},
		},
		{
			workflowType: "documentGenerationChildWorkflow",
			activity: "retrieveProjectContexts",
			queue: "project-document-generation",
			input: {
				...tenant,
				documentId: "example-document",
				documentType: "PROPOSAL",
				aiToken: "example-token",
			},
		},
		{
			workflowType: "projectContextProcessingWorkflow",
			activity: "processProjectContext",
			queue: "project-embeddings",
			input: { ...tenant, contextId: "example-context" },
		},
		{
			workflowType: "contextEmbeddingWorkflow",
			activity: "embedSingleContextActivity",
			queue: "project-embeddings",
			input: { ...tenant, contextId: "example-context", type: "TEXT" },
		},
		{
			workflowType: "contextEmbeddingWorkflow",
			activity: "embedSingleContextActivity",
			queue: "company-context",
			input: {
				...tenant,
				contextId: "example-context",
				type: "TEXT",
				owner: {
					kind: "company",
					organizationId: tenant.organizationId,
				},
			},
		},
		{
			workflowType: "documentEmbeddingWorkflow",
			activity: "embedProjectDocumentActivity",
			queue: "project-embeddings",
			input: { ...tenant, documentId: "example-document" },
		},
		{
			workflowType: "projectContextEmbeddingWorkflow",
			activity: "generateContextEmbeddings",
			queue: "project-embeddings",
			input: {
				...tenant,
				contexts: [
					{
						id: "example-context",
						type: "TEXT",
						content: "Example context",
					},
				],
			},
		},
		{
			workflowType: "projectDocumentEmbeddingSweepWorkflow",
			activity: "sweepStaleDocumentEmbeddingsActivity",
			queue: "project-embeddings",
			input: { maxBatches: 1 },
		},
	])(
		"$workflowType schedules $activity on $queue and replays a legacy scheduled activity",
		async ({ workflowType, activity, queue, input }) => {
			const taskQueue = `example-workflow-queue-${sequence++}`;
			const workflowId = `${taskQueue}-workflow`;
			// No activities registered: the first command can be inspected even
			// when no activity slot on the legacy queue is available.
			const worker = await Worker.create({
				connection: env.nativeConnection,
				taskQueue,
				workflowBundle,
			});
			await worker.runUntil(async () => {
				const handle = await env.client.workflow.start(workflowType, {
					taskQueue,
					workflowId,
					args: [input],
				});
				try {
					await vi.waitFor(
						async () => {
							const history = await handle.fetchHistory();
							const scheduled = history.events?.find(
								(event) =>
									event.activityTaskScheduledEventAttributes,
							)?.activityTaskScheduledEventAttributes;
							expect(scheduled).toBeDefined();
						},
						{ timeout: 10_000, interval: 50 },
					);
					const history = await handle.fetchHistory();
					const scheduled = history.events?.find(
						(event) => event.activityTaskScheduledEventAttributes,
					)?.activityTaskScheduledEventAttributes;
					expect(scheduled?.activityType?.name).toBe(activity);
					expect(scheduled?.taskQueue?.name).toBe(queue);
					// This reproduces the old command attribute while keeping the
					// actual SDK's event IDs, payloads and command order intact.
					if (!scheduled?.taskQueue) {
						throw new Error("Missing scheduled activity");
					}
					scheduled.taskQueue.name = "project-documents";
					await Worker.runReplayHistory(
						{ workflowBundle },
						history,
						workflowId,
					);
				} finally {
					await handle.terminate("Synthetic queue test complete");
				}
			});
		},
		30_000,
	);

	it.each([
		"documentGenerationChildWorkflow",
		"projectDocumentGenerationWorkflow",
		"existingProjectSetupWorkflow",
	])(
		"%s completes with the setup timeout and no background embedding poller",
		async (workflowType) => {
			const taskQueue = "project-documents";
			const workflowId = `example-complete-generation-${sequence++}`;
			const isSetup = workflowType === "existingProjectSetupWorkflow";
			const completedEmbeddings: string[] = [];
			const retrievals: Array<{ type: string; embedded: string[] }> = [];
			const workflowWorker = await Worker.create({
				connection: env.nativeConnection,
				taskQueue,
				workflowBundle,
			});
			const foreground = await Worker.create({
				connection: env.nativeConnection,
				taskQueue: "project-document-generation",
				activities: {
					createAgentTask: async () => ({ id: "example-task" }),
					updateAgentTaskWorkflow: async () => undefined,
					updateAgentTaskStatus: async () => undefined,
					updateProjectWorkflowStatus: async () => undefined,
					reportGenerationJobOpened: async () => undefined,
					reportGenerationJobStep: async () => undefined,
					notifyGenerationOutcome: async () => undefined,
					retrieveProjectContexts: async ({
						documentType,
					}: {
						documentType: string;
					}) => {
						retrievals.push({
							type: documentType,
							embedded: [...completedEmbeddings],
						});
						return ["Example source"];
					},
					updateProjectCodeAnalysisStatus: async () => undefined,
					updateProjectRagSettings: async () => undefined,
					createExistingProjectDocumentRecords: async () => ({
						documents: [
							{ id: "example-document", type: "PRD" },
							{ id: "example-next-document", type: "PROPOSAL" },
						],
					}),
					retrieveAndFormatEpisodicMemory: async () => ({
						episodeCount: 0,
					}),
					checkProjectHasTeamsIntegration: async () => false,
					checkProjectHasSlackIntegration: async () => false,
					updateProjectDocumentStatus: async () => undefined,
					generateDocumentWithAgent: async () => ({
						content: "# Example proposal",
						resolvedPromptVersionId: null,
					}),
					saveProjectDocument: async () => undefined,
					runDocumentDecisionPrecheckActivity: async () => undefined,
					createDocumentVersion: async () => undefined,
					embedProjectDocumentActivity: async ({
						documentId,
					}: {
						documentId: string;
					}) => {
						// A second retrieval must wait for this actual activity result.
						await new Promise((resolve) => setTimeout(resolve, 50));
						completedEmbeddings.push(documentId);
						return { success: true };
					},
				},
			});
			// No project-embeddings or legacy ActivityWorker exists. Awaited
			// embedding must finish using the foreground worker above.
			await workflowWorker.runUntil(() =>
				foreground.runUntil(async () => {
					const handle = await env.client.workflow.start(
						workflowType,
						{
							taskQueue,
							workflowId,
							// Both setup workflows give generation children this ceiling.
							workflowExecutionTimeout: "20m",
							args: [
								{
									...tenant,
									documentId: "example-document",
									documentType: "PROPOSAL",
									aiToken: "example-token",
									skipDependencyWait: true,
									repoUrls: [],
									selectedDocumentTypes: ["PRD", "PROPOSAL"],
									projectTypes: [],
									projectName: "Example project",
								},
							],
						},
					);
					const childHandle =
						workflowType === "documentGenerationChildWorkflow"
							? handle
							: env.client.workflow.getHandle(
									isSetup
										? `${workflowId}-doc-example-document`
										: `${workflowId}-child-example-document`,
								);
					try {
						// Inspect the command before waiting on completion, so an
						// unfixed queue fails immediately instead of waiting 20 min.
						await vi.waitFor(
							async () => {
								const history =
									await childHandle.fetchHistory();
								expect(
									history.events?.some(
										(event) =>
											event
												.activityTaskScheduledEventAttributes
												?.activityType?.name ===
											"embedProjectDocumentActivity",
									),
								).toBe(true);
							},
							{ timeout: 10_000, interval: 50 },
						);
						const pendingHistory = await childHandle.fetchHistory();
						const embed = pendingHistory.events?.find(
							(event) =>
								event.activityTaskScheduledEventAttributes
									?.activityType?.name ===
								"embedProjectDocumentActivity",
						)?.activityTaskScheduledEventAttributes;
						expect(embed?.taskQueue?.name).toBe(
							"project-document-generation",
						);
						const result = await handle.result();
						expect(result).toMatchObject(
							isSetup
								? {
										success: true,
										documentIds: [
											"example-document",
											"example-next-document",
										],
									}
								: {
										success: true,
										documentContent: "# Example proposal",
									},
						);
						if (isSetup) {
							expect(retrievals).toEqual([
								{ type: "PRD", embedded: [] },
								{
									type: "PROPOSAL",
									embedded: ["example-document"],
								},
							]);
							const children =
								(await handle.fetchHistory()).events?.flatMap(
									(event) =>
										event
											.startChildWorkflowExecutionInitiatedEventAttributes
											?.workflowType?.name ===
										"documentGenerationChildWorkflow"
											? [
													event.startChildWorkflowExecutionInitiatedEventAttributes,
												]
											: [],
								) ?? [];
							expect(children).toHaveLength(2);
							expect(
								children.map((child) =>
									Number(
										child.workflowExecutionTimeout?.seconds,
									),
								),
							).toEqual([1200, 1200]);
						}
						const started = (
							await handle.fetchHistory()
						).events?.find(
							(event) =>
								event.workflowExecutionStartedEventAttributes,
						)?.workflowExecutionStartedEventAttributes;
						expect(
							Number(started?.workflowExecutionTimeout?.seconds),
						).toBe(1200);
						const history = await childHandle.fetchHistory();
						const scheduled =
							history.events?.flatMap((event) =>
								event.activityTaskScheduledEventAttributes
									? [
											event.activityTaskScheduledEventAttributes,
										]
									: [],
							) ?? [];
						expect(
							scheduled.map(
								(activity) => activity.activityType?.name,
							),
						).toEqual(
							expect.arrayContaining([
								"updateProjectDocumentStatus",
								"generateDocumentWithAgent",
								"saveProjectDocument",
								"runDocumentDecisionPrecheckActivity",
								"createDocumentVersion",
								"embedProjectDocumentActivity",
							]),
						);
						for (const activity of scheduled) {
							expect(activity.taskQueue?.name).toBe(
								"project-document-generation",
							);
							if (!activity.taskQueue) {
								throw new Error("Missing activity queue");
							}
							activity.taskQueue.name = "project-documents";
						}
						await Worker.runReplayHistory(
							{ workflowBundle },
							history,
							childHandle.workflowId,
						);
					} catch (error) {
						await handle.terminate("Synthetic queue test failed");
						throw error;
					}
				}),
			);
		},
		30_000,
	);
});
