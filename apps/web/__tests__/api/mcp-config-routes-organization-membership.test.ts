/**
 * The Next.js routes that run a caller's MCP config refuse someone who is no
 * longer a member of the organization — or whose role there lacks the MCP
 * permission — BEFORE the config is read or an MCP client is built or reused
 * from cache (Fizzy #2897).
 *
 * The `userId` match on the config lookup already stops one person using
 * another's config. What it never stopped is the config's own owner after
 * they were removed from the organization: the row and its stored token
 * outlive the membership. Each route below is driven with a former member and
 * must answer 403 without touching the config or a client; a member must reach
 * the same code it reached before.
 *
 * The three organization questions are mocked from a role table: a viewer
 * holds MCP_READ but not MCP_CONNECT, a member holds both. That split is pinned
 * against the live permission matrix in
 * `packages/database/__tests__/organization-permissions-mcp.test.ts`; here it
 * only decides which answer each route receives.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getSaasSession: vi.fn(),
	getAuthSession: vi.fn(),
	canReadOrganizationMcpConfigs: vi.fn(),
	canConnectOrganizationMcpConfigs: vi.fn(),
	isOrganizationMember: vi.fn(),
	getMcpConfigById: vi.fn(),
	getMcpConfigByIdInternal: vi.fn(),
	mcpConfigFindFirst: vi.fn(),
	mcpConfigFindMany: vi.fn(),
	createMcpClientForConfig: vi.fn(),
	getCachedMcpClientForConfig: vi.fn(),
	invalidateMcpClientCache: vi.fn(),
	closeMcpClient: vi.fn(),
	getDetailedMcpToolInfo: vi.fn(),
	canMcpToolsHandleTask: vi.fn(),
}));

vi.mock("@saas/auth/lib/server", () => ({
	getSession: mocks.getSaasSession,
}));
vi.mock("@repo/auth", () => ({
	auth: { api: { getSession: mocks.getAuthSession } },
}));
vi.mock("next/headers", () => ({
	headers: async () => new Headers(),
}));
vi.mock("@repo/database", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@repo/database")>();
	return {
		...actual,
		canReadOrganizationMcpConfigs: mocks.canReadOrganizationMcpConfigs,
		canConnectOrganizationMcpConfigs:
			mocks.canConnectOrganizationMcpConfigs,
		isOrganizationMember: mocks.isOrganizationMember,
		getMcpConfigById: mocks.getMcpConfigById,
		getMcpConfigByIdInternal: mocks.getMcpConfigByIdInternal,
		db: {
			...actual.db,
			mCPConfig: {
				findFirst: mocks.mcpConfigFindFirst,
				findMany: mocks.mcpConfigFindMany,
			},
		},
	};
});
vi.mock("@repo/mcp", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@repo/mcp")>();
	return {
		...actual,
		createMcpClientForConfig: mocks.createMcpClientForConfig,
		getCachedMcpClientForConfig: mocks.getCachedMcpClientForConfig,
		invalidateMcpClientCache: mocks.invalidateMcpClientCache,
		closeMcpClient: mocks.closeMcpClient,
	};
});
vi.mock("@repo/agent-core/backend", () => ({
	getDetailedMcpToolInfo: mocks.getDetailedMcpToolInfo,
	canMcpToolsHandleTask: mocks.canMcpToolsHandleTask,
}));

import { POST as suggestTools } from "@/app/api/agents/fabric-ai/suggest-tools/route";
import { POST as testConnection } from "@/app/api/mcp/test-connection/route";
import { POST as callTool } from "@/app/api/mcp-app/call-tool/route";
import { GET as defaultConfigs } from "@/app/api/mcp-app/default-configs/route";
import { POST as invoke } from "@/app/api/mcp-app/invoke/route";
import { POST as resource } from "@/app/api/mcp-app/resource/route";
import { POST as fizzyBoards } from "@/app/api/pipeline/fizzy-boards/route";
import { POST as fizzyColumns } from "@/app/api/pipeline/fizzy-columns/route";
import { POST as mcpTool } from "@/app/api/pipeline/mcp-tool/route";

const USER_ID = "user-1";
const ORG_ID = "org-1";

function post(path: string, body: unknown) {
	return new NextRequest(`http://localhost${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

function asFormerMember() {
	mocks.canReadOrganizationMcpConfigs.mockResolvedValue(false);
	mocks.canConnectOrganizationMcpConfigs.mockResolvedValue(false);
	mocks.isOrganizationMember.mockResolvedValue(false);
}

function asRole(role: "viewer" | "member") {
	mocks.canReadOrganizationMcpConfigs.mockResolvedValue(true);
	mocks.canConnectOrganizationMcpConfigs.mockResolvedValue(role === "member");
	mocks.isOrganizationMember.mockResolvedValue(true);
}

function membershipQuestionsAsked() {
	return [
		...mocks.canReadOrganizationMcpConfigs.mock.calls,
		...mocks.canConnectOrganizationMcpConfigs.mock.calls,
		...mocks.isOrganizationMember.mock.calls,
	];
}

async function expectRefused(res: Response, code: string) {
	expect(res.status).toBe(403);
	const body = (await res.json()) as { code?: string };
	expect(body.code).toBe(code);
	expect(membershipQuestionsAsked()).toContainEqual([USER_ID, ORG_ID]);
}

const NOT_A_MEMBER = "ORGANIZATION_MEMBERSHIP_REQUIRED";
const ROLE_LACKS_PERMISSION = "MCP_PERMISSION_DENIED";

/** A client whose server exposes no tools: a member's request ends in a 404. */
const emptyClient = { tools: async () => ({}) };

