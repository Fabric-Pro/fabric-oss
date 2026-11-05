import { resolve } from "node:path";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import {
	bundleWorkflowCode,
	Worker,
	type WorkflowBundleWithSourceMap,
} from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GROUNDED_ATTACHMENT_FASTPATH_PATCH } from "../attachment-fast-path";

const WORKFLOWS_PATH = resolve(__dirname, "..", "..");
const WORKFLOW_NAME = "orchestratorExecutionWorkflow";

let env: TestWorkflowEnvironment;
let workflowBundle: WorkflowBundleWithSourceMap;
let prePatchBundle: WorkflowBundleWithSourceMap;

beforeAll(async () => {
	env = await TestWorkflowEnvironment.createTimeSkipping();
	workflowBundle = await bundleWorkflowCode({
		workflowsPath: WORKFLOWS_PATH,
	});
	const patchCall =
		/\(0,\s*[\w.$]+\.patched\)\([\w.$]*GROUNDED_ATTACHMENT_FASTPATH_PATCH\)/g;
	const matches = workflowBundle.code.match(patchCall) ?? [];
	if (matches.length !== 2) {
		throw new Error(
			`Expected 2 ${GROUNDED_ATTACHMENT_FASTPATH_PATCH} patch calls in workflow bundle, found ${matches.length}`,
		);
	}
	prePatchBundle = {
		...workflowBundle,
		code: workflowBundle.code.replace(patchCall, "false"),
	};
}, 240_000);

afterAll(async () => {
	await env?.teardown();
});

function createActivities() {
	const clarityCalls: Array<Record<string, unknown>> = [];
	const fabricCalls: Array<Record<string, unknown>> = [];
	const memoryCalls: Array<Record<string, unknown>> = [];
	const mcpRoutingCalls: Array<unknown> = [];
	const roundCalls: Array<Record<string, unknown>> = [];

	const activities = {
		preloadResourcesActivity: vi.fn(async () => ({
			toolMap: {},
			mcpTools: [],
			agents: [],
			integrations: [],
			loadDurationMs: 1,
		})),
		loadOrchestratorMemoryActivity: vi.fn(
			async (req: Record<string, unknown>) => {
				memoryCalls.push(req);
				return {
					memoryContextPrompt: "",
					preferences: {},
					recentEpisodes: [],
					relevantEpisodes: [],
				};
			},
		),
		updateRecentActivityActivity: vi.fn(async () => undefined),
		initializeLettaMemory: vi.fn(async () => null),
		getHybridRoutingSuggestions: vi.fn(async () => ({
			suggestions: [],
			warnings: [],
			fromCache: false,
		})),
		applyPolicyEnrichment: vi.fn(async () => ({ blocked: false })),
		applyFabricPatternEnrichment: vi.fn(
			async (req: Record<string, unknown>) => {
				fabricCalls.push(req);
				return {
					composedPrompt: "",
					components: {
						strategy: null,
						context: null,
						pattern: null,
					},
					fabricAvailable: false,
					cacheHits: {
						strategy: false,
						context: false,
						pattern: false,
					},
				};
			},
		),
		loadInstanceMemoryActivity: vi.fn(async () => ({
			fileCount: 0,
			memoryPrompt: "",
		})),
		getProjectMetadataActivity: vi.fn(async () => null),
		listDefaultEnabledMcpServersActivity: vi.fn(async () => {
			mcpRoutingCalls.push("listDefaultEnabledMcpServersActivity");
			return [
				{
					key: "excalidraw",
					name: "Excalidraw",
					eagerKeywords: ["excalidraw", "diagram"],
					eagerToolName: "create_view",
					suppressOnEager: ["fabric_create_frame"],
				},
			];
		}),
		findDefaultMcpConfigActivity: vi.fn(async () => {
			mcpRoutingCalls.push("findDefaultMcpConfigActivity");
			return null;
		}),
		publishMcpDefaultToolSignalActivity: vi.fn(async () => undefined),
		preloadMcpToolsForConfigsActivity: vi.fn(async () => []),
		analyzeIntentClarityActivity: vi.fn(
			async (req: Record<string, unknown>) => {
				clarityCalls.push(req);
				return { needsClarification: false };
			},
		),
		runAgentIteration: vi.fn(async (req: Record<string, unknown>) => {
			roundCalls.push(req);
			return {
				type: "response",
				content:
					"According to the attached architecture-notes.pdf, launch is scheduled for Q4.",
				usage: { inputTokens: 120, outputTokens: 24 },
			};
		}),
		checkCompletionClaimActivity: vi.fn(async () => ({
			unbackedClaim: false,
			judgedBy: "decision",
			usage: { inputTokens: 0, outputTokens: 0 },
		})),
		embedAndStoreTrajectory: vi.fn(async () => undefined),
		recordExecution: vi.fn(async () => undefined),
		createEpisodeFromExecutionActivity: vi.fn(async () => undefined),
		extractAndLearnPatternsActivity: vi.fn(async () => ({ count: 0 })),
		snapshotAdvisorAnswerActivity: vi.fn(async () => undefined),
		finalizeConversationTurnActivity: vi.fn(
			async (req: Record<string, unknown>) => ({
				status: req.outcome,
				wrote: true,
			}),
		),
	};

	return {
		activities,
		clarityCalls,
		fabricCalls,
		memoryCalls,
		mcpRoutingCalls,
		roundCalls,
	};
}

let queueCounter = 0;

