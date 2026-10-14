/**
 * `?mode=discovery` on the MCP gateway: `tools/list` returns three meta-tools
 * (`search_tools`, `get_tool_schema`, `call_tool`) instead of every tool.
 *
 * The point of most of these tests is equivalence with a direct call, so less
 * is stubbed than in the server-selection suite. The session store, the tool
 * aggregator, the platform tool definitions and their scope table, the
 * connected-tool classifier and the request fingerprint are all real. Stubbed
 * are the connection records, the upstream MCP client, the database calls,
 * and `enforceAuthority`, which is a spy so its arguments can be compared.
 * `executePlatformTool` is a spy that calls through to the real one unless a
 * test says otherwise.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const verifyUserApiKey = vi.fn();
vi.mock("@repo/api/modules/users/procedures/api-keys", () => ({
	verifyUserApiKey: (rawKey: string) => verifyUserApiKey(rawKey),
}));

vi.mock("@repo/api/modules/v1/instruction-direct-repository", () => ({
	getDirectRepositoryState: vi
		.fn()
		.mockResolvedValue({ availability: "UPLOAD", readState: "DIRECT" }),
}));

vi.mock("@repo/auth", () => ({
	auth: { api: { getSession: vi.fn().mockResolvedValue(null) } },
}));

vi.mock("@repo/utils", async (importOriginal) => ({
	...(await importOriginal<typeof import("@repo/utils")>()),
	getBaseUrl: () => "https://app.example.com",
}));

const executePlatformTool = vi.fn();
vi.mock(
	"../../modules/saas/mcp/lib/gateway/platform-tools",
	async (importOriginal) => {
		const actual =
			await importOriginal<
				typeof import("../../modules/saas/mcp/lib/gateway/platform-tools")
			>();
		executePlatformTool.mockImplementation(actual.executePlatformTool);
		return {
			...actual,
			executePlatformTool: (...args: unknown[]) =>
				executePlatformTool(...args),
		};
	},
);

const enforceAuthority = vi.fn();
vi.mock("@saas/mcp/lib/gateway/authority-service", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../modules/saas/mcp/lib/gateway/authority-service")
	>()),
	enforceAuthority: (...args: unknown[]) => enforceAuthority(...args),
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

/** The upstream MCP client, and the one tool execution it can perform. */
const upstreamExecute = vi.fn();
const getCachedMcpClientForConfig = vi.fn();
vi.mock("@repo/mcp", () => ({
	getCachedMcpClientForConfig: (...args: unknown[]) =>
		getCachedMcpClientForConfig(...args),
	invalidateMcpClientCache: vi.fn().mockResolvedValue(undefined),
}));

const listMcpConfigsForTenant = vi.fn();
const resolveUserOrganization = vi.fn();
const resolveOAuthProjectGrantTarget = vi.fn();
const consumeRequestGrant = vi.fn();
const userUpdate = vi.fn();
const getActiveAuthoritySessionForRun = vi.fn();
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
			update: (args: unknown) => userUpdate(args),
		},
	},
	getOrganizationApiKeyByPrefix: vi.fn().mockResolvedValue(null),
	updateOrganizationApiKeyUsage: vi.fn(),
	isOrganizationMember: vi.fn().mockResolvedValue(true),
	resolveUserOrganization: (userId: string) =>
		resolveUserOrganization(userId),
	listMcpConfigsForTenant: (...args: unknown[]) =>
		listMcpConfigsForTenant(...args),
	listMcpConfigRoutingForTenant: (...args: unknown[]) =>
		listMcpConfigsForTenant.getMockImplementation()?.(...args),
	updateMcpConfigToolCache: vi.fn().mockResolvedValue(undefined),
	getActiveAuthoritySessionForRun: (...args: unknown[]) =>
		getActiveAuthoritySessionForRun(...args),
	consumeRequestGrant: (...args: unknown[]) => consumeRequestGrant(...args),
}));

const ORIGIN = "https://app.example.com";
const ALPHA = "org-example-alpha";
const BETA = "org-example-beta";
const PROJECT_ONE = "project-example-one";

function config(
	id: string,
	displayName: string,
	tools: Array<{ name: string; description: string }>,
) {
	return {
		id,
		enabled: true,
		displayName,
		mcpServer: { name: displayName },
		cachedTools: tools,
		toolsCachedAt: new Date(),
	};
}

