// @vitest-environment node
/**
 * Route-level guard for the GitLab personal MCP servers (`gitlab`,
 * `gitlab-official`): the person's GitLab connection token may only travel
 * to the GitLab origin it was issued by, and only through the GitLab
 * outbound fetch.
 *
 *   - Test Connection connects to the URL in the REQUEST, which may differ
 *     from the saved config: a saved token is withheld and the test stops
 *     unless the request supplies a fresh credential for that URL.
 *   - The MCP App routes build SDK transports themselves: both transport
 *     variants must use the GitLab fetch.
 */
import type { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	config: null as Record<string, unknown> | null,
	getValidAccessToken: vi.fn(),
	getMcpOAuthGrantGeneration: vi.fn(),
	getGitLabConnectionToken: vi.fn(),
	safeFetchOutbound: vi.fn(),
	decryptApiKey: vi.fn(),
	connectError: null as Error | null,
	transports: [] as Array<{
		kind: "sse" | "http";
		url: URL;
		opts: Record<string, unknown>;
	}>,
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
	// call-tool resolves the requested organization on the server and checks
	// the caller's tie to it (resolveRequestedOrganization); they have one.
	hasOrganizationTie: async () => true,
	// The MCP App routes check the caller's organization role before they
	// load the config (Fizzy #2897); this caller holds both permissions.
	canReadOrganizationMcpConfigs: async () => true,
	canConnectOrganizationMcpConfigs: async () => true,
	getValidAccessToken: (...args: unknown[]) =>
		state.getValidAccessToken(...args),
	getMcpOAuthGrantGeneration: (...args: unknown[]) =>
		state.getMcpOAuthGrantGeneration(...args),
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

vi.mock("@repo/utils", async (importOriginal) => ({
	...(await importOriginal<object>()),
	decryptApiKey: (...args: unknown[]) => state.decryptApiKey(...args),
}));

const lookupMock = vi.fn();
vi.mock("node:dns", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:dns")>();
	return {
		...actual,
		lookup: (...args: unknown[]) => lookupMock(...args),
	};
});

vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
	SSEClientTransport: class {
		constructor(url: URL, opts: Record<string, unknown>) {
			state.transports.push({ kind: "sse", url, opts });
		}
	},
}));
vi.mock(
	"@modelcontextprotocol/sdk/client/streamableHttp.js",
	async (importOriginal) => ({
		...(await importOriginal<object>()),
		StreamableHTTPClientTransport: class {
			constructor(url: URL, opts: Record<string, unknown>) {
				state.transports.push({ kind: "http", url, opts });
			}
		},
	}),
);
// The connection itself is not under test: stop right after the transport
// is built.
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
	Client: class {
		async connect() {
			throw state.connectError ?? new Error("not connecting in tests");
		}
		async close() {}
	},
}));

import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { fetchMcpServer } from "@repo/mcp/lib/server-url-guard";
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

