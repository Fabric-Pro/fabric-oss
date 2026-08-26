import { beforeEach, describe, expect, it, vi } from "vitest";

const activityStubs = vi.hoisted(() => ({
	preloadResourcesActivity: vi.fn(),
	loadOrchestratorMemoryActivity: vi.fn(),
	updateRecentActivityActivity: vi.fn(),
	initializeLettaMemory: vi.fn(),
	getHybridRoutingSuggestions: vi.fn(),
	applyPolicyEnrichment: vi.fn(),
	applyFabricPatternEnrichment: vi.fn(),
	loadInstanceMemoryActivity: vi.fn(),
	createSandboxActivity: vi.fn(),
	updateWeaveExecutionActivity: vi.fn(),
	getProjectMetadataActivity: vi.fn(),
	findSimilarTrajectory: vi.fn(),
	analyzeAndRoute: vi.fn(),
	createTaskPlan: vi.fn(),
	validatePlan: vi.fn(),
	inferAndValidateContractsActivity: vi.fn(),
	analyzePlanApprovalActivity: vi.fn(),
	createOrchestratorApprovalRequest: vi.fn(),
	recordApprovalOutcomeActivity: vi.fn(),
	updateApprovalTaskStatus: vi.fn(),
	convertWeavePlanToOrchestratorSteps: vi.fn(),
	reflectOnOutput: vi.fn(),
	recordExecution: vi.fn(),
	embedAndStoreTrajectory: vi.fn(),
	saveTrajectory: vi.fn(),
	createEpisodeFromExecutionActivity: vi.fn(),
	extractAndLearnPatternsActivity: vi.fn(),
	destroySandboxActivity: vi.fn(),
}));

vi.mock("@temporalio/workflow", () => ({
	log: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
	proxyActivities: vi.fn(() => activityStubs),
	workflowInfo: vi.fn(() => ({ unsafe: { isReplaying: false } })),
	startChild: vi.fn(),
	ParentClosePolicy: {
		ABANDON: "ABANDON",
	},
}));

import { orchestratorCompletionWorkflow } from "../src/workflows/orchestrator/phases/completion";
import { executeInitializationPhase } from "../src/workflows/orchestrator/phases/initialization";
import { executePlanningPhase } from "../src/workflows/orchestrator/phases/planning";
import { createInitialState } from "../src/workflows/orchestrator/types";