/**
 * Alpha has a "Tracker" server with one read and one write tool, by the
 * name-pattern classification a personal key is held to.
 */
const ALPHA_CONFIGS = [
	config("config-tracker", "Tracker", [
		{ name: "list_issues", description: "List tracker issues." },
		{ name: "create_issue", description: "Create a tracker issue." },
	]),
];
/** Beta has only a "Wiki" server. */
const BETA_CONFIGS = [
	config("config-wiki", "Wiki", [
		{ name: "search_pages", description: "Search wiki pages." },
	]),
];

const META_TOOL_NAMES = ["call_tool", "get_tool_schema", "search_tools"];

let userCounter = 0;
let userId = "";
let scopes: string[] = ["*"];
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
		authorization: "Bearer fab_personal_key",
		...(sessionId ? { "mcp-session-id": sessionId } : {}),
	};
}

type Payload = {
	result?: Record<string, unknown>;
	error?: { code: number; message: string };
};

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
		sessionId: response.headers.get("mcp-session-id"),
		payload: (await response.json()) as Payload,
	};
}

async function postProject(
	query: string,
	body: unknown,
	sessionId?: string | null,
) {
	const { POST } = await import(
		"../../app/api/mcp-gateway/projects/[projectId]/route"
	);
	const response = await POST(
		new Request(
			`${ORIGIN}/api/mcp-gateway/projects/${PROJECT_ONE}${query}`,
			{
				method: "POST",
				headers: headers(sessionId),
				body: JSON.stringify(body),
			},
		) as never,
		{ params: Promise.resolve({ projectId: PROJECT_ONE }) },
	);
	return {
		sessionId: response.headers.get("mcp-session-id"),
		payload: (await response.json()) as Payload,
	};
}

async function open(query: string): Promise<string> {
	const { sessionId, payload } = await post(query, initializeBody);
	expect(payload.error).toBeUndefined();
	expect(sessionId).toBeTruthy();
	return sessionId as string;
}

async function listed(sessionId: string, query = "") {
	const { payload } = await post(query, rpc("tools/list"), sessionId);
	expect(payload.error).toBeUndefined();
	return payload.result?.tools as Array<{
		name: string;
		annotations?: Record<string, unknown>;
		_meta?: Record<string, unknown>;
	}>;
}

type ToolResult = {
	isError?: boolean;
	content: Array<{ type: string; text: string }>;
	structuredContent?: unknown;
};

async function call(
	sessionId: string,
	name: string,
	args?: unknown,
	query = "",
): Promise<ToolResult> {
	const { payload } = await post(
		query,
		rpc("tools/call", {
			name,
			...(args === undefined ? {} : { arguments: args }),
		}),
		sessionId,
	);
	expect(payload.error).toBeUndefined();
	return payload.result as ToolResult;
}

