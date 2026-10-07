/**
 * The MCP OAuth procedures for a person's GitLab MCP server write and refresh
 * the person's ONE GitLab connection through the connection service.
 *
 * - `mcp.oauth.refresh` refreshes the person's connection with the client
 *   that issued it — for a DCR grant, the `gitlab-official` config's own
 *   registration. A legacy token copy on that config is not a connection:
 *   nothing adopts it, so a person with only a copy has nothing to refresh.
 * - `mcp.oauth.callback` reads the new token's GitLab profile from the
 *   instance that issued it, never from a hardcoded gitlab.com.
 *
 * The procedures and the connection service are real; the database is the
 * in-memory GitLab fake (where-clauses applied, real per-key lock).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	createGitLabFakeDb,
	encryptedCredential,
	readCredential,
} from "../../../../integrations/__tests__/gitlab/helpers/gitlab-fake-db";

const state = vi.hoisted(() => ({
	fake: null as unknown as ReturnType<
		typeof import("../../../../integrations/__tests__/gitlab/helpers/gitlab-fake-db").createGitLabFakeDb
	>,
	config: null as Record<string, unknown> | null,
	oauthState: null as Record<string, unknown> | null,
}));

const persistGitLabToken = vi.hoisted(() =>
	vi.fn(async () => ({ written: true, integrationId: "wi-new" })),
);
const safeFetchOutbound = vi.hoisted(() => vi.fn());

vi.mock("@repo/database", async (importOriginal) => ({
	...(await importOriginal<object>()),
	// The config's server is one its tenant may use (see the tenant tests).
	getMcpServerForTenant: async () => ({ isSystemProvided: true }),
	get db() {
		return state.fake.db;
	},
	getMcpConfigByIdInternal: async () => state.config,
	getOauthState: async () => state.oauthState,
	clearRefreshFailures: vi.fn(async () => undefined),
	deleteOauthState: vi.fn(async () => undefined),
	saveMcpOAuthGrant: vi.fn(async () => {
		throw new Error("a GitLab personal config never stores its own token");
	}),
	getOrganizationById: vi.fn(async () => null),
}));

vi.mock("@repo/database/prisma/queries/lib/refresh-lock", () => ({
	withRefreshLock: (
		keys: string | readonly string[],
		fn: (
			tx: unknown,
			assertBudget: (ms: number) => void,
		) => Promise<unknown>,
	) => state.fake.withLock(keys, fn as never),
}));

vi.mock("@repo/utils", async (importOriginal) => {
	const helpers = await import(
		"../../../../integrations/__tests__/gitlab/helpers/gitlab-fake-db"
	);
	return {
		...(await importOriginal<object>()),
		encryptApiKey: helpers.fakeEncrypt,
		decryptApiKey: helpers.fakeDecrypt,
	};
});

vi.mock("@repo/utils/url-security", async (importOriginal) => ({
	// The real address checks (GitLab instance addresses are validated with
	// them); only the transport is replaced.
	...(await importOriginal<object>()),
	assertSafeOutboundUrl: () => undefined,
	safeFetchOutbound,
}));

vi.mock("@repo/temporal", () => ({
	triggerMcpToolIngestion: vi.fn(async () => undefined),
}));

vi.mock("../../integrations/lib/gitlab-token", () => ({
	persistGitLabToken,
}));

vi.mock("../../organizations/lib/membership", () => ({
	verifyOrganizationMembership: vi.fn(async () => null),
}));

vi.mock("../../../orpc/procedures", () => {
	const builder: Record<string, unknown> = {};
	builder.use = () => builder;
	builder.route = () => builder;
	builder.input = () => builder;
	builder.output = () => builder;
	builder.handler = (fn: unknown) => ({ handler: fn });
	return {
		tenantProtectedProcedure: builder,
		publicProcedure: builder,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requirePermission: () => (c: unknown) => c,
		// The real resolver's rule for the organization a request names (the
		// input's, else the session's; an explicit null suppresses the session
		// fallback; none refused when required). Membership and role are
		// exercised for real in gitlab-request-authorization.test.ts.
		authorizeInputOrganization: async (
			_permission: string,
			orgId: string | null | undefined,
			ctx: { session?: { activeOrganizationId?: string | null } },
			opts?: { requireOrganization?: boolean },
		) => {
			const resolved =
				orgId ||
				(orgId === null
					? undefined
					: ctx.session?.activeOrganizationId || undefined);
			if (!resolved && opts?.requireOrganization) {
				throw new Error(
					"This operation requires an organization context",
				);
			}
			return resolved;
		},
	};
});

import {
	buildMcpOAuthBinding,
	withCredentialFingerprint,
} from "@repo/database/prisma/queries/lib/mcp-oauth-binding";
import { resetGitLabConnectionDepsForTests } from "@repo/integrations/gitlab";
import { oauthClientFingerprint } from "../lib/oauth-authorization-server";
import { oauthProcedures } from "../procedures/oauth";

/** The OAuth state fields `start` writes for a flow bound to `tokenEndpoint`. */
function flowFor(tokenEndpoint: string, clientId: string) {
	return {
		authorizationServerSnapshot: {
			clientId,
			// These configs hold a public DCR client (no secret).
			clientFingerprint: oauthClientFingerprint({
				oauthClientId: clientId,
				encryptedOauthClientSecret: null,
			}),
			binding: {
				authorizationServerUrl: new URL(tokenEndpoint).origin,
				tokenEndpoint,
				authorizationServerMetadata: { token_endpoint: tokenEndpoint },
				source: "discovery",
				boundAt: "2026-10-06T00:00:00.000Z",
			},
		},
		expectedGrantGeneration: 0,
	};
}

