/**
 * The Fabric portal tools in the agent runtime.
 *
 * A meeting turn holds a project grant, so the gateway lists the portal tools
 * (features, tasks, documents, contexts, instructions, knowledge search,
 * workspace reads) next to the base set. What is pinned here: which of them the
 * model is ever given, that their schemas ride on a turn only when the request
 * asks for them, that a read and a change are told apart by the gateway's own
 * listing, and that a listing kept for a chat turn is never mistaken for one
 * kept for a meeting.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	createMcpClient: vi.fn(),
	listTools: vi.fn(),
	callTool: vi.fn(),
	closeClient: vi.fn(),
	guardToolWriteForReadOnly: vi.fn(),
}));

vi.mock("@repo/mcp", () => ({ createMcpClient: mocks.createMcpClient }));
vi.mock("@repo/agent-core/backend", () => ({
	closeMcpClientSafe: mocks.closeClient,
}));
vi.mock("@repo/utils", () => ({ getBaseUrl: () => "https://app.example.com" }));
vi.mock("../read-only-gate", () => ({
	guardToolWriteForReadOnly: mocks.guardToolWriteForReadOnly,
}));

import {
	FABRIC_CHAT_TOOL_DEFINITIONS,
	isFabricChatTool,
} from "../../../lib/fabric-gateway-tools";
import {
	FABRIC_PORTAL_EXCLUDED_TOOL_NAMES,
	FABRIC_PORTAL_TOOL_NAMES,
	foreignProjectId,
	isFabricPortalTool,
	needsFabricPortalTools,
} from "../../../lib/fabric-portal-tools";
import {
	loadFabricPlatformTools,
	resetFabricPlatformMcpCache,
} from "../fabric-platform-mcp";

function grantExpiringIn(seconds: number): string {
	const body = JSON.stringify({
		p: { purpose: "fabric-agent-acting-grant" },
		exp: Math.floor(Date.now() / 1000) + seconds,
	});
	return `${Buffer.from(body).toString("base64url")}.signature`;
}

const ACTOR = {
	userId: "user-1",
	organizationId: "org-1",
	actingGrant: grantExpiringIn(3_600),
	projectId: "project-1",
};

const READ = { readOnlyHint: true };

/** What the gateway lists for a meeting's grant: the base set and the whole portal. */
const PORTAL_LISTING = FABRIC_PORTAL_TOOL_NAMES.map((name) => ({
	name,
	description: `The ${name} tool.`,
	inputSchema: {
		type: "object",
		properties: { projectId: { type: "string" } },
	},
	annotations: /_(?:get|list|search|query)_|_instruction_checks$/.test(name)
		? READ
		: undefined,
}));

/** Tools the gateway may list that the model must never get. */
const NEVER_OFFERED = [
	...FABRIC_PORTAL_EXCLUDED_TOOL_NAMES,
	"fabric_not_a_portal_tool",
];

const EXTRAS_LISTING = NEVER_OFFERED.map((name) => ({
	name,
	description: `The ${name} tool.`,
	inputSchema: { type: "object", properties: {} },
	annotations: READ,
}));

const BASE_LISTING = FABRIC_CHAT_TOOL_DEFINITIONS.map((tool) => ({
	name: tool.name,
	description: tool.description,
	inputSchema: tool.inputSchema,
	annotations: tool.annotations,
}));

const PORTAL_TURN = { portal: { offer: true } };
const PORTAL_TURN_WITHOUT_SCHEMAS = { portal: { offer: false } };

beforeEach(() => {
	vi.clearAllMocks();
	resetFabricPlatformMcpCache();
	process.env.AGENT_SERVICE_SECRET = "service-secret-for-tests";
	mocks.createMcpClient.mockResolvedValue({
		listTools: mocks.listTools,
		callTool: mocks.callTool,
	});
	mocks.listTools.mockResolvedValue({
		tools: [...BASE_LISTING, ...PORTAL_LISTING, ...EXTRAS_LISTING],
	});
	mocks.guardToolWriteForReadOnly.mockResolvedValue(null);
});

