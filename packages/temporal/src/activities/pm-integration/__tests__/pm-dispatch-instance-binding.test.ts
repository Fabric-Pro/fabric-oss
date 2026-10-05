/**
 * The PM container id names a project on ONE GitLab instance. Checking the
 * caller's GitLab MCP config before a call is not enough: the config (or the
 * connection behind it) can move to another instance between that check and
 * the dispatch, and a workflow replaying a completed preflight never checks
 * again. So every PM dispatch carries the container's instance (`pmTarget`)
 * into `executeMcpTool`, which only runs the tool on a client bound to it —
 * checked on the client actually acquired, new or cached.
 *
 * These tests run the real `executeMcpTool` and the real `@repo/mcp` client
 * factory and cache; only the MCP SDK connection, the database reads and the
 * GitLab credential lookup are substituted. The container was chosen on
 * gitlab.com (no recorded origin); the config moves to gitlab.example.com.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	config: null as Record<string, unknown> | null,
	/** The config the next read after `moveAfterReads` reads returns. */
	movedTo: null as Record<string, unknown> | null,
	moveAfterReads: Number.POSITIVE_INFINITY,
	reads: 0,
	/** Every request any MCP transport sent, by URL. */
	requests: [] as string[],
	/** Tools the fake GitLab MCP server ran. */
	executed: [] as string[],
}));

const activityStubs = vi.hoisted(() => ({
	getStoriesToSync: vi.fn(),
	updateStoryExternalRefs: vi.fn(),
	discoverPMToolCapabilities: vi.fn(),
	listAllFizzyCards: vi.fn(),
	listWorkItemsFromPM: vi.fn(),
	fetchPMItemsByIds: vi.fn(),
	createOrUpdateStoryFromPMItem: vi.fn(),
	deleteStoriesNotInPMList: vi.fn(),
	executeMcpTool: vi.fn(),
	closeStorySyncJob: vi.fn(),
}));

vi.mock("@temporalio/workflow", async () => {
	const actual = await vi.importActual<typeof import("@temporalio/workflow")>(
		"@temporalio/workflow",
	);
	return {
		ApplicationFailure: actual.ApplicationFailure,
		ActivityFailure: actual.ActivityFailure,
		log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
		defineSignal: (name: string) => ({ name, type: "signal" as const }),
		defineQuery: (name: string) => ({ name, type: "query" as const }),
		setHandler: vi.fn(),
		patched: vi.fn(() => true),
		proxyActivities: vi.fn(() => activityStubs),
	};
});

vi.mock("@temporalio/activity", async () => {
	const actual = await vi.importActual<object>("@temporalio/activity");
	return {
		...actual,
		heartbeat: vi.fn(),
		Context: { current: () => ({ heartbeat: vi.fn() }) },
	};
});

vi.mock("@repo/database", async (importOriginal) => ({
	...(await importOriginal<object>()),
	getMcpConfigById: vi.fn(async () => {
		state.reads++;
		const current = state.config;
		if (state.reads >= state.moveAfterReads && state.movedTo) {
			state.config = state.movedTo;
		}
		return current;
	}),
	getValidAccessToken: vi.fn(async () => "api-key"),
	// The organization gate on the config owner (Fizzy #2903): a member whose
	// role allows MCP read and connect.
	canConnectOrganizationMcpConfigs: vi.fn(async () => true),
	canReadOrganizationMcpConfigs: vi.fn(async () => true),
}));

vi.mock("@repo/mcp/lib/server-url-guard", () => ({
	assertMcpServerUrlResolved: vi.fn(async () => undefined),
	fetchMcpServer: vi.fn(),
}));

// The person's GitLab connection follows the config: its token is for
// whichever instance the config names when the client is built. The
// transport's fetch is a fake GitLab MCP server that records every request.
vi.mock("@repo/mcp/lib/gitlab-credential", async (importOriginal) => ({
	...(await importOriginal<object>()),
	getGitLabMcpTransportAuth: vi.fn(async () => ({
		accessToken: "token",
		fetch: fakeGitLabMcpServer,
	})),
}));

const TOOL_PARAMS: Record<string, string[]> = {
	create_issue: ["project_id", "title"],
	get_issue: ["project_id", "issue_id"],
	list_issues: ["project_id"],
};

