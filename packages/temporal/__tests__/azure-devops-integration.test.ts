/**
 * Azure DevOps Integration Tests
 *
 * Tests for ADO-specific code paths: fieldsBased creation, updatesBased updates,
 * backlog resolution, team auto-resolution, area/iteration path normalization,
 * sparse ref enrichment, and response parsing.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock @repo/agent-core/backend.
// Avoid importOriginal — it triggers loading the real @repo/database
// (PrismaPg pool) and hangs the vitest exit phase (vitest #4373).
vi.mock("@repo/agent-core/backend", () => ({
	getMcpClient: vi.fn(),
	getMcpClientResult: vi.fn(),
	closeMcpClientSafe: vi.fn().mockResolvedValue(undefined),
	// Stubs for any other backend exports the source files transitively
	// reference. Tests don't drive these, so vi.fn() suffices.
	getDetailedMcpToolInfo: vi.fn().mockResolvedValue([]),
	canMcpToolsHandleTask: vi
		.fn()
		.mockReturnValue({ canHandle: false, matchedTools: [] }),
	generateMemoryContext: vi
		.fn()
		.mockResolvedValue({ contextString: "", memoryCount: 0 }),
	getConfiguredAIModel: vi.fn().mockResolvedValue({}),
}));

// Mock executeMcpTool
vi.mock("../src/activities/orchestrator/execution/execute-mcp-tool", () => ({
	executeMcpTool: vi.fn(),
}));

// Mock database functions explicitly. importOriginal would trigger the
// real @repo/database load (prisma singleton), keeping pg.Pool handles
// alive past vitest exit.
vi.mock("@repo/database", () => ({
	setAiUsageRecorder: vi.fn(),
	// Read-only mode gate — default: project is writable
	isProjectReadOnly: vi.fn(async () => false),
	db: {
		userStory: {
			findMany: vi.fn(),
		},
		storyTask: {
			findUnique: vi.fn(),
		},
	},
	Prisma: {},
	getStoryById: vi.fn(),
	getMcpConfigById: vi.fn(),
	updateStory: vi.fn(),
	updateTask: vi.fn(),
	createStory: vi.fn(),
	listStoryStatuses: vi.fn(),
	// Identity stubs — syncStoryToPM calls these around the description
	// at push and pull boundaries (F-1219). The real per-provider regex
	// behaviour is unit-tested in
	// @repo/database/__tests__/fabric-back-link.test.ts; ADO tests only
	// need them to pass the string through so description assertions
	// remain stable (ADO is never the fizzy branch).
	formatBackLinkForProvider: (description: string | null | undefined) =>
		description ?? "",
	normalizeBackLinkFromProvider: (description: string | null | undefined) =>
		description ?? "",
	// Mirror the real regex from fabric-url.ts so buildStoryDescription's
	// two-column back-link lookup resolves the symbol. ADO is never the
	// fizzy branch and these tests don't persist anchors, so the regex
	// matches nothing in fixture content — behaviour unchanged.
	HTML_BACK_LINK_RE:
		/<p>\s*<a\s+[^>]*href=["']([^"']+)["'][^>]*>\s*View in Fabric\s*<\/a>\s*<\/p>/i,
}));

import { getMcpClient, getMcpClientResult } from "@repo/agent-core/backend";
import {
	db,
	getMcpConfigById,
	getStoryById,
	updateStory,
} from "@repo/database";
import { executeMcpTool } from "../src/activities/orchestrator/execution/execute-mcp-tool";
import {
	type AdoBacklogEntry,
	buildAdoTypeMapping,
	fetchAdoBacklogs,
	fetchPMWorkItemsByType,
	resolveAdoDefaultTeam,
} from "../src/activities/pm-integration/fetch-pm-hierarchy";
import {
	listWorkItemsFromPM,
	type StorySyncInput,
	syncBulkStoriesToPM,
	syncStoryToPM,
} from "../src/activities/pm-integration/story-sync";
import {
	analyzePMToolCapabilities,
	buildTaskCreationArgs,
	type McpToolDefinition,
} from "../src/activities/pm-integration/tool-analyzer";

// =============================================================================
// Helpers
// =============================================================================

function wrapInMcpContent(data: unknown) {
	return {
		content: [{ type: "text", text: JSON.stringify(data) }],
	};
}

// =============================================================================
// ADO MCP Tool Definitions
// =============================================================================

const ADO_TOOLS: Record<string, McpToolDefinition> = {
	wit_create_work_item: {
		name: "wit_create_work_item",
		description: "Create a new work item",
		inputSchema: {
			type: "object",
			properties: {
				project: { type: "string", description: "Project name or ID" },
				workItemType: {
					type: "string",
					description: "Work item type (e.g. User Story, Bug)",
				},
				fields: {
					type: "array",
					description:
						"Array of field objects: { name, value, format? }",
				},
			},
			required: ["project", "workItemType", "fields"],
		},
	},
	wit_update_work_item: {
		name: "wit_update_work_item",
		description: "Update an existing work item",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "number", description: "Work item ID" },
				updates: {
					type: "array",
					description: "Array of JSON Patch ops: { op, path, value }",
				},
			},
			required: ["id", "updates"],
		},
	},
	wit_get_work_item: {
		name: "wit_get_work_item",
		description: "Get a work item by ID",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "number", description: "Work item ID" },
				project: {
					type: "string",
					description: "Project name or ID",
				},
			},
			required: ["id", "project"],
		},
	},
	wit_list_backlog_work_items: {
		name: "wit_list_backlog_work_items",
		description: "List work items in a backlog",
		inputSchema: {
			type: "object",
			properties: {
				project: { type: "string", description: "Project name or ID" },
				team: { type: "string", description: "Team name" },
				backlogId: {
					type: "string",
					description: "Backlog category ID",
				},
			},
			required: ["project", "team", "backlogId"],
		},
	},
	wit_list_backlogs: {
		name: "wit_list_backlogs",
		description: "List backlogs for a team",
		inputSchema: {
			type: "object",
			properties: {
				project: { type: "string", description: "Project name or ID" },
				team: { type: "string", description: "Team name" },
			},
			required: ["project", "team"],
		},
	},
	core_list_projects: {
		name: "core_list_projects",
		description: "List all projects in the organization",
		inputSchema: {
			type: "object",
			properties: {},
			required: [],
		},
	},
	core_list_project_teams: {
		name: "core_list_project_teams",
		description: "List teams for a project",
		inputSchema: {
			type: "object",
			properties: {
				project: { type: "string", description: "Project name or ID" },
			},
			required: ["project"],
		},
	},
};

// =============================================================================
// Mock Data
// =============================================================================

const MOCK_ADO_STORY = {
	id: "story-ado-1",
	identifier: "F-001",
	title: "User login functionality",
	description: "As a user, I want to log in",
	acceptanceCriteria: "- Given valid credentials\n- When I click login",
	priority: "P1_HIGH" as const,
	size: "M" as const,
	storyPoints: 5,
	labels: ["auth"],
	externalId: null,
	externalUrl: null,
	tasks: [],
};

const MOCK_ADO_SYNCED_STORY = {
	...MOCK_ADO_STORY,
	externalId: "42",
	externalUrl: "https://dev.azure.com/org/project/_workitems/edit/42",
};

const MOCK_ADO_CREATE_RESPONSE = wrapInMcpContent({
	id: 99,
	fields: {
		"System.Title": "[F-001] User login functionality",
		"System.State": "New",
	},
	_links: {
		html: { href: "https://dev.azure.com/org/project/_workitems/edit/99" },
		web: { href: "https://dev.azure.com/org/project/_workitems/edit/99" },
	},
	url: "https://dev.azure.com/org/project/_apis/wit/workItems/99",
});

// Mirrors the real wit_get_work_item shape: ADO's top-level `url` is the
// REST API endpoint (returns JSON), while the user-facing web URL lives in
// `_links.html.href`. The extractor must prefer the latter, otherwise
// "Open in PM tool" from the roadmap renders raw JSON in the browser.
const MOCK_ADO_GET_RESPONSE = wrapInMcpContent({
	id: 42,
	fields: {
		"System.Title": "Updated title from ADO",
		"System.Description": "<p>Updated description</p>",
		"System.State": "Active",
	},
	_links: {
		self: {
			href: "https://dev.azure.com/org/project/_apis/wit/workItems/42",
		},
		html: { href: "https://dev.azure.com/org/project/_workitems/edit/42" },
		web: { href: "https://dev.azure.com/org/project/_workitems/edit/42" },
	},
	url: "https://dev.azure.com/org/project/_apis/wit/workItems/42",
});

const MOCK_ADO_BACKLOGS = [
	{
		id: "Microsoft.EpicCategory",
		name: "Epics",
		workItemTypes: [{ name: "Epic" }],
	},
	{
		id: "Microsoft.FeatureCategory",
		name: "Features",
		workItemTypes: [{ name: "Feature" }],
	},
	{
		id: "Microsoft.RequirementCategory",
		name: "Stories",
		workItemTypes: [{ name: "User Story" }],
	},
];

const MOCK_ADO_TEAMS = [
	{ name: "MyProject Team", id: "team-1" },
	{ name: "Backend Team", id: "team-2" },
];

function setupAdoMcpClientMock() {
	const mockClient = {
		tools: vi.fn().mockResolvedValue(ADO_TOOLS),
	};
	vi.mocked(getMcpClient).mockResolvedValue({
		client: mockClient as any,
		serverName: "azure-devops-mcp",
	});
	vi.mocked(getMcpClientResult).mockResolvedValue({
		ok: true,
		client: mockClient as any,
		serverName: "azure-devops-mcp",
	});
	return mockClient;
}

// =============================================================================
// Tests
// =============================================================================

describe("Tool Analyzer - ADO Detection", () => {
	it("should detect azure-devops PM type from wit_* names", () => {
		const capabilities = analyzePMToolCapabilities(ADO_TOOLS);
		expect(capabilities.hasPMCapabilities).toBe(true);
		expect(capabilities.detectedType).toBe("azure-devops");
	});

	it("should detect fieldsBased creation (project + workItemType + fields)", () => {
		const capabilities = analyzePMToolCapabilities(ADO_TOOLS);
		expect(capabilities.taskCreation).toBeDefined();
		expect(capabilities.taskCreation?.toolName).toBe(
			"wit_create_work_item",
		);
		expect(capabilities.taskCreation?.containerParam).toBe("project");
		expect(capabilities.taskCreation?.fieldsBased).toBeDefined();
		expect(capabilities.taskCreation?.fieldsBased?.titleKey).toBe(
			"System.Title",
		);
		expect(capabilities.taskCreation?.fieldsBased?.descriptionKey).toBe(
			"System.Description",
		);
		expect(capabilities.taskCreation?.fieldsBased?.workItemTypeParam).toBe(
			"workItemType",
		);
		expect(capabilities.taskCreation?.fieldsBased?.fieldsParam).toBe(
			"fields",
		);
	});

	it("should detect updatesBased update (id + updates)", () => {
		const capabilities = analyzePMToolCapabilities(ADO_TOOLS);
		expect(capabilities.taskUpdate).toBeDefined();
		expect(capabilities.taskUpdate?.toolName).toBe("wit_update_work_item");
		expect(capabilities.taskUpdate?.idParam).toBe("id");
		expect(capabilities.taskUpdate?.updatesBased).toBeDefined();
		expect(capabilities.taskUpdate?.updatesBased?.updatesParam).toBe(
			"updates",
		);
	});

	it("should detect task get (wit_get_work_item)", () => {
		const capabilities = analyzePMToolCapabilities(ADO_TOOLS);
		expect(capabilities.taskGet).toBeDefined();
		expect(capabilities.taskGet?.toolName).toBe("wit_get_work_item");
		expect(capabilities.taskGet?.idParam).toBe("id");
		expect(capabilities.taskGet?.additionalRequiredParams).toContain(
			"project",
		);
	});

	it("should detect task list with team/backlogId filter params", () => {
		const capabilities = analyzePMToolCapabilities(ADO_TOOLS);
		expect(capabilities.taskList).toBeDefined();
		expect(capabilities.taskList?.toolName).toBe(
			"wit_list_backlog_work_items",
		);
		expect(capabilities.taskList?.containerParam).toBe("project");
		expect(capabilities.taskList?.filterParams).toContain("team");
		expect(capabilities.taskList?.filterParams).toContain("backlogId");
	});

	it("should detect container hierarchy (core_list_projects)", () => {
		const capabilities = analyzePMToolCapabilities(ADO_TOOLS);
		expect(capabilities.containerHierarchy.length).toBeGreaterThanOrEqual(
			1,
		);
		const projectLevel = capabilities.containerHierarchy.find(
			(h) => h.containerType === "project",
		);
		expect(projectLevel).toBeDefined();
		expect(projectLevel?.listToolName).toBe("core_list_projects");
	});
});

describe("buildTaskCreationArgs for ADO", () => {
	it("should build fieldsBased args with project, workItemType, fields", () => {
		const capabilities = analyzePMToolCapabilities(ADO_TOOLS);
		const args = buildTaskCreationArgs(
			capabilities,
			{ title: "[F-001] Login", description: "As a user..." },
			"MyProject",
		);

		// For ADO with fieldsBased, buildTaskCreationArgs sets standard params
		// The actual fields-based logic is in syncStoryToPM, but the base args should have project
		expect(args.project).toBe("MyProject");
	});

	it("should include additionalContext values", () => {
		const capabilities = analyzePMToolCapabilities(ADO_TOOLS);
		const args = buildTaskCreationArgs(
			capabilities,
			{ title: "Test", description: "Desc" },
			"MyProject",
			{ account_slug: "my-org" },
		);
		expect(args.project).toBe("MyProject");
	});
});

describe("PUSH: Create Work Item", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("should create with fields array: System.Title, System.Description (format: Html — ADO update path has no format hint, so we ship HTML on both create and update)", async () => {
		setupAdoMcpClientMock();
		vi.mocked(getStoryById).mockResolvedValue(MOCK_ADO_STORY as any);
		vi.mocked(getMcpConfigById).mockResolvedValue({
			baseUrl: "https://dev.azure.com",
		} as any);
		vi.mocked(executeMcpTool).mockResolvedValue({
			success: true,
			output: MOCK_ADO_CREATE_RESPONSE,
			durationMs: 200,
		});
		vi.mocked(updateStory).mockResolvedValue({} as any);

		const input: StorySyncInput = {
			storyId: "story-ado-1",
			projectId: "project-1",
			mcpConfigId: "mcp-ado",
			containerId: "MyProject",
			direction: "push",
			userId: "user-1",
		};

		const result = await syncStoryToPM(input);

		expect(result.success).toBe(true);
		expect(result.externalId).toBeDefined();

		// Verify executeMcpTool was called with fields array
		const createCall = vi
			.mocked(executeMcpTool)
			.mock.calls.find(
				(call) => call[0].toolName === "wit_create_work_item",
			);
		expect(createCall).toBeDefined();
		const createArgs = createCall?.[0].args as Record<string, unknown>;
		expect(createArgs.project).toBe("MyProject");
		expect(createArgs.workItemType).toBe("User Story");

		const fields = createArgs.fields as Array<{
			name: string;
			value: string;
			format?: string;
		}>;
		expect(fields).toBeDefined();
		expect(Array.isArray(fields)).toBe(true);

		const titleField = fields.find((f) => f.name === "System.Title");
		expect(titleField).toBeDefined();
		expect(titleField?.value).toBe(MOCK_ADO_STORY.title);

		const descField = fields.find((f) => f.name === "System.Description");
		expect(descField).toBeDefined();
		// `format: "Html"` keeps the create and update paths symmetric. The
		// ADO MCP `wit_update_work_item` JSON Patch entries have no format
		// field — ADO renders System.Description as HTML by default on update.
		// Sending GFM markdown via create+Markdown would diverge from update.
		expect(descField?.format).toBe("Html");
	});

	it("should include AreaPath and IterationPath with backslash normalization", async () => {
		setupAdoMcpClientMock();
		vi.mocked(getStoryById).mockResolvedValue(MOCK_ADO_STORY as any);
		vi.mocked(getMcpConfigById).mockResolvedValue({
			baseUrl: "https://dev.azure.com",
		} as any);
		vi.mocked(executeMcpTool).mockResolvedValue({
			success: true,
			output: MOCK_ADO_CREATE_RESPONSE,
			durationMs: 200,
		});
		vi.mocked(updateStory).mockResolvedValue({} as any);

		const input: StorySyncInput = {
			storyId: "story-ado-1",
			projectId: "project-1",
			mcpConfigId: "mcp-ado",
			containerId: "MyProject",
			additionalContext: {
				areaPath: "MyProject/Team A",
				iterationPath: "MyProject/Sprint 1",
			},
			direction: "push",
			userId: "user-1",
		};

		await syncStoryToPM(input);

		const createCall = vi
			.mocked(executeMcpTool)
			.mock.calls.find(
				(call) => call[0].toolName === "wit_create_work_item",
			);
		const fields = (createCall?.[0].args as Record<string, unknown>)
			.fields as Array<{ name: string; value: string }>;

		const areaField = fields.find((f) => f.name === "System.AreaPath");
		expect(areaField).toBeDefined();
		expect(areaField?.value).toBe("MyProject\\Team A");

		const iterField = fields.find((f) => f.name === "System.IterationPath");
		expect(iterField).toBeDefined();
		expect(iterField?.value).toBe("MyProject\\Sprint 1");
	});

	it("should use custom workItemType from additionalContext", async () => {
		setupAdoMcpClientMock();
		vi.mocked(getStoryById).mockResolvedValue(MOCK_ADO_STORY as any);
		vi.mocked(getMcpConfigById).mockResolvedValue({
			baseUrl: "https://dev.azure.com",
		} as any);
		vi.mocked(executeMcpTool).mockResolvedValue({
			success: true,
			output: MOCK_ADO_CREATE_RESPONSE,
			durationMs: 200,
		});
		vi.mocked(updateStory).mockResolvedValue({} as any);

		const input: StorySyncInput = {
			storyId: "story-ado-1",
			projectId: "project-1",
			mcpConfigId: "mcp-ado",
			containerId: "MyProject",
			additionalContext: {
				workItemType: "Product Backlog Item",
			},
			direction: "push",
			userId: "user-1",
		};

		await syncStoryToPM(input);

		const createCall = vi
			.mocked(executeMcpTool)
			.mock.calls.find(
				(call) => call[0].toolName === "wit_create_work_item",
			);
		expect(
			(createCall?.[0].args as Record<string, unknown>).workItemType,
		).toBe("Product Backlog Item");
	});

	it("should push a BUG-kind story as the ADO 'Bug' work item type", async () => {
		// Regression: a Fabric bug (UserStory with kind="BUG") pushed via the
		// per-story Push button used to land in ADO as a "User Story" because
		// this path hardcoded the default type and ignored the story's kind.
		// It must mirror the auto-push / AI-update path (hierarchy-sync's
		// ITEM_TYPE_TO_ADO_TYPE, where bug → "Bug"). Verified the real
		// @azure-devops/mcp creates a "Bug" fine.
		setupAdoMcpClientMock();
		vi.mocked(getStoryById).mockResolvedValue({
			...MOCK_ADO_STORY,
			kind: "BUG",
		} as any);
		vi.mocked(getMcpConfigById).mockResolvedValue({
			baseUrl: "https://dev.azure.com",
		} as any);
		vi.mocked(executeMcpTool).mockResolvedValue({
			success: true,
			output: MOCK_ADO_CREATE_RESPONSE,
			durationMs: 200,
		});
		vi.mocked(updateStory).mockResolvedValue({} as any);

		await syncStoryToPM({
			storyId: "story-ado-1",
			projectId: "project-1",
			mcpConfigId: "mcp-ado",
			containerId: "MyProject",
			direction: "push",
			userId: "user-1",
		});

		const createCall = vi
			.mocked(executeMcpTool)
			.mock.calls.find(
				(call) => call[0].toolName === "wit_create_work_item",
			);
		expect(
			(createCall?.[0].args as Record<string, unknown>).workItemType,
		).toBe("Bug");
		// A Bug's body renders in Repro Steps, not System.Description — so the
		// body is mirrored into Microsoft.VSTS.TCM.ReproSteps (System.Description
		// is kept too so the read/pull paths keep working).
		const fields = (createCall?.[0].args as Record<string, unknown>)
			.fields as Array<{ name: string; value: string }>;
		const repro = fields.find(
			(f) => f.name === "Microsoft.VSTS.TCM.ReproSteps",
		);
		const desc = fields.find((f) => f.name === "System.Description");
		expect(repro).toBeDefined();
		expect(repro?.value).toBeTruthy();
		expect(repro?.value).toBe(desc?.value);
	});

	it("should NOT add ReproSteps for a non-bug (FEATURE) kind", async () => {
		setupAdoMcpClientMock();
		vi.mocked(getStoryById).mockResolvedValue({
			...MOCK_ADO_STORY,
			kind: "FEATURE",
		} as any);
		vi.mocked(getMcpConfigById).mockResolvedValue({
			baseUrl: "https://dev.azure.com",
		} as any);
		vi.mocked(executeMcpTool).mockResolvedValue({
			success: true,
			output: MOCK_ADO_CREATE_RESPONSE,
			durationMs: 200,
		});
		vi.mocked(updateStory).mockResolvedValue({} as any);

		await syncStoryToPM({
			storyId: "story-ado-1",
			projectId: "project-1",
			mcpConfigId: "mcp-ado",
			containerId: "MyProject",
			direction: "push",
			userId: "user-1",
		});

		const createCall = vi
			.mocked(executeMcpTool)
			.mock.calls.find(
				(call) => call[0].toolName === "wit_create_work_item",
			);
		const fields = (createCall?.[0].args as Record<string, unknown>)
			.fields as Array<{ name: string }>;
		expect(
			fields.find((f) => f.name === "Microsoft.VSTS.TCM.ReproSteps"),
		).toBeUndefined();
	});

	it("should let a BUG kind override the project-default workItemType", async () => {
		// Bugs map to "Bug" unconditionally — the project-level default
		// (additionalContext.workItemType) only applies to non-bug kinds, so
		// both push paths agree regardless of project configuration.
		setupAdoMcpClientMock();
		vi.mocked(getStoryById).mockResolvedValue({
			...MOCK_ADO_STORY,
			kind: "BUG",
		} as any);
		vi.mocked(getMcpConfigById).mockResolvedValue({
			baseUrl: "https://dev.azure.com",
		} as any);
		vi.mocked(executeMcpTool).mockResolvedValue({
			success: true,
			output: MOCK_ADO_CREATE_RESPONSE,
			durationMs: 200,
		});
		vi.mocked(updateStory).mockResolvedValue({} as any);

		await syncStoryToPM({
			storyId: "story-ado-1",
			projectId: "project-1",
			mcpConfigId: "mcp-ado",
			containerId: "MyProject",
			additionalContext: { workItemType: "Product Backlog Item" },
			direction: "push",
			userId: "user-1",
		});

		const createCall = vi
			.mocked(executeMcpTool)
			.mock.calls.find(
				(call) => call[0].toolName === "wit_create_work_item",
			);
		expect(
			(createCall?.[0].args as Record<string, unknown>).workItemType,
		).toBe("Bug");
	});

	it("should still push a non-bug (FEATURE) kind as the default 'User Story'", async () => {
		// Guard against over-reach: only BUG is special-cased. FEATURE /
		// USER_STORY kinds keep the existing default behavior byte-for-byte.
		setupAdoMcpClientMock();
		vi.mocked(getStoryById).mockResolvedValue({
			...MOCK_ADO_STORY,
			kind: "FEATURE",
		} as any);
		vi.mocked(getMcpConfigById).mockResolvedValue({
			baseUrl: "https://dev.azure.com",
		} as any);
		vi.mocked(executeMcpTool).mockResolvedValue({
			success: true,
			output: MOCK_ADO_CREATE_RESPONSE,
			durationMs: 200,
		});
		vi.mocked(updateStory).mockResolvedValue({} as any);

		await syncStoryToPM({
			storyId: "story-ado-1",
			projectId: "project-1",
			mcpConfigId: "mcp-ado",
			containerId: "MyProject",
			direction: "push",
			userId: "user-1",
		});

		const createCall = vi
			.mocked(executeMcpTool)
			.mock.calls.find(
				(call) => call[0].toolName === "wit_create_work_item",
			);
		expect(
			(createCall?.[0].args as Record<string, unknown>).workItemType,
		).toBe("User Story");
	});

	it("should extract external ID and URL from ADO create response", async () => {
		setupAdoMcpClientMock();
		vi.mocked(getStoryById).mockResolvedValue(MOCK_ADO_STORY as any);
		vi.mocked(getMcpConfigById).mockResolvedValue({
			baseUrl: "https://dev.azure.com",
		} as any);
		vi.mocked(executeMcpTool).mockResolvedValue({
			success: true,
			output: MOCK_ADO_CREATE_RESPONSE,
			durationMs: 200,
		});
		vi.mocked(updateStory).mockResolvedValue({} as any);

		const input: StorySyncInput = {
			storyId: "story-ado-1",
			projectId: "project-1",
			mcpConfigId: "mcp-ado",
			containerId: "MyProject",
			direction: "push",
			userId: "user-1",
		};

		const result = await syncStoryToPM(input);

		expect(result.success).toBe(true);
		// The ID from the create response is 99
		expect(result.externalId).toBe("99");
		expect(result.externalUrl).toContain("dev.azure.com");

		// Verify updateStory was called with the new externalId, attributed to
		// the PM tool rather than to whoever happened to trigger the sync.
		expect(vi.mocked(updateStory)).toHaveBeenCalledWith(
			"story-ado-1",
			"project-1",
			expect.objectContaining({
				externalId: "99",
			}),
			expect.objectContaining({ lastEditedSource: "PM_PULL" }),
		);
	});
});

describe("PUSH: Update Work Item", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("should update with JSON Patch: updates array with op/path/value", async () => {
		setupAdoMcpClientMock();
		vi.mocked(getStoryById).mockResolvedValue(MOCK_ADO_SYNCED_STORY as any);
		vi.mocked(getMcpConfigById).mockResolvedValue({
			baseUrl: "https://dev.azure.com",
		} as any);
		vi.mocked(executeMcpTool).mockResolvedValue({
			success: true,
			output: wrapInMcpContent({ id: 42 }),
			durationMs: 200,
		});

		const input: StorySyncInput = {
			storyId: "story-ado-1",
			projectId: "project-1",
			mcpConfigId: "mcp-ado",
			containerId: "MyProject",
			direction: "push",
			userId: "user-1",
		};

		const result = await syncStoryToPM(input);
		expect(result.success).toBe(true);

		const updateCall = vi
			.mocked(executeMcpTool)
			.mock.calls.find(
				(call) => call[0].toolName === "wit_update_work_item",
			);
		expect(updateCall).toBeDefined();

		const updateArgs = updateCall?.[0].args as Record<string, unknown>;
		expect(updateArgs.id).toBe("42");

		const updates = updateArgs.updates as Array<{
			op: string;
			path: string;
			value: string;
		}>;
		expect(updates).toBeDefined();

		const titlePatch = updates.find(
			(u) => u.path === "/fields/System.Title",
		);
		expect(titlePatch).toBeDefined();
		expect(titlePatch?.op).toBe("add");
		expect(titlePatch?.value).toBe(MOCK_ADO_STORY.title);

		const descPatch = updates.find(
			(u) => u.path === "/fields/System.Description",
		);
		expect(descPatch).toBeDefined();
		expect(descPatch?.op).toBe("add");
	});
});

describe("PUSH: Error Handling", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("surfaces the PM tool's real error verbatim (no misleading WIT-type hint)", async () => {
		// We used to append "Try changing Work Item Type (Scrum = Product
		// Backlog Item, Agile = User Story)" to any "work item was not created"
		// error. That hint was wrong — the real cause is often unrelated (e.g.
		// an invalid AreaPath), and the official ADO MCP creates a Bug fine. The
		// failure path now passes the PM tool's message through untouched.
		setupAdoMcpClientMock();
		vi.mocked(getStoryById).mockResolvedValue(MOCK_ADO_STORY as any);
		vi.mocked(getMcpConfigById).mockResolvedValue({
			baseUrl: "https://dev.azure.com",
		} as any);
		vi.mocked(executeMcpTool).mockResolvedValue({
			success: false,
			output: wrapInMcpContent(
				"TF401347: Invalid tree name given for work item -1, field 'System.AreaPath'.",
			),
			durationMs: 200,
		});

		const input: StorySyncInput = {
			storyId: "story-ado-1",
			projectId: "project-1",
			mcpConfigId: "mcp-ado",
			containerId: "MyProject",
			direction: "push",
			userId: "user-1",
		};

		const result = await syncStoryToPM(input);
		expect(result.success).toBe(false);
		expect(result.error).toContain("TF401347");
		expect(result.error).not.toContain("Work Item Type");
	});
});

describe("PULL: Single Story via wit_get_work_item", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("should pull and parse ADO fields format", async () => {
		setupAdoMcpClientMock();
		vi.mocked(getStoryById).mockResolvedValue(MOCK_ADO_SYNCED_STORY as any);
		vi.mocked(getMcpConfigById).mockResolvedValue({
			baseUrl: "https://dev.azure.com",
		} as any);

		// The first executeMcpTool call won't be update (it has externalId, direction=pull)
		// The get call returns the ADO response
		vi.mocked(executeMcpTool).mockResolvedValue({
			success: true,
			output: MOCK_ADO_GET_RESPONSE,
			durationMs: 200,
		});
		vi.mocked(updateStory).mockResolvedValue({} as any);

		const input: StorySyncInput = {
			storyId: "story-ado-1",
			projectId: "project-1",
			mcpConfigId: "mcp-ado",
			containerId: "MyProject",
			direction: "pull",
			userId: "user-1",
		};

		const result = await syncStoryToPM(input);
		expect(result.success).toBe(true);

		// Verify the get tool was called
		const getCall = vi
			.mocked(executeMcpTool)
			.mock.calls.find(
				(call) => call[0].toolName === "wit_get_work_item",
			);
		expect(getCall).toBeDefined();

		// updateStory should have been called with parsed ADO fields, stamped as
		// a PM pull so the story's "Updated" line names the tool, not a human.
		expect(vi.mocked(updateStory)).toHaveBeenCalledWith(
			"story-ado-1",
			"project-1",
			expect.objectContaining({
				title: "Updated title from ADO",
			}),
			expect.objectContaining({ lastEditedSource: "PM_PULL" }),
		);
	});

	it("pulls a Bug's body from Repro Steps, not System.Description", async () => {
		// ADO Bugs render their body in Microsoft.VSTS.TCM.ReproSteps; the
		// parser must prefer it so an ADO-side Repro Steps edit round-trips.
		setupAdoMcpClientMock();
		vi.mocked(getStoryById).mockResolvedValue(MOCK_ADO_SYNCED_STORY as any);
		vi.mocked(getMcpConfigById).mockResolvedValue({
			baseUrl: "https://dev.azure.com",
		} as any);
		vi.mocked(executeMcpTool).mockResolvedValue({
			success: true,
			output: wrapInMcpContent({
				id: 42,
				fields: {
					"System.Title": "Bug from ADO",
					"System.WorkItemType": "Bug",
					"System.Description": "<p>stale description</p>",
					"Microsoft.VSTS.TCM.ReproSteps": "<p>real repro body</p>",
				},
			}),
			durationMs: 200,
		});
		vi.mocked(updateStory).mockResolvedValue({} as any);

		await syncStoryToPM({
			storyId: "story-ado-1",
			projectId: "project-1",
			mcpConfigId: "mcp-ado",
			containerId: "MyProject",
			direction: "pull",
			userId: "user-1",
		});

		const call = vi
			.mocked(updateStory)
			.mock.calls.find((c) => c[0] === "story-ado-1");
		const updated = call?.[2] as { description?: string } | undefined;
		expect(updated?.description).toContain("real repro body");
		expect(updated?.description).not.toContain("stale description");
	});

	it("should extract URL from _links.html.href or _links.web.href", async () => {
		setupAdoMcpClientMock();
		vi.mocked(getStoryById).mockResolvedValue(MOCK_ADO_SYNCED_STORY as any);
		vi.mocked(getMcpConfigById).mockResolvedValue({
			baseUrl: "https://dev.azure.com",
		} as any);
		vi.mocked(executeMcpTool).mockResolvedValue({
			success: true,
			output: MOCK_ADO_GET_RESPONSE,
			durationMs: 200,
		});
		vi.mocked(updateStory).mockResolvedValue({} as any);

		const input: StorySyncInput = {
			storyId: "story-ado-1",
			projectId: "project-1",
			mcpConfigId: "mcp-ado",
			containerId: "MyProject",
			direction: "pull",
			userId: "user-1",
		};

		const result = await syncStoryToPM(input);
		expect(result.success).toBe(true);

		// externalUrl must come from `_links.html.href`, NOT the top-level
		// `url` field which carries the REST-API endpoint. Loose substring
		// matches like "dev.azure.com" let the regression through silently.
		expect(result.externalUrl).toContain("/_workitems/edit/");
		expect(result.externalUrl).not.toContain("/_apis/wit/workItems/");
	});
});

describe("PULL: List Work Items", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("should auto-resolve team and backlogId for wit_list_backlog_work_items", async () => {
		setupAdoMcpClientMock();

		// executeMcpTool calls in order:
		// 1. core_list_project_teams → teams
		// 2. wit_list_backlogs → backlogs
		// 3. wit_list_backlog_work_items → work items
		vi.mocked(executeMcpTool).mockImplementation(async (params) => {
			if (params.toolName === "core_list_project_teams") {
				return {
					success: true,
					output: wrapInMcpContent(MOCK_ADO_TEAMS),
					durationMs: 100,
				};
			}
			if (params.toolName === "wit_list_backlogs") {
				return {
					success: true,
					output: wrapInMcpContent(MOCK_ADO_BACKLOGS),
					durationMs: 100,
				};
			}
			if (params.toolName === "wit_list_backlog_work_items") {
				return {
					success: true,
					output: wrapInMcpContent([
						{
							target: {
								id: 101,
								url: "https://dev.azure.com/...",
							},
						},
						{
							target: {
								id: 102,
								url: "https://dev.azure.com/...",
							},
						},
					]),
					durationMs: 100,
				};
			}
			// wit_get_work_item for enrichment
			if (params.toolName === "wit_get_work_item") {
				const id = (params.args as Record<string, unknown>).id;
				return {
					success: true,
					output: wrapInMcpContent({
						id,
						fields: {
							"System.Title": `Work Item ${id}`,
							"System.Description": `Description for ${id}`,
						},
						_links: {
							web: {
								href: `https://dev.azure.com/org/proj/_workitems/edit/${id}`,
							},
						},
					}),
					durationMs: 100,
				};
			}
			return { success: false, output: null, durationMs: 0 };
		});

		const { items } = await listWorkItemsFromPM({
			mcpConfigId: "mcp-ado",
			containerId: "MyProject",
			userId: "user-1",
		});

		expect(items.length).toBe(2);
		// Verify team was auto-resolved (core_list_project_teams called)
		expect(vi.mocked(executeMcpTool)).toHaveBeenCalledWith(
			expect.objectContaining({
				toolName: "core_list_project_teams",
				args: expect.objectContaining({ project: "MyProject" }),
			}),
		);
	});

	it("should parse sparse refs with target.id wrapper", async () => {
		setupAdoMcpClientMock();

		vi.mocked(executeMcpTool).mockImplementation(async (params) => {
			if (params.toolName === "core_list_project_teams") {
				return {
					success: true,
					output: wrapInMcpContent(MOCK_ADO_TEAMS),
					durationMs: 100,
				};
			}
			if (params.toolName === "wit_list_backlogs") {
				return {
					success: true,
					output: wrapInMcpContent(MOCK_ADO_BACKLOGS),
					durationMs: 100,
				};
			}
			if (params.toolName === "wit_list_backlog_work_items") {
				return {
					success: true,
					output: wrapInMcpContent([
						{ target: { id: 200 } },
						{ target: { id: 201 } },
					]),
					durationMs: 100,
				};
			}
			if (params.toolName === "wit_get_work_item") {
				const id = (params.args as Record<string, unknown>).id;
				return {
					success: true,
					output: wrapInMcpContent({
						id,
						fields: {
							"System.Title": `Enriched Item ${id}`,
						},
						_links: {
							web: {
								href: `https://dev.azure.com/org/proj/_workitems/edit/${id}`,
							},
						},
					}),
					durationMs: 100,
				};
			}
			return { success: false, output: null, durationMs: 0 };
		});

		const { items } = await listWorkItemsFromPM({
			mcpConfigId: "mcp-ado",
			containerId: "MyProject",
			userId: "user-1",
		});

		// Items should be enriched (wit_get_work_item called for each)
		expect(items.length).toBe(2);
		const getWorkItemCalls = vi
			.mocked(executeMcpTool)
			.mock.calls.filter(
				(call) => call[0].toolName === "wit_get_work_item",
			);
		expect(getWorkItemCalls.length).toBe(2);
	});

	it("should pass organizationId through all calls", async () => {
		setupAdoMcpClientMock();

		vi.mocked(executeMcpTool).mockImplementation(async (params) => {
			if (params.toolName === "core_list_project_teams") {
				return {
					success: true,
					output: wrapInMcpContent(MOCK_ADO_TEAMS),
					durationMs: 100,
				};
			}
			if (params.toolName === "wit_list_backlogs") {
				return {
					success: true,
					output: wrapInMcpContent(MOCK_ADO_BACKLOGS),
					durationMs: 100,
				};
			}
			if (params.toolName === "wit_list_backlog_work_items") {
				return {
					success: true,
					output: wrapInMcpContent([
						{
							id: 301,
							fields: { "System.Title": "Ready Item" },
						},
					]),
					durationMs: 100,
				};
			}
			return { success: false, output: null, durationMs: 0 };
		});

		await listWorkItemsFromPM({
			mcpConfigId: "mcp-ado",
			containerId: "MyProject",
			userId: "user-1",
			organizationId: "org-42",
		});

		// Every executeMcpTool call should include organizationId
		for (const call of vi.mocked(executeMcpTool).mock.calls) {
			expect(call[0].organizationId).toBe("org-42");
		}
	});
});

describe("Fetch PM Hierarchy - ADO", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("should fetch by backlog category (Epic, Feature, User Story)", async () => {
		setupAdoMcpClientMock();

		vi.mocked(executeMcpTool).mockImplementation(async (params) => {
			if (params.toolName === "core_list_project_teams") {
				return {
					success: true,
					output: wrapInMcpContent(MOCK_ADO_TEAMS),
					durationMs: 100,
				};
			}
			if (params.toolName === "wit_list_backlogs") {
				return {
					success: true,
					output: wrapInMcpContent(MOCK_ADO_BACKLOGS),
					durationMs: 100,
				};
			}
			if (params.toolName === "wit_list_backlog_work_items") {
				const backlogId = (params.args as Record<string, unknown>)
					.backlogId as string;
				if (backlogId === "Microsoft.EpicCategory") {
					return {
						success: true,
						output: wrapInMcpContent([
							{
								target: {
									id: 10,
									fields: {
										"System.Title": "Epic 1",
									},
								},
							},
						]),
						durationMs: 100,
					};
				}
				if (backlogId === "Microsoft.FeatureCategory") {
					return {
						success: true,
						output: wrapInMcpContent([
							{
								target: {
									id: 20,
									fields: {
										"System.Title": "Feature 1",
									},
								},
							},
						]),
						durationMs: 100,
					};
				}
				if (backlogId === "Microsoft.RequirementCategory") {
					return {
						success: true,
						output: wrapInMcpContent([
							{
								target: {
									id: 30,
									fields: {
										"System.Title": "Story 1",
									},
								},
							},
						]),
						durationMs: 100,
					};
				}
				return {
					success: true,
					output: wrapInMcpContent([]),
					durationMs: 100,
				};
			}
			if (params.toolName === "wit_get_work_item") {
				const id = (params.args as Record<string, unknown>).id;
				return {
					success: true,
					output: wrapInMcpContent({
						id,
						fields: { "System.Title": `Item ${id}` },
					}),
					durationMs: 100,
				};
			}
			return { success: false, output: null, durationMs: 0 };
		});

		const capabilities = analyzePMToolCapabilities(ADO_TOOLS);
		const result = await fetchPMWorkItemsByType({
			projectId: "project-1",
			mcpConfigId: "mcp-ado",
			containerId: "MyProject",
			userId: "user-1",
			capabilities: {
				...capabilities,
				// Override so it matches what discoverPMToolCapabilities returns
			},
		});

		expect(result.detectedType).toBe("azure-devops");
		expect(result.epics.length).toBeGreaterThanOrEqual(1);
		expect(result.features.length).toBeGreaterThanOrEqual(1);
		expect(result.stories.length).toBeGreaterThanOrEqual(1);
	});

	it("should auto-resolve team when missing from additionalContext", async () => {
		setupAdoMcpClientMock();

		vi.mocked(executeMcpTool).mockImplementation(async (params) => {
			if (params.toolName === "core_list_project_teams") {
				return {
					success: true,
					output: wrapInMcpContent(MOCK_ADO_TEAMS),
					durationMs: 100,
				};
			}
			if (params.toolName === "wit_list_backlogs") {
				return {
					success: true,
					output: wrapInMcpContent(MOCK_ADO_BACKLOGS),
					durationMs: 100,
				};
			}
			if (params.toolName === "wit_list_backlog_work_items") {
				return {
					success: true,
					output: wrapInMcpContent([]),
					durationMs: 100,
				};
			}
			return { success: false, output: null, durationMs: 0 };
		});

		const capabilities = analyzePMToolCapabilities(ADO_TOOLS);
		await fetchPMWorkItemsByType({
			projectId: "project-1",
			mcpConfigId: "mcp-ado",
			containerId: "MyProject",
			userId: "user-1",
			capabilities,
		});

		// Should have called core_list_project_teams to resolve team
		expect(vi.mocked(executeMcpTool)).toHaveBeenCalledWith(
			expect.objectContaining({
				toolName: "core_list_project_teams",
			}),
		);
	});
});

describe("buildAdoTypeMapping", () => {
	it("should map Agile template (Epic, Feature, User Story)", () => {
		const backlogs: AdoBacklogEntry[] = [
			{
				id: "Microsoft.EpicCategory",
				name: "Epics",
				workItemTypes: [{ name: "Epic" }],
			},
			{
				id: "Microsoft.FeatureCategory",
				name: "Features",
				workItemTypes: [{ name: "Feature" }],
			},
			{
				id: "Microsoft.RequirementCategory",
				name: "Stories",
				workItemTypes: [{ name: "User Story" }],
			},
		];

		const mapping = buildAdoTypeMapping(backlogs);
		expect(mapping.epicType).toBe("Epic");
		expect(mapping.featureType).toBe("Feature");
		expect(mapping.storyType).toBe("User Story");
		expect(mapping.hasFeatureCategory).toBe(true);
	});

	it("should map Basic template (Issue, no Feature)", () => {
		const backlogs: AdoBacklogEntry[] = [
			{
				id: "Microsoft.EpicCategory",
				name: "Epics",
				workItemTypes: [{ name: "Epic" }],
			},
			{
				id: "Microsoft.RequirementCategory",
				name: "Issues",
				workItemTypes: [{ name: "Issue" }],
			},
		];

		const mapping = buildAdoTypeMapping(backlogs);
		expect(mapping.epicType).toBe("Epic");
		expect(mapping.featureType).toBeUndefined();
		expect(mapping.storyType).toBe("Issue");
		expect(mapping.hasFeatureCategory).toBe(false);
	});

	it("should map Scrum template (Product Backlog Item)", () => {
		const backlogs: AdoBacklogEntry[] = [
			{
				id: "Microsoft.EpicCategory",
				name: "Epics",
				workItemTypes: [{ name: "Epic" }],
			},
			{
				id: "Microsoft.FeatureCategory",
				name: "Features",
				workItemTypes: [{ name: "Feature" }],
			},
			{
				id: "Microsoft.RequirementCategory",
				name: "Backlog items",
				workItemTypes: [{ name: "Product Backlog Item" }],
			},
		];

		const mapping = buildAdoTypeMapping(backlogs);
		expect(mapping.epicType).toBe("Epic");
		expect(mapping.featureType).toBe("Feature");
		expect(mapping.storyType).toBe("Product Backlog Item");
		expect(mapping.hasFeatureCategory).toBe(true);
	});
});

describe("resolveAdoDefaultTeam", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("should resolve the first team name from core_list_project_teams", async () => {
		vi.mocked(executeMcpTool).mockResolvedValue({
			success: true,
			output: wrapInMcpContent(MOCK_ADO_TEAMS),
			durationMs: 100,
		});

		const team = await resolveAdoDefaultTeam({
			project: "MyProject",
			mcpConfigId: "mcp-ado",
			userId: "user-1",
			availableTools: ["core_list_project_teams"],
		});

		expect(team).toBe("MyProject Team");
	});

	it("should return undefined when no teams tool is available", async () => {
		const team = await resolveAdoDefaultTeam({
			project: "MyProject",
			mcpConfigId: "mcp-ado",
			userId: "user-1",
			availableTools: ["wit_create_work_item"],
		});

		expect(team).toBeUndefined();
	});

	it("should return undefined when teams list is empty", async () => {
		vi.mocked(executeMcpTool).mockResolvedValue({
			success: true,
			output: wrapInMcpContent([]),
			durationMs: 100,
		});

		const team = await resolveAdoDefaultTeam({
			project: "MyProject",
			mcpConfigId: "mcp-ado",
			userId: "user-1",
			availableTools: ["core_list_project_teams"],
		});

		expect(team).toBeUndefined();
	});
});

describe("fetchAdoBacklogs", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("should parse backlogs list from MCP response", async () => {
		vi.mocked(executeMcpTool).mockResolvedValue({
			success: true,
			output: wrapInMcpContent(MOCK_ADO_BACKLOGS),
			durationMs: 100,
		});

		const backlogs = await fetchAdoBacklogs({
			project: "MyProject",
			team: "MyProject Team",
			mcpConfigId: "mcp-ado",
			userId: "user-1",
			backlogsListToolName: "wit_list_backlogs",
		});

		expect(backlogs).toHaveLength(3);
		expect(backlogs[0].id).toBe("Microsoft.EpicCategory");
	});

	it("should return empty array on failure", async () => {
		vi.mocked(executeMcpTool).mockResolvedValue({
			success: false,
			output: null,
			durationMs: 100,
		});

		const backlogs = await fetchAdoBacklogs({
			project: "MyProject",
			team: "MyProject Team",
			mcpConfigId: "mcp-ado",
			userId: "user-1",
			backlogsListToolName: "wit_list_backlogs",
		});

		expect(backlogs).toHaveLength(0);
	});
});

describe("Tenant Isolation", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("should pass organizationId in PUSH flow", async () => {
		setupAdoMcpClientMock();
		vi.mocked(getStoryById).mockResolvedValue(MOCK_ADO_STORY as any);
		vi.mocked(getMcpConfigById).mockResolvedValue({
			baseUrl: "https://dev.azure.com",
		} as any);
		vi.mocked(executeMcpTool).mockResolvedValue({
			success: true,
			output: MOCK_ADO_CREATE_RESPONSE,
			durationMs: 200,
		});
		vi.mocked(updateStory).mockResolvedValue({} as any);

		await syncStoryToPM({
			storyId: "story-ado-1",
			projectId: "project-1",
			mcpConfigId: "mcp-ado",
			containerId: "MyProject",
			direction: "push",
			userId: "user-1",
			organizationId: "org-99",
		});

		// getMcpClientResult should receive organizationId
		expect(vi.mocked(getMcpClientResult)).toHaveBeenCalledWith(
			"mcp-ado",
			"user-1",
			"org-99",
		);

		// executeMcpTool calls should include organizationId
		for (const call of vi.mocked(executeMcpTool).mock.calls) {
			expect(call[0].organizationId).toBe("org-99");
		}
	});

	it("should pass organizationId in PULL flow", async () => {
		setupAdoMcpClientMock();
		vi.mocked(getStoryById).mockResolvedValue(MOCK_ADO_SYNCED_STORY as any);
		vi.mocked(getMcpConfigById).mockResolvedValue({
			baseUrl: "https://dev.azure.com",
		} as any);
		vi.mocked(executeMcpTool).mockResolvedValue({
			success: true,
			output: MOCK_ADO_GET_RESPONSE,
			durationMs: 200,
		});
		vi.mocked(updateStory).mockResolvedValue({} as any);

		await syncStoryToPM({
			storyId: "story-ado-1",
			projectId: "project-1",
			mcpConfigId: "mcp-ado",
			containerId: "MyProject",
			direction: "pull",
			userId: "user-1",
			organizationId: "org-99",
		});

		// getMcpClientResult should receive organizationId
		expect(vi.mocked(getMcpClientResult)).toHaveBeenCalledWith(
			"mcp-ado",
			"user-1",
			"org-99",
		);

		// All executeMcpTool calls should include organizationId
		for (const call of vi.mocked(executeMcpTool).mock.calls) {
			expect(call[0].organizationId).toBe("org-99");
		}
	});
});

describe("Bulk Push - ADO", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("should sync multiple ADO stories", async () => {
		setupAdoMcpClientMock();
		vi.mocked(getMcpConfigById).mockResolvedValue({
			baseUrl: "https://dev.azure.com",
		} as any);

		(
			vi.mocked(db).userStory.findMany as ReturnType<typeof vi.fn>
		).mockResolvedValue([
			{ id: "story-1", identifier: "F-001" },
			{ id: "story-2", identifier: "F-002" },
		] as any);

		vi.mocked(getStoryById).mockImplementation(async (storyId: string) => {
			return {
				...MOCK_ADO_STORY,
				id: storyId,
				identifier: storyId === "story-1" ? "F-001" : "F-002",
			} as any;
		});

		vi.mocked(executeMcpTool).mockResolvedValue({
			success: true,
			output: MOCK_ADO_CREATE_RESPONSE,
			durationMs: 200,
		});
		vi.mocked(updateStory).mockResolvedValue({} as any);

		const result = await syncBulkStoriesToPM({
			projectId: "project-1",
			mcpConfigId: "mcp-ado",
			containerId: "MyProject",
			userId: "user-1",
		});

		expect(result.success).toBe(true);
		expect(result.totalStories).toBe(2);
		expect(result.syncedCount).toBe(2);
		expect(result.failedCount).toBe(0);
	});

	it("should handle partial failures", async () => {
		setupAdoMcpClientMock();
		vi.mocked(getMcpConfigById).mockResolvedValue({
			baseUrl: "https://dev.azure.com",
		} as any);

		(
			vi.mocked(db).userStory.findMany as ReturnType<typeof vi.fn>
		).mockResolvedValue([
			{ id: "story-1", identifier: "F-001" },
			{ id: "story-2", identifier: "F-002" },
		] as any);

		vi.mocked(getStoryById).mockImplementation(async (storyId: string) => {
			return {
				...MOCK_ADO_STORY,
				id: storyId,
				identifier: storyId === "story-1" ? "F-001" : "F-002",
			} as any;
		});

		let callCount = 0;
		vi.mocked(executeMcpTool).mockImplementation(async () => {
			callCount++;
			// First create call succeeds, second fails
			if (callCount <= 1) {
				return {
					success: true,
					output: MOCK_ADO_CREATE_RESPONSE,
					durationMs: 200,
				};
			}
			return {
				success: false,
				output: wrapInMcpContent("Work item was not created"),
				durationMs: 200,
			};
		});
		vi.mocked(updateStory).mockResolvedValue({} as any);

		const result = await syncBulkStoriesToPM({
			projectId: "project-1",
			mcpConfigId: "mcp-ado",
			containerId: "MyProject",
			userId: "user-1",
		});

		expect(result.totalStories).toBe(2);
		expect(result.syncedCount).toBe(1);
		expect(result.failedCount).toBe(1);
	});
});
