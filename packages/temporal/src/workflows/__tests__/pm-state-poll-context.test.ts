import { beforeEach, describe, expect, it, vi } from "vitest";

const { activities, executeChild } = vi.hoisted(() => ({
	activities: {
		getAdoActiveProjects: vi.fn(),
		fetchAdoWorkItemStates: vi.fn(),
		reconcileAdoStates: vi.fn(),
		reconcileMissingTickets: vi.fn(),
		reportPmScanJobOpened: vi.fn(),
		reportPmScanJobClosed: vi.fn(),
		updateProjectPollTimestamp: vi.fn(),
	},
	executeChild: vi.fn(),
}));

vi.mock("@temporalio/workflow", () => ({
	executeChild,
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
	patched: vi.fn(() => false),
	proxyActivities: vi.fn(() => activities),
	sleep: vi.fn(),
	uuid4: vi.fn(() => "child-run"),
	workflowInfo: vi.fn(() => ({ runId: "run-1" })),
}));

import { adoStatePollProjectWorkflow } from "../pm-state-poll-project-workflow";
import { adoStatePollWorkflow } from "../pm-state-poll-workflow";

const project = {
	id: "project-1",
	mcpConfigId: "config-1",
	mcpServerId: "server-1",
	sourceKind: "mcp" as const,
	pmTool: "fizzy",
	containerId: "board-1",
	containerName: "Fabric",
	lastAdoStatePollAt: null,
	userId: "user-1",
	organizationId: "org-1",
	projectManagementAdditionalContext: { account_slug: "/6117483" },
};

const childInput = {
	...project,
	projectId: project.id,
};

beforeEach(() => {
	vi.clearAllMocks();
	activities.getAdoActiveProjects.mockResolvedValue([project]);
	executeChild.mockResolvedValue({ projectId: project.id, success: true });
	activities.fetchAdoWorkItemStates.mockResolvedValue({
		items: [],
		seenExternalIds: [],
		notFoundIds: [],
		failedIds: [],
		totalLinked: 0,
		complete: true,
		terminalStatusesHash: "hash",
	});
	activities.reconcileAdoStates.mockResolvedValue({
		pendingChangesCreated: 0,
		storiesAutoHidden: 0,
		settingsStable: true,
	});
	activities.updateProjectPollTimestamp.mockResolvedValue(undefined);
});

describe("PM state-poll additional context", () => {
	it("forwards saved context from the parent into each child workflow", async () => {
		await adoStatePollWorkflow();

		expect(executeChild).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				args: [
					expect.objectContaining({
						projectManagementAdditionalContext: {
							account_slug: "/6117483",
						},
					}),
				],
			}),
		);
	});

	it("forwards saved context from the child to its fetch activity", async () => {
		const result = await adoStatePollProjectWorkflow(childInput);

		expect(result.success).toBe(true);
		expect(activities.fetchAdoWorkItemStates).toHaveBeenCalledWith(
			expect.objectContaining({
				projectManagementAdditionalContext: {
					account_slug: "/6117483",
				},
			}),
		);
	});

	it("accepts an old child input that lacks saved context", async () => {
		const { projectManagementAdditionalContext: _unused, ...oldInput } =
			childInput;

		const result = await adoStatePollProjectWorkflow(oldInput);

		expect(result.success).toBe(true);
		expect(activities.fetchAdoWorkItemStates).toHaveBeenCalledWith(
			expect.objectContaining({
				projectManagementAdditionalContext: undefined,
			}),
		);
	});
});