async function fakeGitLabMcpServer(
	input: string | URL | Request,
	init?: RequestInit,
): Promise<Response> {
	const url = String(input instanceof Request ? input.url : input);
	state.requests.push(url);
	if ((init?.method ?? "GET") !== "POST") {
		return new Response(null, { status: 405 });
	}
	const message = JSON.parse(String(init?.body)) as {
		id?: number;
		method: string;
		params?: { name?: string };
	};
	const reply = (result: unknown) =>
		new Response(
			JSON.stringify({ jsonrpc: "2.0", id: message.id, result }),
			{
				status: 200,
				headers: { "content-type": "application/json" },
			},
		);
	switch (message.method) {
		case "initialize":
			return reply({
				protocolVersion: "2025-06-18",
				capabilities: { tools: {} },
				serverInfo: { name: "gitlab", version: "1" },
			});
		case "tools/list":
			return reply({
				tools: Object.entries(TOOL_PARAMS).map(([name, params]) => ({
					name,
					description: `GitLab ${name.replace("_", " ")}`,
					inputSchema: {
						type: "object",
						properties: Object.fromEntries(
							params.map((param) => [param, { type: "string" }]),
						),
						required: params,
					},
				})),
			});
		case "tools/call":
			state.executed.push(String(message.params?.name));
			// An empty board, as a listing on the wrong instance could read.
			return reply({
				content: [
					{
						type: "text",
						text: JSON.stringify(
							message.params?.name === "list_issues"
								? []
								: { iid: 7 },
						),
					},
				],
			});
		default:
			return new Response(null, { status: 202 });
	}
}

vi.mock("../../shared/read-only-gate", () => ({
	guardToolWriteForReadOnly: vi.fn(async () => null),
}));
vi.mock("../../letta-memory-activities", () => ({
	cacheToolResult: vi.fn(),
	getCachedToolResult: vi.fn(async () => ({ found: false })),
}));
vi.mock("../../shared/frame-service", () => ({
	createFirstClassFrame: vi.fn(),
	getFirstClassFrame: vi.fn(),
	listFirstClassFrames: vi.fn(),
	shareFirstClassFrame: vi.fn(),
	updateFirstClassFrame: vi.fn(),
}));
vi.mock("../../shared/oauth-tool-executors", () => ({
	executeMicrosoftTeamsTool: vi.fn(),
}));

import { clearMcpClientCache, getCachedMcpClientForConfig } from "@repo/mcp";
import { storySyncWorkflow } from "../../../workflows/story-sync-workflow";
import { executeMcpTool } from "../../orchestrator/execution/execute-mcp-tool";
import { fetchPmTicket } from "../fetch-pm-ticket";
import { fetchPMItemsByIds, listWorkItemsFromPM } from "../story-sync";

function gitlabConfig(baseUrl: string) {
	return {
		id: "cfg-gl",
		userId: "user-1",
		organizationId: "org-1",
		enabled: true,
		needsReauth: false,
		displayName: "GitLab",
		baseUrl,
		transport: "HTTP",
		authType: "OAUTH2",
		apiKeyMethod: "BEARER",
		mcpServer: {
			key: "gitlab-official",
			name: "GitLab",
			defaultUrl: "https://gitlab.com/api/v4/mcp",
			transport: "HTTP",
		},
	};
}
const ON_GITLAB_COM = gitlabConfig("https://gitlab.com/api/v4/mcp");
const ON_EXAMPLE = gitlabConfig("https://gitlab.example.com/api/v4/mcp");

const GITLAB_CAPABILITIES = {
	hasPMCapabilities: true,
	detectedType: "gitlab",
	containerHierarchy: [],
	availableTools: ["create_issue", "get_issue", "list_issues"],
	taskCreation: {
		toolName: "create_issue",
		containerParam: "project_id",
		titleParam: "title",
		descriptionParam: "description",
		allParams: [
			{ name: "project_id" },
			{ name: "title" },
			{ name: "description" },
		],
	},
	taskList: {
		toolName: "list_issues",
		containerParam: "project_id",
		filterParams: [],
		paginationInfo: { style: "none" },
		allParams: [{ name: "project_id" }],
	},
	taskGet: {
		toolName: "get_issue",
		idParam: "issue_iid",
		additionalRequiredParams: ["project_id"],
		allParams: [{ name: "issue_iid", required: true }],
	},
};

beforeEach(async () => {
	vi.clearAllMocks();
	await clearMcpClientCache();
	state.config = ON_GITLAB_COM;
	state.movedTo = null;
	state.moveAfterReads = Number.POSITIVE_INFINITY;
	state.reads = 0;
	state.requests = [];
	state.executed = [];
	activityStubs.executeMcpTool.mockImplementation(executeMcpTool);
	activityStubs.listWorkItemsFromPM.mockImplementation(listWorkItemsFromPM);
	activityStubs.deleteStoriesNotInPMList.mockResolvedValue({
		deletedCount: 3,
	});
	activityStubs.getStoriesToSync.mockResolvedValue([]);
});

