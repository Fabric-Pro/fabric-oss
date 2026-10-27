import { beforeEach, expect, it, vi } from "vitest";
import { BUDGET } from "../../orchestrator-config";

const activities = vi.hoisted(() => ({
	startChild: vi.fn(),
	embedAndStoreTrajectory: vi.fn().mockResolvedValue(true),
	createEpisodeFromExecutionActivity: vi.fn(),
	extractAndLearnPatternsActivity: vi.fn().mockResolvedValue({ count: 0 }),
}));
vi.mock("@temporalio/workflow", () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
	startChild: activities.startChild,
	ParentClosePolicy: { PARENT_CLOSE_POLICY_ABANDON: "ABANDON" },
	patched: vi.fn(() => false),
	proxyActivities: vi.fn(() => activities),
	workflowInfo: vi.fn(() => ({ unsafe: { isReplaying: false } })),
}));

import {
	createInitialState,
	DEFAULT_ALTK_CONFIG,
	EXECUTION_MODE_CONFIGS,
} from "../../types";
import {
	buildWorkflowOutput,
	executeCompletionPhase,
	orchestratorCompletionWorkflow,
} from "../completion";

beforeEach(() => vi.clearAllMocks());

it.each([
	{
		launchWorkspaceId: "example-launch-workspace",
		workspaceIds: ["example-workspace", "example-other-workspace"],
		expected: [
			"example-workspace",
			"example-other-workspace",
			"example-launch-workspace",
		],
	},
	{
		launchWorkspaceId: "example-workspace",
		workspaceIds: ["example-workspace", "example-other-workspace"],
		expected: ["example-workspace", "example-other-workspace"],
	},
	{
		launchWorkspaceId: "example-launch-workspace",
		workspaceIds: undefined,
		expected: ["example-launch-workspace"],
	},
	{
		launchWorkspaceId: undefined,
		workspaceIds: ["example-workspace"],
		expected: ["example-workspace"],
	},
])(
	"passes attached and launch workspaces to storage ($launchWorkspaceId)",
	async ({ launchWorkspaceId, workspaceIds, expected }) => {
		await orchestratorCompletionWorkflow({
			executionId: "example-run",
			userId: "example-user",
			organizationId: "example-org",
			message: "Example task",
			finalResponse: "Example response",
			executionMode: "balanced",
			projectId: "example-project",
			launchWorkspaceId,
			workspaceIds,
			startTime: 0,
			lettaAgentId: null,
			taskPlanSteps: [],
			trajectorySteps: [],
			toolCalls: [],
			stepResults: [],
			reflectionEnabled: false,
			reflectionOnFinalOutput: false,
		});
		expect(activities.embedAndStoreTrajectory).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "example-project",
				workspaceIds: expected,
			}),
		);
		expect(activities.extractAndLearnPatternsActivity).toHaveBeenCalled();
	},
);

it("carries the launch workspace from the parent into the existing completion child", async () => {
	const input = {
		executionId: "example-run",
		userId: "example-user",
		organizationId: "example-org",
		message: "Example task",
		history: [],
		executionMode: "balanced" as const,
		projectId: "example-project",
		workspaceIds: ["example-workspace"],
		launchWorkspaceId: "example-launch-workspace",
	};
	const state = createInitialState(input);
	state.taskPlan = {
		id: "example-plan",
		description: "Example task",
		steps: [],
		riskLevel: "low",
		strategy: "agent",
		createdAt: "2026-10-22",
	};
	await executeCompletionPhase(
		state,
		input,
		EXECUTION_MODE_CONFIGS.balanced,
		DEFAULT_ALTK_CONFIG,
		"Example response",
		vi.fn(),
	);
	expect(activities.startChild).toHaveBeenCalledWith(
		orchestratorCompletionWorkflow,
		expect.objectContaining({
			args: [
				expect.objectContaining({
					projectId: "example-project",
					workspaceIds: ["example-workspace"],
					launchWorkspaceId: "example-launch-workspace",
				}),
			],
		}),
	);
});

it.each([true, false])(
	"final budget card uses charged ledger totals under weighted marker %s",
	(weighted) => {
		const input = {
			executionId: "example-run",
			userId: "example-user",
			message: "Example",
			executionMode: "balanced" as const,
			history: [],
		};
		const state = createInitialState(input);
		state.advisorWeightedAllowanceEnabled = weighted;
		state.iterationCosts = [
			{
				iteration: 1,
				inputTokens: 150_000,
				outputTokens: 1,
				timestamp: "2026-01-01",
			},
		];
		state.turnLedger = {
			allowance: 300_000,
			measured: 10_000,
			outstanding: 2_000,
			finalizationReserve: 30_000,
			enforcement: "ENFORCED",
		};
		expect(buildWorkflowOutput(state, "completed").tokenBudget).toEqual({
			used: weighted ? 12_000 : 150_001,
			total: weighted ? 300_000 : BUDGET.defaultMaxTotalTokens,
			usagePercentage: weighted
				? 0.04
				: 150_001 / BUDGET.defaultMaxTotalTokens,
		});
	},
);

// Every planning-audit producer, plus retained summary source types.
it.each([
	["orchestrator_memory", "Orchestrator Memory"],
	["workspace_rag", "Workspace Documents"],
	["agent_template", "Agent Template"],
	["policy_enrichment", "System Policies"],
	["project_context", "Project Context"],
	["fabric_pattern", "Fabric Patterns"],
	["semantic_memory", "Past Executions"],
	["letta_memory", "Keyword Memory"],
	["negative_memory", "Failure Avoidance"],
	["trajectory_reuse", "Similar Trajectory"],
	["agent_capabilities", "Agent Capabilities"],
	["mcp_tool_discovery", "Available Tools"],
	["user_input", "User Input"],
	["web_research", "Web Research"],
])("formats %s as %s in the completion summary", (type, label) => {
	const state = createInitialState({
		executionId: "example-run",
		userId: "example-user",
		message: "Example",
		executionMode: "balanced",
		history: [],
	});
	state.planningAudit.contextSources = [
		{ type, description: "Example source", used: true },
	];
	expect(
		buildWorkflowOutput(state, "completed").planningAudit?.sourcesUsed,
	).toEqual([label]);
});
