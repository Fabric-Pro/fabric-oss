/**
 * Exercise real Temporal scheduling, completed operations and extraction-wait
 * saturation. Replay histories with historical queues to protect executions
 * already in flight.
 */
import { resolve } from "node:path";
import { Context } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
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

describe("project operation activity isolation", () => {
	it.each([
		{
			workflowType: "projectContextsReprocessWorkflow",
			activity: "fetchProjectContextsForReprocess",
			queue: "project-operations",
			input: tenant,
		},
		{
			workflowType: "urlSourceCrawlWorkflow",
			activity: "firecrawlScrapeActivity",
			queue: "project-embeddings",
			input: {
				...tenant,
				contextId: "example-context",
				url: "https://example.com/source",
				scope: "SINGLE_PAGE",
				maxPages: 1,
			},
		},
		{
			workflowType: "urlSourceCrawlWorkflow",
			activity: "firecrawlMapActivity",
			queue: "project-embeddings",
			input: {
				...tenant,
				contextId: "example-context",
				url: "https://example.com/source",
				scope: "PATH_PREFIX",
				maxPages: 1,
			},
		},
		{
			workflowType: "urlSourceCrawlWorkflow",
			activity: "companyUrlCrawlGateActivity",
			queue: "company-context",
			input: {
				...tenant,
				contextId: "example-context",
				url: "https://example.com/source",
				scope: "SINGLE_PAGE",
				maxPages: 1,
				owner: {
					kind: "company",
					organizationId: tenant.organizationId,
				},
			},
		},

		{
			workflowType: "parlumeNotesWorkflow",
			activity: "writeParlumeNotes",
			queue: "project-operations",
			input: { sessionId: "example-session" },
		},
		{
			workflowType: "discoveryRunWorkflow",
			activity: "setDiscoveryRunStatus",
			queue: "project-operations",
			input: {
				...tenant,
				discoveryRunId: "example-run",
				storyId: "example-story",
				sources: {},
				story: { identifier: "EX-1", title: "Example" },
				project: { name: "Example" },
			},
		},
		{
			workflowType: "scopeIntakeWorkflow",
			activity: "awaitContextExtracted",
			queue: "project-documents",
			input: { ...tenant, contextId: "example-context" },
		},
		{
			workflowType: "meetingTranscriptSyncWorkflow",
			activity: "getLinkedMeetingJoinUrlsActivity",
			queue: "project-operations",
			input: { ...tenant, intervalMinutes: 0, daysBack: 1 },
		},
		{
			workflowType: "slackHuddleIngestWorkflow",
			activity: "getLinkedHuddleChannelsActivity",
			queue: "project-operations",
			input: { ...tenant, intervalMinutes: 0, enabledAtMs: 0 },
		},
		{
			workflowType: "extractMeetingInsightsOnDemandWorkflow",
			activity: "extractMeetingInsightsActivity",
			queue: "project-operations",
			input: { ...tenant, transcriptCuid: "example-transcript" },
		},
		{
			workflowType: "generateMeetingAgendaWorkflow",
			activity: "generateAgendaActivity",
			queue: "project-operations",
			input: {
				...tenant,
				agendaId: "example-agenda",
				linkedMeetingId: "example-meeting",
			},
		},
		{
			workflowType: "linkMeetingActionItemsWorkflow",
			activity: "linkMeetingActionItemsActivity",
			queue: "project-operations",
			input: { ...tenant, transcriptCuid: "example-transcript" },
		},
		{
			workflowType: "matchMeetingActionItemOwnersWorkflow",
			activity: "matchMeetingActionItemOwnersActivity",
			queue: "project-operations",
			input: { ...tenant, transcriptCuid: "example-transcript" },
		},
		{
			workflowType: "wizardToProjectBindingWorkflow",
			activity: "bindWizardEmbeddingsToProjectActivity",
			queue: "project-operations",
			input: {
				...tenant,
				sessionId: "example-session",
				contextIdMapping: {},
			},
		},
		{
			workflowType: "contextDeletionWorkflow",
			activity: "deleteSingleContextActivity",
			queue: "project-embeddings",
			input: { ...tenant, contextId: "example-context" },
		},
		{
			workflowType: "contextDeletionWorkflow",
			activity: "deleteSingleContextActivity",
			queue: "company-context",
			input: {
				...tenant,
				contextId: "example-context",
				owner: {
					kind: "company",
					organizationId: tenant.organizationId,
				},
			},
		},
		{
			workflowType: "documentEvalWorkflow",
			activity: "checkEvalCache",
			queue: "fabric-worker",
			input: {
				...tenant,
				projectDocumentId: "example-document",
				documentContent: "Example",
				documentVersion: 1,
				documentType: "PROPOSAL",
			},
		},
	])(
		"$workflowType schedules $activity on $queue and replays a legacy scheduled activity",
		async ({ workflowType, activity, queue, input }) => {
			const taskQueue =
				workflowType === "scopeIntakeWorkflow"
					? "project-documents"
					: `example-workflow-queue-${sequence++}`;
			const workflowId = `${taskQueue}-workflow-${sequence++}`;
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
	describe("complete operations and historical command replay", () => {
		const projectInput = { ...tenant, contextId: "example-context" };
		const cases = [
			{
				workflowType: "projectContextsReprocessWorkflow",
				firstActivity: "fetchProjectContextsForReprocess",
				input: tenant,
				activities: {
					fetchProjectContextsForReprocess: async () => [],
				},
				expected: {
					success: true,
					totalContexts: 0,
					processedCount: 0,
					failedCount: 0,
				},
				names: ["fetchProjectContextsForReprocess"],
			},

			{
				workflowType: "generateMeetingAgendaWorkflow",
				firstActivity: "generateAgendaActivity",
				input: {
					...tenant,
					agendaId: "example-agenda",
					linkedMeetingId: "example-meeting",
				},
				activities: {
					generateAgendaActivity: async () => {
						throw ApplicationFailure.nonRetryable(
							"Example generation failure",
						);
					},
					markAgendaFailedActivity: async () => undefined,
				},
				expected: { status: "FAILED" },
				names: ["generateAgendaActivity", "markAgendaFailedActivity"],
			},
			{
				workflowType: "documentEvalWorkflow",
				firstActivity: "checkEvalCache",
				input: {
					...tenant,
					projectDocumentId: "example-document",
					documentContent: "Example",
					documentVersion: 1,
					documentType: "PROPOSAL",
				},
				activities: {
					checkEvalCache: async () => ({ cached: false }),
					getGoldenReference: async () => ({
						found: false,
						requiredSections: [],
					}),
					runNLPMetrics: async () => ({
						overallScore: 90,
						executionTimeMs: 1,
						completeness: { score: 90, details: { missing: [] } },
						similarity: { score: 90 },
						keywords: { score: 90, details: { missing: [] } },
						structure: { score: 90, details: { missing: [] } },
					}),
					runLLMMetricsActivity: async () => null,
					saveEvalResult: async () => ({
						evalId: "example-evaluation",
					}),
				},
				expected: {
					success: true,
					evalId: "example-evaluation",
					evalMode: "nlp_only",
				},
				names: [
					"checkEvalCache",
					"getGoldenReference",
					"runNLPMetrics",
					"runLLMMetricsActivity",
					"saveEvalResult",
				],
			},

			{
				workflowType: "discoveryRunWorkflow",
				firstActivity: "setDiscoveryRunStatus",
				input: {
					...tenant,
					discoveryRunId: "example-run",
					storyId: "example-story",
					sources: {},
					story: { identifier: "EX-1", title: "Example" },
					project: { name: "Example" },
				},
				activities: {
					setDiscoveryRunStatus: async () => undefined,
					gatherDiscoveryEvidence: async () => ({
						warnings: [],
						sources: [],
					}),
					draftIntegrationContract: async () => ({
						markdown: "Example contract",
						contract: { unknowns: [] },
					}),
					persistIntegrationContract: async () => ({
						documentId: "example-document",
					}),
					postDiscoveryQuestions: async () => ({
						stageAdvanced: true,
					}),
				},
				expected: {
					documentId: "example-document",
					questionCount: 0,
					stageAdvanced: true,
				},
				names: [
					"setDiscoveryRunStatus",
					"gatherDiscoveryEvidence",
					"draftIntegrationContract",
					"persistIntegrationContract",
					"postDiscoveryQuestions",
				],
			},
			{
				workflowType: "scopeIntakeWorkflow",
				firstActivity: "awaitContextExtracted",
				input: projectInput,
				activities: {
					// Preserve the readiness step before extraction; the operation
					// does not skip the source's existing extraction dependency.
					awaitContextExtracted: async () => ({
						text: "Example scope",
						originalFilename: "example.txt",
					}),
					extractScopeItems: async () => ({
						stats: { rowCount: 1, areaCount: 1, llmUsed: true },
						proposal: { changes: [{}] },
					}),
					persistScopeProposal: async () => ({
						proposalId: "example-proposal",
						changeCount: 1,
					}),
				},
				expected: {
					proposalId: "example-proposal",
					changeCount: 1,
					rowCount: 1,
				},
				names: [
					"awaitContextExtracted",
					"extractScopeItems",
					"persistScopeProposal",
				],
			},
			{
				workflowType: "meetingTranscriptSyncWorkflow",
				firstActivity: "getLinkedMeetingJoinUrlsActivity",
				input: { ...tenant, intervalMinutes: 0, daysBack: 1 },
				activities: {
					getLinkedMeetingJoinUrlsActivity: async () => [
						{
							id: "example-meeting",
							joinUrl: "https://example.com/meeting",
							syncedByUserId: tenant.userId,
						},
					],
					listRecentMeetingInstancesForLinkedUrls: async () => [
						{
							joinUrl: "https://example.com/meeting",
							startTime: "2026-01-01T00:00:00Z",
						},
					],
					fetchAndStoreMeetingTranscript: async () => ({
						success: true,
						transcriptsFetched: 1,
					}),
					updateMeetingTranscriptSyncLastRunActivity: async () =>
						undefined,
				},
				expected: undefined,
				names: [
					"getLinkedMeetingJoinUrlsActivity",
					"listRecentMeetingInstancesForLinkedUrls",
					"fetchAndStoreMeetingTranscript",
					"updateMeetingTranscriptSyncLastRunActivity",
				],
			},
			{
				workflowType: "extractMeetingInsightsOnDemandWorkflow",
				firstActivity: "extractMeetingInsightsActivity",
				input: { ...tenant, transcriptCuid: "example-transcript" },
				activities: {
					extractMeetingInsightsActivity: async () => ({
						extractedCount: 1,
						cachedCount: 0,
					}),
				},
				expected: { extractedCount: 1, cachedCount: 0 },
				names: ["extractMeetingInsightsActivity"],
			},
		];

		it.each(cases)(
			"$workflowType completes and replays every historical queue command",
			async ({
				workflowType,
				firstActivity,
				input,
				activities,
				expected,
				names,
			}) => {
				const activityQueue =
					workflowType === "documentEvalWorkflow"
						? "fabric-worker"
						: "project-operations";
				const workflowId = `example-full-operation-${sequence++}`;
				const workflowWorker = await Worker.create({
					connection: env.nativeConnection,
					taskQueue: "project-documents",
					workflowBundle,
					// Only the long readiness wait retains the inherited queue.
					activities:
						workflowType === "scopeIntakeWorkflow"
							? {
									awaitContextExtracted:
										activities.awaitContextExtracted,
								}
							: undefined,
				});
				const operations = await Worker.create({
					connection: env.nativeConnection,
					taskQueue: activityQueue,
					activities,
				});
				await workflowWorker.runUntil(() =>
					operations.runUntil(async () => {
						const handle = await env.client.workflow.start(
							workflowType,
							{
								taskQueue: "project-documents",
								workflowId,
								args: [input],
							},
						);
						try {
							await vi.waitFor(
								async () => {
									const history = await handle.fetchHistory();
									const first = history.events?.find(
										(e) =>
											e.activityTaskScheduledEventAttributes,
									)?.activityTaskScheduledEventAttributes;
									expect(first?.activityType?.name).toBe(
										firstActivity,
									);
									expect(first?.taskQueue).toBeDefined();
								},
								{ timeout: 10_000, interval: 50 },
							);
							const first = (
								await handle.fetchHistory()
							).events?.find(
								(e) => e.activityTaskScheduledEventAttributes,
							)?.activityTaskScheduledEventAttributes;
							expect(first?.taskQueue?.name).toBe(
								firstActivity === "awaitContextExtracted"
									? "project-documents"
									: activityQueue,
							);
							const result = await handle.result();
							if (expected === undefined) {
								expect(result).toBeUndefined();
							} else {
								expect(result).toMatchObject(expected);
							}
							const history = await handle.fetchHistory();
							const scheduled =
								history.events?.flatMap((e) =>
									e.activityTaskScheduledEventAttributes
										? [
												e.activityTaskScheduledEventAttributes,
											]
										: [],
								) ?? [];
							expect(
								scheduled.map((a) => a.activityType?.name),
							).toEqual(names);
							for (const activity of scheduled) {
								expect(activity.taskQueue?.name).toBe(
									activity.activityType?.name ===
										"awaitContextExtracted"
										? "project-documents"
										: activityQueue,
								);
								if (!activity.taskQueue) {
									throw new Error("Missing activity queue");
								}
								activity.taskQueue.name = "project-documents";
							}
							await Worker.runReplayHistory(
								{ workflowBundle },
								history,
								workflowId,
							);
						} catch (error) {
							await handle.terminate(
								"Synthetic operation test failed",
							);
							throw error;
						}
					}),
				);
			},
			30_000,
		);

		it.each([false, true])(
			"file processing advances failure/import control after extraction (import=%s)",
			async (isImport) => {
				const workflowId = `example-context-operation-${sequence++}`;
				const workflowWorker = await Worker.create({
					connection: env.nativeConnection,
					taskQueue: "project-documents",
					workflowBundle,
				});
				// Only extraction runs here. No embedding activity is registered.
				const extractionWorker = await Worker.create({
					connection: env.nativeConnection,
					taskQueue: "project-embeddings",
					activities: {
						processProjectContext: async () =>
							isImport
								? {
										success: true,
										chunkCount: 1,
										qdrantIds: [],
										extractedContent: "Example import",
										documentTag: "PROPOSAL",
										targetDocumentId: "example-document",
									}
								: {
										success: false,
										error: "Example extraction failure",
									},
					},
				});
				const operations = await Worker.create({
					connection: env.nativeConnection,
					taskQueue: "project-operations",
					activities: {
						getProjectContextStatus: async () => "EXTRACTING",
						updateProjectContextStatus: async () => undefined,
						cleanupImportedContent: async () => "# Example import",
						// A document completed by another writer must remain untouched,
						// and requires no further vector indexing to end this operation.
						fillTargetDocument: async () => ({ applied: false }),
					},
				});
				await workflowWorker.runUntil(() =>
					extractionWorker.runUntil(() =>
						operations.runUntil(async () => {
							const handle = await env.client.workflow.start(
								"projectContextProcessingWorkflow",
								{
									taskQueue: "project-documents",
									workflowId,
									args: [projectInput],
								},
							);
							try {
								await vi.waitFor(
									async () => {
										const history =
											await handle.fetchHistory();
										const control = history.events?.find(
											(e) =>
												e
													.activityTaskScheduledEventAttributes
													?.activityType?.name ===
												(isImport
													? "cleanupImportedContent"
													: "getProjectContextStatus"),
										)?.activityTaskScheduledEventAttributes;
										expect(
											control?.taskQueue,
										).toBeDefined();
									},
									{ timeout: 10_000, interval: 50 },
								);
								const control = (
									await handle.fetchHistory()
								).events?.find(
									(e) =>
										e.activityTaskScheduledEventAttributes
											?.activityType?.name ===
										(isImport
											? "cleanupImportedContent"
											: "getProjectContextStatus"),
								)?.activityTaskScheduledEventAttributes;
								expect(control?.taskQueue?.name).toBe(
									"project-operations",
								);
								if (isImport) {
									expect(await handle.result()).toMatchObject(
										{ success: true },
									);
								} else {
									await expect(
										handle.result(),
									).rejects.toThrow();
								}
								const history = await handle.fetchHistory();
								const scheduled =
									history.events?.flatMap((e) =>
										e.activityTaskScheduledEventAttributes
											? [
													e.activityTaskScheduledEventAttributes,
												]
											: [],
									) ?? [];
								expect(
									scheduled.map((a) => a.activityType?.name),
								).toEqual(
									isImport
										? [
												"processProjectContext",
												"cleanupImportedContent",
												"fillTargetDocument",
											]
										: [
												"processProjectContext",
												"getProjectContextStatus",
												"updateProjectContextStatus",
											],
								);
								for (const activity of scheduled) {
									expect(activity.taskQueue?.name).toBe(
										activity.activityType?.name ===
											"processProjectContext"
											? "project-embeddings"
											: "project-operations",
									);
									if (!activity.taskQueue) {
										throw new Error(
											"Missing activity queue",
										);
									}
									activity.taskQueue.name =
										"project-documents";
								}
								await Worker.runReplayHistory(
									{ workflowBundle },
									history,
									workflowId,
								);
							} catch (error) {
								await handle.terminate(
									"Synthetic context test failed",
								);
								throw error;
							}
						}),
					),
				);
			},
			30_000,
		);
	});
	it("batch embedding publishes its completed status on operations capacity", async () => {
		const workflowId = `example-batch-embedding-status-${sequence++}`;
		const workflowWorker = await Worker.create({
			connection: env.nativeConnection,
			taskQueue: "project-documents",
			workflowBundle,
		});
		const indexing = await Worker.create({
			connection: env.nativeConnection,
			taskQueue: "project-embeddings",
			activities: {
				generateContextEmbeddings: async () => [[0.1]],
				storeContextsInQdrant: async () => ["example-point"],
			},
		});
		const operations = await Worker.create({
			connection: env.nativeConnection,
			taskQueue: "project-operations",
			activities: { updateContextEmbeddingStatus: async () => undefined },
		});
		await workflowWorker.runUntil(() =>
			indexing.runUntil(() =>
				operations.runUntil(async () => {
					const handle = await env.client.workflow.start(
						"projectContextEmbeddingWorkflow",
						{
							taskQueue: "project-documents",
							workflowId,
							args: [
								{
									...tenant,
									contexts: [
										{
											id: "example-context",
											type: "TEXT",
											content: "Example context",
										},
									],
								},
							],
						},
					);
					try {
						await vi.waitFor(
							async () => {
								const history = await handle.fetchHistory();
								expect(
									history.events?.some(
										(e) =>
											e
												.activityTaskScheduledEventAttributes
												?.activityType?.name ===
											"updateContextEmbeddingStatus",
									),
								).toBe(true);
							},
							{ timeout: 10_000, interval: 50 },
						);
						const pending = await handle.fetchHistory();
						const status = pending.events?.find(
							(e) =>
								e.activityTaskScheduledEventAttributes
									?.activityType?.name ===
								"updateContextEmbeddingStatus",
						)?.activityTaskScheduledEventAttributes;
						expect(status?.taskQueue?.name).toBe(
							"project-operations",
						);
						expect(await handle.result()).toMatchObject({
							success: true,
							embeddedCount: 1,
						});
						const history = await handle.fetchHistory();
						const scheduled =
							history.events?.flatMap((e) =>
								e.activityTaskScheduledEventAttributes
									? [e.activityTaskScheduledEventAttributes]
									: [],
							) ?? [];
						expect(
							scheduled.map((a) => a.activityType?.name),
						).toEqual([
							"generateContextEmbeddings",
							"storeContextsInQdrant",
							"updateContextEmbeddingStatus",
						]);
						for (const activity of scheduled) {
							expect(activity.taskQueue?.name).toBe(
								activity.activityType?.name ===
									"updateContextEmbeddingStatus"
									? "project-operations"
									: "project-embeddings",
							);
							if (!activity.taskQueue) {
								throw new Error("Missing activity queue");
							}
							activity.taskQueue.name = "project-documents";
						}
						await Worker.runReplayHistory(
							{ workflowBundle },
							history,
							workflowId,
						);
					} catch (error) {
						await handle.terminate(
							"Synthetic embedding-status test failed",
						);
						throw error;
					}
				}),
			),
		);
	}, 30_000);
	it("five extraction waits leave operations capacity available", async () => {
		const workflowIds: string[] = [];
		const readinessQueues: string[] = [];
		let releaseReadiness = () => {};
		let readinessReleased = false;
		const readiness = new Promise<void>((resolve) => {
			releaseReadiness = () => {
				readinessReleased = true;
				resolve();
			};
		});
		const awaitContextExtracted = async () => {
			readinessQueues.push(Context.current().info.taskQueue);
			await readiness;
			return { text: "Example scope", originalFilename: "example.txt" };
		};
		const workflowWorker = await Worker.create({
			connection: env.nativeConnection,
			taskQueue: "project-documents",
			workflowBundle,
		});
		const legacy = await Worker.create({
			connection: env.nativeConnection,
			taskQueue: "project-documents",
			maxConcurrentActivityTaskExecutions: 5,
			activities: { awaitContextExtracted },
		});
		const operations = await Worker.create({
			connection: env.nativeConnection,
			taskQueue: "project-operations",
			maxConcurrentActivityTaskExecutions: 5,
			activities: {
				// Register the wait on both workers so the unfixed workflow really
				// fills all operations slots, rather than failing registration.
				awaitContextExtracted,
				extractMeetingInsightsActivity: async () => ({
					extractedCount: 1,
					cachedCount: 0,
				}),
				extractScopeItems: async () => ({
					stats: { rowCount: 0, areaCount: 0 },
					proposal: { changes: [] },
				}),
				persistScopeProposal: async () => ({
					proposalId: "example-proposal",
					changeCount: 0,
				}),
			},
		});
		await workflowWorker.runUntil(() =>
			legacy.runUntil(() =>
				operations.runUntil(async () => {
					try {
						for (let index = 0; index < 5; index++) {
							const workflowId = `example-blocked-scope-${sequence++}`;
							workflowIds.push(workflowId);
							await env.client.workflow.start(
								"scopeIntakeWorkflow",
								{
									taskQueue: "project-documents",
									workflowId,
									args: [
										{
											...tenant,
											contextId: `example-context-${index}`,
										},
									],
								},
							);
						}
						await vi.waitFor(
							() => expect(readinessQueues).toHaveLength(5),
							{ timeout: 10_000, interval: 50 },
						);
						const workflowId = `example-meeting-during-scope-waits-${sequence++}`;
						workflowIds.push(workflowId);
						const handle = await env.client.workflow.start(
							"extractMeetingInsightsOnDemandWorkflow",
							{
								taskQueue: "project-documents",
								workflowId,
								args: [
									{
										...tenant,
										transcriptCuid: "example-transcript",
									},
								],
							},
						);
						let meetingResult: unknown;
						let meetingError: unknown;
						const completion = handle.result().then(
							(result) => {
								meetingResult = result;
							},
							(error) => {
								meetingError = error;
							},
						);
						await vi.waitFor(
							() => {
								expect(meetingError).toBeUndefined();
								expect(meetingResult).toEqual({
									extractedCount: 1,
									cachedCount: 0,
								});
							},
							{ timeout: 10_000, interval: 50 },
						);
						await completion;
						expect(readinessReleased).toBe(false);
						expect(readinessQueues).toEqual(
							Array(5).fill("project-documents"),
						);
						for (const waitingId of workflowIds.slice(0, 5)) {
							const history = await env.client.workflow
								.getHandle(waitingId)
								.fetchHistory();
							const scheduled = history.events?.find(
								(e) => e.activityTaskScheduledEventAttributes,
							)?.activityTaskScheduledEventAttributes;
							expect(scheduled?.activityType?.name).toBe(
								"awaitContextExtracted",
							);
							expect(scheduled?.taskQueue?.name).toBe(
								"project-documents",
							);
							expect(
								history.events?.some(
									(e) =>
										e.workflowExecutionCompletedEventAttributes,
								),
							).toBe(false);
						}
					} finally {
						// Release held activities before runUntil shuts their workers down,
						// including the unfixed case where the unrelated operation stalls.
						releaseReadiness();
						await Promise.allSettled(
							workflowIds.map((id) =>
								env.client.workflow
									.getHandle(id)
									.terminate(
										"Synthetic saturation test complete",
									),
							),
						);
					}
				}),
			),
		);
	}, 30_000);
});