describe("which portal tools the model is given", () => {
	it("is exactly the named allowlist, however much the gateway lists", async () => {
		const platform = await loadFabricPlatformTools(ACTOR, PORTAL_TURN);

		const portalOffered = Object.keys(platform?.tools ?? {}).filter(
			(name) =>
				!FABRIC_CHAT_TOOL_DEFINITIONS.some(
					(tool) => tool.name === name,
				),
		);
		expect(portalOffered.sort()).toEqual(
			FABRIC_PORTAL_TOOL_NAMES.filter(
				(name) => !isFabricChatTool(name),
			).sort(),
		);
	});

	it.each(NEVER_OFFERED)("never offers %s", async (name) => {
		const platform = await loadFabricPlatformTools(ACTOR, PORTAL_TURN);

		expect(platform?.tools).not.toHaveProperty(name);
		expect(isFabricPortalTool(name)).toBe(false);
	});

	it("is 38 tools, every platform tool of the gateway but the three that manage delegated authority and the memory tools", () => {
		expect(FABRIC_PORTAL_TOOL_NAMES).toHaveLength(38);
		for (const name of FABRIC_PORTAL_EXCLUDED_TOOL_NAMES) {
			expect(FABRIC_PORTAL_TOOL_NAMES).not.toContain(name);
		}
	});

	it("keeps the two create tools, which the gateway files from the words given", () => {
		expect(FABRIC_PORTAL_TOOL_NAMES).toContain("fabric_create_feature");
		expect(FABRIC_PORTAL_TOOL_NAMES).toContain("fabric_create_bug");
	});

	it("covers identity, organizations, projects, features, tasks, documents, contexts, instructions, knowledge search, workspaces, chats and connected servers", () => {
		expect(FABRIC_PORTAL_TOOL_NAMES).toEqual(
			expect.arrayContaining([
				"fabric_get_identity",
				"fabric_list_organizations",
				"fabric_switch_organization",
				"fabric_list_projects",
				"fabric_create_project",
				"fabric_list_chats",
				"fabric_list_connected_servers",
				"fabric_list_features",
				"fabric_get_feature",
				"fabric_update_feature_status",
				"fabric_create_feature_task",
				"fabric_update_task",
				"fabric_complete_task",
				"fabric_list_documents",
				"fabric_get_document",
				"fabric_create_document",
				"fabric_update_document",
				"fabric_list_project_contexts",
				"fabric_update_project_context",
				"fabric_list_project_instructions",
				"fabric_propose_project_instruction_change",
				"fabric_add_instruction_lesson",
				"fabric_search_project_knowledge",
				"fabric_list_workspaces",
				"fabric_get_workspace",
				"fabric_query_workspace",
			]),
		);
	});
});

describe("when the portal schemas ride on a turn", () => {
	it("carries only the six base project reads for a turn that does not ask for portal tools", async () => {
		const platform = await loadFabricPlatformTools(
			ACTOR,
			PORTAL_TURN_WITHOUT_SCHEMAS,
		);

		expect(
			Object.keys(platform?.tools ?? {}).filter(isFabricPortalTool),
		).toEqual(
			FABRIC_CHAT_TOOL_DEFINITIONS.map((tool) => tool.name).filter(
				isFabricPortalTool,
			),
		);
		expect(Object.keys(platform?.tools ?? {}).sort()).toEqual(
			FABRIC_CHAT_TOOL_DEFINITIONS.filter(
				(tool) =>
					!FABRIC_PORTAL_EXCLUDED_TOOL_NAMES.includes(tool.name),
			)
				.map((tool) => tool.name)
				.sort(),
		);
	});

	it.each([
		"fabric_get_project_pm_connection",
		"fabric_list_project_pm_members",
		"fabric_get_project_work_item_counts",
		"fabric_list_project_pm_assigned_items",
		"fabric_get_project_pm_item_snapshots",
	])(
		"refuses %s when the portal turn omits portal schemas too",
		async (name) => {
			const platform = await loadFabricPlatformTools(
				ACTOR,
				PORTAL_TURN_WITHOUT_SCHEMAS,
			);
			expect(platform?.tools).not.toHaveProperty(name);
			await expect(platform?.callAuthorized(name, {})).resolves.toEqual({
				error: `${name} is not available`,
			});
			expect(mocks.callTool).not.toHaveBeenCalled();
		},
	);

	it("carries them for a turn that asks, in that same turn", async () => {
		const platform = await loadFabricPlatformTools(ACTOR, PORTAL_TURN);

		expect(
			Object.keys(platform?.tools ?? {}).filter(isFabricPortalTool),
		).toHaveLength(FABRIC_PORTAL_TOOL_NAMES.length);
	});

	it("gives an ordinary chat only the six selected portal reads", async () => {
		const platform = await loadFabricPlatformTools(ACTOR);

		expect(
			Object.keys(platform?.tools ?? {}).filter(isFabricPortalTool),
		).toEqual(
			FABRIC_CHAT_TOOL_DEFINITIONS.map((tool) => tool.name).filter(
				isFabricPortalTool,
			),
		);
	});

	it("keeps a chat turn's listing apart from a meeting's, whichever is fetched first", async () => {
		mocks.listTools.mockResolvedValueOnce({ tools: BASE_LISTING });
		await loadFabricPlatformTools(ACTOR);

		const meeting = await loadFabricPlatformTools(ACTOR, PORTAL_TURN);

		expect(mocks.listTools).toHaveBeenCalledTimes(2);
		expect(
			Object.keys(meeting?.tools ?? {}).filter(isFabricPortalTool),
		).toHaveLength(FABRIC_PORTAL_TOOL_NAMES.length);
	});

	it("measures the weight a turn does not carry", async () => {
		const without = await loadFabricPlatformTools(
			ACTOR,
			PORTAL_TURN_WITHOUT_SCHEMAS,
		);
		const withPortal = await loadFabricPlatformTools(ACTOR, PORTAL_TURN);
		const size = (tools: Record<string, unknown> | undefined) =>
			JSON.stringify(
				Object.entries(tools ?? {}).map(([name, tool]) => [
					name,
					(tool as { description?: string }).description,
					(tool as { inputSchema?: { jsonSchema?: unknown } })
						.inputSchema?.jsonSchema,
				]),
			).length;

		expect(size(withPortal?.tools)).toBeGreaterThan(size(without?.tools));
		expect(Object.keys(without?.tools ?? {})).not.toContain(
			"fabric_get_feature",
		);
	});
});

