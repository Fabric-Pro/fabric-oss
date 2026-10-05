/**
 * The GitLab personal MCP servers (`gitlab`, `gitlab-official`) carry no
 * credential of their own: every MCP transport for them presents the caller's
 * GitLab connection token, and only after checking that the config is the
 * caller's own personal config in this tenant context and that its endpoint
 * is on the GitLab instance the credential was issued by. The MCPConfig token
 * copy is never sent and never refreshed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetMcpConfigById = vi.fn();
const mockGetValidAccessToken = vi.fn();
const mockAuthorizeMcpConfigAccess = vi.fn();
const mockUpdateMcpConfigTokens = vi.fn();
const mockIsOrganizationMember = vi.fn();

vi.mock("@repo/database", () => ({
	// Mirrors the real predicate (prisma/queries/lib/gitlab-personal-keys.ts).
	isGitLabPersonalMcpServerKey: (key: string | null | undefined) =>
		key === "gitlab" || key === "gitlab-official",
	getMcpConfigById: (...args: unknown[]) => mockGetMcpConfigById(...args),
	isOrganizationMember: (...args: unknown[]) =>
		mockIsOrganizationMember(...args),
	// The organization gate in ../organization-access: a member here holds
	// both MCP permissions, and a non-member neither.
	canConnectOrganizationMcpConfigs: (...args: unknown[]) =>
		mockIsOrganizationMember(...args),
	canReadOrganizationMcpConfigs: (...args: unknown[]) =>
		mockIsOrganizationMember(...args),
	getValidAccessToken: (...args: unknown[]) =>
		mockGetValidAccessToken(...args),
	authorizeMcpConfigAccess: (...args: unknown[]) =>
		mockAuthorizeMcpConfigAccess(...args),
	updateMcpConfigTokens: (...args: unknown[]) =>
		mockUpdateMcpConfigTokens(...args),
	getMcpConfigByIdInternal: (...args: unknown[]) =>
		mockGetMcpConfigById(...args),
	recordRefreshFailure: vi.fn(),
	clearRefreshFailures: vi.fn(),
	getCachedOAuthMetadata: vi.fn(),
	isPermanentGrantFailure: () => false,
}));

const mockGetGitLabConnectionToken = vi.fn();
const mockReadStoredGitLabConnectionStatus = vi.fn();
vi.mock("@repo/integrations/gitlab", async (importOriginal) => ({
	...(await importOriginal<object>()),
	getGitLabConnectionToken: (...args: unknown[]) =>
		mockGetGitLabConnectionToken(...args),
	readStoredGitLabConnectionStatus: (...args: unknown[]) =>
		mockReadStoredGitLabConnectionStatus(...args),
}));

// The GitLab outbound guard's network half (resolved-address checks) is
// `safeFetchOutbound`; record what reaches it instead of resolving DNS.
const mockSafeFetchOutbound = vi.fn();
vi.mock("@repo/utils/url-security", async (importOriginal) => ({
	...(await importOriginal<object>()),
	safeFetchOutbound: (...args: unknown[]) => mockSafeFetchOutbound(...args),
}));

const mockRefreshOAuthToken = vi.fn();
vi.mock("@repo/utils/oauth-refresh", () => ({
	refreshOAuthToken: (...args: unknown[]) => mockRefreshOAuthToken(...args),
}));

// No DNS: the destination guard is not under test here.
vi.mock("../server-url-guard", () => ({
	assertMcpServerUrlResolved: async () => undefined,
	fetchMcpServer: (input: string | URL, init?: RequestInit) =>
		fetch(input, init),
}));

/** Every transport the client builds, with the options it was given. */
const transports: Array<{ url: URL; opts: Record<string, unknown> }> = [];
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
	StreamableHTTPClientTransport: class {
		constructor(url: URL, opts: Record<string, unknown>) {
			transports.push({ url, opts });
		}
	},
}));
/** Every client the SDK factory built, so a test can see one closed. */
const builtClients: Array<{ close: ReturnType<typeof vi.fn> }> = [];
vi.mock("@ai-sdk/mcp", async (importOriginal) => ({
	...(await importOriginal<object>()),
	createMCPClient: vi.fn(async () => {
		const client = {
			tools: async () => ({}),
			close: vi.fn(async () => undefined),
		};
		builtClients.push(client);
		return client;
	}),
}));

