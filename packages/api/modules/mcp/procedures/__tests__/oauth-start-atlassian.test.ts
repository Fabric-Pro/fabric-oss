/**
 * Procedure-level tests for `oauthProcedures.start` against an Atlassian config.
 *
 * Pins the discovery → DCR → authorization-URL path for the 2026-05-19 OAuth
 * fix (AC-7 in `requirements.md`; design at
 * `docs/superpowers/specs/2026-05-19-atlassian-mcp-oauth-fix-design.md` §5.4).
 *
 * Mocking strategy mirrors
 * `packages/api/modules/admin/procedures/__tests__/audit-log-via-api-key.test.ts`:
 * the procedure-builder is mocked so `.handler(fn)` captures the handler
 * function under `._handler`, then we invoke it directly with a stubbed
 * `{input, context}`. The HTTP boundary is mocked via `safeFetchOutbound`
 * with a URL-routing implementation so test order and call count don't
 * matter.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	getMcpConfigByIdInternalMock,
	getOrganizationByIdMock,
	verifyMembershipMock,
	replaceMcpOAuthRegistrationMock,
	createOauthStateMock,
	safeFetchOutboundMock,
	dbMcpConfigUpdateMock,
} = vi.hoisted(() => ({
	getMcpConfigByIdInternalMock: vi.fn(),
	getOrganizationByIdMock: vi.fn(),
	verifyMembershipMock: vi.fn(),
	replaceMcpOAuthRegistrationMock: vi.fn(),
	createOauthStateMock: vi.fn(),
	safeFetchOutboundMock: vi.fn(),
	dbMcpConfigUpdateMock: vi.fn(),
}));

vi.mock("@repo/database", async () => ({
	// The config's server is one its tenant may use (see the tenant tests).
	getMcpServerForTenant: async () => ({ isSystemProvided: true }),
	// The pure binding helpers are the real ones.
	...(await vi.importActual<Record<string, unknown>>(
		"@repo/database/prisma/queries/lib/mcp-oauth-binding",
	)),
	clearRefreshFailures: vi.fn(),
	createOauthState: (...args: unknown[]) => createOauthStateMock(...args),
	db: {
		mCPConfig: {
			update: (...args: unknown[]) => dbMcpConfigUpdateMock(...args),
		},
	},
	deleteOauthState: vi.fn(),
	getGoogleAccountEmail: vi.fn(),
	getMcpConfigByIdInternal: (...args: unknown[]) =>
		getMcpConfigByIdInternalMock(...args),
	getMcpServerDefaultTokenExpiry: () => null,
	getOauthState: vi.fn(),
	getOrganizationById: (...args: unknown[]) =>
		getOrganizationByIdMock(...args),
	refreshMcpOAuthAccessToken: vi.fn(),
	replaceMcpOAuthRegistration: (...args: unknown[]) =>
		replaceMcpOAuthRegistrationMock(...args),
	saveMcpOAuthGrant: vi.fn(),
}));

vi.mock("@repo/temporal", () => ({
	triggerMcpToolIngestion: vi.fn(),
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
	verifyOrganizationMembership: (...args: unknown[]) =>
		verifyMembershipMock(...args),
}));

// The procedure-builder mock. `.handler(fn)` returns `{ _handler: fn }` so the
// test can invoke the underlying function directly. The middleware chain
// (`.use(requirePermission(...))`, `.route`, `.input`, `.output`) is a no-op.
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

const ATLASSIAN_AUTH_SERVER_METADATA = {
	// The issuer names the AS the document is served for (RFC 8414 §3.3);
	// its endpoints may live on another host, as Atlassian's do.
	issuer: "https://mcp.atlassian.com",
	authorization_endpoint: "https://mcp.atlassian.com/v1/authorize",
	token_endpoint: "https://cf.mcp.atlassian.com/v1/token",
	registration_endpoint: "https://cf.mcp.atlassian.com/v1/register",
	revocation_endpoint: "https://cf.mcp.atlassian.com/v1/token",
	response_types_supported: ["code"],
	response_modes_supported: ["query"],
	grant_types_supported: ["authorization_code", "refresh_token"],
	token_endpoint_auth_methods_supported: [
		"client_secret_basic",
		"client_secret_post",
		"none",
	],
	code_challenge_methods_supported: ["plain", "S256"],
};

const DCR_RESPONSE = {
	client_id: "atlassian-dcr-client-id",
	client_secret: "atlassian-dcr-secret",
};

function makeAtlassianConfig(overrides: Record<string, unknown> = {}) {
	return {
		id: "cfg-atlassian-1",
		userId: "user-1",
		organizationId: null,
		baseUrl: "https://mcp.atlassian.com/v1/mcp",
		oauthClientId: null,
		encryptedOauthClientSecret: null,
		dcrRegistrationEndpoint: null,
		dcrClientMetadata: null,
		dcrRegisteredAt: null,
		oauthMetadataCache: null,
		oauthMetadataCachedAt: null,
		scopes: [],
		mcpServer: {
			id: "srv-atlassian",
			key: "atlassian",
			oauthDiscoveryUrl:
				"https://mcp.atlassian.com/.well-known/oauth-authorization-server",
			oauthAuthorizationEndpoint: null,
			oauthTokenEndpoint: null,
			defaultUrl: "https://mcp.atlassian.com/v1/mcp",
		},
		...overrides,
	};
}

function makeSlackConfig(overrides: Record<string, unknown> = {}) {
	return {
		id: "cfg-slack-1",
		userId: "user-1",
		organizationId: null,
		baseUrl: "https://mcp.slack.com/mcp",
		oauthClientId: null,
		encryptedOauthClientSecret: null,
		dcrRegistrationEndpoint: null,
		dcrClientMetadata: null,
		dcrRegisteredAt: null,
		oauthMetadataCache: null,
		oauthMetadataCachedAt: null,
		scopes: [],
		mcpServer: {
			id: "srv-slack",
			key: "slack-remote",
			oauthDiscoveryUrl: null,
			oauthAuthorizationEndpoint: null,
			oauthTokenEndpoint: null,
			defaultUrl: "https://mcp.slack.com/mcp",
		},
		...overrides,
	};
}

function jsonResponse(body: unknown, init: { status?: number } = {}) {
	return {
		ok: (init.status ?? 200) >= 200 && (init.status ?? 200) < 300,
		status: init.status ?? 200,
		json: () => Promise.resolve(body),
	} as unknown as Response;
}

/**
 * URL-routing fetch impl: matches by substring so test order and call count
 * don't matter. `dcrFails: true` flips the DCR registration response to 403.
 */