type Handler = (args: {
	input: Record<string, unknown>;
	context?: Record<string, unknown>;
}) => Promise<Record<string, unknown>>;
const handlerOf = (procedure: unknown) =>
	(procedure as { handler: Handler }).handler;

const officialServer = {
	id: "srv-official",
	key: "gitlab-official",
	defaultUrl: "https://gitlab.com/api/v4/mcp",
};

/** Production's DCR shape: a usable grant on the MCP copy, no WI row. */
function dcrOnlyCopy() {
	return {
		id: "cfg-official",
		userId: "user-2",
		organizationId: "org-example",
		mcpServerId: officialServer.id,
		baseUrl: null,
		oauthClientId: "dcr-client",
		encryptedOauthClientSecret: null,
		dcrClientMetadata: { token_endpoint_auth_method: "none" },
		encryptedAccessToken: "enc:dcr-access",
		encryptedRefreshToken: "enc:dcr-refresh",
		tokenExpiresAt: new Date(Date.now() + 3_600_000),
		needsReauth: false,
		enabled: true,
		authType: "OAUTH2",
		createdAt: new Date("2026-01-01T00:00:00Z"),
		updatedAt: new Date("2026-01-01T00:00:00Z"),
	};
}

const fetchMock = vi.fn();

beforeEach(() => {
	vi.clearAllMocks();
	fetchMock.mockReset();
	vi.stubGlobal("fetch", fetchMock);
	vi.stubEnv("GITLAB_CLIENT_ID", "app-client");
	resetGitLabConnectionDepsForTests();
	state.fake = createGitLabFakeDb({ mCPServer: [officialServer] });
	state.config = null;
	state.oauthState = null;
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("mcp.oauth.refresh — GitLab personal server", () => {
	it("refreshes the person's connection with the DCR client that issued it", async () => {
		state.fake = createGitLabFakeDb({
			mCPServer: [officialServer],
			// The registration stays, bound to gitlab.com by the connect flow;
			// the token copy is gone.
			mCPConfig: [
				{
					...dcrOnlyCopy(),
					encryptedAccessToken: null,
					encryptedRefreshToken: null,
					tokenExpiresAt: null,
					oauthBinding: withCredentialFingerprint(
						buildMcpOAuthBinding({
							authorizationServerUrl: "https://gitlab.com",
							tokenEndpoint: "https://gitlab.com/oauth/token",
							source: "connection",
						}),
						{
							oauthClientId: "dcr-client",
							encryptedOauthClientSecret: null,
							encryptedRefreshToken: null,
						},
					),
				},
			],
			workflowIntegration: [
				{
					id: "wi-1",
					userId: "user-2",
					organizationId: "org-example",
					provider: "GITLAB",
					name: "GitLab",
					workflowId: null,
					isActive: true,
					credentials: encryptedCredential({
						access_token: "wi-access",
						refresh_token: "wi-refresh",
						expires_in: 7200,
						token_obtained_at: new Date().toISOString(),
						issuer: {
							kind: "mcp-dcr",
							mcpConfigId: "cfg-official",
							serverKey: "gitlab-official",
							clientId: "dcr-client",
							origin: "https://gitlab.com",
						},
						connectionGeneration: 1,
					}),
					settings: {},
					createdAt: new Date("2026-01-01T00:00:00Z"),
					updatedAt: new Date("2026-01-01T00:00:00Z"),
				},
			],
		});
		state.config = {
			...dcrOnlyCopy(),
			mcpServer: { key: "gitlab-official" },
		};
		fetchMock.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					access_token: "refreshed-access",
					refresh_token: "refreshed-refresh",
					token_type: "bearer",
					expires_in: 7200,
				}),
				{ status: 200 },
			),
		);

		const result = await handlerOf(oauthProcedures.refresh)({
			input: { configId: "cfg-official" },
			context: { user: { id: "user-2" } },
		});

		expect(result).toEqual({ success: true });
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://gitlab.com/oauth/token");
		const body = new URLSearchParams(String(init.body));
		expect(body.get("client_id")).toBe("dcr-client");
		expect(body.get("refresh_token")).toBe("wi-refresh");
		const rows = state.fake.tables.workflowIntegration;
		expect(rows).toHaveLength(1);
		expect(readCredential(rows[0]).refresh_token).toBe("refreshed-refresh");
	});

	it("does not adopt a legacy MCP token copy: with no connection there is nothing to refresh", async () => {
		state.fake = createGitLabFakeDb({
			mCPServer: [officialServer],
			mCPConfig: [dcrOnlyCopy()],
		});
		state.config = {
			...dcrOnlyCopy(),
			mcpServer: { key: "gitlab-official" },
		};

		const result = await handlerOf(oauthProcedures.refresh)({
			input: { configId: "cfg-official" },
			context: { user: { id: "user-2" } },
		});

		expect(result).toEqual({ success: false });
		expect(fetchMock).not.toHaveBeenCalled();
		expect(state.fake.tables.workflowIntegration).toHaveLength(0);
	});

	it("still refuses a config owned by someone else before touching any connection", async () => {
		state.fake = createGitLabFakeDb({
			mCPServer: [officialServer],
			mCPConfig: [dcrOnlyCopy()],
		});
		state.config = {
			...dcrOnlyCopy(),
			mcpServer: { key: "gitlab-official" },
		};

		await expect(
			handlerOf(oauthProcedures.refresh)({
				input: { configId: "cfg-official" },
				context: { user: { id: "user-1" } },
			}),
		).rejects.toThrow("You do not have access to this MCP config");
		expect(fetchMock).not.toHaveBeenCalled();
		expect(state.fake.tables.workflowIntegration).toHaveLength(0);
	});
});

