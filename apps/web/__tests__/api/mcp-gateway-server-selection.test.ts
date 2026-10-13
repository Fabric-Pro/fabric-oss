/**
 * `?servers=` on `/api/mcp-gateway` — a client chooses which of the gateway's
 * servers it sees: `fabric` for the platform tools, a connected server by the
 * prefix its tools carry.
 *
 * The selection is read when the session is created and kept on it, so the
 * session store is the real one. The aggregator is real too, because what is
 * pinned is that its shared per-user cache only ever holds the full list and
 * that a deselected server's upstream is never contacted; only the connection
 * records, the upstream client and the platform tools themselves are stubbed.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatServerSelection } from "../../modules/saas/mcp/lib/gateway/server-selection";

const verifyUserApiKey = vi.fn();
vi.mock("@repo/api/modules/users/procedures/api-keys", () => ({
	verifyUserApiKey: (rawKey: string) => verifyUserApiKey(rawKey),
}));

vi.mock("@repo/auth", () => ({
	auth: { api: { getSession: vi.fn().mockResolvedValue(null) } },
}));

vi.mock("@repo/utils", async (importOriginal) => ({
	...(await importOriginal<typeof import("@repo/utils")>()),
	getBaseUrl: () => "https://app.example.com",
}));

const PLATFORM_TOOLS = [
	{
		name: "fabric_get_identity",
		description: "Identity",
		inputSchema: { type: "object", properties: {} },
		_gateway_source: "platform",
	},
	{
		name: "fabric_list_projects",
		description: "Projects",
		inputSchema: { type: "object", properties: {} },
		_gateway_source: "platform",
	},
];

const executePlatformTool = vi.fn();
vi.mock("../../modules/saas/mcp/lib/gateway/platform-tools", () => ({
	PLATFORM_TOOL_DEFINITIONS: PLATFORM_TOOLS,
	executePlatformTool: (...args: unknown[]) => executePlatformTool(...args),
	platformToolScope: () => ({ scope: "mcp:read", kind: "read" }),
}));

vi.mock("@saas/mcp/lib/gateway", async () => {
	const store = await import(
		"../../modules/saas/mcp/lib/gateway/session-store"
	);
	const aggregator = await import(
		"../../modules/saas/mcp/lib/gateway/tool-aggregator"
	);
	return {
		createGatewaySession: store.createGatewaySession,
		getGatewaySession: store.getGatewaySession,
		deleteGatewaySession: store.deleteGatewaySession,
		updateSessionOrganization: store.updateSessionOrganization,
		executePlatformTool: (...args: unknown[]) =>
			executePlatformTool(...args),
		executeConnectedServerTool: aggregator.executeConnectedServerTool,
		getAggregatedTools: aggregator.getAggregatedTools,
		validateServerSelection: aggregator.validateServerSelection,
	};
});

const enforceAuthority = vi.fn();
vi.mock("@saas/mcp/lib/gateway/authority-service", () => ({
	classifyConnectedToolAccess: vi.fn().mockReturnValue("READ"),
	enforceAuthority: (...args: unknown[]) => enforceAuthority(...args),
	generateRequestFingerprint: vi.fn().mockResolvedValue("fingerprint"),
	resolveProviderKeyFromToolPrefix: vi.fn().mockReturnValue(undefined),
}));

vi.mock("@saas/mcp/lib/record-cli-reach", () => ({
	recordCliReach: vi.fn(),
	toOAuthClientIdentity: (id: string) => ({ kind: "OAUTH_CLIENT", id }),
	toOrganizationKeyIdentity: (id: string) => ({
		kind: "ORGANIZATION_API_KEY",
		id,
	}),
	toUserKeyIdentity: (id: string) => ({ kind: "USER_API_KEY", id }),
}));

/** The upstream MCP client. A deselected server's must never be asked for. */
const getCachedMcpClientForConfig = vi.fn();
vi.mock("@repo/mcp", () => ({
	getCachedMcpClientForConfig: (...args: unknown[]) =>
		getCachedMcpClientForConfig(...args),
	invalidateMcpClientCache: vi.fn().mockResolvedValue(undefined),
}));