function genericConfig(overrides: Record<string, unknown> = {}) {
	return {
		id: "cfg_generic",
		userId: "user_a",
		organizationId: "org_a",
		enabled: true,
		baseUrl: "https://mcp.example.com/api/mcp",
		transport: "HTTP",
		authType: "NONE",
		oauthGrantGeneration: 4,
		mcpServer: {
			key: "custom",
			defaultUrl: null,
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
	expect(transportFetch).not.toBe(fetchMcpServer);
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
}

beforeEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.stubEnv("NODE_ENV", "production");
	vi.stubEnv("MCP_SERVER_ALLOWED_HOSTS", "");
	lookupMock.mockReset();
	lookupMock.mockImplementation(
		(
			_hostname: string,
			_options: unknown,
			callback: (
				error: Error | null,
				addresses: { address: string; family: number }[],
			) => void,
		) => callback(null, [{ address: "93.184.216.34", family: 4 }]),
	);
	state.transports.length = 0;
	state.config = gitlabConfig();
	state.connectError = null;
	state.getValidAccessToken.mockReset();
	state.getMcpOAuthGrantGeneration.mockReset();
	state.getMcpOAuthGrantGeneration.mockResolvedValue(4);
	state.safeFetchOutbound.mockReset();
	state.decryptApiKey.mockReset();
	state.decryptApiKey.mockImplementation((value: string) =>
		value.replace(/^enc:/, ""),
	);
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
	it("reports that a saved token is withheld from another requested endpoint", async () => {
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
		expect(body).toMatchObject({
			success: false,
			message:
				"The saved credentials are only sent to the saved server address. Save the new address, or enter the credentials again, to test it.",
			error: { type: "SAVED_CREDENTIAL_URL_MISMATCH" },
		});
		expect(state.getGitLabConnectionToken).not.toHaveBeenCalled();
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

afterEach(() => {
	vi.unstubAllEnvs();
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

describe("MCP App configured-server address guard", () => {
	const routes = [
		{
			name: "call-tool",
			invoke: () =>
				callTool(
					jsonRequest({
						configId: "cfg_generic",
						toolName: "list_items",
						organizationId: "org_a",
					}),
				),
			genericError: "Failed to call MCP tool",
		},
		{
			name: "resource",
			invoke: () =>
				readResource(
					jsonRequest({
						configId: "cfg_generic",
						resourceUri: "ui://example/app",
						organizationId: "org_a",
					}),
				),
			genericError: "Failed to fetch MCP App resource",
		},
	];

	it.each(routes)(
		"$name refuses a link-local configured address before constructing a transport",
		async ({ invoke, genericError }) => {
			state.config = genericConfig({
				baseUrl: "http://169.254.169.254/latest/meta-data/",
			});

			const response = await invoke();
			const body = await response.json();
			expect(response.status).toBe(500);
			expect(body.error).toBe(genericError);
			expect(state.transports).toHaveLength(0);
		},
	);

	it.each(routes)(
		"$name refuses a configured hostname resolving to 10.x before constructing a transport",
		async ({ invoke, genericError }) => {
			state.config = genericConfig({
				baseUrl: "https://mcp.internal.example/api/mcp",
			});
			lookupMock.mockImplementation(
				(
					_hostname: string,
					_options: unknown,
					callback: (
						error: Error | null,
						addresses: { address: string; family: number }[],
					) => void,
				) => callback(null, [{ address: "10.20.30.40", family: 4 }]),
			);

			const response = await invoke();
			const body = await response.json();
			expect(response.status).toBe(500);
			expect(body.error).toBe(genericError);
			expect(state.transports).toHaveLength(0);
		},
	);

	for (const route of routes) {
		for (const transport of ["HTTP", "SSE"] as const) {
			it(`${route.name} hands the ${transport} transport the guarded fetch`, async () => {
				state.config = genericConfig({ transport });

				await route.invoke();

				expect(state.transports).toHaveLength(1);
				expect(state.transports[0]?.opts.fetch).toBe(fetchMcpServer);
			});
		}
	}

	it.each(routes)(
		"$name does not echo an SDK upstream response body",
		async ({ invoke, genericError }) => {
			state.config = genericConfig();
			const upstreamBody = "private upstream response body";
			// This is the SDK's real exported error class and constructor shape
			// from @modelcontextprotocol/sdk/dist/cjs/client/streamableHttp.js.
			state.connectError = new StreamableHTTPError(
				502,
				`Error POSTing to endpoint: ${upstreamBody}`,
			);

			const response = await invoke();
			const body = await response.json();
			expect(response.status).toBe(500);
			expect(body.error).toBe(genericError);
			expect(JSON.stringify(body)).not.toContain(upstreamBody);
		},
	);
});

describe("POST /api/mcp/test-connection — stored credential destination", () => {
	it.each([
		"http://127.0.0.1:7233/mcp",
		"http://169.254.169.254/latest/meta-data/",
	])(
		"refuses stored-config destination %s before decrypting or constructing a transport",
		async (baseUrl) => {
			state.config = genericConfig({
				baseUrl,
				authType: "API_KEY",
				encryptedApiKey: "enc:stored-secret",
			});

			const response = await testConnection(
				jsonRequest({
					configId: "cfg_generic",
					authType: "API_KEY",
					transport: "HTTP",
					baseUrl,
				}),
			);

			expect(response.status).toBe(400);
			expect(state.decryptApiKey).not.toHaveBeenCalled();
			expect(state.transports).toHaveLength(0);
		},
	);

	it("refuses a stored-config hostname resolving to 10.x before decrypting or constructing a transport", async () => {
		const baseUrl = "https://mcp.internal.example/api/mcp";
		state.config = genericConfig({
			baseUrl,
			authType: "API_KEY",
			encryptedApiKey: "enc:stored-secret",
		});
		lookupMock.mockImplementation(
			(
				_hostname: string,
				_options: unknown,
				callback: (
					error: Error | null,
					addresses: { address: string; family: number }[],
				) => void,
			) => callback(null, [{ address: "10.20.30.40", family: 4 }]),
		);

		const response = await testConnection(
			jsonRequest({
				configId: "cfg_generic",
				authType: "API_KEY",
				transport: "HTTP",
				baseUrl,
			}),
		);

		expect(response.status).toBe(400);
		expect(state.decryptApiKey).not.toHaveBeenCalled();
		expect(state.transports).toHaveLength(0);
	});

	it("does not decrypt or attach a stored API key for a different requested endpoint", async () => {
		state.config = genericConfig({
			authType: "API_KEY",
			encryptedApiKey: "enc:stored-secret",
			apiKeyMethod: "BEARER",
		});

		const response = await testConnection(
			jsonRequest({
				configId: "cfg_generic",
				authType: "API_KEY",
				transport: "HTTP",
				baseUrl: "https://other.example.com/api/mcp",
			}),
		);

		const body = await response.json();
		expect(response.status).toBe(400);
		expect(body).toMatchObject({
			success: false,
			message:
				"The saved credentials are only sent to the saved server address. Save the new address, or enter the credentials again, to test it.",
			error: { type: "SAVED_CREDENTIAL_URL_MISMATCH" },
		});
		expect(state.decryptApiKey).not.toHaveBeenCalled();
		expect(state.transports).toHaveLength(0);
	});

	it("uses a fresh API key for a different requested endpoint instead of the stored key", async () => {
		state.config = genericConfig({
			authType: "API_KEY",
			encryptedApiKey: "enc:stored-secret",
			apiKeyMethod: "BEARER",
		});

		await testConnection(
			jsonRequest({
				configId: "cfg_generic",
				authType: "API_KEY",
				apiKey: "fresh-secret",
				apiKeyMethod: "BEARER",
				transport: "HTTP",
				baseUrl: "https://other.example.com/api/mcp",
			}),
		);

		expect(state.decryptApiKey).not.toHaveBeenCalled();
		expect(state.transports).toHaveLength(1);
		expect(headersOf(0).Authorization).toBe("Bearer fresh-secret");
	});

	it("can test a different endpoint anonymously when the config has no saved credential", async () => {
		state.config = genericConfig({ authType: "NONE" });

		await testConnection(
			jsonRequest({
				configId: "cfg_generic",
				authType: "NONE",
				transport: "HTTP",
				baseUrl: "https://other.example.com/api/mcp",
			}),
		);

		expect(state.decryptApiKey).not.toHaveBeenCalled();
		expect(state.transports).toHaveLength(1);
		expect(headersOf(0)).toEqual({});
	});

	it("attaches the stored API key when only a trailing slash differs", async () => {
		state.config = genericConfig({
			baseUrl: "https://mcp.example.com/api/mcp/",
			authType: "API_KEY",
			encryptedApiKey: "enc:stored-secret",
			apiKeyMethod: "BEARER",
		});

		await testConnection(
			jsonRequest({
				configId: "cfg_generic",
				authType: "API_KEY",
				transport: "HTTP",
				baseUrl: "https://mcp.example.com/api/mcp",
			}),
		);

		expect(state.decryptApiKey).toHaveBeenCalledWith("enc:stored-secret");
		expect(headersOf(0).Authorization).toBe("Bearer stored-secret");
	});
});