function json(result: ToolResult): Record<string, unknown> {
	return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

type SearchResult = {
	total: number;
	tools: Array<{
		name: string;
		summary: string;
		server: string;
		annotations: Record<string, unknown>;
		requiresAuthority: boolean;
	}>;
};

async function search(
	sessionId: string,
	query: string,
	limit?: number,
): Promise<SearchResult> {
	const result = await call(sessionId, "search_tools", {
		query,
		...(limit === undefined ? {} : { limit }),
	});
	expect(result.isError).toBeUndefined();
	return json(result) as SearchResult;
}

async function storedSession(sessionId: string) {
	const store = await import(
		"../../modules/saas/mcp/lib/gateway/session-store"
	);
	return store.getGatewaySession(sessionId);
}

beforeEach(() => {
	vi.clearAllMocks();
	// A fresh person per test, so the aggregator's per-user cache never carries
	// one test's list into the next.
	userCounter += 1;
	userId = `user-discovery-${userCounter}`;
	scopes = ["*"];
	organizationFor = { [userId]: ALPHA };
	verifyUserApiKey.mockImplementation(async () => ({
		valid: true,
		userId,
		scopes,
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
	// The resolver answers the last organization switched to, as
	// `User.lastActiveOrganizationId` does.
	userUpdate.mockImplementation(
		async (args: { data: { lastActiveOrganizationId: string } }) => {
			organizationFor[userId] = args.data.lastActiveOrganizationId;
			return {};
		},
	);
	enforceAuthority.mockResolvedValue({ authorized: true });
	getActiveAuthoritySessionForRun.mockResolvedValue(null);
	consumeRequestGrant.mockResolvedValue(undefined);
	upstreamExecute.mockResolvedValue({
		content: [{ type: "text", text: "upstream ran" }],
	});
	getCachedMcpClientForConfig.mockResolvedValue({
		client: {
			tools: async () => ({
				list_issues: { execute: upstreamExecute },
				create_issue: { execute: upstreamExecute },
				search_pages: { execute: upstreamExecute },
			}),
		},
	});
});

describe("tools/list", () => {
	it("is unchanged without the parameter: every tool, with authority metadata on connected tools", async () => {
		const sessionId = await open("");
		const tools = await listed(sessionId);
		const names = tools.map((tool) => tool.name);

		expect(names).toContain("fabric_list_projects");
		expect(names).toContain("tracker__create_issue");
		for (const meta of META_TOOL_NAMES) {
			expect(names).not.toContain(meta);
		}
		expect(
			tools.find((tool) => tool.name === "tracker__create_issue")?._meta,
		).toEqual({
			requiresAuthority: true,
			providerAuthorityStatus: "missing",
			providerKey: "custom:tracker",
		});
		expect((await storedSession(sessionId))?.toolListMode).toBe("full");
	});

	it("marks a read tool as needing no authority, as enforceAuthority treats it", async () => {
		const sessionId = await open("");
		const tools = await listed(sessionId);

		expect(
			tools.find((tool) => tool.name === "tracker__list_issues")?._meta,
		).toEqual({
			requiresAuthority: false,
			providerKey: "custom:tracker",
		});
	});

	it("reports an approved grant for the provider as provider-wide status on write tools only", async () => {
		getActiveAuthoritySessionForRun.mockResolvedValue({
			grants: [{ providerKey: "custom:tracker", status: "APPROVED" }],
		});
		const sessionId = await open("");
		const tools = await listed(sessionId);
		const metaOf = (name: string) =>
			tools.find((tool) => tool.name === name)?._meta;

		expect(metaOf("tracker__create_issue")).toEqual({
			requiresAuthority: true,
			providerAuthorityStatus: "granted",
			providerKey: "custom:tracker",
		});
		expect(metaOf("tracker__list_issues")).toEqual({
			requiresAuthority: false,
			providerKey: "custom:tracker",
		});
		for (const tool of tools) {
			expect(tool._meta?.authorityStatus).toBeUndefined();
		}
	});

	it("returns exactly the three meta-tools in discovery mode", async () => {
		const sessionId = await open("?mode=discovery");
		const tools = await listed(sessionId);

		expect(tools.map((tool) => tool.name).sort()).toEqual(META_TOOL_NAMES);
		const byName = Object.fromEntries(
			tools.map((tool) => [tool.name, tool]),
		);
		expect(byName.search_tools.annotations).toEqual({ readOnlyHint: true });
		expect(byName.get_tool_schema.annotations).toEqual({
			readOnlyHint: true,
		});
		expect(byName.call_tool.annotations).toBeUndefined();
		for (const tool of tools) {
			expect(tool._meta).toBeUndefined();
		}
	});

	it.each([["?mode=full"], ["?mode=compact"], ["?mode="]])(
		"refuses %s with -32602 naming the accepted value, and opens no session",
		async (query) => {
			const { sessionId, payload } = await post(query, initializeBody);

			expect(payload.result).toBeUndefined();
			expect(payload.error?.code).toBe(-32602);
			expect(payload.error?.message).toContain('"mode"');
			expect(payload.error?.message).toContain('"discovery"');
			expect(sessionId).toBeNull();
		},
	);

	it("works on a project's URL", async () => {
		const { sessionId, payload } = await postProject(
			"?mode=discovery",
			initializeBody,
		);
		expect(payload.error).toBeUndefined();

		const listedProject = await postProject(
			"",
			rpc("tools/list"),
			sessionId,
		);
		expect(
			(listedProject.payload.result?.tools as Array<{ name: string }>)
				.map((tool) => tool.name)
				.sort(),
		).toEqual(META_TOOL_NAMES);
	});
});

describe("the mode is fixed when the session is created", () => {
	it("keeps discovery mode for a later request without the parameter", async () => {
		const sessionId = await open("?mode=discovery");

		const tools = await listed(sessionId, "");

		expect(tools.map((tool) => tool.name).sort()).toEqual(META_TOOL_NAMES);
		expect((await storedSession(sessionId))?.toolListMode).toBe(
			"discovery",
		);
	});

	it("keeps full mode for a later request that asks for discovery", async () => {
		const sessionId = await open("");

		const { sessionId: answeredIn, payload } = await post(
			"?mode=discovery",
			rpc("tools/list"),
			sessionId,
		);

		expect(answeredIn).toBe(sessionId);
		const names = (payload.result?.tools as Array<{ name: string }>).map(
			(tool) => tool.name,
		);
		expect(names).toContain("fabric_list_projects");
		expect(names).not.toContain("search_tools");
	});

	it("ignores a malformed parameter on a reused session, as for servers", async () => {
		const sessionId = await open("?mode=discovery");

		const { sessionId: answeredIn, payload } = await post(
			"?mode=compact",
			rpc("tools/list"),
			sessionId,
		);

		expect(payload.error).toBeUndefined();
		expect(answeredIn).toBe(sessionId);
	});
});

describe("search_tools and get_tool_schema offer only what a direct call would not refuse for scope", () => {
	it("hides write tools, platform and connected, from an mcp:read key, in results, counts and schemas", async () => {
		scopes = ["mcp:read"];
		const sessionId = await open("?mode=discovery");

		const platform = await search(sessionId, "fabric_update_project");
		expect(platform.total).toBe(0);
		expect(platform.tools).toEqual([]);

		const connected = await search(sessionId, "tracker");
		expect(connected.total).toBe(1);
		expect(connected.tools.map((tool) => tool.name)).toEqual([
			"tracker__list_issues",
		]);

		const reads = await search(sessionId, "fabric_list_projects");
		expect(reads.tools.map((tool) => tool.name)).toEqual([
			"fabric_list_projects",
		]);

		const unknown = await call(sessionId, "get_tool_schema", {
			name: "nothing__here",
		});
		for (const forbidden of [
			"fabric_update_project",
			"tracker__create_issue",
		]) {
			const result = await call(sessionId, "get_tool_schema", {
				name: forbidden,
			});
			expect(result.isError).toBe(true);
			// The same answer as for a tool that does not exist, apart from
			// the name it repeats.
			expect(result.content[0].text).toBe(
				unknown.content[0].text.replace("nothing__here", forbidden),
			);
		}
	});

	it("reads a platform tool's own scope: a projects:read key sees project reads and nothing else", async () => {
		scopes = ["projects:read"];
		const sessionId = await open("?mode=discovery");

		expect(
			(await search(sessionId, "fabric_list_projects")).tools.map(
				(tool) => tool.name,
			),
		).toEqual(["fabric_list_projects"]);
		// `orgs:read`, and `mcp:read` for a connected read, are not held.
		expect((await search(sessionId, "fabric_get_identity")).total).toBe(0);
		expect((await search(sessionId, "tracker")).total).toBe(0);
		expect(
			(
				await call(sessionId, "get_tool_schema", {
					name: "fabric_list_projects",
				})
			).isError,
		).toBeUndefined();
	});

	it("offers the same tools to a * key, with their schemas and authority needs", async () => {
		const sessionId = await open("?mode=discovery");

		const platform = await search(sessionId, "fabric_update_project");
		expect(platform.tools.map((tool) => tool.name).sort()).toEqual([
			"fabric_update_project",
			"fabric_update_project_context",
		]);
		expect(platform.total).toBe(2);

		const connected = await search(sessionId, "tracker");
		expect(connected.total).toBe(2);
		expect(
			Object.fromEntries(
				connected.tools.map((tool) => [
					tool.name,
					[tool.server, tool.requiresAuthority],
				]),
			),
		).toEqual({
			tracker__list_issues: ["tracker", false],
			tracker__create_issue: ["tracker", true],
		});

		const schema = await call(sessionId, "get_tool_schema", {
			name: "fabric_update_project",
		});
		expect(schema.isError).toBeUndefined();
		const body = json(schema);
		expect(body.name).toBe("fabric_update_project");
		expect(body.requiresAuthority).toBe(false);
		expect(body.inputSchema).toMatchObject({ type: "object" });
		expect(schema.structuredContent).toEqual(body);
	});

	it("returns the definition a full-mode list shows, every annotation included", async () => {
		const fullSession = await open("");
		const fromList = (await listed(fullSession)).find(
			(tool) => tool.name === "fabric_update_project_context",
		) as Record<string, unknown> | undefined;
		expect(fromList?.annotations).toEqual({ idempotentHint: true });

		const sessionId = await open("?mode=discovery");
		const body = json(
			await call(sessionId, "get_tool_schema", {
				name: "fabric_update_project_context",
			}),
		);
		expect({
			name: body.name,
			description: body.description,
			inputSchema: body.inputSchema,
			annotations: body.annotations,
		}).toEqual({
			name: fromList?.name,
			description: fromList?.description,
			inputSchema: fromList?.inputSchema,
			annotations: fromList?.annotations,
		});
	});

	it("respects the server selection", async () => {
		const sessionId = await open("?mode=discovery&servers=fabric");

		const connected = await search(sessionId, "tracker");
		expect(connected.total).toBe(0);
		const schema = await call(sessionId, "get_tool_schema", {
			name: "tracker__list_issues",
		});
		expect(schema.isError).toBe(true);
		expect(json(schema).hint).toContain("search_tools");
	});

	it("respects a project's allow-list", async () => {
		const opened = await postProject("?mode=discovery", initializeBody);
		const sessionId = opened.sessionId as string;
		const searched = await postProject(
			"",
			rpc("tools/call", {
				name: "search_tools",
				arguments: { query: "organization", limit: 25 },
			}),
			sessionId,
		);
		const names = (
			JSON.parse(
				(searched.payload.result as ToolResult).content[0].text,
			) as SearchResult
		).tools.map((tool) => tool.name);
		expect(names).not.toContain("fabric_list_organizations");
		expect(names).not.toContain("fabric_switch_organization");

		const projectSearch = await postProject(
			"",
			rpc("tools/call", {
				name: "search_tools",
				arguments: { query: "project", limit: 25 },
			}),
			sessionId,
		);
		const projectResult = JSON.parse(
			(projectSearch.payload.result as ToolResult).content[0].text,
		) as SearchResult;
		expect(projectResult.total).toBeGreaterThan(0);
		expect(projectResult.tools.map((tool) => tool.name)).toContain(
			"fabric_get_project",
		);

		const schema = await postProject(
			"",
			rpc("tools/call", {
				name: "get_tool_schema",
				arguments: { name: "fabric_list_organizations" },
			}),
			sessionId,
		);
		expect((schema.payload.result as ToolResult).isError).toBe(true);

		const allowed = await postProject(
			"",
			rpc("tools/call", {
				name: "get_tool_schema",
				arguments: { name: "fabric_get_project" },
			}),
			sessionId,
		);
		const allowedResult = allowed.payload.result as ToolResult;
		expect(allowedResult.isError).toBeUndefined();
		const inputSchema = json(allowedResult).inputSchema as {
			properties: Record<string, unknown>;
			required?: string[];
		};
		// Bound to one project, projectId is optional and defaults to it.
		expect(inputSchema.properties).toHaveProperty("projectId");
		expect(inputSchema.required ?? []).not.toContain("projectId");
	});

	it("returns at most the limit, reports the total, and refuses an empty query", async () => {
		const sessionId = await open("?mode=discovery");

		const limited = await search(sessionId, "fabric", 3);
		expect(limited.tools).toHaveLength(3);
		expect(limited.total).toBeGreaterThan(3);

		const empty = await call(sessionId, "search_tools", { query: "   " });
		expect(empty.isError).toBe(true);
		expect(json(empty).error).toContain("search terms");
	});
});

describe("call_tool runs the named tool exactly as a direct call", () => {
	it("hands enforceAuthority the same arguments, and a refusal reaches neither upstream nor the grant", async () => {
		enforceAuthority.mockResolvedValue({
			authorized: false,
			reason: "No active authority",
			action: "request_authority",
		});
		const sessionId = await open("?mode=discovery");
		const args = { title: "Example", labels: ["a"] };

		const direct = await call(sessionId, "tracker__create_issue", args);
		const viaMeta = await call(sessionId, "call_tool", {
			name: "tracker__create_issue",
			arguments: args,
		});

		expect(enforceAuthority).toHaveBeenCalledTimes(2);
		const [directCall, metaCall] = enforceAuthority.mock.calls.map(
			(entry) => entry[0],
		);
		expect(metaCall).toEqual(directCall);
		const { generateRequestFingerprint } = await import(
			"../../modules/saas/mcp/lib/gateway/authority-service"
		);
		expect(metaCall).toMatchObject({
			toolName: "tracker__create_issue",
			providerKey: "custom:tracker",
			boundRunType: "MCP_GATEWAY",
			boundRunId: sessionId,
			requestFingerprint: await generateRequestFingerprint(
				"tracker__create_issue",
				args,
			),
		});
		expect(viaMeta).toEqual(direct);
		expect(viaMeta.isError).toBe(true);
		expect(upstreamExecute).not.toHaveBeenCalled();
		expect(consumeRequestGrant).not.toHaveBeenCalled();
	});

	it("consumes a one-shot REQUEST grant exactly once and sends upstream only the inner arguments", async () => {
		enforceAuthority.mockResolvedValue({
			authorized: true,
			grant: {
				id: "grant-example",
				kind: "REQUEST",
				accessLevel: "WRITE",
				expiresAt: new Date(),
				providerKey: "custom:tracker",
				sessionId: "authority-example",
			},
		});
		const sessionId = await open("?mode=discovery");

		const result = await call(sessionId, "call_tool", {
			name: "tracker__create_issue",
			arguments: { title: "Example" },
		});

		expect(result.isError).toBeUndefined();
		expect(result.content[0].text).toBe("upstream ran");
		expect(upstreamExecute).toHaveBeenCalledTimes(1);
		expect(upstreamExecute.mock.calls[0][0]).toEqual({ title: "Example" });
		expect(consumeRequestGrant).toHaveBeenCalledTimes(1);
		expect(consumeRequestGrant).toHaveBeenCalledWith("grant-example");
	});

	it("refuses a write tool for an mcp:read key before authority, upstream or grant", async () => {
		scopes = ["mcp:read"];
		const sessionId = await open("?mode=discovery");

		const direct = await call(sessionId, "tracker__create_issue", {});
		const viaMeta = await call(sessionId, "call_tool", {
			name: "tracker__create_issue",
			arguments: {},
		});

		expect(viaMeta).toEqual(direct);
		expect(json(viaMeta).error).toContain('"mcp:write" scope');
		expect(enforceAuthority).not.toHaveBeenCalled();
		expect(upstreamExecute).not.toHaveBeenCalled();
		expect(consumeRequestGrant).not.toHaveBeenCalled();
	});

	it("refuses a tool outside the server selection before authority, upstream or grant", async () => {
		const sessionId = await open("?mode=discovery&servers=fabric");

		const direct = await call(sessionId, "tracker__list_issues", {});
		const viaMeta = await call(sessionId, "call_tool", {
			name: "tracker__list_issues",
		});

		expect(viaMeta).toEqual(direct);
		expect(viaMeta.isError).toBe(true);
		// The exported dispatch, called as the endpoint calls it, answers the
		// same.
		const { dispatchToolCall } = await import(
			"../../modules/saas/mcp/lib/gateway-endpoint"
		);
		const session = await storedSession(sessionId);
		expect(
			await dispatchToolCall(
				"tracker__list_issues",
				{},
				session as NonNullable<typeof session>,
				sessionId,
			),
		).toEqual(direct);
		expect(enforceAuthority).not.toHaveBeenCalled();
		expect(upstreamExecute).not.toHaveBeenCalled();
		expect(consumeRequestGrant).not.toHaveBeenCalled();
	});

	it("runs a platform tool through executePlatformTool with its real name and arguments", async () => {
		executePlatformTool.mockResolvedValueOnce({
			content: [{ type: "text", text: "projects" }],
		});
		const sessionId = await open("?mode=discovery");

		const result = await call(sessionId, "call_tool", {
			name: "fabric_list_projects",
			arguments: { limit: 5 },
		});

		expect(result.content[0].text).toBe("projects");
		expect(executePlatformTool).toHaveBeenCalledTimes(1);
		const [name, args, session] = executePlatformTool.mock.calls[0];
		expect(name).toBe("fabric_list_projects");
		expect(args).toEqual({ limit: 5 });
		expect(session).toBe(await storedSession(sessionId));
	});

	it("refuses a platform write for an mcp:read key with the direct call's answer", async () => {
		scopes = ["mcp:read"];
		const sessionId = await open("?mode=discovery");

		const direct = await call(sessionId, "fabric_update_project", {
			projectId: "project-example-one",
		});
		const viaMeta = await call(sessionId, "call_tool", {
			name: "fabric_update_project",
			arguments: { projectId: "project-example-one" },
		});

		expect(viaMeta).toEqual(direct);
		expect(json(viaMeta).error).toContain('"projects:write" scope');
	});

	it("switches the organization, keeps discovery mode, and searches the new organization", async () => {
		const sessionId = await open("?mode=discovery");
		expect((await search(sessionId, "tracker")).total).toBe(2);

		const switched = await call(sessionId, "call_tool", {
			name: "fabric_switch_organization",
			arguments: { organizationId: BETA },
		});

		expect(switched.isError).toBeUndefined();
		const session = await storedSession(sessionId);
		expect(session?.organizationId).toBe(BETA);
		expect(session?.toolListMode).toBe("discovery");

		const tools = await listed(sessionId);
		expect(tools.map((tool) => tool.name).sort()).toEqual(META_TOOL_NAMES);
		expect((await search(sessionId, "tracker")).total).toBe(0);
		expect(
			(await search(sessionId, "wiki")).tools.map((tool) => tool.name),
		).toEqual(["wiki__search_pages"]);
	});
});

describe("call_tool refuses what it cannot dispatch", () => {
	it.each(META_TOOL_NAMES)(
		"refuses to call %s (no recursion)",
		async (name) => {
			const sessionId = await open("?mode=discovery");

			const result = await call(sessionId, "call_tool", {
				name,
				arguments: { query: "x" },
			});

			expect(result.isError).toBe(true);
			expect(executePlatformTool).not.toHaveBeenCalled();
			expect(enforceAuthority).not.toHaveBeenCalled();
		},
	);

	it.each([
		["an array", []],
		["a string", "title=x"],
		["null", null],
	])("refuses arguments that are %s", async (_label, args) => {
		const sessionId = await open("?mode=discovery");

		const result = await call(sessionId, "call_tool", {
			name: "fabric_list_projects",
			arguments: args,
		});

		expect(result.isError).toBe(true);
		expect(json(result).error).toContain('"arguments" must be an object');
		expect(executePlatformTool).not.toHaveBeenCalled();
	});

	it.each([
		["missing", {}],
		["empty", { name: " " }],
		["not a string", { name: 3 }],
	])("refuses a name that is %s", async (_label, args) => {
		const sessionId = await open("?mode=discovery");

		const result = await call(sessionId, "call_tool", args);

		expect(result.isError).toBe(true);
		expect(executePlatformTool).not.toHaveBeenCalled();
	});
});

describe("the two modes otherwise call tools the same way", () => {
	it("runs a direct call by the real name in discovery mode", async () => {
		executePlatformTool.mockResolvedValueOnce({
			content: [{ type: "text", text: "projects" }],
		});
		const sessionId = await open("?mode=discovery");

		const result = await call(sessionId, "fabric_list_projects", {});

		expect(result.content[0].text).toBe("projects");
		expect(executePlatformTool).toHaveBeenCalledWith(
			"fabric_list_projects",
			{},
			expect.anything(),
		);
	});

	it.each(META_TOOL_NAMES)(
		"answers %s as an unknown tool in full mode",
		async (name) => {
			const sessionId = await open("");

			const result = await call(sessionId, name, { query: "x" });

			expect(result.isError).toBe(true);
			expect(json(result).error).toBe(`Unknown tool: ${name}`);
		},
	);
});

describe("initialize instructions", () => {
	async function instructions(
		send: typeof post | typeof postProject,
		query: string,
	) {
		const { payload } = await send(query, initializeBody);
		return (payload.result as { instructions: string }).instructions;
	}

	it("lead with the discovery section in discovery mode, organization-wide and per project", async () => {
		const organizationWide = await instructions(post, "?mode=discovery");
		expect(organizationWide.startsWith("## Discovery mode\n")).toBe(true);
		expect(organizationWide).toContain("`search_tools`");
		expect(organizationWide).toContain("`get_tool_schema`");
		expect(organizationWide).toContain("`call_tool`");
		expect(organizationWide).toContain("`fabric_get_identity`");

		const project = await instructions(postProject, "?mode=discovery");
		expect(project.startsWith("## Discovery mode\n")).toBe(true);
		expect(project).toContain("`fabric_get_project`");
	});

	it("leave the section out in full mode", async () => {
		expect(await instructions(post, "")).not.toContain("Discovery mode");
		expect(await instructions(postProject, "")).not.toContain(
			"Discovery mode",
		);
	});
});