const listMcpConfigsForTenant = vi.fn();
const resolveUserOrganization = vi.fn();
const resolveOAuthProjectGrantTarget = vi.fn();
vi.mock("@repo/database", () => ({
	isOrganizationLive: vi.fn().mockResolvedValue(true),
	verifyOAuthAccessToken: vi.fn(),
	resolveOAuthProjectGrantTarget: (...args: unknown[]) =>
		resolveOAuthProjectGrantTarget(...args),
	db: {
		user: {
			findUnique: vi.fn().mockResolvedValue({
				name: "Test User",
				email: "dev@example.com",
				role: "user",
			}),
		},
	},
	getOrganizationApiKeyByPrefix: vi.fn().mockResolvedValue(null),
	updateOrganizationApiKeyUsage: vi.fn(),
	isOrganizationMember: vi.fn().mockResolvedValue(true),
	resolveUserOrganization: (userId: string) =>
		resolveUserOrganization(userId),
	listMcpConfigsForTenant: (...args: unknown[]) =>
		listMcpConfigsForTenant(...args),
	// The routing query returns the same rows as the full one, without
	// counting as a call to it.
	listMcpConfigRoutingForTenant: (...args: unknown[]) =>
		listMcpConfigsForTenant.getMockImplementation()?.(...args),
	updateMcpConfigToolCache: vi.fn().mockResolvedValue(undefined),
	getActiveAuthoritySessionForRun: vi.fn().mockResolvedValue(null),
	consumeRequestGrant: vi.fn().mockResolvedValue(undefined),
}));

const ORIGIN = "https://app.example.com";
const ALPHA = "org-example-alpha";
const BETA = "org-example-beta";
const PERSONAL_KEY = "Bearer fab_personal_key";
const PROJECT_ONE = "project-example-one";

/** A connection record as `listMcpConfigsForTenant` returns it. */
function config(
	id: string,
	displayName: string,
	toolNames: string[],
	overrides: Record<string, unknown> = {},
) {
	return {
		id,
		enabled: true,
		displayName,
		mcpServer: { name: displayName },
		cachedTools: toolNames.map((name) => ({ name, description: name })),
		toolsCachedAt: new Date(),
		...overrides,
	};
}

/**
 * Alpha has GitHub, a second GitHub (prefix `github_2`), Linear, and Fizzy with
 * three tools, for selecting single tools.
 */
const ALPHA_CONFIGS = [
	config("config-github", "GitHub", ["list_repos"]),
	config("config-github-two", "GitHub", ["list_repos"]),
	config("config-linear", "Linear", ["list_issues"]),
	config("config-fizzy", "Fizzy", [
		"fizzy_get_cards",
		"fizzy_create_card",
		"fizzy_delete_card",
	]),
];
/** Beta has only Linear. */
const BETA_CONFIGS = [config("config-linear-beta", "Linear", ["list_issues"])];

const ALL_TOOL_NAMES = [
	"fabric_get_identity",
	"fabric_list_projects",
	"github__list_repos",
	"github_2__list_repos",
	"linear__list_issues",
	"fizzy__fizzy_get_cards",
	"fizzy__fizzy_create_card",
	"fizzy__fizzy_delete_card",
].sort();

let userCounter = 0;
let userId = "";
let organizationFor: Record<string, string> = {};

const initializeBody = {
	jsonrpc: "2.0",
	id: 1,
	method: "initialize",
	params: {
		protocolVersion: "2025-03-26",
		capabilities: {},
		clientInfo: { name: "example-client", version: "1.0.0" },
	},
};

function rpc(method: string, params?: Record<string, unknown>) {
	return { jsonrpc: "2.0", id: 2, method, params };
}