import {
	clearMcpClientCache,
	createMcpClientForConfig,
	createOAuthClientProvider,
	GitLabMcpCredentialError,
	getCachedMcpClientForConfig,
	getValidMcpAccessToken,
	getValidMcpTransportAuth,
	McpClientError,
} from "../../index";
import { fetchMcpServer } from "../server-url-guard";

const OFFICIAL_URL = "https://gitlab.com/api/v4/mcp";

function gitlabConfig(overrides: Record<string, unknown> = {}) {
	return {
		id: "cfg_gl",
		userId: "user_a",
		organizationId: "org_a",
		enabled: true,
		// A tripped breaker on the legacy copy does not gate the connection.
		needsReauth: true,
		displayName: "GitLab",
		baseUrl: null,
		transport: "HTTP",
		authType: "OAUTH2",
		oauthClientId: "dcr-client",
		encryptedAccessToken: "enc:copy-access",
		encryptedRefreshToken: "enc:copy-refresh",
		tokenExpiresAt: new Date(Date.now() - 60_000),
		mcpServer: {
			key: "gitlab-official",
			name: "GitLab",
			defaultUrl: OFFICIAL_URL,
			transport: "HTTP",
		},
		...overrides,
	};
}

function connectionToken(overrides: Record<string, unknown> = {}) {
	return {
		ok: true,
		accessToken: "connection-token",
		issuer: {
			kind: "mcp-dcr",
			mcpConfigId: "cfg_gl",
			serverKey: "gitlab-official",
			clientId: "dcr-client",
			origin: "https://gitlab.com",
		},
		origin: "https://gitlab.com",
		integrationId: "wi_1",
		generation: 1,
		settings: {},
		...overrides,
	};
}

beforeEach(async () => {
	await clearMcpClientCache();
	builtClients.length = 0;
	mockIsOrganizationMember.mockReset();
	// The caller is a member of the config's organization unless a test
	// says otherwise.
	mockIsOrganizationMember.mockResolvedValue(true);
	mockReadStoredGitLabConnectionStatus.mockReset();
	transports.length = 0;
	mockGetMcpConfigById.mockReset();
	mockGetValidAccessToken.mockReset();
	mockAuthorizeMcpConfigAccess.mockReset();
	mockUpdateMcpConfigTokens.mockReset();
	mockGetGitLabConnectionToken.mockReset();
	mockRefreshOAuthToken.mockReset();
	mockSafeFetchOutbound.mockReset();
	vi.unstubAllGlobals();
});

type TransportFetch = (
	url: string | URL,
	init?: RequestInit,
) => Promise<Response>;
const transportFetch = () => transports[0]?.opts.fetch as TransportFetch;

const requestHeaders = () =>
	(transports[0]?.opts.requestInit as { headers?: Record<string, string> })
		?.headers ?? {};

