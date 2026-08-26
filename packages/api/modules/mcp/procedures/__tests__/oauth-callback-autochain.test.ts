/**
 * Procedure-level tests for the Rovo → Atlassian Cloud OAuth auto-chain
 * (PR #1181 follow-up to PR #1180).
 *
 * Pins the contract: when a Rovo MCP OAuth callback succeeds AND the env
 * vars `ATLASSIAN_CLOUD_OAUTH_CLIENT_ID` / `ATLASSIAN_CLOUD_OAUTH_CLIENT_SECRET`
 * are set AND the config doesn't already have a Cloud token, the
 * `oauth.callback` procedure returns a `chainTo` hop with the Cloud
 * authorize URL. Otherwise `chainTo` is undefined and the popup closes
 * as today.
 *
 * The mocking strategy mirrors `oauth-start-atlassian.test.ts` — the
 * procedure-builder is mocked so `.handler(fn)` returns `{ _handler: fn }`
 * and we invoke the handler directly with a stubbed `{input}` argument.
 * The HTTP boundary is mocked via `safeFetchOutbound`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
	getOauthStateMock,
	getMcpConfigByIdInternalMock,
	updateMcpConfigTokensMock,
	clearRefreshFailuresMock,
	deleteOauthStateMock,
	createOauthStateMock,
	safeFetchOutboundMock,
	triggerToolIngestionMock,
} = vi.hoisted(() => ({
	getOauthStateMock: vi.fn(),
	getMcpConfigByIdInternalMock: vi.fn(),
	updateMcpConfigTokensMock: vi.fn(),
	clearRefreshFailuresMock: vi.fn(),
	deleteOauthStateMock: vi.fn(),
	createOauthStateMock: vi.fn(),
	safeFetchOutboundMock: vi.fn(),
	triggerToolIngestionMock: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	clearRefreshFailures: (...args: unknown[]) =>
		clearRefreshFailuresMock(...args),
	createOauthState: (...args: unknown[]) => createOauthStateMock(...args),
	db: { mCPConfig: { update: vi.fn() } },
	deleteOauthState: (...args: unknown[]) => deleteOauthStateMock(...args),
	getCachedOAuthMetadata: vi.fn(),
	getGoogleAccountEmail: vi.fn(),
	getMcpConfigByIdInternal: (...args: unknown[]) =>
		getMcpConfigByIdInternalMock(...args),
	getOauthState: (...args: unknown[]) => getOauthStateMock(...args),
	getOrganizationById: vi.fn(),
	updateMcpConfigAfterDcr: vi.fn(),
	updateMcpConfigTokens: (...args: unknown[]) =>
		updateMcpConfigTokensMock(...args),
	updateOAuthMetadataCache: vi.fn(),
}));

vi.mock("@repo/temporal", () => ({
	triggerMcpToolIngestion: (...args: unknown[]) =>
		triggerToolIngestionMock(...args),
}));

vi.mock("@repo/utils", () => ({
	decryptApiKey: vi.fn((s: string) => s),
	encryptApiKey: vi.fn((s: string) => `encrypted:${s}`),
	hashApiKey: vi.fn((s: string) => `hashed:${s}`),
}));
vi.mock("@repo/utils/url-security", () => ({
	assertSafeOutboundUrl: vi.fn(),
	safeFetchOutbound: (...args: unknown[]) => safeFetchOutboundMock(...args),
}));

vi.mock("../../../organizations/lib/membership", () => ({
	verifyOrganizationMembership: vi.fn(),
}));

vi.mock("../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => ({ _handler: fn }),
	});
	return {
		publicProcedure: chainable,
		tenantProtectedProcedure: chainable,
		requirePermission: () => () => ({}),
		Permissions: {
			MCP_CONNECT: "mcp:connect",
			MCP_UPDATE: "mcp:update",
		} as const,
	};
});

vi.mock("@orpc/server", () => ({
	ORPCError: class extends Error {
		readonly code: string;
		constructor(code: string, opts?: { message?: string }) {
			super(opts?.message ?? code);
			this.code = code;
		}
	},
}));

import { oauthProcedures } from "../oauth";

const handler = (
	oauthProcedures.callback as unknown as {
		_handler: (args: {
			input: { code?: string; state?: string; error?: string };
		}) => Promise<{
			success: boolean;
			message: string;
			chainTo?: { type: "atlassian_cloud"; authorizationUrl: string };
		}>;
	}
)._handler;

function tokenResponse(body: Record<string, unknown> = {}) {
	return {
		ok: true,
		status: 200,
		json: () =>
			Promise.resolve({
				access_token: "rovo-access-token",
				refresh_token: "rovo-refresh-token",
				expires_in: 3600,
				...body,
			}),
	} as unknown as Response;
}

const ATLASSIAN_STATE = {
	configId: "cfg_atlassian_1",
	userId: "user_1",
	organizationId: null as string | null,
	codeVerifier: "verifier",
	redirectUri: "https://staging.fabric.pro/api/mcp/oauth/callback",
	expiresAt: new Date(Date.now() + 600_000),
	mcpServerId: "srv-atlassian",
};

function makeAtlassianConfig(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		id: "cfg_atlassian_1",
		userId: "user_1",
		organizationId: null,
		mcpServerId: "srv-atlassian",
		baseUrl: "https://mcp.atlassian.com/v1/mcp",
		oauthClientId: "rovo-client",
		encryptedOauthClientSecret: "secret",
		encryptedAtlassianCloudAccessToken: null,
		enabled: true,
		displayName: "Atlassian",
		mcpServer: {
			id: "srv-atlassian",
			key: "atlassian",
			name: "Atlassian (Jira & Confluence)",
			oauthDiscoveryUrl:
				"https://mcp.atlassian.com/.well-known/oauth-authorization-server",
			oauthAuthorizationEndpoint: null,
			oauthTokenEndpoint: null,
			defaultUrl: "https://mcp.atlassian.com/v1/mcp",
		},
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	clearRefreshFailuresMock.mockResolvedValue(undefined);
	deleteOauthStateMock.mockResolvedValue(undefined);
	updateMcpConfigTokensMock.mockResolvedValue(undefined);
	triggerToolIngestionMock.mockResolvedValue(undefined);
	createOauthStateMock.mockResolvedValue("chained-state-token");
	safeFetchOutboundMock.mockImplementation(async (url: string) => {
		if (url.includes("slack")) {
			if (url.includes("/.well-known/")) {
				return {
					ok: true,
					status: 200,
					json: async () => ({
						token_endpoint: "https://slack.com/api/oauth.v2.access",
					}),
				};
			}
			if (url.includes("oauth.v2.access")) {
				return tokenResponse();
			}
		}
		if (url.includes("/oauth-authorization-server")) {
			return {
				ok: true,
				status: 200,
				json: async () => ({
					token_endpoint: "https://cf.mcp.atlassian.com/v1/token",
				}),
			};
		}
		if (url.includes("/v1/token") || url.includes("/oauth/token")) {
			return tokenResponse();
		}
		return { ok: false, status: 404, json: async () => null };
	});
});

afterEach(() => {
	delete process.env.ATLASSIAN_CLOUD_OAUTH_CLIENT_ID;
	delete process.env.ATLASSIAN_CLOUD_OAUTH_CLIENT_SECRET;
});

describe("oauth.callback — Atlassian Cloud auto-chain", () => {
	it("returns chainTo when Atlassian Rovo + env vars set + no Cloud token", async () => {
		process.env.ATLASSIAN_CLOUD_OAUTH_CLIENT_ID = "cloud-client-id";
		process.env.ATLASSIAN_CLOUD_OAUTH_CLIENT_SECRET = "cloud-secret";
		getOauthStateMock.mockResolvedValue(ATLASSIAN_STATE);
		getMcpConfigByIdInternalMock.mockResolvedValue(makeAtlassianConfig());

		const result = await handler({
			input: { code: "rovo-code", state: "rovo-state" },
		});

		expect(result.success).toBe(true);
		expect(result.chainTo).toBeDefined();
		expect(result.chainTo?.type).toBe("atlassian_cloud");
		expect(result.chainTo?.authorizationUrl).toMatch(
			/^https:\/\/auth\.atlassian\.com\/authorize\?/,
		);
		const url = new URL(result.chainTo!.authorizationUrl);
		expect(url.searchParams.get("audience")).toBe("api.atlassian.com");
		expect(url.searchParams.get("client_id")).toBe("cloud-client-id");
		expect(url.searchParams.get("scope")).toContain(
			"write:attachment:jira",
		);
		expect(url.searchParams.get("redirect_uri")).toBe(
			"https://staging.fabric.pro/api/mcp/atlassian-cloud/callback",
		);
		expect(url.searchParams.get("state")).toBe("chained-state-token");
		expect(url.searchParams.get("code_challenge_method")).toBe("S256");
		expect(createOauthStateMock).toHaveBeenCalled();
	});

	it("returns no chainTo when env vars are NOT set", async () => {
		getOauthStateMock.mockResolvedValue(ATLASSIAN_STATE);
		getMcpConfigByIdInternalMock.mockResolvedValue(makeAtlassianConfig());

		const result = await handler({
			input: { code: "rovo-code", state: "rovo-state" },
		});

		expect(result.success).toBe(true);
		expect(result.chainTo).toBeUndefined();
		expect(createOauthStateMock).not.toHaveBeenCalled();
	});

	it("returns no chainTo when config already has Cloud token", async () => {
		process.env.ATLASSIAN_CLOUD_OAUTH_CLIENT_ID = "cloud-client-id";
		process.env.ATLASSIAN_CLOUD_OAUTH_CLIENT_SECRET = "cloud-secret";
		getOauthStateMock.mockResolvedValue(ATLASSIAN_STATE);
		getMcpConfigByIdInternalMock.mockResolvedValue(
			makeAtlassianConfig({
				encryptedAtlassianCloudAccessToken: "already-have-it",
			}),
		);

		const result = await handler({
			input: { code: "rovo-code", state: "rovo-state" },
		});

		expect(result.success).toBe(true);
		expect(result.chainTo).toBeUndefined();
	});

	it("returns no chainTo for non-Atlassian MCP (e.g. Slack)", async () => {
		process.env.ATLASSIAN_CLOUD_OAUTH_CLIENT_ID = "cloud-client-id";
		process.env.ATLASSIAN_CLOUD_OAUTH_CLIENT_SECRET = "cloud-secret";
		getOauthStateMock.mockResolvedValue({
			...ATLASSIAN_STATE,
			configId: "cfg_slack",
			mcpServerId: "srv-slack",
		});
		getMcpConfigByIdInternalMock.mockResolvedValue({
			...makeAtlassianConfig(),
			id: "cfg_slack",
			mcpServerId: "srv-slack",
			baseUrl: "https://mcp.slack.com/mcp",
			mcpServer: {
				id: "srv-slack",
				key: "slack-remote",
				oauthDiscoveryUrl: "https://mcp.slack.com/.well-known/oauth",
				defaultUrl: "https://mcp.slack.com/mcp",
			},
		});

		const result = await handler({
			input: { code: "code", state: "state" },
		});

		expect(result.success).toBe(true);
		expect(result.chainTo).toBeUndefined();
	});

	it("returns no chainTo when Atlassian hostname doesn't strict-match", async () => {
		// Lookalike domain — must not chain credentials onto it.
		process.env.ATLASSIAN_CLOUD_OAUTH_CLIENT_ID = "cloud-client-id";
		process.env.ATLASSIAN_CLOUD_OAUTH_CLIENT_SECRET = "cloud-secret";
		getOauthStateMock.mockResolvedValue(ATLASSIAN_STATE);
		getMcpConfigByIdInternalMock.mockResolvedValue(
			makeAtlassianConfig({
				baseUrl: "https://evil.mcp.atlassian.com.attacker.example/",
				mcpServer: {
					...(makeAtlassianConfig().mcpServer as Record<
						string,
						unknown
					>),
					key: "custom-tool",
					oauthDiscoveryUrl: null,
				},
			}),
		);

		const result = await handler({
			input: { code: "code", state: "state" },
		});

		expect(result.success).toBe(true);
		expect(result.chainTo).toBeUndefined();
	});

	it("chainTo redirect_uri is derived from the primary callback origin", async () => {
		process.env.ATLASSIAN_CLOUD_OAUTH_CLIENT_ID = "cloud-client-id";
		process.env.ATLASSIAN_CLOUD_OAUTH_CLIENT_SECRET = "cloud-secret";
		// Prod-style redirect URI on the state record — chain should
		// follow that origin, not a hardcoded staging URL.
		getOauthStateMock.mockResolvedValue({
			...ATLASSIAN_STATE,
			redirectUri: "https://fabric.pro/api/mcp/oauth/callback",
		});
		getMcpConfigByIdInternalMock.mockResolvedValue(makeAtlassianConfig());

		const result = await handler({
			input: { code: "rovo-code", state: "rovo-state" },
		});

		expect(result.chainTo?.authorizationUrl).toContain(
			encodeURIComponent(
				"https://fabric.pro/api/mcp/atlassian-cloud/callback",
			),
		);
	});

	it("chainTo includes required granular Jira scopes for attachment upload", async () => {
		process.env.ATLASSIAN_CLOUD_OAUTH_CLIENT_ID = "cloud-client-id";
		process.env.ATLASSIAN_CLOUD_OAUTH_CLIENT_SECRET = "cloud-secret";
		getOauthStateMock.mockResolvedValue(ATLASSIAN_STATE);
		getMcpConfigByIdInternalMock.mockResolvedValue(makeAtlassianConfig());

		const result = await handler({
			input: { code: "code", state: "state" },
		});

		const url = new URL(result.chainTo!.authorizationUrl);
		const scope = url.searchParams.get("scope") ?? "";
		expect(scope).toContain("read:attachment:jira");
		expect(scope).toContain("write:attachment:jira");
		expect(scope).toContain("offline_access");
		expect(scope).toContain("read:me");
	});

	it("returns no chainTo when the chained createOauthState throws", async () => {
		// Defensive — the helper must never propagate an exception that
		// would break the primary Rovo connect flow.
		process.env.ATLASSIAN_CLOUD_OAUTH_CLIENT_ID = "cloud-client-id";
		process.env.ATLASSIAN_CLOUD_OAUTH_CLIENT_SECRET = "cloud-secret";
		getOauthStateMock.mockResolvedValue(ATLASSIAN_STATE);
		getMcpConfigByIdInternalMock.mockResolvedValue(makeAtlassianConfig());
		createOauthStateMock.mockRejectedValueOnce(new Error("db dead"));

		const result = await handler({
			input: { code: "rovo-code", state: "rovo-state" },
		});

		expect(result.success).toBe(true); // primary flow stays successful
		expect(result.chainTo).toBeUndefined();
	});
});