function headers(sessionId?: string | null): Record<string, string> {
	return {
		host: "localhost:3001",
		"content-type": "application/json",
		accept: "application/json",
		authorization: PERSONAL_KEY,
		...(sessionId ? { "mcp-session-id": sessionId } : {}),
	};
}

async function post(query: string, body: unknown, sessionId?: string | null) {
	const { POST } = await import("../../app/api/mcp-gateway/route");
	const response = await POST(
		new Request(`${ORIGIN}/api/mcp-gateway${query}`, {
			method: "POST",
			headers: headers(sessionId),
			body: JSON.stringify(body),
		}) as never,
	);
	return {
		response,
		sessionId: response.headers.get("mcp-session-id"),
		payload: (await response.json()) as {
			result?: Record<string, unknown>;
			error?: { code: number; message: string };
		},
	};
}

async function postProject(query: string, body: unknown) {
	const { POST } = await import(
		"../../app/api/mcp-gateway/projects/[projectId]/route"
	);
	const response = await POST(
		new Request(
			`${ORIGIN}/api/mcp-gateway/projects/${PROJECT_ONE}${query}`,
			{
				method: "POST",
				headers: headers(),
				body: JSON.stringify(body),
			},
		) as never,
		{ params: Promise.resolve({ projectId: PROJECT_ONE }) },
	);
	return {
		response,
		sessionId: response.headers.get("mcp-session-id"),
		payload: (await response.json()) as {
			result?: Record<string, unknown>;
			error?: { code: number; message: string };
		},
	};
}

/** Open a session at `query` and return its id. */
async function open(query: string): Promise<string> {
	const { sessionId, payload } = await post(query, initializeBody);
	expect(payload.error).toBeUndefined();
	expect(sessionId).toBeTruthy();
	return sessionId as string;
}

async function listedToolNames(
	sessionId: string,
	query = "",
): Promise<string[]> {
	const { payload } = await post(query, rpc("tools/list"), sessionId);
	expect(payload.error).toBeUndefined();
	return (payload.result?.tools as Array<{ name: string }>)
		.map((tool) => tool.name)
		.sort();
}

async function call(sessionId: string, name: string) {
	const { payload } = await post(
		"",
		rpc("tools/call", { name, arguments: {} }),
		sessionId,
	);
	return payload.result as {
		isError?: boolean;
		content: Array<{ text: string }>;
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	// A fresh person per test, so the aggregator's per-user cache, which lives
	// for the whole file, never carries one test's list into the next.
	userCounter += 1;
	userId = `user-selection-${userCounter}`;
	organizationFor = { [userId]: ALPHA };
	verifyUserApiKey.mockImplementation(async () => ({
		valid: true,
		userId,
		scopes: ["*"],
	}));
	resolveUserOrganization.mockImplementation(async (id: string) => ({
		kind: "resolved",
		organizationId: organizationFor[id],
	}));
	resolveOAuthProjectGrantTarget.mockImplementation(
		async (_userId: string, projectId: string) => ({
			projectId,
			projectName: "Example project",
			organizationId: ALPHA,
			organizationName: "Example Alpha",
		}),
	);
	listMcpConfigsForTenant.mockImplementation(
		async ({ organizationId }: { organizationId: string }) =>
			organizationId === BETA ? BETA_CONFIGS : ALPHA_CONFIGS,
	);
	enforceAuthority.mockResolvedValue({ authorized: true });
	executePlatformTool.mockResolvedValue({
		content: [{ type: "text", text: "ok" }],
	});
	getCachedMcpClientForConfig.mockResolvedValue({
		client: {
			tools: async () => ({
				list_repos: { execute: async () => ({ content: [] }) },
				list_issues: { execute: async () => ({ content: [] }) },
			}),
		},
	});
});