describe("createMcpClientForConfig — GitLab personal servers", () => {
	it("connects with the caller's GitLab connection token, never the MCP copy", async () => {
		mockGetMcpConfigById.mockResolvedValue(gitlabConfig());
		mockGetGitLabConnectionToken.mockResolvedValue(connectionToken());

		await createMcpClientForConfig({
			configId: "cfg_gl",
			userId: "user_a",
			organizationId: "org_a",
		});

		expect(mockGetGitLabConnectionToken).toHaveBeenCalledWith(
			{ userId: "user_a", organizationId: "org_a" },
			{ mode: "strict", anyOrigin: true },
			undefined,
		);
		expect(transports).toHaveLength(1);
		expect(String(transports[0].url)).toBe(OFFICIAL_URL);
		expect(requestHeaders().Authorization).toBe("Bearer connection-token");
		// No OAuth provider: nothing the SDK could refresh the copy with.
		expect(transports[0].opts.authProvider).toBeUndefined();
		expect(mockGetValidAccessToken).not.toHaveBeenCalled();
		expect(mockRefreshOAuthToken).not.toHaveBeenCalled();
		expect(mockUpdateMcpConfigTokens).not.toHaveBeenCalled();
	});

	it("refuses an endpoint on a different GitLab instance than the credential", async () => {
		mockGetMcpConfigById.mockResolvedValue(
			gitlabConfig({
				baseUrl: "https://gitlab.example.com/api/v4/mcp",
				needsReauth: false,
			}),
		);
		mockGetGitLabConnectionToken.mockResolvedValue(connectionToken());

		await expect(
			createMcpClientForConfig({
				configId: "cfg_gl",
				userId: "user_a",
				organizationId: "org_a",
			}),
		).rejects.toMatchObject({
			code: "OAUTH_AUTH_REQUIRED",
			isAuthError: true,
		});
		expect(transports).toHaveLength(0);
	});

	it("connects a self-hosted endpoint with a credential issued by that same instance", async () => {
		mockGetMcpConfigById.mockResolvedValue(
			gitlabConfig({
				baseUrl: "https://gitlab.example.com/api/v4/mcp",
				needsReauth: false,
			}),
		);
		mockGetGitLabConnectionToken.mockResolvedValue(
			connectionToken({ origin: "https://gitlab.example.com" }),
		);

		await createMcpClientForConfig({
			configId: "cfg_gl",
			userId: "user_a",
			organizationId: "org_a",
		});

		expect(transports).toHaveLength(1);
		expect(String(transports[0].url)).toBe(
			"https://gitlab.example.com/api/v4/mcp",
		);
		expect(requestHeaders().Authorization).toBe("Bearer connection-token");
	});

	it("refuses an organization-level GitLab config without resolving anyone's connection", async () => {
		mockGetMcpConfigById.mockResolvedValue(
			gitlabConfig({ userId: null, needsReauth: false }),
		);
		mockGetGitLabConnectionToken.mockResolvedValue(connectionToken());

		const error = await createMcpClientForConfig({
			configId: "cfg_gl",
			userId: "user_a",
			organizationId: "org_a",
		}).catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(McpClientError);
		expect(error).toMatchObject({ code: "OAUTH_AUTH_REQUIRED" });
		expect(mockGetGitLabConnectionToken).not.toHaveBeenCalled();
		expect(transports).toHaveLength(0);
	});

	it("refuses when the connection needs reconnecting, whatever the legacy copy says", async () => {
		mockGetMcpConfigById.mockResolvedValue(
			gitlabConfig({ needsReauth: false }),
		);
		mockGetGitLabConnectionToken.mockResolvedValue({
			ok: false,
			reason: "needs-reauth",
			message: "the GitLab connection needs to be reconnected",
		});

		await expect(
			createMcpClientForConfig({
				configId: "cfg_gl",
				userId: "user_a",
				organizationId: "org_a",
			}),
		).rejects.toMatchObject({ code: "OAUTH_AUTH_REQUIRED" });
		expect(transports).toHaveLength(0);
	});
});

// A GitLab personal config holds no credential of its own whatever auth type
// it names: an API key saved on one (as an older release allowed) is never
// sent, and the person's connection decides.
const API_KEY_AUTH = {
	authType: "API_KEY",
	apiKeyMethod: "BEARER",
	encryptedApiKey: "enc:glpat-on-the-config",
	encryptedAccessToken: null,
	encryptedRefreshToken: null,
	tokenExpiresAt: null,
	needsReauth: false,
};
const NO_AUTH = { ...API_KEY_AUTH, authType: "NONE", encryptedApiKey: null };

