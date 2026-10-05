/**
 * A project's GitLab PM container id names a project on ONE GitLab instance
 * (`recordedGitLabPmOrigin`; none recorded means gitlab.com). A worker
 * activity handed an `mcpConfigId` dispatches through that config's own
 * endpoint, so a personal GitLab config on another instance must be refused
 * inside the activity — before discovery, a read or a write — not only in
 * the API gate that enqueued it.
 *
 * Here the caller's GitLab MCP config is on gitlab.example.com and the
 * container was chosen on gitlab.com.
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
	getStoryById: vi.fn(),
	userStoryFindMany: vi.fn(),
	config: null as Record<string, unknown> | null,
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
	isGitLabPersonalMcpServerKey: (key: string | null | undefined) =>
		key === "gitlab" || key === "gitlab-official",
	setAiUsageRecorder: vi.fn(),
	isProjectReadOnly: vi.fn(async () => false),
	getMcpConfigById: vi.fn(async () => wire.config),
	getStoryById: wire.getStoryById,
	db: {
		userStory: {
			findMany: wire.userStoryFindMany,
			findFirst: vi.fn(async () => null),
			update: vi.fn(),
			updateMany: vi.fn(),
		},
		storyTask: { findUnique: vi.fn(async () => null) },
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
	updateTask: vi.fn(),
	createStory: vi.fn(),
	deleteStory: vi.fn(),
	listStoryStatuses: vi.fn(),
	formatBackLinkForProvider: (d: string | null | undefined) => d ?? "",
	normalizeBackLinkFromProvider: (d: string | null | undefined) => d ?? "",
	HTML_BACK_LINK_RE: /a^/,
}));

import { fetchPmComments } from "../fetch-pm-comments";
import { fetchPMWorkItemsByType } from "../fetch-pm-hierarchy";
import { fetchPmTicket } from "../fetch-pm-ticket";
import { syncWorkItemToPM } from "../hierarchy-sync";
import {
	createOrUpdateStoryFromPMItem,
	discoverPMToolCapabilitiesResult,
	fetchPMItemsByIds,
	getWorkItemsByIdsFromPM,
	listWorkItemsFromPM,
	searchWorkItemsFromPM,
	syncBulkStoriesToPM,
	syncStoryToPM,
	syncTaskToPM,
} from "../story-sync";

const GITLAB_EXAMPLE_CONFIG = {
	id: "cfg-gl",
	enabled: true,
	baseUrl: "https://gitlab.example.com/api/v4/mcp",
	mcpServer: {
		key: "gitlab-official",
		defaultUrl: "https://gitlab.com/api/v4/mcp",
	},
};

const TENANT = { userId: "user-1", organizationId: "org-1" };
const TARGET = {
	mcpConfigId: "cfg-gl",
	containerId: "42",
	projectId: "proj-1",
	...TENANT,
};
const CAPABILITIES = {
	hasPMCapabilities: true,
	detectedType: "gitlab",
	containerHierarchy: [],
	availableTools: ["create_issue", "get_issue", "list_issues"],
	taskCreation: { toolName: "create_issue", allParams: [] },
	taskGet: { toolName: "get_issue", idParam: "issue_iid", allParams: [] },
	taskList: { toolName: "list_issues", allParams: [] },
	taskComments: { toolName: "list_issue_notes", allParams: [] },
} as never;

/** Every activity entry point that dispatches through `mcpConfigId`. */
const ENTRY_POINTS: Array<
	[string, (additionalContext: unknown) => Promise<unknown>]