describe("tools/list under a server selection", () => {
	it("offers every tool when the parameter is absent", async () => {
		const sessionId = await open("");
		expect(await listedToolNames(sessionId)).toEqual(ALL_TOOL_NAMES);
	});

	it("offers only the platform tools for servers=fabric", async () => {
		const sessionId = await open("?servers=fabric");
		expect(await listedToolNames(sessionId)).toEqual([
			"fabric_get_identity",
			"fabric_list_projects",
		]);
	});

	it("offers only the named connected server, including a deduplicated prefix", async () => {
		const sessionId = await open("?servers=github_2");
		expect(await listedToolNames(sessionId)).toEqual([
			"github_2__list_repos",
		]);
	});

	it("offers the platform tools and the named servers together", async () => {
		const sessionId = await open("?servers=fabric,linear");
		expect(await listedToolNames(sessionId)).toEqual([
			"fabric_get_identity",
			"fabric_list_projects",
			"linear__list_issues",
		]);
	});

	it("trims, lowercases and collapses duplicate names", async () => {
		const sessionId = await open(
			`?servers=${encodeURIComponent(" Fabric ,LINEAR,fabric")}`,
		);
		expect((await storedSelection(sessionId))?.slice()).toEqual([
			"fabric",
			"linear",
		]);
		expect(await listedToolNames(sessionId)).toEqual([
			"fabric_get_identity",
			"fabric_list_projects",
			"linear__list_issues",
		]);
	});

	it("accepts the name of a server whose tools cannot be discovered right now", async () => {
		listMcpConfigsForTenant.mockResolvedValue([
			...ALPHA_CONFIGS,
			config("config-down", "Notion", [], {
				cachedTools: null,
				toolsCachedAt: null,
			}),
		]);
		getCachedMcpClientForConfig.mockRejectedValue(new Error("unreachable"));

		const sessionId = await open("?servers=fabric,notion");
		expect(await listedToolNames(sessionId)).toEqual([
			"fabric_get_identity",
			"fabric_list_projects",
		]);
	});
});

async function storedSelection(sessionId: string) {
	const store = await import(
		"../../modules/saas/mcp/lib/gateway/session-store"
	);
	const selection = store.getGatewaySession(sessionId)?.serverSelection;
	// As it would be written in the parameter, one entry per element.
	return selection ? formatServerSelection(selection).split(",") : selection;
}

describe("a selection that cannot be honoured", () => {
	it.each([
		["an unknown name", "?servers=fabric,jira", ["jira", "github_2"]],
		["several unknown names", "?servers=jira,slack", ["jira, slack"]],
		["an empty value", "?servers=", ["no server name"]],
		["an empty entry", "?servers=fabric,,linear", ["no server name"]],
	])(
		"fails initialize for %s, naming the problem, and opens no session",
		async (_label, query, expected) => {
			const { response, sessionId, payload } = await post(
				query,
				initializeBody,
			);

			expect(response.status).toBe(200);
			expect(payload.result).toBeUndefined();
			expect(payload.error?.code).toBe(-32602);
			for (const text of expected) {
				expect(payload.error?.message).toContain(text);
			}
			expect(sessionId).toBeNull();
		},
	);

	it("lists the valid names when it refuses an unknown one", async () => {
		const { payload } = await post("?servers=jira", initializeBody);
		expect(payload.error?.message).toContain(
			"Valid names for this connection: fabric, github, github_2, linear, fizzy.",
		);
	});

	it("refuses an unknown name on a request that creates a session without initialize", async () => {
		const { sessionId, payload } = await post(
			"?servers=jira",
			rpc("tools/list"),
		);
		expect(payload.error?.code).toBe(-32602);
		expect(sessionId).toBeNull();
	});
});

describe("a session created without initialize", () => {
	it("takes its selection from the request that created it", async () => {
		const { sessionId, payload } = await post(
			"?servers=fabric",
			rpc("tools/list"),
		);
		expect(
			(payload.result?.tools as Array<{ name: string }>).map(
				(t) => t.name,
			),
		).toEqual(["fabric_get_identity", "fabric_list_projects"]);
		expect(await storedSelection(sessionId as string)).toEqual(["fabric"]);
	});
});