describe("mcp.oauth.callback — GitLab personal server on gitlab.com", () => {
	it("exchanges the code on gitlab.com with redirects refused and records the gitlab.com origin", async () => {
		state.oauthState = {
			userId: "user-2",
			organizationId: "org-example",
			configId: "cfg-official",
			redirectUri: "https://app.example.com/callback",
			codeVerifier: "verifier",
			expiresAt: new Date(Date.now() + 600_000),
		};
		state.config = {
			id: "cfg-official",
			userId: "user-2",
			organizationId: "org-example",
			baseUrl: null,
			oauthClientId: "dcr-client",
			encryptedOauthClientSecret: null,
			dcrClientMetadata: { token_endpoint_auth_method: "none" },
			enabled: false,
			authType: "OAUTH2",
			mcpServerId: officialServer.id,
			mcpServer: {
				key: "gitlab-official",
				defaultUrl: officialServer.defaultUrl,
			},
		};
		// What `start` resolved for this flow: the callback uses exactly that.
		state.config = { ...state.config, oauthGrantGeneration: 0 };
		state.oauthState = {
			...state.oauthState,
			...flowFor(
				"https://gitlab.com/oauth/token",
				String(state.config.oauthClientId),
			),
		};
		fetchMock.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					access_token: "com-access",
					refresh_token: "com-refresh",
					expires_in: 7200,
					scope: "api read_user",
				}),
				{ status: 200 },
			),
		);
		fetchMock.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					id: 9,
					username: "dev",
					name: "Dev",
					avatar_url: null,
				}),
				{ status: 200 },
			),
		);

		const result = await handlerOf(oauthProcedures.callback)({
			input: { code: "code", state: "state" },
		});

		expect(result).toMatchObject({ success: true });
		expect(safeFetchOutbound).not.toHaveBeenCalled();
		expect(fetchMock).toHaveBeenCalledTimes(2);
		const [exchangeUrl, exchangeInit] = fetchMock.mock.calls[0] as [
			string,
			RequestInit,
		];
		expect(exchangeUrl).toBe("https://gitlab.com/oauth/token");
		expect(exchangeInit.redirect).toBe("error");
		expect(String(exchangeInit.body)).toContain("code_verifier=verifier");
		expect(persistGitLabToken).toHaveBeenCalledWith(
			expect.objectContaining({
				issuer: expect.objectContaining({
					kind: "mcp-dcr",
					clientId: "dcr-client",
					origin: "https://gitlab.com",
				}),
			}),
		);
	});
});