describe.each([
	["API_KEY", API_KEY_AUTH],
	["NONE", NO_AUTH],
])("a GitLab personal config with authType %s", (_authType, auth) => {
	it("createMcpClientForConfig connects with the connection token, never the stored key", async () => {
		mockGetMcpConfigById.mockResolvedValue(gitlabConfig(auth));
		mockGetGitLabConnectionToken.mockResolvedValue(connectionToken());

		await createMcpClientForConfig({
			configId: "cfg_gl",
			userId: "user_a",
			organizationId: "org_a",
		});

		expect(requestHeaders().Authorization).toBe("Bearer connection-token");
		expect(mockGetValidAccessToken).not.toHaveBeenCalled();
	});

	it("createMcpClientForConfig refuses when GitLab is not connected", async () => {
		mockGetMcpConfigById.mockResolvedValue(gitlabConfig(auth));
		mockGetGitLabConnectionToken.mockResolvedValue({
			ok: false,
			reason: "not-connected",
		});

		await expect(
			createMcpClientForConfig({
				configId: "cfg_gl",
				userId: "user_a",
				organizationId: "org_a",
			}),
		).rejects.toBeInstanceOf(McpClientError);
		expect(transports).toHaveLength(0);
		expect(mockGetValidAccessToken).not.toHaveBeenCalled();
	});

	it("getValidMcpAccessToken and getValidMcpTransportAuth answer with the connection token", async () => {
		mockAuthorizeMcpConfigAccess.mockResolvedValue(gitlabConfig(auth));
		mockGetGitLabConnectionToken.mockResolvedValue(connectionToken());

		expect(
			await getValidMcpAccessToken({
				configId: "cfg_gl",
				userId: "user_a",
				organizationId: "org_a",
			}),
		).toBe("connection-token");
		const transport = await getValidMcpTransportAuth({
			configId: "cfg_gl",
			userId: "user_a",
			organizationId: "org_a",
			endpoint: OFFICIAL_URL,
		});
		expect(transport.accessToken).toBe("connection-token");
		expect(transport.fetch).toBeTypeOf("function");
		expect(mockGetValidAccessToken).not.toHaveBeenCalled();
	});
});

it("createMcpClientForConfig refuses a GitLab personal config set to STDIO before reading any key", async () => {
	// A runnable STDIO definition, so the refusal is the GitLab one and not a
	// missing command: the STDIO wrapper would be handed the stored key.
	mockGetMcpConfigById.mockResolvedValue(
		gitlabConfig({
			...API_KEY_AUTH,
			transport: "STDIO",
			mcpServer: {
				key: "gitlab",
				name: "GitLab",
				defaultUrl: null,
				transport: "STDIO",
				command: "npx",
				args: ["-y", "example-gitlab-mcp"],
			},
		}),
	);
	const networkFetch = vi.fn(async () => new Response("{}"));
	vi.stubGlobal("fetch", networkFetch);

	await expect(
		createMcpClientForConfig({
			configId: "cfg_gl",
			userId: "user_a",
			organizationId: "org_a",
		}),
	).rejects.toMatchObject({
		code: "OAUTH_AUTH_REQUIRED",
		message: expect.stringContaining("STDIO transport is not supported"),
	});
	expect(networkFetch).not.toHaveBeenCalled();
	expect(mockGetValidAccessToken).not.toHaveBeenCalled();
	expect(mockGetGitLabConnectionToken).not.toHaveBeenCalled();
	vi.unstubAllGlobals();
});

describe("createMcpClientForConfig — the GitLab transport fetch", () => {
	it("keeps every request on the credential's origin and refuses redirects", async () => {
		mockGetMcpConfigById.mockResolvedValue(gitlabConfig());
		mockGetGitLabConnectionToken.mockResolvedValue(connectionToken());
		const networkFetch = vi.fn(async () => new Response("{}"));
		vi.stubGlobal("fetch", networkFetch);

		await createMcpClientForConfig({
			configId: "cfg_gl",
			userId: "user_a",
			organizationId: "org_a",
		});

		const guarded = transportFetch();
		expect(guarded).toBeTypeOf("function");
		expect(guarded).not.toBe(fetchMcpServer);
		// A request off the credential's origin never leaves the process.
		await expect(
			guarded("https://other.example.com/mcp", { method: "POST" }),
		).rejects.toBeInstanceOf(GitLabMcpCredentialError);
		await expect(
			guarded("http://gitlab.com/api/v4/mcp", { method: "POST" }),
		).rejects.toBeInstanceOf(GitLabMcpCredentialError);
		expect(networkFetch).not.toHaveBeenCalled();
		// On its origin it goes out with redirects refused.
		await guarded(OFFICIAL_URL, { method: "POST" });
		expect(networkFetch).toHaveBeenCalledTimes(1);
		expect(networkFetch).toHaveBeenCalledWith(
			OFFICIAL_URL,
			expect.objectContaining({ method: "POST", redirect: "error" }),
		);
	});

	it("sends a self-hosted instance's requests through the outbound guard", async () => {
		mockGetMcpConfigById.mockResolvedValue(
			gitlabConfig({
				baseUrl: "https://gitlab.example.com/api/v4/mcp",
				needsReauth: false,
			}),
		);
		mockGetGitLabConnectionToken.mockResolvedValue(
			connectionToken({ origin: "https://gitlab.example.com" }),
		);
		const networkFetch = vi.fn(async () => new Response("{}"));
		vi.stubGlobal("fetch", networkFetch);
		mockSafeFetchOutbound.mockResolvedValue(new Response("{}"));

		await createMcpClientForConfig({
			configId: "cfg_gl",
			userId: "user_a",
			organizationId: "org_a",
		});

		await transportFetch()("https://gitlab.example.com/api/v4/mcp", {
			method: "POST",
		});
		expect(mockSafeFetchOutbound).toHaveBeenCalledWith(
			"https://gitlab.example.com/api/v4/mcp",
			expect.objectContaining({ redirect: "error" }),
		);
		expect(networkFetch).not.toHaveBeenCalled();
	});
});