describe("calls outside the selection", () => {
	it("refuses a platform tool when fabric is not selected, without running it", async () => {
		const sessionId = await open("?servers=linear");

		const result = await call(sessionId, "fabric_list_projects");

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain(
			"fabric_list_projects is not available on this connection",
		);
		expect(executePlatformTool).not.toHaveBeenCalled();
	});

	it("refuses a deselected connected server's tool by its exact name, before authority or its upstream", async () => {
		const sessionId = await open("?servers=fabric");

		const result = await call(sessionId, "linear__list_issues");

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain(
			"linear__list_issues is not available on this connection",
		);
		expect(enforceAuthority).not.toHaveBeenCalled();
		expect(getCachedMcpClientForConfig).not.toHaveBeenCalled();
	});

	it("refuses a deduplicated sibling of a selected server", async () => {
		const sessionId = await open("?servers=github");

		const result = await call(sessionId, "github_2__list_repos");

		expect(result.isError).toBe(true);
		expect(getCachedMcpClientForConfig).not.toHaveBeenCalled();
	});

	it("runs a selected connected server's tool (the control for the refusals above)", async () => {
		const sessionId = await open("?servers=linear");

		const result = await call(sessionId, "linear__list_issues");

		expect(result.isError).toBeUndefined();
		expect(getCachedMcpClientForConfig).toHaveBeenCalledWith(
			expect.objectContaining({ configId: "config-linear" }),
		);
	});

	it("runs a selected platform tool", async () => {
		const sessionId = await open("?servers=fabric");

		const result = await call(sessionId, "fabric_list_projects");

		expect(result.isError).toBeUndefined();
		expect(executePlatformTool).toHaveBeenCalledTimes(1);
	});
});

describe("a connection whose name starts with Fabric", () => {
	/** "Fabric" would take the platform tools' name; "Fabric Docs" starts with `fabric_`. */
	const FABRIC_NAMED_CONFIGS = [
		config("config-fabric", "Fabric", ["list_items"]),
		config("config-fabric-docs", "Fabric Docs", ["list_items"]),
	];

	beforeEach(() => {
		listMcpConfigsForTenant.mockResolvedValue(FABRIC_NAMED_CONFIGS);
		getCachedMcpClientForConfig.mockResolvedValue({
			client: {
				tools: async () => ({
					list_items: { execute: async () => ({ content: [] }) },
				}),
			},
		});
	});

	it("lists them under prefixes the platform tools do not use", async () => {
		const sessionId = await open("");

		expect(await listedToolNames(sessionId)).toEqual(
			[
				"fabric_get_identity",
				"fabric_list_projects",
				"fabric_2__list_items",
				"fabric_docs__list_items",
			].sort(),
		);
	});

	it.each([
		["fabric_2__list_items", "config-fabric"],
		["fabric_docs__list_items", "config-fabric-docs"],
	])(
		"runs %s on its server, not as a platform tool",
		async (name, configId) => {
			const sessionId = await open("");

			const result = await call(sessionId, name);

			expect(result.isError).toBeUndefined();
			expect(executePlatformTool).not.toHaveBeenCalled();
			expect(getCachedMcpClientForConfig).toHaveBeenCalledWith(
				expect.objectContaining({ configId }),
			);
		},
	);

	it("keeps servers=fabric to the platform tools", async () => {
		const sessionId = await open("?servers=fabric");

		expect(await listedToolNames(sessionId)).toEqual([
			"fabric_get_identity",
			"fabric_list_projects",
		]);
	});

	it("names their own servers in discovery mode's search", async () => {
		const sessionId = await open("?mode=discovery");

		const { payload } = await post(
			"",
			rpc("tools/call", {
				name: "search_tools",
				arguments: { query: "list_items" },
			}),
			sessionId,
		);
		const result = payload.result as { content: Array<{ text: string }> };
		const found = JSON.parse(result.content[0].text) as {
			tools: Array<{ name: string; server: string }>;
		};

		expect(
			found.tools.map(({ name, server }) => ({ name, server })),
		).toEqual(
			expect.arrayContaining([
				{ name: "fabric_2__list_items", server: "fabric_2" },
				{ name: "fabric_docs__list_items", server: "fabric_docs" },
			]),
		);
		expect(found.tools).toHaveLength(2);
	});

	it("selects the connection named Fabric by its own prefix", async () => {
		const sessionId = await open("?servers=fabric_2");

		expect(await listedToolNames(sessionId)).toEqual([
			"fabric_2__list_items",
		]);
		expect(
			(await call(sessionId, "fabric_2__list_items")).isError,
		).toBeUndefined();
		expect((await call(sessionId, "fabric_list_projects")).isError).toBe(
			true,
		);
	});
});

