// @vitest-environment node
/**
 * Route-level guard for the GitLab personal MCP servers (`gitlab`,
 * `gitlab-official`): the person's GitLab connection token may only travel
 * to the GitLab origin it was issued by, and only through the GitLab
 * outbound fetch.
 *
 *   - Test Connection connects to the URL in the REQUEST, which may differ
 *     from the saved config: the token is attached only when that URL is on
 *     the credential's origin.
 *   - The MCP App routes (call-tool, resource) build SDK transports
 *     themselves: both transport variants must use the GitLab fetch.
 */
import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	config: null as Record<string, unknown> | null,
	getValidAccessToken: vi.fn(),
	getGitLabConnectionToken: vi.fn(),
	safeFetchOutbound: vi.fn(),
	transports: [] as Array<{
		kind: "sse" | "http";
		url: URL;
		opts: Record<string, unknown>;
	}>,
	fetchMcpServer: vi.fn(),
}));

const session = {
	user: { id: "user_a" },
	session: { activeOrganizationId: "org_a" },
};

vi.mock("@repo/auth", () => ({
	auth: { api: { getSession: async () => session } },
}));
vi.mock("@saas/auth/lib/server", () => ({
	getSession: async () => session,
}));

vi.mock("@repo/database", () => ({
	isGitLabPersonalMcpServerKey: (key: string | null | undefined) =>
		key === "gitlab" || key === "gitlab-official",
	getMcpConfigByIdInternal: async () => state.config,
	getMcpConfigById: async () => state.config,
	authorizeMcpConfigAccess: async () => state.config,
	// The GitLab credential checks the caller still belongs to the config's
	// organization; they do.
	isOrganizationMember: async () => true,
	// The MCP App routes check the caller's organization role before they
	// load the config (Fizzy #2897); this caller holds both permissions.
	canReadOrganizationMcpConfigs: async () => true,
	canConnectOrganizationMcpConfigs: async () => true,
	getValidAccessToken: (...args: unknown[]) =>
		state.getValidAccessToken(...args),
}));

vi.mock("@repo/integrations/gitlab", async (importOriginal) => ({
	...(await importOriginal<object>()),
	getGitLabConnectionToken: (...args: unknown[]) =>
		state.getGitLabConnectionToken(...args),
}));

vi.mock("@repo/utils/url-security", async (importOriginal) => ({
	...(await importOriginal<object>()),
	safeFetchOutbound: (...args: unknown[]) => state.safeFetchOutbound(...args),
}));

// No DNS: the generic destination guard is not under test here.
vi.mock("@repo/mcp/lib/server-url-guard", async (importOriginal) => ({
	...(await importOriginal<object>()),
	assertMcpServerUrlResolved: async () => undefined,
	fetchMcpServer: state.fetchMcpServer,
}));

vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
	SSEClientTransport: class {
		constructor(url: URL, opts: Record<string, unknown>) {
			state.transports.push({ kind: "sse", url, opts });
		}
	},
}));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
	StreamableHTTPClientTransport: class {
		constructor(url: URL, opts: Record<string, unknown>) {
			state.transports.push({ kind: "http", url, opts });
		}
	},
}));
// The connection itself is not under test: stop right after the transport
// is built.
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
	Client: class {
		async connect() {
			throw new Error("not connecting in tests");
		}
		async close() {}
	},
}));

import { POST as callTool } from "../../../mcp-app/call-tool/route";
import { POST as readResource } from "../../../mcp-app/resource/route";
import { POST as testConnection } from "../route";

const OFFICIAL_URL = "https://gitlab.com/api/v4/mcp";

function gitlabConfig(overrides: Record<string, unknown> = {}) {
	return {
		id: "cfg_gl",
		userId: "user_a",
		organizationId: "org_a",
		enabled: true,
		baseUrl: null,
		transport: "HTTP",
		authType: "OAUTH2",
		mcpServer: {
			key: "gitlab-official",
			defaultUrl: OFFICIAL_URL,
			transport: "HTTP",
		},
		...overrides,
	};
}

function jsonRequest(body: unknown): NextRequest {
	return new Request("https://app.example.com/api", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	}) as unknown as NextRequest;
}

type TransportFetch = (
	url: string | URL,
	init?: RequestInit,
) => Promise<Response>;

const headersOf = (index: number) =>
	(
		state.transports[index]?.opts.requestInit as
			| { headers?: Record<string, string> }
			| undefined
	)?.headers ?? {};

/** The transport's fetch must be the GitLab fetch: bound to gitlab.com. */
async function expectGitLabFetch(index: number) {
	const transportFetch = state.transports[index]?.opts.fetch as
		| TransportFetch
		| undefined;
	expect(transportFetch).toBeTypeOf("function");
	expect(transportFetch).not.toBe(state.fetchMcpServer);
	const network = vi.fn(async () => new Response("{}"));
	vi.stubGlobal("fetch", network);
	await expect(
		transportFetch?.("https://other.example.com/mcp", { method: "POST" }),
	).rejects.toMatchObject({ code: "origin-mismatch" });
	expect(network).not.toHaveBeenCalled();
	await transportFetch?.(OFFICIAL_URL, { method: "POST" });
	expect(network).toHaveBeenCalledWith(
		OFFICIAL_URL,
		expect.objectContaining({ redirect: "error" }),
	);
	expect(state.fetchMcpServer).not.toHaveBeenCalled();
}