describe("getValidMcpTransportAuth", () => {
	it("refuses an endpoint on another origin than the credential, even when the saved config matches", async () => {
		mockAuthorizeMcpConfigAccess.mockResolvedValue(gitlabConfig());
		mockGetGitLabConnectionToken.mockResolvedValue(connectionToken());

		await expect(
			getValidMcpTransportAuth({
				configId: "cfg_gl",
				userId: "user_a",
				organizationId: "org_a",
				endpoint: "https://other.example.com/mcp",
			}),
		).rejects.toMatchObject({ code: "origin-mismatch" });
	});

	it("answers the credential's own endpoint with the token and its GitLab fetch", async () => {
		mockAuthorizeMcpConfigAccess.mockResolvedValue(gitlabConfig());
		mockGetGitLabConnectionToken.mockResolvedValue(connectionToken());

		const auth = await getValidMcpTransportAuth({
			configId: "cfg_gl",
			userId: "user_a",
			organizationId: "org_a",
			endpoint: OFFICIAL_URL,
		});

		expect(auth.accessToken).toBe("connection-token");
		expect(auth.fetch).toBeTypeOf("function");
	});

	it("keeps the generic token and no fetch for every other server", async () => {
		mockAuthorizeMcpConfigAccess.mockResolvedValue(
			gitlabConfig({ mcpServer: { key: "linear", defaultUrl: null } }),
		);
		mockGetValidAccessToken.mockResolvedValue("generic-token");

		const auth = await getValidMcpTransportAuth({
			configId: "cfg_gl",
			userId: "user_a",
			organizationId: "org_a",
			endpoint: "https://mcp.example.com/mcp",
		});

		expect(auth).toEqual({ accessToken: "generic-token" });
		expect(mockGetGitLabConnectionToken).not.toHaveBeenCalled();
	});
});

describe("getValidMcpAccessToken", () => {
	it("authorizes, then answers a GitLab config with the connection token", async () => {
		mockAuthorizeMcpConfigAccess.mockResolvedValue(gitlabConfig());
		mockGetGitLabConnectionToken.mockResolvedValue(connectionToken());

		expect(
			await getValidMcpAccessToken({
				configId: "cfg_gl",
				userId: "user_a",
				organizationId: "org_a",
			}),
		).toBe("connection-token");
		expect(mockAuthorizeMcpConfigAccess).toHaveBeenCalledWith({
			configId: "cfg_gl",
			userId: "user_a",
			organizationId: "org_a",
		});
		expect(mockGetValidAccessToken).not.toHaveBeenCalled();
	});

	it("never resolves a connection for a config the caller may not use", async () => {
		mockAuthorizeMcpConfigAccess.mockRejectedValue(
			new Error(
				"Unauthorized: You do not have access to this MCP config",
			),
		);

		await expect(
			getValidMcpAccessToken({
				configId: "cfg_gl",
				userId: "user_b",
				organizationId: "org_a",
			}),
		).rejects.toThrow(/Unauthorized/);
		expect(mockGetGitLabConnectionToken).not.toHaveBeenCalled();
	});

	it("keeps the generic path for every other server", async () => {
		mockAuthorizeMcpConfigAccess.mockResolvedValue(
			gitlabConfig({
				mcpServer: {
					key: "linear",
					defaultUrl: "https://mcp.linear.app",
				},
			}),
		);
		mockGetValidAccessToken.mockResolvedValue("linear-token");

		expect(
			await getValidMcpAccessToken({
				configId: "cfg_linear",
				userId: "user_a",
				organizationId: "org_a",
			}),
		).toBe("linear-token");
		expect(mockGetGitLabConnectionToken).not.toHaveBeenCalled();
	});
});