describe("the shared tool cache", () => {
	it("serves the full list to a client without a selection after one with servers=fabric filled it", async () => {
		const narrow = await open("?servers=fabric");
		expect(await listedToolNames(narrow)).toHaveLength(2);

		const wide = await open("");
		expect(await listedToolNames(wide)).toEqual(ALL_TOOL_NAMES);
		// The cache was filled once, by the first client, and reused.
		expect(
			listMcpConfigsForTenant.mock.calls.length,
			"initialize validates against the routing rows; only the first tools/list reads the full records, to fill the cache",
		).toBe(1);
	});

	it("serves the narrowed list to a servers=fabric client after one without a selection filled it", async () => {
		const wide = await open("");
		expect(await listedToolNames(wide)).toEqual(ALL_TOOL_NAMES);

		const narrow = await open("?servers=fabric");
		expect(await listedToolNames(narrow)).toEqual([
			"fabric_get_identity",
			"fabric_list_projects",
		]);
		expect(await listedToolNames(wide)).toEqual(ALL_TOOL_NAMES);
	});
});

describe("the selection belongs to the session", () => {
	it("is stored at initialize and not moved by a later request's own parameter", async () => {
		const sessionId = await open("?servers=fabric");
		expect(await storedSelection(sessionId)).toEqual(["fabric"]);

		expect(await listedToolNames(sessionId, "")).toEqual([
			"fabric_get_identity",
			"fabric_list_projects",
		]);
		expect(await listedToolNames(sessionId, "?servers=linear")).toEqual([
			"fabric_get_identity",
			"fabric_list_projects",
		]);
		// Not even an invalid one is read on a reused session.
		expect(await listedToolNames(sessionId, "?servers=jira")).toEqual([
			"fabric_get_identity",
			"fabric_list_projects",
		]);
	});

	it("survives an organization switch, and a name the new organization lacks contributes nothing", async () => {
		const sessionId = await open("?servers=fabric,github,linear");
		executePlatformTool.mockImplementationOnce(
			async (
				_name: string,
				_args: unknown,
				session: { organizationId: string },
			) => {
				session.organizationId = BETA;
				organizationFor[userId] = BETA;
				return { content: [{ type: "text", text: "switched" }] };
			},
		);

		const switched = await call(sessionId, "fabric_switch_organization");
		expect(switched.isError).toBeUndefined();

		expect(await storedSelection(sessionId)).toEqual([
			"fabric",
			"github",
			"linear",
		]);
		expect(await listedToolNames(sessionId)).toEqual([
			"fabric_get_identity",
			"fabric_list_projects",
			"linear__list_issues",
		]);
	});
});

describe("a project's URL", () => {
	it("refuses the servers parameter and opens no session", async () => {
		const { sessionId, payload } = await postProject(
			"?servers=fabric",
			initializeBody,
		);
		expect(payload.error?.code).toBe(-32602);
		expect(payload.error?.message).toContain(
			"not available on a project's URL",
		);
		expect(sessionId).toBeNull();
	});

	it("still opens a session without the parameter", async () => {
		const { sessionId, payload } = await postProject("", initializeBody);
		expect(payload.error).toBeUndefined();
		expect(sessionId).toBeTruthy();
	});
});

