/**
 * `syncTaskToPM` only creates. A "sync with tasks" push calls it for every
 * task on the story, so a task that already has an `externalId` must be left
 * alone: creating it again duplicates the item in the PM tool on every push
 * and repoints the task's link at the newest copy.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@temporalio/activity", async () => {
	const actual = await vi.importActual<object>("@temporalio/activity");
	return {
		...actual,
		Context: { current: () => ({ heartbeat: vi.fn() }) },
	};
});

const wire = vi.hoisted(() => ({
	getMcpClientResult: vi.fn(),
	executeMcpTool: vi.fn(),
	storyTaskFindUnique: vi.fn(),
	updateTask: vi.fn(),
	getStoryById: vi.fn(async () => null),
}));

vi.mock("@repo/agent-core/backend", () => ({
	getMcpClientResult: wire.getMcpClientResult,
	getMcpClient: vi.fn(),
	closeMcpClientSafe: vi.fn().mockResolvedValue(undefined),
	getDetailedMcpToolInfo: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../orchestrator/execution/execute-mcp-tool", () => ({
	executeMcpTool: wire.executeMcpTool,
}));

vi.mock("@repo/storage", () => ({
	getStorageProvider: vi.fn(() => ({ getSignedUrl: vi.fn() })),
}));

vi.mock("@repo/config", () => ({
	config: {
		storage: { bucketNames: { projectContexts: "test-project-contexts" } },
	},
}));

vi.mock("../record-pm-sync-log", () => ({ recordPmSyncLog: vi.fn() }));

vi.mock("@repo/database", () => ({
	isGitLabPersonalMcpServerKey: () => false,
	setAiUsageRecorder: vi.fn(),
	isProjectReadOnly: vi.fn(async () => false),
	getMcpConfigById: vi.fn(async () => ({
		id: "cfg-1",
		enabled: true,
		baseUrl: "https://pm.example.com/mcp",
		mcpServer: {
			key: "example-pm",
			defaultUrl: "https://pm.example.com/mcp",
		},
	})),
	getStoryById: wire.getStoryById,
	db: {
		storyTask: { findUnique: wire.storyTaskFindUnique },
		mCPConfig: {
			findUnique: vi.fn(async () => null),
			findFirst: vi.fn(async () => null),
		},
	},
	PmSyncStatus: {
		PENDING: "PENDING",
		SUCCESS: "SUCCESS",
		CONFLICT: "CONFLICT",
		FAILED: "FAILED",
	},
	updateStory: vi.fn(),
	updateTask: wire.updateTask,
	createStory: vi.fn(),
	deleteStory: vi.fn(),
	listStoryStatuses: vi.fn(),
	formatBackLinkForProvider: (d: string | null | undefined) => d ?? "",
	normalizeBackLinkFromProvider: (d: string | null | undefined) => d ?? "",
	HTML_BACK_LINK_RE: /a^/,
}));

import { syncTaskToPM } from "../story-sync";

const PARAMS = {
	taskId: "task-1",
	storyId: "story-1",
	projectId: "proj-1",
	mcpConfigId: "cfg-1",
	containerId: "container-1",
	parentExternalId: "PM-10",
	userId: "user-1",
	organizationId: "org-1",
};

function taskRow(externalId: string | null) {
	return {
		id: "task-1",
		identifier: "TASK-001",
		title: "Write the migration",
		description: null,
		externalId,
		story: { id: "story-1", title: "Story", externalId: "PM-10" },
	};
}

describe("syncTaskToPM on an already-linked task", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		wire.getMcpClientResult.mockResolvedValue({
			ok: false,
			error: "unreachable in test",
		});
	});

	it("keeps the existing link and sends nothing to the PM tool", async () => {
		wire.storyTaskFindUnique.mockResolvedValue(taskRow("PM-11"));

		const result = await syncTaskToPM(PARAMS);

		expect(result).toEqual({
			success: true,
			externalId: "PM-11",
			skipped: true,
		});
		expect(wire.getMcpClientResult).not.toHaveBeenCalled();
		expect(wire.executeMcpTool).not.toHaveBeenCalled();
		expect(wire.updateTask).not.toHaveBeenCalled();
	});

	it("still goes on to the create path for an unlinked task", async () => {
		wire.storyTaskFindUnique.mockResolvedValue(taskRow(null));

		const result = await syncTaskToPM(PARAMS);

		// Discovery is reached (and fails here), so the task is not skipped.
		expect(result.skipped).toBeUndefined();
		expect(result.success).toBe(false);
		expect(wire.getMcpClientResult).toHaveBeenCalled();
	});
});