describe("createOAuthClientProvider — GitLab personal servers", () => {
	it("hands the SDK the connection token, no refresh token, and stores nothing", async () => {
		mockGetMcpConfigById.mockResolvedValue(gitlabConfig());
		mockGetGitLabConnectionToken.mockResolvedValue(connectionToken());

		const provider = await createOAuthClientProvider({
			configId: "cfg_gl",
			userId: "user_a",
			organizationId: "org_a",
			redirectUri: "https://app.example.com/callback",
		} as never);

		expect(await provider.tokens()).toEqual({
			access_token: "connection-token",
			token_type: "Bearer",
		});
		await provider.saveTokens({
			access_token: "sdk-token",
			refresh_token: "sdk-refresh",
			token_type: "Bearer",
		});
		await provider.invalidateCredentials?.("all");
		expect(mockUpdateMcpConfigTokens).not.toHaveBeenCalled();
		expect(mockRefreshOAuthToken).not.toHaveBeenCalled();
	});

	it("gives an organization-level GitLab config no token at all", async () => {
		mockGetMcpConfigById.mockResolvedValue(gitlabConfig({ userId: null }));
		mockGetGitLabConnectionToken.mockResolvedValue(connectionToken());

		const provider = await createOAuthClientProvider({
			configId: "cfg_gl",
			userId: "user_a",
			organizationId: "org_a",
			redirectUri: "https://app.example.com/callback",
		} as never);

		expect(await provider.tokens()).toBeUndefined();
		expect(mockGetGitLabConnectionToken).not.toHaveBeenCalled();
	});
});

describe("a GitLab config in an organization the caller has left", () => {
	it("is refused before the connection is read, classified or refreshed", async () => {
		mockGetMcpConfigById.mockResolvedValue(gitlabConfig());
		mockGetGitLabConnectionToken.mockResolvedValue(connectionToken());
		mockIsOrganizationMember.mockResolvedValue(false);

		// The organization gate every config-backed client passes first
		// (../organization-access) refuses before the config is even read.
		await expect(
			createMcpClientForConfig({
				configId: "cfg_gl",
				userId: "user_a",
				organizationId: "org_a",
			}),
		).rejects.toMatchObject({ code: "ORGANIZATION_MEMBERSHIP_REQUIRED" });
		expect(mockIsOrganizationMember).toHaveBeenCalledWith(
			"user_a",
			"org_a",
		);
		expect(mockGetGitLabConnectionToken).not.toHaveBeenCalled();
		expect(transports).toHaveLength(0);
	});

	it("a GitLab config with no organization is refused without reading any connection", async () => {
		mockGetMcpConfigById.mockResolvedValue(
			gitlabConfig({ organizationId: null }),
		);
		mockGetGitLabConnectionToken.mockResolvedValue(connectionToken());

		await expect(
			createMcpClientForConfig({
				configId: "cfg_gl",
				userId: "user_a",
				organizationId: undefined,
			}),
		).rejects.toMatchObject({ code: "OAUTH_AUTH_REQUIRED" });
		expect(mockGetGitLabConnectionToken).not.toHaveBeenCalled();
	});
});