describe("the handshake instructions", () => {
	it("say which servers a selection kept, and that the platform tools are out", async () => {
		const { payload } = await post("?servers=linear", initializeBody);
		const instructions = payload.result?.instructions as string;
		expect(instructions).toContain("servers=linear");
		expect(instructions).toContain("are not included");
	});

	it("are unchanged without a selection", async () => {
		const { payload } = await post("", initializeBody);
		expect(payload.result?.instructions as string).not.toContain(
			"server selection",
		);
	});
});

describe("selecting single tools", () => {
	it("lists only the named tools of a server, beside whole servers", async () => {
		const sessionId = await open(
			"?servers=fabric,fizzy:fizzy_get_cards,fizzy:fizzy_create_card",
		);
		expect(await listedToolNames(sessionId)).toEqual(
			[
				"fabric_get_identity",
				"fabric_list_projects",
				"fizzy__fizzy_create_card",
				"fizzy__fizzy_get_cards",
			].sort(),
		);
	});

	it("lists only the named platform tool for fabric:<tool>", async () => {
		const sessionId = await open("?servers=fabric:fabric_list_projects");
		expect(await listedToolNames(sessionId)).toEqual([
			"fabric_list_projects",
		]);
	});

	it("reads name together with name:tool, in either order, as the whole server", async () => {
		for (const query of [
			"?servers=fizzy,fizzy:fizzy_get_cards",
			"?servers=fizzy:fizzy_get_cards,fizzy:*",
		]) {
			const sessionId = await open(query);
			expect(await storedSelection(sessionId), query).toEqual(["fizzy"]);
			expect(await listedToolNames(sessionId), query).toEqual([
				"fizzy__fizzy_create_card",
				"fizzy__fizzy_delete_card",
				"fizzy__fizzy_get_cards",
			]);
		}
	});

	it("lowercases the server part and keeps the tool part's case", async () => {
		const sessionId = await open(
			`?servers=${encodeURIComponent(" FIZZY : fizzy_get_cards ")}`,
		);
		expect(await storedSelection(sessionId)).toEqual([
			"fizzy:fizzy_get_cards",
		]);

		const { payload } = await post(
			"?servers=fizzy:FIZZY_GET_CARDS",
			initializeBody,
		);
		expect(payload.error?.message).toContain("fizzy:FIZZY_GET_CARDS");
		expect(payload.error?.message).toContain("case-sensitive");
	});

	it("refuses a deselected tool of a selected server at the endpoint, before authority or its upstream", async () => {
		const sessionId = await open("?servers=fizzy:fizzy_get_cards");

		const result = await call(sessionId, "fizzy__fizzy_delete_card");

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain(
			"fizzy__fizzy_delete_card is not available on this connection",
		);
		expect(enforceAuthority).not.toHaveBeenCalled();
		expect(getCachedMcpClientForConfig).not.toHaveBeenCalled();
	});

	it("runs the selected tool of that server (the control)", async () => {
		getCachedMcpClientForConfig.mockResolvedValue({
			client: {
				tools: async () => ({
					fizzy_get_cards: { execute: async () => ({ content: [] }) },
				}),
			},
		});
		const sessionId = await open("?servers=fizzy:fizzy_get_cards");

		const result = await call(sessionId, "fizzy__fizzy_get_cards");

		expect(result.isError).toBeUndefined();
		expect(getCachedMcpClientForConfig).toHaveBeenCalledWith(
			expect.objectContaining({ configId: "config-fizzy" }),
		);
	});

	it("refuses a deselected platform tool when fabric names other tools", async () => {
		const sessionId = await open("?servers=fabric:fabric_get_identity");

		const result = await call(sessionId, "fabric_list_projects");

		expect(result.isError).toBe(true);
		expect(executePlatformTool).not.toHaveBeenCalled();
	});

	it("fails initialize for a platform tool that does not exist", async () => {
		const { sessionId, payload } = await post(
			"?servers=fabric:fabric_no_such_tool",
			initializeBody,
		);
		expect(payload.error?.code).toBe(-32602);
		expect(payload.error?.message).toContain("fabric:fabric_no_such_tool");
		expect(payload.error?.message).toContain("fabric_list_projects");
		expect(sessionId).toBeNull();
	});

	it("fails initialize for a discovered server's unknown tool, listing its tools", async () => {
		const { sessionId, payload } = await post(
			"?servers=fizzy:fizzy_no_such_tool",
			initializeBody,
		);
		expect(payload.error?.code).toBe(-32602);
		expect(payload.error?.message).toContain("fizzy:fizzy_no_such_tool");
		expect(payload.error?.message).toContain(
			"Its tools are: fizzy_get_cards, fizzy_create_card, fizzy_delete_card.",
		);
		expect(sessionId).toBeNull();
	});

	it("accepts a tool of a server whose tools cannot be discovered right now", async () => {
		listMcpConfigsForTenant.mockResolvedValue([
			...ALPHA_CONFIGS,
			config("config-down", "Notion", [], {
				cachedTools: null,
				toolsCachedAt: null,
			}),
		]);
		getCachedMcpClientForConfig.mockRejectedValue(new Error("unreachable"));

		const sessionId = await open("?servers=fabric,notion:search");
		expect(await storedSelection(sessionId)).toEqual([
			"fabric",
			"notion:search",
		]);
	});

	it.each([
		["an empty tool part", "?servers=fizzy:", "no tool name"],
		["an empty server part", "?servers=:fizzy_get_cards", "no server name"],
	])("fails initialize for %s", async (_label, query, expected) => {
		const { sessionId, payload } = await post(query, initializeBody);
		expect(payload.error?.code).toBe(-32602);
		expect(payload.error?.message).toContain(expected);
		expect(sessionId).toBeNull();
	});
});

