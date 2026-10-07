/**
 * `mcp.oauth.start` binds an unbound GitLab MCP client to the instance the
 * person's GitLab connection recorded — and the connection then refreshes
 * with it. That bootstrap is only for a PUBLIC client: an unbound row holding
 * a secret has no provenance (the previous app version may have written one
 * issued by another instance under the same client id), so start must not
 * bind it, or the connection refresh would send that secret to the
 * connection's instance.
 *
 * Real `start`, real credential writer (`replaceMcpOAuthRegistration`), real
 * GitLab connection service and resolver, over the in-memory GitLab fake.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	createGitLabFakeDb,
	encryptedCredential,
} from "../../../../integrations/__tests__/gitlab/helpers/gitlab-fake-db";

const state = vi.hoisted(() => ({
	fake: null as unknown as ReturnType<
		typeof import("../../../../integrations/__tests__/gitlab/helpers/gitlab-fake-db").createGitLabFakeDb
	>,
}));

// The credential module writes through this client: point it at the fake.
vi.mock("@repo/database/prisma/client", async (importOriginal) => ({
	...(await importOriginal<object>()),
	get db() {
		return state.fake?.db;
	},
}));

vi.mock("@repo/database", async (importOriginal) => ({
	...(await importOriginal<object>()),
	getMcpServerForTenant: async () => ({ isSystemProvided: true }),
	get db() {
		return state.fake?.db;
	},
	getMcpConfigByIdInternal: async (id: string) =>
		state.fake.db.mCPConfig.findUnique({ where: { id } } as never),
	createOauthState: vi.fn(async () => "state-1"),
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
	...(await importOriginal<object>()),
	assertSafeOutboundUrl: () => undefined,
	// No discovery is needed here; anything asked answers 404.
	safeFetchOutbound: vi.fn(
		async () => new Response(JSON.stringify({}), { status: 404 }),
	),
}));

vi.mock("@repo/temporal", () => ({
	triggerMcpToolIngestion: vi.fn(async () => undefined),
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
		authorizeInputOrganization: async () => "org-example",
	};
});

import {
	getFreshGitLabAccessToken,
	resetGitLabConnectionDepsForTests,
} from "@repo/integrations/gitlab";
import { oauthProcedures } from "../procedures/oauth";

type StartHandler = (args: {
	input: Record<string, unknown>;
	context: Record<string, unknown>;
}) => Promise<{ authorizationUrl: string }>;
const start = (oauthProcedures.start as unknown as { handler: StartHandler })
	.handler;

const USER = "user-2";
const ORG = "org-example";

const officialServer = {
	id: "srv-official",
	key: "gitlab-official",
	isSystemProvided: true,
	defaultUrl: "https://gitlab.com/api/v4/mcp",
};

function mcpRow(client: {
	encryptedOauthClientSecret: string | null;
	authMethod: string;
}) {
	return {
		id: "cfg-official",
		userId: USER,
		organizationId: ORG,
		mcpServerId: officialServer.id,
		baseUrl: null,
		authType: "OAUTH2",
		enabled: false,
		scopes: ["api"],
		oauthGrantGeneration: 0,
		oauthBinding: null,
		oauthClientId: "dcr-client",
		encryptedOauthClientSecret: client.encryptedOauthClientSecret,
		dcrClientMetadata: { token_endpoint_auth_method: client.authMethod },
		dcrRegistrationEndpoint: "https://gitlab.com/oauth/register",
		dcrRegisteredAt: new Date("2026-01-01T00:00:00Z"),
		encryptedAccessToken: null,
		accessTokenHash: null,
		encryptedRefreshToken: null,
		tokenExpiresAt: null,
		needsReauth: false,
	};
}

/** The person's connection, issued by `dcr-client` at gitlab.com, expired. */
function connection() {
	return {
		id: "wi-1",
		userId: USER,
		organizationId: ORG,
		provider: "GITLAB",
		name: "GitLab",
		workflowId: null,
		isActive: true,
		credentials: encryptedCredential({
			access_token: "old-access",
			refresh_token: "old-refresh",
			expires_in: 7200,
			token_obtained_at: new Date(
				Date.now() - 3 * 60 * 60 * 1000,
			).toISOString(),
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
	};
}

const fetchMock = vi.fn();

function tokenCalls() {
	return fetchMock.mock.calls.filter(([url]) =>
		String(url).endsWith("/oauth/token"),
	);
}

function startConnect() {
	return start({
		input: {
			configId: "cfg-official",
			redirectUri: "https://app.example.com/api/mcp/oauth/callback",
			autoDiscoverAndRegister: true,
		},
		context: {
			user: { id: USER },
			session: { activeOrganizationId: ORG },
		},
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	fetchMock.mockReset();
	vi.stubGlobal("fetch", fetchMock);
	vi.stubEnv("GITLAB_CLIENT_ID", "");
	vi.stubEnv("GITLAB_CLIENT_SECRET", "");
	resetGitLabConnectionDepsForTests();
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("oauth.start → GitLab connection refresh", () => {
	it("never binds an unbound client holding a secret, so the connection still refuses to send it", async () => {
		// The previous app version wrote a secret issued by another instance
		// under the same client id the connection recorded.
		state.fake = createGitLabFakeDb({
			mCPServer: [officialServer],
			mCPConfig: [
				mcpRow({
					encryptedOauthClientSecret: "enc:secret-from-elsewhere",
					authMethod: "client_secret_post",
				}),
			],
			workflowIntegration: [connection()],
		});

		await expect(startConnect()).rejects.toMatchObject({
			message: expect.stringContaining("changed outside"),
		});
		expect(state.fake.tables.mCPConfig[0].oauthBinding).toBeNull();

		const result = await getFreshGitLabAccessToken(USER, ORG);

		expect(result).toMatchObject({ ok: false });
		expect(tokenCalls()).toHaveLength(0);
		expect(JSON.stringify(fetchMock.mock.calls)).not.toContain(
			"secret-from-elsewhere",
		);
	});

	it("binds an unbound PUBLIC client to the connection's instance, which then refreshes with it", async () => {
		state.fake = createGitLabFakeDb({
			mCPServer: [officialServer],
			mCPConfig: [
				mcpRow({
					encryptedOauthClientSecret: null,
					authMethod: "none",
				}),
			],
			workflowIntegration: [connection()],
		});

		const { authorizationUrl } = await startConnect();

		expect(new URL(authorizationUrl).origin).toBe("https://gitlab.com");
		expect(state.fake.tables.mCPConfig[0].oauthBinding).toMatchObject({
			authorizationServerUrl: "https://gitlab.com",
			source: "connection",
			credentialFingerprint: expect.any(String),
		});

		fetchMock.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					access_token: "new-access",
					refresh_token: "new-refresh",
					token_type: "bearer",
					expires_in: 7200,
					created_at: Math.floor(Date.now() / 1000),
				}),
				{
					status: 200,
					headers: { "content-type": "application/json" },
				},
			),
		);
		const result = await getFreshGitLabAccessToken(USER, ORG);

		expect(result).toMatchObject({ ok: true, token: "new-access" });
		const calls = tokenCalls();
		expect(calls).toHaveLength(1);
		const body = new URLSearchParams(
			String((calls[0][1] as RequestInit).body),
		);
		expect(body.get("client_id")).toBe("dcr-client");
		expect(body.get("client_secret")).toBeNull();
	});

	it("replaces a bearer-only import on a PUBLIC client with a binding, so the connection can refresh after sign-in", async () => {
		state.fake = createGitLabFakeDb({
			mCPServer: [officialServer],
			mCPConfig: [
				{
					...mcpRow({
						encryptedOauthClientSecret: null,
						authMethod: "none",
					}),
					oauthBinding: {
						mode: "bearer-only",
						importedAt: "2026-01-01T00:00:00.000Z",
					},
					encryptedAccessToken: "enc:imported-access",
					encryptedRefreshToken: "enc:imported-refresh",
				},
			],
			workflowIntegration: [connection()],
		});

		const { authorizationUrl } = await startConnect();

		expect(new URL(authorizationUrl).origin).toBe("https://gitlab.com");
		const row = state.fake.tables.mCPConfig[0];
		expect(row.oauthBinding).toMatchObject({
			authorizationServerUrl: "https://gitlab.com",
			source: "connection",
			credentialFingerprint: expect.any(String),
		});
		// The imported grant is dropped, not carried under the new binding.
		expect(row.encryptedAccessToken).toBeNull();
		expect(row.encryptedRefreshToken).toBeNull();

		fetchMock.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					access_token: "new-access",
					refresh_token: "new-refresh",
					token_type: "bearer",
					expires_in: 7200,
					created_at: Math.floor(Date.now() / 1000),
				}),
				{
					status: 200,
					headers: { "content-type": "application/json" },
				},
			),
		);
		const result = await getFreshGitLabAccessToken(USER, ORG);

		expect(result).toMatchObject({ ok: true, token: "new-access" });
		const calls = tokenCalls();
		expect(calls).toHaveLength(1);
		const body = new URLSearchParams(
			String((calls[0][1] as RequestInit).body),
		);
		expect(body.get("client_id")).toBe("dcr-client");
		expect(body.get("refresh_token")).toBe("old-refresh");
		expect(body.get("client_secret")).toBeNull();
	});
});