describe("activity dispatch after the entry check", () => {
	it("fetchPmTicket: a config moved after the entry check sends nothing to the new instance", async () => {
		// The entry check reads the config on gitlab.com; the move lands
		// before the client is built for the dispatch.
		state.movedTo = ON_EXAMPLE;
		state.moveAfterReads = 1;

		await expect(
			fetchPmTicket({
				mcpConfigId: "cfg-gl",
				userId: "user-1",
				organizationId: "org-1",
				capabilities: GITLAB_CAPABILITIES as never,
				externalId: "7",
				containerId: "42",
				additionalContext: undefined,
			}),
		).rejects.toMatchObject({
			type: "GitLabPmOriginMismatch",
			nonRetryable: true,
		});
		expect(state.reads).toBe(2);
		expect(state.requests).toEqual([]);
		expect(state.executed).toEqual([]);
	});

	it("fetchPmTicket: runs on the container's instance when nothing moved", async () => {
		await fetchPmTicket({
			mcpConfigId: "cfg-gl",
			userId: "user-1",
			organizationId: "org-1",
			capabilities: GITLAB_CAPABILITIES as never,
			externalId: "7",
			containerId: "42",
			additionalContext: undefined,
		}).catch(() => null);

		expect(state.executed).toEqual(["get_issue"]);
	});
});

describe("activity dispatch after discovery", () => {
	it("fetchPMItemsByIds: a per-item read refused on the moved config fails the activity, not just that item", async () => {
		// Read 1: the entry check; read 2: discovery's check; read 3: the
		// discovery client. The move lands before the per-item read builds
		// its client.
		state.movedTo = ON_EXAMPLE;
		state.moveAfterReads = 3;

		await expect(
			fetchPMItemsByIds({
				mcpConfigId: "cfg-gl",
				containerId: "42",
				externalIds: ["7"],
				additionalContext: undefined,
				userId: "user-1",
				organizationId: "org-1",
			}),
		).rejects.toMatchObject({
			type: "GitLabPmOriginMismatch",
			nonRetryable: true,
		});
		expect(state.executed).toEqual([]);
		// Only the gitlab.com discovery client spoke; nothing reached the
		// moved config's instance.
		expect(
			state.requests.filter((url) => url.includes("gitlab.example.com")),
		).toEqual([]);
	});
});

describe("cached tool list", () => {
	it("tools listed from one client are never run on another", async () => {
		await executeMcpTool({
			toolName: "get_issue",
			args: { issue_iid: "7" },
			userId: "user-1",
			organizationId: "org-1",
			mcpConfigId: "cfg-gl",
			pmTarget: { additionalContext: undefined },
		});
		// The client is dropped (closed), as the cache does on expiry,
		// eviction or a stale connection; the next call builds a new one.
		await clearMcpClientCache();

		const result = await executeMcpTool({
			toolName: "get_issue",
			args: { issue_iid: "7" },
			userId: "user-1",
			organizationId: "org-1",
			mcpConfigId: "cfg-gl",
			pmTarget: { additionalContext: undefined },
		});

		expect(result.success).toBe(true);
		expect(state.executed).toEqual(["get_issue", "get_issue"]);
	});
});

describe("cached client", () => {
	it("a client cached for another instance is refused, unused", async () => {
		// Built (e.g. by an agent tool call, unbound) after the config moved.
		state.config = ON_EXAMPLE;
		await getCachedMcpClientForConfig({
			configId: "cfg-gl",
			userId: "user-1",
			organizationId: "org-1",
		});
		const sentWhileBuilding = state.requests.length;
		expect(sentWhileBuilding).toBeGreaterThan(0);

		await expect(
			executeMcpTool({
				toolName: "get_issue",
				args: { issue_iid: "7", project_id: "42" },
				userId: "user-1",
				organizationId: "org-1",
				mcpConfigId: "cfg-gl",
				pmTarget: { additionalContext: undefined },
			}),
		).rejects.toMatchObject({
			type: "GitLabPmOriginMismatch",
			nonRetryable: true,
		});
		// Not even a health check or tool listing went out on it.
		expect(state.requests).toHaveLength(sentWhileBuilding);
		expect(state.executed).toEqual([]);
	});

	it("an unbound call (no pmTarget) is unchanged", async () => {
		state.config = ON_EXAMPLE;

		const result = await executeMcpTool({
			toolName: "get_issue",
			args: { issue_iid: "7" },
			userId: "user-1",
			organizationId: "org-1",
			mcpConfigId: "cfg-gl",
		});

		expect(result.success).toBe(true);
		expect(state.executed).toEqual(["get_issue"]);
	});
});