beforeEach(() => {
	vi.unstubAllGlobals();
	state.transports.length = 0;
	state.config = gitlabConfig();
	state.getValidAccessToken.mockReset();
	state.fetchMcpServer.mockReset();
	state.safeFetchOutbound.mockReset();
	state.getGitLabConnectionToken.mockReset();
	state.getGitLabConnectionToken.mockResolvedValue({
		ok: true,
		accessToken: "personal-token",
		issuer: null,
		origin: "https://gitlab.com",
		integrationId: "wi_1",
		generation: 1,
		settings: {},
	});
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("POST /api/mcp/test-connection — GitLab personal server", () => {
	it("attaches no token when the request's URL is on another origin than the credential", async () => {
		const response = await testConnection(
			jsonRequest({
				configId: "cfg_gl",
				authType: "OAUTH2",
				transport: "HTTP",
				baseUrl: "https://other.example.com/mcp",
			}),
		);

		const body = await response.json();
		expect(response.status).toBe(400);
		expect(body.error?.type).toBe("OAUTH_ACCESS_TOKEN_REQUIRED");
		// No transport, so no request carried the token anywhere.
		expect(state.transports).toHaveLength(0);
	});

	it("tests the credential's own origin through the GitLab fetch", async () => {
		await testConnection(
			jsonRequest({
				configId: "cfg_gl",
				authType: "OAUTH2",
				transport: "HTTP",
				baseUrl: OFFICIAL_URL,
			}),
		);

		expect(state.transports).toHaveLength(1);
		expect(headersOf(0).Authorization).toBe("Bearer personal-token");
		await expectGitLabFetch(0);
	});
});

// The server decides, not the auth type: a GitLab config saved as API_KEY
// (an older release let the API store a personal access token there) is
// tested and used with the person's GitLab connection, never with that key.
const STORED_KEY = "enc:glpat-stored-on-config";

describe("GitLab personal server saved as API_KEY", () => {
	it.each(["API_KEY", "NONE"] as const)(
		"test-connection with authType %s uses the connection token, not the stored key",
		async (authType) => {
			state.config = gitlabConfig({
				authType: "API_KEY",
				encryptedApiKey: STORED_KEY,
			});

			await testConnection(
				jsonRequest({
					configId: "cfg_gl",
					authType,
					apiKeyMethod: "BEARER",
					transport: "HTTP",
					baseUrl: OFFICIAL_URL,
				}),
			);

			expect(state.transports).toHaveLength(1);
			expect(headersOf(0).Authorization).toBe("Bearer personal-token");
			expect(JSON.stringify(headersOf(0))).not.toContain("glpat");
			await expectGitLabFetch(0);
			expect(state.getValidAccessToken).not.toHaveBeenCalled();
		},
	);

	it("call-tool uses the connection token through the GitLab fetch", async () => {
		state.config = gitlabConfig({
			authType: "API_KEY",
			apiKeyMethod: "BEARER",
			encryptedApiKey: STORED_KEY,
		});

		await callTool(
			jsonRequest({
				configId: "cfg_gl",
				toolName: "list_issues",
				organizationId: "org_a",
			}),
		);

		expect(state.transports).toHaveLength(1);
		expect(headersOf(0).Authorization).toBe("Bearer personal-token");
		await expectGitLabFetch(0);
	});

	it("resource uses the connection token through the GitLab fetch", async () => {
		state.config = gitlabConfig({
			authType: "API_KEY",
			apiKeyMethod: "BEARER",
			encryptedApiKey: STORED_KEY,
		});

		await readResource(
			jsonRequest({
				configId: "cfg_gl",
				resourceUri: "ui://gitlab/board",
				organizationId: "org_a",
			}),
		);

		expect(state.transports).toHaveLength(1);
		expect(headersOf(0).Authorization).toBe("Bearer personal-token");
		await expectGitLabFetch(0);
	});
});

describe("POST /api/mcp-app/call-tool — GitLab personal server", () => {
	for (const transport of ["HTTP", "SSE"] as const) {
		it(`builds the ${transport} transport with the GitLab fetch`, async () => {
			state.config = gitlabConfig({ transport });

			await callTool(
				jsonRequest({
					configId: "cfg_gl",
					toolName: "list_issues",
					organizationId: "org_a",
				}),
			);

			expect(state.transports).toHaveLength(1);
			expect(state.transports[0].kind).toBe(
				transport === "SSE" ? "sse" : "http",
			);
			expect(headersOf(0).Authorization).toBe("Bearer personal-token");
			await expectGitLabFetch(0);
		});
	}

	it("sends no token when the saved endpoint is on another origin than the credential", async () => {
		state.config = gitlabConfig({
			baseUrl: "https://gitlab.example.com/api/v4/mcp",
		});

		const response = await callTool(
			jsonRequest({
				configId: "cfg_gl",
				toolName: "list_issues",
				organizationId: "org_a",
			}),
		);

		expect(response.status).toBe(500);
		expect(state.transports).toHaveLength(0);
	});
});

describe("POST /api/mcp-app/resource — GitLab personal server", () => {
	for (const transport of ["HTTP", "SSE"] as const) {
		it(`builds the ${transport} transport with the GitLab fetch`, async () => {
			state.config = gitlabConfig({ transport });

			await readResource(
				jsonRequest({
					configId: "cfg_gl",
					resourceUri: "ui://gitlab/board",
					organizationId: "org_a",
				}),
			);

			expect(state.transports).toHaveLength(1);
			expect(state.transports[0].kind).toBe(
				transport === "SSE" ? "sse" : "http",
			);
			expect(headersOf(0).Authorization).toBe("Bearer personal-token");
			await expectGitLabFetch(0);
		});
	}
});