describe("orchestrator memory regression", () => {
	beforeEach(() => {
		vi.clearAllMocks();

		activityStubs.preloadResourcesActivity.mockResolvedValue({
			mcpTools: [],
			toolMap: {},
			agents: [],
			loadDurationMs: 5,
			workflowGuidance: "",
		});
		activityStubs.loadOrchestratorMemoryActivity.mockResolvedValue({
			preferences: {
				preferences: {},
				recentProjectIds: [],
				recentWorkspaceIds: [],
			},
			memoryContextPrompt: "Use the user's past preferences and memory.",
			relevantEpisodes: [{ id: "episode-1" }],
			recentEpisodes: [{ id: "episode-2" }],
		});
		activityStubs.updateRecentActivityActivity.mockResolvedValue(undefined);
		activityStubs.initializeLettaMemory.mockResolvedValue(null);
		activityStubs.getHybridRoutingSuggestions.mockResolvedValue({
			suggestions: [],
			warnings: [],
			stats: {},
		});
		activityStubs.applyPolicyEnrichment.mockResolvedValue({
			blocked: false,
			enrichedMessage: "Help me inspect this bug",
			systemPromptAdditions: "",
		});
		activityStubs.applyFabricPatternEnrichment.mockResolvedValue({
			fabricAvailable: false,
			composedPrompt: "",
			cacheHits: 0,
			components: {},
		});
		activityStubs.loadInstanceMemoryActivity.mockResolvedValue({
			fileCount: 0,
			memoryPrompt: "",
		});
		activityStubs.getProjectMetadataActivity.mockResolvedValue(null);
		activityStubs.findSimilarTrajectory.mockResolvedValue(null);
		activityStubs.analyzeAndRoute.mockResolvedValue({
			primaryAgent: "mcp_direct",
			suggestedStrategy: "mcp",
			riskLevel: "low",
			confidence: 0.9,
			reasoning: "Strong tool match",
			useMcpDirect: true,
			matchedMcpTools: [],
		});
		activityStubs.createTaskPlan.mockResolvedValue({
			id: "plan-1",
			description: "Inspect the bug",
			steps: [
				{
					id: "step-1",
					description: "Inspect the bug",
					type: "mcp",
					status: "pending",
					order: 1,
					executor: "mcp_direct",
					riskLevel: "low",
					requiresApproval: false,
				},
			],
			riskLevel: "low",
			strategy: "mcp",
			createdAt: new Date().toISOString(),
		});
		activityStubs.validatePlan.mockResolvedValue({
			isValid: true,
			issues: [],
		});
		activityStubs.inferAndValidateContractsActivity.mockResolvedValue({
			validation: {
				errors: [],
				warnings: [],
			},
		});
		activityStubs.analyzePlanApprovalActivity.mockResolvedValue({
			requiresApproval: false,
			autoApprovedStepIds: [],
			pendingApprovalStepIds: [],
		});
		activityStubs.reflectOnOutput.mockResolvedValue({
			satisfactory: true,
		});
		activityStubs.recordExecution.mockResolvedValue(undefined);
		activityStubs.embedAndStoreTrajectory.mockResolvedValue(undefined);
		activityStubs.saveTrajectory.mockResolvedValue(undefined);
		activityStubs.createEpisodeFromExecutionActivity.mockResolvedValue(
			undefined,
		);
		activityStubs.extractAndLearnPatternsActivity.mockResolvedValue({
			count: 0,
			patternsLearned: [],
		});
	});

	it("loads orchestrator memory during initialization and passes it into routing", async () => {
		const input = {
			executionId: "exec-1",
			message: "Help me inspect this bug",
			userId: "user-1",
			organizationId: "org-1",
			executionMode: "default",
			history: [],
			systemPrompt: "Base system prompt",
		} as any;
		const state = createInitialState(input);

		const initResult = await executeInitializationPhase(
			state,
			input,
			vi.fn(),
		);

		expect(initResult.success).toBe(true);
		expect(
			activityStubs.loadOrchestratorMemoryActivity,
		).toHaveBeenCalledWith({
			userId: "user-1",
			organizationId: "org-1",
			projectId: null,
			workspaceId: null,
			currentQuery: "Help me inspect this bug",
		});
		expect(initResult.data?.enrichedSystemPrompt).toContain(
			"Use the user's past preferences and memory.",
		);

		expect(initResult.data).toBeDefined();
		const enrichedMessage = initResult.data?.enrichedMessage ?? "";
		const enrichedSystemPrompt =
			initResult.data?.enrichedSystemPrompt ?? "";
		state.enrichedMessage = enrichedMessage;
		state.enrichedSystemPrompt = enrichedSystemPrompt;

		await executePlanningPhase(
			state,
			input,
			{
				taskDecomposition: true,
			} as any,
			vi.fn(),
			vi.fn(),
		);

		expect(activityStubs.analyzeAndRoute).toHaveBeenCalledWith(
			expect.objectContaining({
				message: enrichedMessage,
				memoryContext: enrichedSystemPrompt,
			}),
		);
	});

	it("still stores semantic and episodic memory during completion", async () => {
		const startTime = Date.now() - 2_000;

		await orchestratorCompletionWorkflow({
			executionId: "exec-2",
			userId: "user-1",
			organizationId: "org-1",
			message: "Inspect the bug",
			finalResponse: "I found the issue.",
			executionMode: "default",
			conversationId: "conv-1",
			projectId: "project-1",
			workspaceIds: ["workspace-1"],
			startTime,
			lettaAgentId: "letta-1",
			taskPlanSteps: [
				{
					id: "step-1",
					description: "Inspect the bug",
					status: "complete",
					executor: "mcp_direct",
				},
			],
			trajectorySteps: [],
			toolCalls: [
				{
					name: "context7_search",
					status: "success",
				},
			] as any,
			stepResults: [
				{
					stepId: "step-1",
					toolCalls: [
						{
							name: "context7_search",
							status: "success",
						},
					],
				},
			] as any,
			reflectionEnabled: false,
			reflectionOnFinalOutput: false,
		});

		expect(activityStubs.recordExecution).toHaveBeenCalled();
		expect(activityStubs.embedAndStoreTrajectory).toHaveBeenCalledWith(
			expect.objectContaining({
				executionId: "exec-2",
				taskDescription: "Inspect the bug",
				userId: "user-1",
				organizationId: "org-1",
				outcome: "success",
			}),
		);
		expect(
			activityStubs.createEpisodeFromExecutionActivity,
		).toHaveBeenCalledWith(
			expect.objectContaining({
				executionId: "exec-2",
				conversationId: "conv-1",
				userId: "user-1",
				organizationId: "org-1",
				toolsUsed: ["context7_search"],
				agentsUsed: ["mcp_direct"],
				outcome: "success",
			}),
		);
	});
});