describe("a session replaced because the caller's organization changed", () => {
	it("narrows the replacement to the same parameter in the new organization", async () => {
		const sessionId = await open("?servers=linear");
		// The caller now resolves to Beta, so the stored session no longer
		// matches and is replaced on the next request, which sends the same URL.
		organizationFor[userId] = BETA;

		const { sessionId: replacement, payload } = await post(
			"?servers=linear",
			rpc("tools/list"),
			sessionId,
		);

		expect(payload.error).toBeUndefined();
		expect(replacement).not.toBe(sessionId);
		// Beta has Linear; without the selection the platform tools would be
		// listed too.
		expect(
			(payload.result?.tools as Array<{ name: string }>).map(
				(t) => t.name,
			),
		).toEqual(["linear__list_issues"]);
		expect(await storedSelection(replacement as string)).toEqual([
			"linear",
		]);
	});

	it("refuses a parameter naming a server the new organization lacks, on the retry too", async () => {
		const sessionId = await open("?servers=fabric,github");
		organizationFor[userId] = BETA;

		const first = await post(
			"?servers=fabric,github",
			rpc("tools/list"),
			sessionId,
		);

		expect(first.payload.result).toBeUndefined();
		expect(first.payload.error?.code).toBe(-32602);
		expect(first.payload.error?.message).toContain("github");
		expect(first.payload.error?.message).toContain(
			"Valid names for this connection: fabric, linear.",
		);
		expect(first.sessionId).toBeNull();

		// The client retries the same URL, still with the old session id. It is
		// refused again and never served an unrestricted session.
		const retry = await post(
			"?servers=fabric,github",
			rpc("tools/list"),
			sessionId,
		);
		expect(retry.payload.result).toBeUndefined();
		expect(retry.payload.error?.code).toBe(-32602);
		expect(retry.sessionId).toBeNull();
	});

	it("takes the request's parameter when the replaced session had no selection", async () => {
		const sessionId = await open("");
		organizationFor[userId] = BETA;

		const { sessionId: replacement } = await post(
			"?servers=fabric",
			rpc("tools/list"),
			sessionId,
		);

		expect(await storedSelection(replacement as string)).toEqual([
			"fabric",
		]);
	});
});