describe("a cached GitLab client", () => {
	const open = () =>
		getCachedMcpClientForConfig({
			configId: "cfg_gl",
			userId: "user_a",
			organizationId: "org_a",
		});
	const usableConnection = (overrides: Record<string, unknown> = {}) => ({
		connected: true,
		needsReauth: false,
		generation: 1,
		...overrides,
	});

	beforeEach(async () => {
		mockGetMcpConfigById.mockResolvedValue(
			gitlabConfig({ needsReauth: false }),
		);
		mockGetGitLabConnectionToken.mockResolvedValue(connectionToken());
		mockReadStoredGitLabConnectionStatus.mockResolvedValue(
			usableConnection(),
		);
		// Warm the cache.
		expect((await open()).fromCache).toBe(false);
		expect(builtClients).toHaveLength(1);
	});

	it("is reused while its config is on and the connection is the one it was built with", async () => {
		expect((await open()).fromCache).toBe(true);
		expect(mockReadStoredGitLabConnectionStatus).toHaveBeenCalledWith({
			userId: "user_a",
			organizationId: "org_a",
		});
		expect(builtClients[0].close).not.toHaveBeenCalled();
	});

	it("is closed and refused once the caller has left the config's organization", async () => {
		mockIsOrganizationMember.mockResolvedValue(false);

		await expect(open()).rejects.toMatchObject({
			code: "ORGANIZATION_MEMBERSHIP_REQUIRED",
		});
		// The organization gate on the cached client refused it before the
		// GitLab reuse check or a rebuild could read the connection again.
		expect(mockIsOrganizationMember).toHaveBeenCalledWith(
			"user_a",
			"org_a",
		);
		expect(mockGetGitLabConnectionToken).toHaveBeenCalledTimes(1);
		expect(builtClients[0].close).toHaveBeenCalled();
		expect(builtClients).toHaveLength(1);
		// Nothing is left behind for a later call to reuse.
		mockIsOrganizationMember.mockResolvedValue(true);
		expect((await open()).fromCache).toBe(false);
	});

	it("is dropped when the reuse check cannot read what it needs", async () => {
		mockReadStoredGitLabConnectionStatus.mockRejectedValueOnce(
			new Error("connection pool timeout"),
		);

		// The entry is evicted and the client built anew (the fresh path's
		// own checks pass here), never reused unchecked.
		expect((await open()).fromCache).toBe(false);
		expect(builtClients[0].close).toHaveBeenCalled();
		expect(builtClients).toHaveLength(2);
	});

	it("is dropped, not left cached, when the check fails and the rebuild fails too", async () => {
		mockIsOrganizationMember.mockRejectedValue(
			new Error("connection pool timeout"),
		);

		await expect(open()).rejects.toThrow();
		expect(builtClients[0].close).toHaveBeenCalled();

		mockIsOrganizationMember.mockResolvedValue(true);
		expect((await open()).fromCache).toBe(false);
		expect(builtClients).toHaveLength(2);
	});

	it("is closed and refused once its config is turned off (the tile's Delete)", async () => {
		mockGetMcpConfigById.mockResolvedValue(
			gitlabConfig({ enabled: false }),
		);

		await expect(open()).rejects.toMatchObject({
			code: "CONFIG_DISABLED",
		});
		expect(builtClients[0].close).toHaveBeenCalled();
		expect(builtClients).toHaveLength(1);
	});

	it.each([
		[
			"disconnected",
			usableConnection({ connected: false }),
			{ ok: false, reason: "not-connected", message: "not connected" },
		],
		[
			"needing a reconnect",
			usableConnection({ needsReauth: true }),
			{ ok: false, reason: "needs-reauth", message: "reconnect" },
		],
	])(
		"is closed and refused once the connection is %s",
		async (_name, status, token) => {
			mockReadStoredGitLabConnectionStatus.mockResolvedValue(status);
			mockGetGitLabConnectionToken.mockResolvedValue(token);

			await expect(open()).rejects.toMatchObject({
				code: "OAUTH_AUTH_REQUIRED",
			});
			expect(builtClients[0].close).toHaveBeenCalled();
			expect(builtClients).toHaveLength(1);
		},
	);

	it("is replaced, with the new token, after a reconnect", async () => {
		mockReadStoredGitLabConnectionStatus.mockResolvedValue(
			usableConnection({ generation: 2 }),
		);
		mockGetGitLabConnectionToken.mockResolvedValue(
			connectionToken({
				accessToken: "reconnected-token",
				generation: 2,
			}),
		);

		expect((await open()).fromCache).toBe(false);
		expect(builtClients[0].close).toHaveBeenCalled();
		expect(builtClients).toHaveLength(2);
		const headers = (
			transports[1]?.opts.requestInit as {
				headers?: Record<string, string>;
			}
		)?.headers;
		expect(headers?.Authorization).toBe("Bearer reconnected-token");
	});
});
