import { beforeEach, expect, it, vi } from "vitest";

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