beforeEach(() => {
	vi.clearAllMocks();
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
	mocks.getSaasSession.mockResolvedValue({ user: { id: USER_ID } });
	mocks.getAuthSession.mockResolvedValue({
		user: { id: USER_ID },
		session: {},
	});
	mocks.getMcpConfigById.mockResolvedValue(null);
	mocks.mcpConfigFindMany.mockResolvedValue([]);
	mocks.createMcpClientForConfig.mockResolvedValue({
		client: emptyClient,
		serverUrl: "https://mcp.example.com",
	});
	mocks.getCachedMcpClientForConfig.mockResolvedValue({
		client: emptyClient,
		serverName: "Example",
	});
	mocks.invalidateMcpClientCache.mockResolvedValue(undefined);
	mocks.closeMcpClient.mockResolvedValue(undefined);
	mocks.getDetailedMcpToolInfo.mockResolvedValue([]);
});

describe("POST /api/mcp-app/call-tool", () => {
	const body = {
		configId: "cfg-1",
		toolName: "save",
		args: {},
		organizationId: ORG_ID,
	};

	it("refuses a former member before the config is read", async () => {
		asFormerMember();
		await expectRefused(
			await callTool(post("/api/mcp-app/call-tool", body)),
			NOT_A_MEMBER,
		);
		expect(mocks.getMcpConfigById).not.toHaveBeenCalled();
	});

	it("refuses a viewer, whose role cannot execute tools", async () => {
		asRole("viewer");
		await expectRefused(
			await callTool(post("/api/mcp-app/call-tool", body)),
			ROLE_LACKS_PERMISSION,
		);
		expect(mocks.getMcpConfigById).not.toHaveBeenCalled();
	});

	it("lets a member through to the config lookup", async () => {
		asRole("member");
		const res = await callTool(post("/api/mcp-app/call-tool", body));
		expect(res.status).toBe(404);
		expect(mocks.getMcpConfigById).toHaveBeenCalledWith("cfg-1", {
			userId: USER_ID,
			organizationId: ORG_ID,
		});
	});

	it("leaves the personal arm unchecked", async () => {
		const res = await callTool(
			post("/api/mcp-app/call-tool", {
				...body,
				organizationId: undefined,
			}),
		);
		expect(res.status).toBe(404);
		expect(membershipQuestionsAsked()).toEqual([]);
		expect(mocks.getMcpConfigById).toHaveBeenCalledWith("cfg-1", {
			userId: USER_ID,
			organizationId: undefined,
		});
	});
});

describe("POST /api/mcp-app/resource", () => {
	const body = {
		configId: "cfg-1",
		resourceUri: "ui://diagram",
		organizationId: ORG_ID,
	};

	it("refuses a former member before the config is read", async () => {
		asFormerMember();
		await expectRefused(
			await resource(post("/api/mcp-app/resource", body)),
			NOT_A_MEMBER,
		);
		expect(mocks.getMcpConfigById).not.toHaveBeenCalled();
	});

	it("lets a viewer read", async () => {
		asRole("viewer");
		const res = await resource(post("/api/mcp-app/resource", body));
		expect(res.status).toBe(404);
		expect(mocks.getMcpConfigById).toHaveBeenCalledWith("cfg-1", {
			userId: USER_ID,
			organizationId: ORG_ID,
		});
	});
});