describe("grounded attachment fast-path workflow & Temporal replay", () => {
	it("replays pre-patch sequential initialization + clarity histories cleanly on the new bundle", async () => {
		const taskQueue = `grounded-replay-${++queueCounter}`;
		const { activities, clarityCalls } = createActivities();

		const legacyWorker = await Worker.create({
			connection: env.nativeConnection,
			taskQueue,
			workflowBundle: prePatchBundle,
			activities,
		});

		const handle = await legacyWorker.runUntil(async () => {
			const h = await env.client.workflow.start(WORKFLOW_NAME, {
				taskQueue,
				workflowId: `orch-replay-prepatch-${queueCounter}`,
				args: [
					{
						executionId: `orch-replay-prepatch-${queueCounter}`,
						message: "what does this document say?",
						history: [],
						userId: "user-example-1",
						organizationId: "org-example-1",
						executionMode: "balanced",
						surface: "loom-orchestrator",
					},
				],
			});
			await h.result();
			return h;
		});

		expect(clarityCalls).toHaveLength(1);
		const history = await handle.fetchHistory();

		await expect(
			Worker.runReplayHistory(
				{ workflowBundle },
				history,
				handle.workflowId,
			),
		).resolves.toBeUndefined();
	}, 60_000);

	it("skips clarity and shields pattern/memory/MCP routing from attachment text on simple grounded Q&A", async () => {
		const taskQueue = `grounded-live-${++queueCounter}`;
		const {
			activities,
			clarityCalls,
			fabricCalls,
			memoryCalls,
			mcpRoutingCalls,
			roundCalls,
		} = createActivities();

		const worker = await Worker.create({
			connection: env.nativeConnection,
			taskQueue,
			workflowBundle,
			activities,
		});

		const groundedMessage = [
			"what does this document say?",
			"",
			"## Files Attached This Turn",
			"",
			"<fabric_attachment>",
			"[Uploaded Document: architecture-notes.pdf]",
			"This internal design plan mentions excalidraw diagrams and security vulnerability checklists for Q4.",
			"</fabric_attachment>",
		].join("\n");

		const output = await worker.runUntil(async () => {
			const h = await env.client.workflow.start(WORKFLOW_NAME, {
				taskQueue,
				workflowId: `orch-live-grounded-${queueCounter}`,
				args: [
					{
						executionId: `orch-live-grounded-${queueCounter}`,
						message: groundedMessage,
						rawUserMessage: "what does this document say?",
						attachmentManifest: [
							{
								name: "architecture-notes.pdf",
								status: "extracted",
							},
						],
						hasCompleteInlineAttachments: true,
						history: [],
						userId: "user-example-1",
						organizationId: "org-example-1",
						executionMode: "balanced",
						surface: "loom-orchestrator",
					},
				],
			});
			return h.result();
		});

		expect(output.status).toBe("completed");
		expect(clarityCalls).toHaveLength(0);
		expect(fabricCalls).toHaveLength(1);
		expect(fabricCalls[0]?.message).toBe("what does this document say?");
		expect(memoryCalls).toHaveLength(1);
		expect(memoryCalls[0]?.currentQuery).toBeUndefined();
		expect(mcpRoutingCalls).not.toContain("findDefaultMcpConfigActivity");
		expect(roundCalls).toHaveLength(1);
		const historySent = JSON.stringify(
			roundCalls[0]?.conversationHistory ?? roundCalls[0] ?? {},
		);
		expect(historySent).toContain("architecture-notes.pdf");
	}, 60_000);

	it("retains clarity checks with compact attachment manifest for advanced/action queries", async () => {
		const taskQueue = `grounded-advanced-${++queueCounter}`;
		const { activities, clarityCalls, memoryCalls } = createActivities();

		const worker = await Worker.create({
			connection: env.nativeConnection,
			taskQueue,
			workflowBundle,
			activities,
		});

		const hugePdfBody = `Section 1\n${"Detailed specification paragraph. ".repeat(400)}`;

		await worker.runUntil(async () => {
			const h = await env.client.workflow.start(WORKFLOW_NAME, {
				taskQueue,
				workflowId: `orch-live-advanced-${queueCounter}`,
				args: [
					{
						executionId: `orch-live-advanced-${queueCounter}`,
						message: `create Jira stories from this spec\n\n<fabric_attachment>\n[Uploaded Document: spec.pdf]\n${hugePdfBody}\n</fabric_attachment>`,
						rawUserMessage: "create Jira stories from this spec",
						attachmentManifest: [
							{ name: "spec.pdf", status: "extracted" },
						],
						hasCompleteInlineAttachments: true,
						history: [],
						userId: "user-example-1",
						organizationId: "org-example-1",
						executionMode: "balanced",
						surface: "loom-orchestrator",
					},
				],
			});
			return h.result();
		});

		expect(clarityCalls).toHaveLength(1);
		expect(memoryCalls).toHaveLength(1);
		expect(memoryCalls[0]?.currentQuery).toBe(
			"create Jira stories from this spec\n[Attached files: spec.pdf]",
		);
		const sentClarityMsg = String(clarityCalls[0]?.message ?? "");
		expect(sentClarityMsg).toContain("create Jira stories from this spec");
		expect(sentClarityMsg).toContain(
			"spec.pdf (full text attached inline)",
		);
		expect(sentClarityMsg).not.toContain(
			"Detailed specification paragraph.",
		);
	}, 60_000);
});