function makeAtlassianFetchImpl(opts: { dcrFails?: boolean } = {}) {
	return (url: string) => {
		if (url.includes("/.well-known/oauth-protected-resource")) {
			// Atlassian does not publish RFC 9728 protected-resource metadata.
			return Promise.resolve(jsonResponse({}, { status: 404 }));
		}
		if (
			url.includes("/.well-known/oauth-authorization-server") ||
			url.includes("/.well-known/openid-configuration")
		) {
			return Promise.resolve(
				jsonResponse(ATLASSIAN_AUTH_SERVER_METADATA),
			);
		}
		if (url === "https://cf.mcp.atlassian.com/v1/register") {
			if (opts.dcrFails) {
				return Promise.resolve(
					jsonResponse(
						{ error: "registration_denied" },
						{ status: 403 },
					),
				);
			}
			return Promise.resolve(jsonResponse(DCR_RESPONSE, { status: 201 }));
		}
		// Default: 404 so anything unexpected surfaces loudly in test failures.
		return Promise.resolve(jsonResponse({}, { status: 404 }));
	};
}

async function loadStartHandler() {
	const mod = await import("../oauth");
	return (mod.oauthProcedures.start as any)._handler as (args: {
		input: {
			configId: string;
			redirectUri: string;
			autoDiscoverAndRegister?: boolean;
		};
		context: { user: { id: string } };
	}) => Promise<{ authorizationUrl: string; state: string }>;
}

const context = { user: { id: "user-1" } };
const input = {
	configId: "cfg-atlassian-1",
	redirectUri: "https://app.fabric.pro/api/mcp/oauth/callback",
	autoDiscoverAndRegister: true,
};

beforeEach(() => {
	// resetAllMocks clears implementations (vs clearAllMocks which only
	// clears `.mock.calls`/`.mock.results`). Necessary so the
	// `mockResolvedValueOnce` queues from one test don't leak into the next.
	vi.resetAllMocks();
	vi.resetModules();
	createOauthStateMock.mockResolvedValue("opaque-state-token");
	// The registration write returns the row as written.
	replaceMcpOAuthRegistrationMock.mockImplementation(
		async (args: {
			expectedGeneration: number;
			client: Record<string, unknown> | null;
			binding: unknown;
		}) => ({
			written: true,
			generation: (args.expectedGeneration ?? 0) + 1,
			config: makeAtlassianConfig({
				...(args.client ?? {}),
				oauthBinding: args.binding,
				oauthGrantGeneration: (args.expectedGeneration ?? 0) + 1,
			}),
		}),
	);
});