> = [
	[
		"syncStoryToPM",
		(additionalContext) =>
			syncStoryToPM({
				...TARGET,
				storyId: "story-1",
				direction: "push",
				additionalContext,
				capabilities: CAPABILITIES,
			} as never),
	],
	[
		"syncWorkItemToPM",
		(additionalContext) =>
			syncWorkItemToPM({
				...TARGET,
				itemType: "story",
				itemId: "story-1",
				additionalContext,
				capabilities: CAPABILITIES,
			} as never),
	],
	[
		"syncTaskToPM",
		(additionalContext) =>
			syncTaskToPM({
				...TARGET,
				taskId: "task-1",
				storyId: "story-1",
				additionalContext,
			} as never),
	],
	[
		"syncBulkStoriesToPM",
		(additionalContext) =>
			syncBulkStoriesToPM({ ...TARGET, additionalContext } as never),
	],
	[
		"getWorkItemsByIdsFromPM",
		(additionalContext) =>
			getWorkItemsByIdsFromPM({
				...TARGET,
				ids: [7],
				additionalContext,
			} as never),
	],
	[
		"searchWorkItemsFromPM",
		(additionalContext) =>
			searchWorkItemsFromPM({
				...TARGET,
				query: "checkout",
				additionalContext,
			} as never),
	],
	[
		"listWorkItemsFromPM",
		(additionalContext) =>
			listWorkItemsFromPM({
				...TARGET,
				additionalContext,
				capabilities: CAPABILITIES,
			} as never),
	],
	[
		"fetchPMItemsByIds",
		(additionalContext) =>
			fetchPMItemsByIds({
				...TARGET,
				externalIds: ["7"],
				additionalContext,
			} as never),
	],
	[
		"createOrUpdateStoryFromPMItem",
		(additionalContext) =>
			createOrUpdateStoryFromPMItem({
				...TARGET,
				externalId: "7",
				title: "Checkout",
				additionalContext,
				capabilities: CAPABILITIES,
			} as never),
	],
	[
		"fetchPMWorkItemsByType",
		(additionalContext) =>
			fetchPMWorkItemsByType({
				...TARGET,
				additionalContext,
				capabilities: CAPABILITIES,
			} as never),
	],
	[
		"fetchPmTicket",
		(additionalContext) =>
			fetchPmTicket({
				...TARGET,
				externalId: "7",
				additionalContext,
				capabilities: CAPABILITIES,
			} as never),
	],
	[
		"fetchPmComments",
		(additionalContext) =>
			fetchPmComments({
				...TARGET,
				externalId: "7",
				additionalContext,
				capabilities: CAPABILITIES,
			} as never),
	],
];

beforeEach(() => {
	vi.clearAllMocks();
	wire.config = GITLAB_EXAMPLE_CONFIG;
	wire.getStoryById.mockResolvedValue(null);
	wire.userStoryFindMany.mockResolvedValue([]);
	wire.getMcpClientResult.mockResolvedValue({
		ok: false,
		error: { code: "CONNECT_FAILED", message: "not in this test" },
	});
	wire.executeMcpTool.mockResolvedValue({ success: false, output: {} });
});

describe("worker PM activities — a personal GitLab config on another instance", () => {
	it.each(ENTRY_POINTS)(
		"%s refuses it, non-retryably, before any MCP call",
		async (_name, run) => {
			await expect(run(undefined)).rejects.toMatchObject({
				type: "GitLabPmOriginMismatch",
				nonRetryable: true,
			});
			expect(wire.executeMcpTool).not.toHaveBeenCalled();
			expect(wire.getMcpClientResult).not.toHaveBeenCalled();
		},
	);

	it.each(ENTRY_POINTS)(
		"%s lets it through when the container was recorded on its instance",
		async (_name, run) => {
			// Past the instance check the activity runs into this harness's
			// stubs (no story, no MCP client); any outcome but the refusal is
			// a pass.
			const outcome = await run({
				gitlabOrigin: "https://gitlab.example.com",
			}).then(
				() => null,
				(error: unknown) => error,
			);
			expect(outcome).not.toMatchObject({
				type: "GitLabPmOriginMismatch",
			});
		},
	);
});

describe("discoverPMToolCapabilitiesResult — pmTarget", () => {
	it("refuses before connecting when the caller dispatches to the container itself", async () => {
		const result = await discoverPMToolCapabilitiesResult({
			mcpConfigId: "cfg-gl",
			...TENANT,
			pmTarget: { additionalContext: undefined },
		});

		expect(result).toMatchObject({
			ok: false,
			error: { code: "GITLAB_PM_ORIGIN_MISMATCH" },
		});
		expect(wire.getMcpClientResult).not.toHaveBeenCalled();
	});

	it("only lists tools, unchecked, for a caller that names no container", async () => {
		await discoverPMToolCapabilitiesResult({
			mcpConfigId: "cfg-gl",
			...TENANT,
		});

		expect(wire.getMcpClientResult).toHaveBeenCalledTimes(1);
	});
});