describe("mcp.oauth.callback — GitLab personal server on a self-hosted instance", () => {
	it("reads the profile from the instance that issued the token and records that origin", async () => {
		state.oauthState = {
			userId: "user-2",
			organizationId: "org-example",
			configId: "cfg-self",
			redirectUri: "https://app.example.com/callback",
			codeVerifier: "verifier",
			expiresAt: new Date(Date.now() + 600_000),
		};
		state.config = {
			id: "cfg-self",
			userId: "user-2",
			organizationId: "org-example",
			baseUrl: "https://gitlab.example.com/api/v4/mcp",
			oauthClientId: "self-dcr-client",
			encryptedOauthClientSecret: null,
			dcrClientMetadata: { token_endpoint_auth_method: "none" },
			enabled: false,
			authType: "OAUTH2",
			mcpServerId: officialServer.id,
			mcpServer: { key: "gitlab-official", defaultUrl: null },
		};
		// What `start` resolved for this flow: the callback uses exactly that.
		state.config = { ...state.config, oauthGrantGeneration: 0 };
		state.oauthState = {
			...state.oauthState,
			...flowFor(
				"https://gitlab.example.com/oauth/token",
				String(state.config.oauthClientId),
			),
		};
		safeFetchOutbound.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					access_token: "instance-access",
					refresh_token: "instance-refresh",
					expires_in: 7200,
					scope: "api read_user",
				}),
				{ status: 200 },
			),
		);
		// The profile request goes to a self-hosted instance, so it travels
		// through the outbound guard too (`gitlabOutboundFetch`).
		safeFetchOutbound.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					id: 7,
					username: "dev",
					name: "Dev",
					avatar_url: null,
				}),
				{ status: 200 },
			),
		);

		const result = await handlerOf(oauthProcedures.callback)({
			input: { code: "code", state: "state" },
		});

		expect(result).toMatchObject({ success: true });
		expect(fetchMock).not.toHaveBeenCalled();
		expect(safeFetchOutbound).toHaveBeenCalledTimes(2);
		const [exchangeUrl, exchangeInit] = safeFetchOutbound.mock.calls[0] as [
			string,
			RequestInit,
		];
		expect(exchangeUrl).toBe("https://gitlab.example.com/oauth/token");
		expect(exchangeInit.redirect).toBe("error");
		const [url, init] = safeFetchOutbound.mock.calls[1] as [
			string,
			RequestInit,
		];
		expect(url).toBe("https://gitlab.example.com/api/v4/user");
		expect(init.headers).toMatchObject({
			Authorization: "Bearer instance-access",
		});
		expect(persistGitLabToken).toHaveBeenCalledWith(
			expect.objectContaining({
				issuer: expect.objectContaining({
					kind: "mcp-dcr",
					clientId: "self-dcr-client",
					origin: "https://gitlab.example.com",
				}),
			}),
		);
	});

	it("refuses a token endpoint on a non-https instance before the code exchange: no request at all, nothing recorded", async () => {
		state.oauthState = {
			userId: "user-2",
			organizationId: "org-example",
			configId: "cfg-self",
			redirectUri: "https://app.example.com/callback",
			codeVerifier: "verifier",
			expiresAt: new Date(Date.now() + 600_000),
		};
		state.config = {
			id: "cfg-self",
			userId: "user-2",
			organizationId: "org-example",
			baseUrl: "http://gitlab.example.com/api/v4/mcp",
			oauthClientId: "self-dcr-client",
			encryptedOauthClientSecret: null,
			dcrClientMetadata: { token_endpoint_auth_method: "none" },
			enabled: false,
			authType: "OAUTH2",
			mcpServerId: officialServer.id,
			mcpServer: { key: "gitlab-official", defaultUrl: null },
		};
		// What `start` resolved for this flow: the callback uses exactly that.
		state.config = { ...state.config, oauthGrantGeneration: 0 };
		state.oauthState = {
			...state.oauthState,
			...flowFor(
				"http://gitlab.example.com/oauth/token",
				String(state.config.oauthClientId),
			),
		};
		safeFetchOutbound.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					access_token: "instance-access",
					refresh_token: "instance-refresh",
					expires_in: 7200,
				}),
				{ status: 200 },
			),
		);

		const outcome = await handlerOf(oauthProcedures.callback)({
			input: { code: "code", state: "state" },
		}).catch((error: unknown) => error);

		expect(outcome).toMatchObject({
			success: false,
			message: expect.stringContaining("GitLab token endpoint refused"),
		});
		// The code, the PKCE verifier and any client secret never left: not
		// even the code exchange was sent to the refused endpoint.
		expect(safeFetchOutbound).not.toHaveBeenCalled();
		expect(fetchMock).not.toHaveBeenCalled();
		expect(persistGitLabToken).not.toHaveBeenCalled();
	});

	it("refuses an https token endpoint on a private address before the code exchange", async () => {
		state.oauthState = {
			userId: "user-2",
			organizationId: "org-example",
			configId: "cfg-self",
			redirectUri: "https://app.example.com/callback",
			codeVerifier: "verifier",
			expiresAt: new Date(Date.now() + 600_000),
		};
		state.config = {
			id: "cfg-self",
			userId: "user-2",
			organizationId: "org-example",
			baseUrl: "https://10.0.0.5/api/v4/mcp",
			oauthClientId: "self-dcr-client",
			encryptedOauthClientSecret: null,
			dcrClientMetadata: { token_endpoint_auth_method: "none" },
			enabled: false,
			authType: "OAUTH2",
			mcpServerId: officialServer.id,
			mcpServer: { key: "gitlab-official", defaultUrl: null },
		};
		// What `start` resolved for this flow: the callback uses exactly that.
		state.config = { ...state.config, oauthGrantGeneration: 0 };
		state.oauthState = {
			...state.oauthState,
			...flowFor(
				"https://10.0.0.5/oauth/token",
				String(state.config.oauthClientId),
			),
		};

		const outcome = await handlerOf(oauthProcedures.callback)({
			input: { code: "code", state: "state" },
		}).catch((error: unknown) => error);

		expect(outcome).toMatchObject({
			success: false,
			message: expect.stringContaining("GitLab token endpoint refused"),
		});
		expect(safeFetchOutbound).not.toHaveBeenCalled();
		expect(fetchMock).not.toHaveBeenCalled();
		expect(persistGitLabToken).not.toHaveBeenCalled();
	});
});