describe("workflow dispatch after a completed preflight", () => {
	it("storySyncWorkflow push: the create is refused on the moved config and nothing is sent", async () => {
		// The preflight already ran (on gitlab.com) and its recorded result
		// is replayed; by the time the push dispatches, the config is on
		// gitlab.example.com.
		activityStubs.discoverPMToolCapabilities.mockResolvedValue(
			GITLAB_CAPABILITIES,
		);
		activityStubs.getStoriesToSync.mockResolvedValue([
			{
				id: "story-1",
				identifier: "F-1",
				title: "Checkout flow",
				description: "Body",
				externalId: null,
				externalUrl: null,
			},
		]);
		state.config = ON_EXAMPLE;

		const output = await storySyncWorkflow({
			projectId: "proj-1",
			mcpServerId: "srv-gitlab",
			mcpConfigId: "cfg-gl",
			containerId: "42",
			userId: "user-1",
			organizationId: "org-1",
			direction: "push",
		});

		// The dispatch carried the container's instance from workflow input.
		expect(activityStubs.executeMcpTool).toHaveBeenCalledWith(
			expect.objectContaining({
				toolName: "create_issue",
				pmTarget: { additionalContext: undefined },
			}),
		);
		expect(output.syncedCount).toBe(0);
		expect(state.requests).toEqual([]);
		expect(state.executed).toEqual([]);
		expect(activityStubs.updateStoryExternalRefs).not.toHaveBeenCalled();
	});

	it("storySyncWorkflow push: creates on the container's instance when nothing moved", async () => {
		activityStubs.discoverPMToolCapabilities.mockResolvedValue(
			GITLAB_CAPABILITIES,
		);
		activityStubs.getStoriesToSync.mockResolvedValue([
			{
				id: "story-1",
				identifier: "F-1",
				title: "Checkout flow",
				description: "Body",
				externalId: null,
				externalUrl: null,
			},
		]);

		await storySyncWorkflow({
			projectId: "proj-1",
			mcpServerId: "srv-gitlab",
			mcpConfigId: "cfg-gl",
			containerId: "42",
			userId: "user-1",
			organizationId: "org-1",
			direction: "push",
		});

		expect(state.executed).toEqual(["create_issue"]);
	});
});

describe("full pull on a moved config", () => {
	it("storySyncWorkflow: the listing is refused, so the empty-board delete is never reached", async () => {
		// Preflight recorded on gitlab.com; the listing runs after the config
		// moved to gitlab.example.com, whose project 42 is unrelated (and
		// would list as empty).
		activityStubs.discoverPMToolCapabilities.mockResolvedValue(
			GITLAB_CAPABILITIES,
		);
		state.config = ON_EXAMPLE;

		const outcome = await storySyncWorkflow({
			projectId: "proj-1",
			mcpServerId: "srv-gitlab",
			mcpConfigId: "cfg-gl",
			containerId: "42",
			userId: "user-1",
			organizationId: "org-1",
			direction: "pull",
		}).then(
			(output) => output,
			(error: unknown) => error,
		);

		expect(outcome).not.toMatchObject({ success: true });
		expect(activityStubs.listWorkItemsFromPM).toHaveBeenCalled();
		expect(activityStubs.deleteStoriesNotInPMList).not.toHaveBeenCalled();
		expect(state.requests).toEqual([]);
		expect(state.executed).toEqual([]);
	});

	it("storySyncWorkflow: an empty board on the container's own instance still clears it", async () => {
		activityStubs.discoverPMToolCapabilities.mockResolvedValue(
			GITLAB_CAPABILITIES,
		);

		await storySyncWorkflow({
			projectId: "proj-1",
			mcpServerId: "srv-gitlab",
			mcpConfigId: "cfg-gl",
			containerId: "42",
			userId: "user-1",
			organizationId: "org-1",
			direction: "pull",
		});

		expect(state.executed).toEqual(["list_issues"]);
		expect(activityStubs.deleteStoriesNotInPMList).toHaveBeenCalledWith(
			expect.objectContaining({ pmExternalIds: [] }),
		);
	});
});