describe("telling a read from a change", () => {
	it("takes it from the gateway's readOnlyHint, and reads a tool that does not say as a change", async () => {
		const platform = await loadFabricPlatformTools(ACTOR, PORTAL_TURN);

		expect(platform?.access).toMatchObject({
			fabric_list_features: "READ",
			fabric_get_feature: "READ",
			fabric_search_project_knowledge: "READ",
			fabric_instruction_checks: "READ",
			fabric_query_workspace: "READ",
			fabric_get_identity: "READ",
			fabric_list_organizations: "READ",
			fabric_list_projects: "READ",
			fabric_list_chats: "READ",
			fabric_list_connected_servers: "READ",
			fabric_switch_organization: "WRITE",
			fabric_create_project: "WRITE",
			fabric_update_project: "WRITE",
			fabric_create_feature: "WRITE",
			fabric_create_bug: "WRITE",
			fabric_update_feature_status: "WRITE",
			fabric_create_document: "WRITE",
			fabric_add_instruction_lesson: "WRITE",
			fabric_create_feature_task: "WRITE",
		});
	});
});

describe("needsFabricPortalTools", () => {
	it.each([
		"what's the status of F-12?",
		"what are we working on this sprint",
		"create a test work item called demo",
		"who owns the roadmap",
		"summarise the last meeting",
		"how many open bugs are there",
		"file a bug for the login crash",
		"create a feature for dark mode",
	])("does not ask for the portal tools: %s", (message) => {
		expect(needsFabricPortalTools(message)).toBe(false);
	});

	it.each([
		"move F-12 to in review",
		"mark the task done",
		"set the status of F-14 to blocked",
		"add a task to F-9 to write the migration",
		"update the spec document",
		"create a document for the launch plan",
		"change the priority of that feature",
		"search the project knowledge for rate limits",
		"what does the library say about retries",
		"add a lesson about the flaky test",
		"propose an instruction change for the linter",
		"update the project context",
		"which projects do we have",
		"create a new project for the pilot",
		"which organizations am I in",
		"show me my recent chats",
		"which connected servers are there",
	])("asks for the portal tools: %s", (message) => {
		expect(needsFabricPortalTools(message)).toBe(true);
	});

	it("also counts the speaker's previous request, so a follow-up still gets them", () => {
		expect(needsFabricPortalTools("yes do it", "mark the task done")).toBe(
			true,
		);
		expect(needsFabricPortalTools("yes do it", "what is the plan")).toBe(
			false,
		);
	});
});

describe("foreignProjectId", () => {
	it("finds a project named anywhere in the arguments, nested ones included", () => {
		expect(foreignProjectId({ projectId: "other" }, "mine")).toBe("other");
		expect(
			foreignProjectId(
				{ preset: { name: "x", projectId: "other" } },
				"mine",
			),
		).toBe("other");
		expect(
			foreignProjectId(
				{ items: [{ nested: { projectId: "other" } }] },
				"mine",
			),
		).toBe("other");
	});

	it("passes arguments that name only the meeting's project, or none", () => {
		expect(
			foreignProjectId(
				{ projectId: "mine", preset: { projectId: "mine" } },
				"mine",
			),
		).toBeNull();
		expect(foreignProjectId({ featureId: "f" }, "mine")).toBeNull();
		expect(foreignProjectId({ projectId: "" }, "mine")).toBeNull();
		expect(foreignProjectId(undefined, "mine")).toBeNull();
	});
});
