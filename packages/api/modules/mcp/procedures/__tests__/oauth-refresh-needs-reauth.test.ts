/**
 * Procedure-level tests for the `needsReauth` circuit-breaker guard on
 * `oauthProcedures.refresh`.
 *
 * The 3-strike breaker (`recordRefreshFailure`) is now enforced across the
 * refresh paths, but this user-triggered procedure reloaded the config and
 * POSTed the stored refresh token to the provider without ever consulting the
 * flag — a separate bypass that kept a known-dead credential in circulation.
 *
 * Mocking strategy mirrors `oauth-start-atlassian.test.ts`: the
 * procedure-builder is mocked so `.handler(fn)` captures the handler under
 * `._handler`, then we invoke it directly with a stubbed `{input, context}`.
 * The HTTP boundary is mocked via `safeFetchOutbound`, and `decryptApiKey` is
 * asserted on directly so the test pins that a tripped config is refused
 * *before* the refresh token is decrypted, not merely before the POST.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	getMcpConfigByIdInternalMock,
	getOrganizationByIdMock,
	verifyMembershipMock,
	updateMcpConfigTokensMock,
	safeFetchOutboundMock,
	decryptApiKeyMock,
} = vi.hoisted(() => ({
	getMcpConfigByIdInternalMock: vi.fn(),
	getOrganizationByIdMock: vi.fn(),
	verifyMembershipMock: vi.fn(),
	updateMcpConfigTokensMock: vi.fn(),
	safeFetchOutboundMock: vi.fn(),
	decryptApiKeyMock: vi.fn((s: string) => s),
}));

vi.mock("@repo/database", () => ({
	clearRefreshFailures: vi.fn(),
	createOauthState: vi.fn(),
	db: { mCPConfig: { update: vi.fn() } },
	deleteOauthState: vi.fn(),
	getCachedOAuthMetadata: vi.fn(),
	getGoogleAccountEmail: vi.fn(),
	getMcpConfigByIdInternal: (...args: unknown[]) =>
		getMcpConfigByIdInternalMock(...args),
	getOauthState: vi.fn(),
	getOrganizationById: (...args: unknown[]) =>
		getOrganizationByIdMock(...args),
	updateMcpConfigAfterDcr: vi.fn(),
	updateMcpConfigTokens: (...args: unknown[]) =>
		updateMcpConfigTokensMock(...args),
	updateOAuthMetadataCache: vi.fn(),
}));

vi.mock("@repo/temporal", () => ({
	triggerMcpToolIngestion: vi.fn(),
}));

vi.mock("@repo/utils", () => ({
	decryptApiKey: (...args: unknown[]) => decryptApiKeyMock(...args),
	encryptApiKey: vi.fn((s: string) => `encrypted:${s}`),
	hashApiKey: vi.fn((s: string) => `hashed:${s}`),
}));
vi.mock("@repo/utils/url-security", () => ({
	assertSafeOutboundUrl: vi.fn(),
	safeFetchOutbound: (...args: unknown[]) => safeFetchOutboundMock(...args),
}));

vi.mock("../../../organizations/lib/membership", () => ({
	verifyOrganizationMembership: (...args: unknown[]) =>
		verifyMembershipMock(...args),
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
	oauthProcedures.refresh as unknown as {
		_handler: (args: {
			input: { configId: string };
			context: { user: { id: string } };
		}) => Promise<{ success: boolean }>;
	}
)._handler;

function makeConfig(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		id: "cfg_1",
		userId: "user_1",
		organizationId: null,
		displayName: "Example MCP",
		authType: "OAUTH2",
		baseUrl: "https://mcp.example.com/v1/mcp",
		oauthClientId: "client-id",
		encryptedOauthClientSecret: "client-secret",
		encryptedRefreshToken: "refresh-token",
		needsReauth: false,
		mcpServer: {
			key: "example",
			// A `/.well-known/` discovery URL keeps endpoint resolution to a
			// single stubbed fetch instead of the multi-hop RFC 9728 path.
			oauthDiscoveryUrl:
				"https://mcp.example.com/.well-known/oauth-authorization-server",
			oauthTokenEndpoint: "https://mcp.example.com/token",
			defaultUrl: "https://mcp.example.com/v1/mcp",
		},
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	decryptApiKeyMock.mockImplementation((s: string) => s);
	updateMcpConfigTokensMock.mockResolvedValue(undefined);
	safeFetchOutboundMock.mockImplementation(async (url: string) => {
		if (url.includes("/token")) {
			return {
				ok: true,
				status: 200,
				json: async () => ({
					access_token: "new-access-token",
					refresh_token: "new-refresh-token",
					expires_in: 3600,
				}),
			};
		}
		// Discovery misses, so the endpoint resolves from the server config.
		return { ok: false, status: 404, json: async () => null };
	});
});

describe("oauth.refresh — needsReauth circuit breaker", () => {
	it("refuses a tripped config before decrypting or posting the refresh token", async () => {
		getMcpConfigByIdInternalMock.mockResolvedValue(
			makeConfig({ needsReauth: true }),
		);

		await expect(
			handler({
				input: { configId: "cfg_1" },
				context: { user: { id: "user_1" } },
			}),
		).rejects.toMatchObject({
			code: "PRECONDITION_FAILED",
			message: expect.stringContaining("re-authenticate"),
		});

		// Nothing reached the provider, and the stored refresh token was never
		// decrypted — the guard sits ahead of both.
		expect(safeFetchOutboundMock).not.toHaveBeenCalled();
		expect(decryptApiKeyMock).not.toHaveBeenCalled();
		expect(updateMcpConfigTokensMock).not.toHaveBeenCalled();
	});

	it("still refreshes normally when the breaker has not tripped", async () => {
		getMcpConfigByIdInternalMock.mockResolvedValue(makeConfig());

		const result = await handler({
			input: { configId: "cfg_1" },
			context: { user: { id: "user_1" } },
		});

		expect(result).toEqual({ success: true });
		expect(updateMcpConfigTokensMock).toHaveBeenCalledTimes(1);
	});

	it("no-ops a non-OAUTH2 config even if it still carries a refresh token and a tripped breaker", async () => {
		// A row edited from OAUTH2 to API_KEY can still carry leftover OAuth
		// fields from its earlier life. The scoping guard must reject on
		// `authType` alone, before the `needsReauth` breaker check ever runs —
		// so this also covers a config that was never scoped correctly, not
		// just the well-behaved case where `needsReauth` is false.
		getMcpConfigByIdInternalMock.mockResolvedValue(
			makeConfig({
				authType: "API_KEY",
				needsReauth: true,
				encryptedRefreshToken: "refresh-token",
			}),
		);

		const result = await handler({
			input: { configId: "cfg_1" },
			context: { user: { id: "user_1" } },
		});

		expect(result).toEqual({ success: false });

		// Narrowing the guard to `cfg.authType === "OAUTH2" &&
		// cfg.needsReauth` instead — the obvious "simplification" — would let
		// this fixture fall through to the refresh logic, which decrypts both
		// credentials, POSTs to the token endpoint and persists what comes
		// back. With this fixture that returns `{ success: true }`, so the
		// assertion above catches it too.
		//
		// These assert the part that actually matters and would survive a
		// change of fixture: a config the caller has no OAuth grant for must
		// not cause an outbound token request at all. A fall-through that
		// happened to end in `{ success: false }` — a missing client id, say —
		// would satisfy the return value while still having contacted the
		// provider.
		expect(safeFetchOutboundMock).not.toHaveBeenCalled();
		expect(decryptApiKeyMock).not.toHaveBeenCalled();
		expect(updateMcpConfigTokensMock).not.toHaveBeenCalled();
	});
});