describe("POST /api/mcp-app/invoke", () => {
	const body = { configId: "cfg-1", toolName: "create_view" };

	beforeEach(() => {
		mocks.mcpConfigFindFirst.mockResolvedValue({
			id: "cfg-1",
			organizationId: ORG_ID,
			mcpServer: { key: "excalidraw" },
		});
	});

	it("refuses a former member of the config's organization before a client is built", async () => {
		asFormerMember();
		await expectRefused(
			await invoke(post("/api/mcp-app/invoke", body)),
			NOT_A_MEMBER,
		);
		expect(mocks.createMcpClientForConfig).not.toHaveBeenCalled();
	});

	it("refuses a viewer before a client is built", async () => {
		asRole("viewer");
		await expectRefused(
			await invoke(post("/api/mcp-app/invoke", body)),
			ROLE_LACKS_PERMISSION,
		);
		expect(mocks.createMcpClientForConfig).not.toHaveBeenCalled();
	});

	it("lets a member through to the client", async () => {
		asRole("member");
		const res = await invoke(post("/api/mcp-app/invoke", body));
		expect(res.status).toBe(404);
		// The client factory re-checks the same action (Fizzy #2903).
		expect(mocks.createMcpClientForConfig).toHaveBeenCalledWith({
			configId: "cfg-1",
			userId: USER_ID,
			organizationId: ORG_ID,
			access: "connect",
		});
	});

	it("still answers a missing config with 404 and no membership read", async () => {
		mocks.mcpConfigFindFirst.mockResolvedValue(null);
		const res = await invoke(post("/api/mcp-app/invoke", body));
		expect(res.status).toBe(404);
		expect(membershipQuestionsAsked()).toEqual([]);
		expect(mocks.createMcpClientForConfig).not.toHaveBeenCalled();
	});
});

describe("GET /api/mcp-app/default-configs", () => {
	function get(query: string) {
		return new NextRequest(
			`http://localhost/api/mcp-app/default-configs${query}`,
		);
	}

	it("refuses a former member before listing configs", async () => {
		asFormerMember();
		await expectRefused(
			await defaultConfigs(get(`?organizationId=${ORG_ID}`)),
			NOT_A_MEMBER,
		);
		expect(mocks.mcpConfigFindMany).not.toHaveBeenCalled();
	});

	it("lists a member's configs", async () => {
		asRole("viewer");
		const res = await defaultConfigs(get(`?organizationId=${ORG_ID}`));
		expect(res.status).toBe(200);
		expect(mocks.mcpConfigFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					userId: USER_ID,
					organizationId: ORG_ID,
				}),
			}),
		);
	});

	it("leaves the personal arm unchecked", async () => {
		const res = await defaultConfigs(get(""));
		expect(res.status).toBe(200);
		expect(membershipQuestionsAsked()).toEqual([]);
		expect(mocks.mcpConfigFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ organizationId: null }),
			}),
		);
	});
});

describe("POST /api/pipeline/mcp-tool", () => {
	const base = { mcpConfigId: "cfg-1", organizationId: ORG_ID };

	it.each(["list_tools", "listResources", "readResource"])(
		"refuses a former member's %s before the client cache is consulted",
		async (action) => {
			asFormerMember();
			await expectRefused(
				await mcpTool(
					post("/api/pipeline/mcp-tool", {
						...base,
						action,
						resourceUri: "file://x",
					}),
				),
				NOT_A_MEMBER,
			);
			expect(mocks.getCachedMcpClientForConfig).not.toHaveBeenCalled();
		},
	);

	it("refuses a former member's tool execution before the client cache is consulted", async () => {
		asFormerMember();
		await expectRefused(
			await mcpTool(
				post("/api/pipeline/mcp-tool", { ...base, toolName: "x" }),
			),
			NOT_A_MEMBER,
		);
		expect(mocks.getCachedMcpClientForConfig).not.toHaveBeenCalled();
	});

	it("refuses a viewer's tool execution", async () => {
		asRole("viewer");
		await expectRefused(
			await mcpTool(
				post("/api/pipeline/mcp-tool", { ...base, toolName: "x" }),
			),
			ROLE_LACKS_PERMISSION,
		);
		expect(mocks.getCachedMcpClientForConfig).not.toHaveBeenCalled();
	});

	it("lets a viewer list tools", async () => {
		asRole("viewer");
		const res = await mcpTool(
			post("/api/pipeline/mcp-tool", { ...base, action: "list_tools" }),
		);
		expect(res.status).toBe(200);
		// The client factory re-checks the same action (Fizzy #2903).
		expect(mocks.getCachedMcpClientForConfig).toHaveBeenCalledWith(
			expect.objectContaining({
				configId: "cfg-1",
				userId: USER_ID,
				organizationId: ORG_ID,
				access: "read",
			}),
		);
	});

	it("lets a member execute a tool", async () => {
		asRole("member");
		const res = await mcpTool(
			post("/api/pipeline/mcp-tool", { ...base, toolName: "x" }),
		);
		// The empty client has no such tool.
		expect(res.status).toBe(404);
		expect(mocks.getCachedMcpClientForConfig).toHaveBeenCalledWith(
			expect.objectContaining({ access: "connect" }),
		);
	});
});