describe("oauthProcedures.start — Atlassian discovery → DCR → authorize URL", () => {
	it("hits mcp.atlassian.com for discovery, NOT auth.atlassian.com", async () => {
		safeFetchOutboundMock.mockImplementation(makeAtlassianFetchImpl());

		// Pre-DCR config has null oauthClientId; post-DCR refresh returns the
		// updated config (DCR populated `oauthClientId`).
		getMcpConfigByIdInternalMock
			.mockResolvedValueOnce(makeAtlassianConfig())
			.mockResolvedValueOnce(
				makeAtlassianConfig({
					oauthClientId: "atlassian-dcr-client-id",
					encryptedOauthClientSecret:
						"encrypted:atlassian-dcr-secret",
					dcrClientMetadata: {
						token_endpoint_auth_method: "client_secret_basic",
					},
				}),
			);

		const handler = await loadStartHandler();
		await handler({ input, context });

		// Every URL containing /.well-known/ is mcp.atlassian.com-prefixed.
		const wellKnownCalls = safeFetchOutboundMock.mock.calls.filter(
			(call: unknown[]) =>
				typeof call[0] === "string" &&
				(call[0] as string).includes("/.well-known/"),
		);
		expect(wellKnownCalls.length).toBeGreaterThan(0);
		for (const call of wellKnownCalls) {
			expect(call[0] as string).toMatch(/^https:\/\/mcp\.atlassian\.com/);
			expect(call[0] as string).not.toMatch(/auth\.atlassian\.com/);
		}
	});

	it("posts the right DCR shape to cf.mcp.atlassian.com/v1/register", async () => {
		safeFetchOutboundMock.mockImplementation(makeAtlassianFetchImpl());

		getMcpConfigByIdInternalMock
			.mockResolvedValueOnce(makeAtlassianConfig())
			.mockResolvedValueOnce(
				makeAtlassianConfig({
					oauthClientId: "atlassian-dcr-client-id",
					encryptedOauthClientSecret:
						"encrypted:atlassian-dcr-secret",
					dcrClientMetadata: {
						token_endpoint_auth_method: "client_secret_basic",
					},
				}),
			);

		const handler = await loadStartHandler();
		await handler({ input, context });

		const dcrCall = safeFetchOutboundMock.mock.calls.find(
			(call: unknown[]) =>
				call[0] === "https://cf.mcp.atlassian.com/v1/register",
		);
		expect(dcrCall).toBeDefined();
		const init = dcrCall?.[1] as RequestInit & { body: string };
		expect(init.method).toBe("POST");
		expect((init.headers as Record<string, string>)["content-type"]).toBe(
			"application/json",
		);
		const body = JSON.parse(init.body);
		expect(body.client_name).toBe("Fabric Portal");
		expect(body.redirect_uris).toEqual([input.redirectUri]);
		expect(body.grant_types).toEqual([
			"authorization_code",
			"refresh_token",
		]);
		expect(body.response_types).toEqual(["code"]);
		expect(body.token_endpoint_auth_method).toBe("client_secret_basic");
	});

	it("returns an authorization URL with the right origin, path, and OAuth params", async () => {
		safeFetchOutboundMock.mockImplementation(makeAtlassianFetchImpl());

		getMcpConfigByIdInternalMock
			.mockResolvedValueOnce(makeAtlassianConfig())
			.mockResolvedValueOnce(
				makeAtlassianConfig({
					oauthClientId: "atlassian-dcr-client-id",
					encryptedOauthClientSecret:
						"encrypted:atlassian-dcr-secret",
					dcrClientMetadata: {
						token_endpoint_auth_method: "client_secret_basic",
					},
				}),
			);

		const handler = await loadStartHandler();
		const result = await handler({ input, context });

		const url = new URL(result.authorizationUrl);
		expect(url.origin).toBe("https://mcp.atlassian.com");
		expect(url.pathname).toBe("/v1/authorize");
		expect(url.searchParams.get("response_type")).toBe("code");
		expect(url.searchParams.get("client_id")).toBe(
			"atlassian-dcr-client-id",
		);
		expect(url.searchParams.get("state")).toBe("opaque-state-token");
		expect(url.searchParams.get("code_challenge_method")).toBe("S256");
		const codeChallenge = url.searchParams.get("code_challenge");
		expect(codeChallenge).toBeTruthy();
		expect((codeChallenge as string).length).toBeGreaterThan(0);
	});

	it("surfaces the Atlassian-specific error message when DCR fails", async () => {
		safeFetchOutboundMock.mockImplementation(
			makeAtlassianFetchImpl({ dcrFails: true }),
		);

		// Both pre- and post-DCR reads return the same config (DCR didn't
		// persist anything because it failed).
		getMcpConfigByIdInternalMock.mockResolvedValue(makeAtlassianConfig());

		const handler = await loadStartHandler();
		await expect(handler({ input, context })).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: expect.stringMatching(/atlassian/i),
		});
	});

	it("preserves the generic message for Slack (control case for AC-9)", async () => {
		// For Slack we just need the discovery to fail cleanly so we land in
		// the BAD_REQUEST branch. Return 404 for every fetch.
		safeFetchOutboundMock.mockResolvedValue(
			jsonResponse({}, { status: 404 }),
		);
		// Suppress the SLACK_CLIENT_ID env-creds fallback in case the dev
		// machine has it set.
		const originalSlackClientId = process.env.SLACK_CLIENT_ID;
		const originalSlackSecret = process.env.SLACK_CLIENT_SECRET;
		// `delete`, not `= undefined`: assigning undefined stores the
		// string "undefined", which reads as configured credentials.
		delete process.env.SLACK_CLIENT_ID;
		delete process.env.SLACK_CLIENT_SECRET;
		try {
			getMcpConfigByIdInternalMock.mockResolvedValue(makeSlackConfig());

			const handler = await loadStartHandler();
			const slackInput = {
				...input,
				configId: "cfg-slack-1",
				autoDiscoverAndRegister: false,
			};
			// Discovery returns null → no authorizationEndpoint → throws the
			// "Authorization endpoint not available" error, NOT the
			// Atlassian-specific one. AC-9 confirms the Atlassian copy doesn't
			// leak. As a second check, if discovery DID succeed for Slack,
			// the BAD_REQUEST branch would fire with the *generic* message
			// because Slack has no entry in OAUTH_CREDENTIAL_ERROR_MESSAGES.
			await expect(
				handler({ input: slackInput, context }),
			).rejects.toMatchObject({
				code: "BAD_REQUEST",
			});
			// Whatever the message is, it must NOT contain the Atlassian copy.
			await expect(
				handler({ input: slackInput, context }),
			).rejects.toMatchObject({
				message: expect.not.stringMatching(/atlassian/i),
			});
		} finally {
			if (originalSlackClientId === undefined) {
				delete process.env.SLACK_CLIENT_ID;
			} else {
				process.env.SLACK_CLIENT_ID = originalSlackClientId;
			}
			if (originalSlackSecret === undefined) {
				delete process.env.SLACK_CLIENT_SECRET;
			} else {
				process.env.SLACK_CLIENT_SECRET = originalSlackSecret;
			}
		}
	});

	it("does not auto-populate scopes for Atlassian (not in KNOWN_DEFAULT_SCOPES)", async () => {
		safeFetchOutboundMock.mockImplementation(makeAtlassianFetchImpl());

		getMcpConfigByIdInternalMock
			.mockResolvedValueOnce(makeAtlassianConfig())
			.mockResolvedValueOnce(
				makeAtlassianConfig({
					oauthClientId: "atlassian-dcr-client-id",
					encryptedOauthClientSecret:
						"encrypted:atlassian-dcr-secret",
					dcrClientMetadata: {
						token_endpoint_auth_method: "client_secret_basic",
					},
				}),
			);

		const handler = await loadStartHandler();
		await handler({ input, context });

		// `db.mCPConfig.update` is only called by the scope auto-population
		// block (not by DCR — that uses `replaceMcpOAuthRegistration`). Atlassian
		// shouldn't trigger it.
		const scopeUpdateCalls = dbMcpConfigUpdateMock.mock.calls.filter(
			(call: unknown[]) => {
				const args = call[0] as { data?: { scopes?: unknown } };
				return args?.data?.scopes !== undefined;
			},
		);
		expect(scopeUpdateCalls).toHaveLength(0);
	});

	it("registers, binds and starts against ONE authorization server, and hands it to the callback", async () => {
		safeFetchOutboundMock.mockImplementation(makeAtlassianFetchImpl());
		getMcpConfigByIdInternalMock
			.mockResolvedValueOnce(
				makeAtlassianConfig({ oauthGrantGeneration: 0 }),
			)
			.mockResolvedValueOnce(
				makeAtlassianConfig({
					oauthClientId: "atlassian-dcr-client-id",
					encryptedOauthClientSecret:
						"encrypted:atlassian-dcr-secret",
					dcrClientMetadata: {
						token_endpoint_auth_method: "client_secret_basic",
					},
					oauthGrantGeneration: 1,
				}),
			);

		const handler = await loadStartHandler();
		await handler({ input, context });

		// The registration replaces the client in one conditional write and
		// binds it to the AS it was registered at.
		expect(replaceMcpOAuthRegistrationMock).toHaveBeenCalledTimes(1);
		const write = replaceMcpOAuthRegistrationMock.mock.calls[0]?.[0] as {
			expectedGeneration: number;
			client: { dcrClientMetadata: Record<string, unknown> };
			binding: { authorizationServerUrl: string; tokenEndpoint: string };
		};
		expect(write.expectedGeneration).toBe(0);
		// Bound to the AS Fabric fetched the metadata for, with the
		// document's token endpoint.
		expect(write.binding).toMatchObject({
			authorizationServerUrl: "https://mcp.atlassian.com",
			tokenEndpoint: "https://cf.mcp.atlassian.com/v1/token",
		});
		// The registration response is stored from an allowlist; the secret
		// and the issuer claimed by the response are not copied, and the
		// requested auth method is recorded when the response names none.
		expect(write.client.dcrClientMetadata).toEqual({
			issuer: "https://mcp.atlassian.com",
			token_endpoint_auth_method: "client_secret_basic",
		});

		// The state row carries the same AS and the post-registration
		// generation to the callback.
		const state = createOauthStateMock.mock.calls[0]?.[0] as {
			authorizationServerSnapshot: {
				binding: { tokenEndpoint: string };
				clientId: string;
			};
			expectedGrantGeneration: number;
		};
		expect(state.expectedGrantGeneration).toBe(1);
		expect(state.authorizationServerSnapshot).toMatchObject({
			clientId: "atlassian-dcr-client-id",
			binding: { tokenEndpoint: "https://cf.mcp.atlassian.com/v1/token" },
		});
	});

	it("logs neither the client secret nor the registration response body", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		safeFetchOutboundMock.mockImplementation((url: string) =>
			url === "https://cf.mcp.atlassian.com/v1/register"
				? Promise.resolve(
						jsonResponse(
							{
								...DCR_RESPONSE,
								registration_access_token:
									"reg-access-token-value",
							},
							{ status: 201 },
						),
					)
				: makeAtlassianFetchImpl()(url),
		);
		getMcpConfigByIdInternalMock
			.mockResolvedValueOnce(makeAtlassianConfig())
			.mockResolvedValueOnce(
				makeAtlassianConfig({
					oauthClientId: "atlassian-dcr-client-id",
					encryptedOauthClientSecret:
						"encrypted:atlassian-dcr-secret",
				}),
			);

		const handler = await loadStartHandler();
		await handler({ input, context });

		const logged = JSON.stringify([
			...logSpy.mock.calls,
			...errorSpy.mock.calls,
		]);
		expect(logged).not.toContain("atlassian-dcr-secret");
		expect(logged).not.toContain("reg-access-token-value");
		expect(logged).toContain("atlassian-dcr-client-id");
		const write = replaceMcpOAuthRegistrationMock.mock.calls[0]?.[0] as {
			client: { dcrClientMetadata: Record<string, unknown> };
		};
		expect(write.client.dcrClientMetadata).not.toHaveProperty(
			"registration_access_token",
		);
		expect(write.client.dcrClientMetadata).not.toHaveProperty(
			"client_secret",
		);
		logSpy.mockRestore();
		errorSpy.mockRestore();
	});

	it("logs only the key names of a failed registration response", async () => {
		const errorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		safeFetchOutboundMock.mockImplementation((url: string) =>
			url === "https://cf.mcp.atlassian.com/v1/register"
				? Promise.resolve(
						jsonResponse(
							{
								error: "invalid_client_metadata",
								client_secret: "leaked-in-error-body",
							},
							{ status: 400 },
						),
					)
				: makeAtlassianFetchImpl()(url),
		);
		getMcpConfigByIdInternalMock.mockResolvedValue(makeAtlassianConfig());

		const handler = await loadStartHandler();
		await expect(handler({ input, context })).rejects.toBeDefined();

		const logged = JSON.stringify(errorSpy.mock.calls);
		expect(logged).not.toContain("leaked-in-error-body");
		expect(logged).toContain("client_secret");
		errorSpy.mockRestore();
	});
});