describe.each([
	[
		"POST /api/pipeline/fizzy-boards",
		fizzyBoards,
		"/api/pipeline/fizzy-boards",
		"fizzy_get_boards",
		{ mcpConfigId: "cfg-1", accountSlug: "/1", organizationId: ORG_ID },
	],
	[
		"POST /api/pipeline/fizzy-columns",
		fizzyColumns,
		"/api/pipeline/fizzy-columns",
		"fizzy_get_columns",
		{
			mcpConfigId: "cfg-1",
			accountSlug: "/1",
			boardId: "board-1",
			organizationId: ORG_ID,
		},
	],
])("%s", (_name, handler, path, toolName, body) => {
	it("refuses a former member before a client is built", async () => {
		asFormerMember();
		await expectRefused(await handler(post(path, body)), NOT_A_MEMBER);
		expect(mocks.createMcpClientForConfig).not.toHaveBeenCalled();
	});

	it("refuses a viewer before a client is built: the lookup executes a tool", async () => {
		asRole("viewer");
		await expectRefused(
			await handler(post(path, body)),
			ROLE_LACKS_PERMISSION,
		);
		expect(mocks.canConnectOrganizationMcpConfigs).toHaveBeenCalledWith(
			USER_ID,
			ORG_ID,
		);
		expect(mocks.createMcpClientForConfig).not.toHaveBeenCalled();
	});

	it("lets a member through to tool execution", async () => {
		asRole("member");
		const execute = vi.fn().mockResolvedValue([]);
		mocks.createMcpClientForConfig.mockResolvedValue({
			client: { tools: async () => ({ [toolName]: { execute } }) },
			serverUrl: "https://mcp.example.com",
		});

		const res = await handler(post(path, body));

		expect(res.status).toBe(200);
		expect(mocks.createMcpClientForConfig).toHaveBeenCalledWith(
			expect.objectContaining({
				configId: "cfg-1",
				userId: USER_ID,
				organizationId: ORG_ID,
				access: "connect",
			}),
		);
		expect(execute).toHaveBeenCalledTimes(1);
	});
});

describe("POST /api/agents/fabric-ai/suggest-tools", () => {
	const body = { message: "list my boards", organizationId: ORG_ID };

	it("refuses a former member before any config is discovered", async () => {
		asFormerMember();
		await expectRefused(
			await suggestTools(
				post("/api/agents/fabric-ai/suggest-tools", body),
			),
			NOT_A_MEMBER,
		);
		expect(mocks.getDetailedMcpToolInfo).not.toHaveBeenCalled();
	});

	it("lets a viewer through to discovery", async () => {
		asRole("viewer");
		const res = await suggestTools(
			post("/api/agents/fabric-ai/suggest-tools", body),
		);
		expect(res.status).toBe(200);
		expect(mocks.getDetailedMcpToolInfo).toHaveBeenCalledWith({
			userId: USER_ID,
			organizationId: ORG_ID,
			enabledMcpConfigIds: undefined,
		});
	});
});

describe("POST /api/mcp/test-connection with a stored config (Fizzy #2903)", () => {
	const body = {
		configId: "cfg-1",
		baseUrl: "https://mcp.example.com/mcp",
		authType: "API_KEY",
	};

	beforeEach(() => {
		// The caller's session is active in the config's organization, so the
		// route's own config/session match passes and only the organization
		// gate stands between the caller and the stored key.
		mocks.getAuthSession.mockResolvedValue({
			user: { id: USER_ID },
			session: { activeOrganizationId: ORG_ID },
		});
		mocks.getMcpConfigByIdInternal.mockResolvedValue({
			id: "cfg-1",
			userId: USER_ID,
			organizationId: ORG_ID,
			encryptedApiKey: "not-a-real-ciphertext",
			apiKeyMethod: "BEARER",
			mcpServer: { key: "example" },
		});
	});

	it("refuses a former member before the stored key is read", async () => {
		asFormerMember();
		await expectRefused(
			await testConnection(post("/api/mcp/test-connection", body)),
			NOT_A_MEMBER,
		);
	});

	it("refuses a viewer: the test runs one of the server's tools", async () => {
		asRole("viewer");
		await expectRefused(
			await testConnection(post("/api/mcp/test-connection", body)),
			ROLE_LACKS_PERMISSION,
		);
		expect(mocks.canConnectOrganizationMcpConfigs).toHaveBeenCalledWith(
			USER_ID,
			ORG_ID,
		);
	});
});
