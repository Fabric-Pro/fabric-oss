/**
 * `mcp.configs.list` returns a config's stored token ciphertexts. Echoing them
 * back through `mcp.configs.upsert` is not a new grant: it must not lift the
 * refresh circuit breaker (`needsReauth`, UNAVAILABLE, strikes) or erase the
 * stored access token's expiry — otherwise anyone could "recover" a condemned
 * config, and keep serving its expired token, with no new credential at all.
 *
 * The handlers and the credential module (`mcp-oauth-credentials`) are real;
 * the Prisma client underneath is a simulated row whose conditional writes
 * are evaluated like their WHERE clauses would be.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
	row: null as Record<string, unknown> | null,
	server: null as Record<string, unknown> | null,
	refreshRequests: [] as unknown[],
}));

function matches(where: Record<string, unknown>): boolean {
	const row = store.row;
	if (!row) {
		return false;
	}
	return Object.entries(where).every(([column, value]) => {
		if (column === "id") {
			return row.id === value;
		}
		return (row[column] ?? null) === (value ?? null);
	});
}

function apply(data: Record<string, unknown>) {
	const row = store.row;
	if (!row) {
		return;
	}
	for (const [column, value] of Object.entries(data)) {
		if (
			value &&
			typeof value === "object" &&
			"increment" in (value as Record<string, unknown>)
		) {
			row[column] =
				(row[column] as number) +
				(value as { increment: number }).increment;
		} else {
			row[column] = value === "DbNull" ? null : value;
		}
	}
}

const simulatedDb = vi.hoisted(() => ({}) as Record<string, unknown>);

vi.mock("@repo/database/prisma/client", () => {
	class PrismaClientKnownRequestError extends Error {
		code = "";
	}
	const mCPConfig = {
		update: async (args: {
			where: Record<string, unknown>;
			data: Record<string, unknown>;
		}) => {
			if (!matches(args.where)) {
				const error = new PrismaClientKnownRequestError("P2025");
				error.code = "P2025";
				throw error;
			}
			apply(args.data);
			return { ...store.row, mcpServer: store.row?.mcpServer };
		},
		updateMany: async (args: {
			where: Record<string, unknown>;
			data: Record<string, unknown>;
		}) => {
			if (!matches(args.where)) {
				return { count: 0 };
			}
			apply(args.data);
			return { count: 1 };
		},
		findUniqueOrThrow: async () => ({ ...store.row }),
		findUnique: async () => (store.row ? { ...store.row } : null),
	};
	Object.assign(simulatedDb, {
		mCPConfig,
		$transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
			fn({ mCPConfig }),
	});
	return {
		Prisma: { DbNull: "DbNull", PrismaClientKnownRequestError },
		db: simulatedDb,
	};
});

vi.mock("@repo/database", async () => ({
	// The real credential module and binding helpers, over the row above.
	...(await import("@repo/database/prisma/queries/mcp-oauth-credentials")),
	db: simulatedDb,
	isGitLabPersonalMcpServerKey: () => false,
	clearMcpConfigFromReportInstances: vi.fn(),
	createMcpClientSession: vi.fn(),
	createMcpConfig: vi.fn(),
	deleteMcpConfig: vi.fn(),
	getMcpConfigById: async () => ({ ...store.row }),
	getMcpConfigForTenantAndServer: async () => ({ ...store.row }),
	getMcpServerById: async () => null,
	// A custom server the caller owns: an import there is bearer-only.
	getMcpServerForTenant: async () => store.server,
	getOrganizationById: vi.fn(),
	listMcpConfigsForTenant: async () => [{ ...store.row }],
	recordAudit: vi.fn(),
	updateMcpConfigEnabled: vi.fn(),
	upsertMcpConfig: vi.fn(),
}));

// Any token request the refresh service would make is recorded here.
vi.mock("@repo/utils/oauth-refresh", async (importOriginal) => ({
	...(await importOriginal<object>()),
	refreshOAuthToken: async (request: unknown) => {
		store.refreshRequests.push(request);
		return {
			ok: true,
			accessToken: "refreshed",
			refreshToken: null,
			expiresIn: 3600,
			tokenType: "Bearer",
			scope: null,
		};
	},
}));

vi.mock("@repo/temporal", () => ({
	triggerMcpServerIngestion: vi.fn(),
	triggerMcpToolDeletion: vi.fn(),
	triggerMcpToolIngestion: vi.fn(),
}));

vi.mock("@repo/integrations/gitlab", () => ({
	findUsableGitLabConnection: vi.fn(async () => null),
}));

vi.mock("@repo/utils", () => ({
	decryptApiKey: (s: string) => s.replace(/^encrypted(?:-v\d+)?:/, ""),
	encryptApiKey: (s: string) => `encrypted:${s}`,
	// Deterministic, like the real HMAC.
	hashApiKey: (s: string) => `hashed:${s}`,
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
		authorizeInputOrganization: vi.fn(),
		Permissions: {
			MCP_CREATE: "mcp:create",
			MCP_DELETE: "mcp:delete",
			MCP_READ: "mcp:read",
			MCP_UPDATE: "mcp:update",
		} as const,
	};
});

vi.mock("../../lib/gitlab-config-removal", () => ({
	removeGitLabPersonalMcpConfig: vi.fn(),
}));

vi.mock("@orpc/server", () => ({
	ORPCError: class extends Error {
		readonly code: string;
		constructor(code: string, opts?: { message?: string }) {
			super(opts?.message ?? code);
			this.code = code;
		}
	},
}));

import { configProcedures } from "../configs";

type Handler = (args: {
	input: Record<string, unknown>;
	context: { user: { id: string } };
}) => Promise<unknown>;
const list = (configProcedures.list as unknown as { _handler: Handler })
	._handler;
const upsert = (configProcedures.upsert as unknown as { _handler: Handler })
	._handler;

const context = { user: { id: "user_1" } };
const expiredAt = new Date(Date.now() - 3_600_000);

beforeEach(() => {
	store.refreshRequests.length = 0;
	store.server = {
		id: "srv_1",
		key: "custom:example",
		isSystemProvided: false,
		userId: "user_1",
		organizationId: null,
		defaultUrl: "https://mcp.example.com/mcp",
	};
	// A condemned config on a custom server, as the backfill leaves one.
	store.row = {
		id: "cfg_1",
		mcpServerId: "srv_1",
		userId: "user_1",
		organizationId: null,
		authType: "OAUTH2",
		enabled: false,
		isManagedDefault: false,
		baseUrl: null,
		displayName: "Example",
		mcpServer: { authMethods: ["OAUTH2"] },
		oauthGrantGeneration: 5,
		oauthBinding: null,
		oauthClientId: null,
		encryptedOauthClientSecret: null,
		encryptedAccessToken: "encrypted:access-1",
		accessTokenHash: "hashed:access-1",
		encryptedRefreshToken: "encrypted:refresh-1",
		tokenExpiresAt: expiredAt,
		needsReauth: true,
		status: "UNAVAILABLE",
		refreshFailureCount: 3,
	};
});

describe("configs.list → configs.upsert token echo", () => {
	it("echoing the listed ciphertexts back lifts nothing and keeps the expiry", async () => {
		const [listed] = (await list({ input: {}, context })) as Array<
			Record<string, unknown>
		>;

		await upsert({
			input: {
				configId: "cfg_1",
				mcpServerId: "srv_1",
				organizationId: null,
				scopes: [],
				enabled: false,
				authType: "OAUTH2",
				encryptedAccessToken: listed?.encryptedAccessToken,
				encryptedRefreshToken: listed?.encryptedRefreshToken,
			},
			context,
		});

		expect(store.row).toMatchObject({
			needsReauth: true,
			status: "UNAVAILABLE",
			refreshFailureCount: 3,
			tokenExpiresAt: expiredAt,
			encryptedAccessToken: "encrypted:access-1",
		});
	});

	it("a re-encryption of the same token is still the same token", async () => {
		await upsert({
			input: {
				configId: "cfg_1",
				mcpServerId: "srv_1",
				organizationId: null,
				scopes: [],
				enabled: false,
				authType: "OAUTH2",
				encryptedAccessToken: "encrypted-v2:access-1",
			},
			context,
		});

		expect(store.row).toMatchObject({
			needsReauth: true,
			status: "UNAVAILABLE",
			tokenExpiresAt: expiredAt,
		});
	});

	it("a NEW access token is a new grant: the breaker is lifted and the config is bearer-only", async () => {
		await upsert({
			input: {
				configId: "cfg_1",
				mcpServerId: "srv_1",
				organizationId: null,
				scopes: [],
				enabled: false,
				authType: "OAUTH2",
				accessToken: "access-2",
			},
			context,
		});

		expect(store.row).toMatchObject({
			needsReauth: false,
			status: "HEALTHY",
			refreshFailureCount: 0,
			encryptedAccessToken: "encrypted:access-2",
			tokenExpiresAt: null,
			oauthGrantGeneration: 6,
			oauthBinding: { mode: "bearer-only" },
		});
	});

	const upsertTokens = (tokens: Record<string, unknown>) =>
		upsert({
			input: {
				configId: "cfg_1",
				mcpServerId: "srv_1",
				organizationId: null,
				scopes: [],
				enabled: false,
				authType: "OAUTH2",
				...tokens,
			},
			context,
		});

	it("clear, then replay the listed ciphertext: the breaker stays set", async () => {
		const [listed] = (await list({ input: {}, context })) as Array<
			Record<string, unknown>
		>;

		await upsertTokens({ encryptedAccessToken: null });
		expect(store.row?.encryptedAccessToken).toBeNull();
		await upsertTokens({
			encryptedAccessToken: listed?.encryptedAccessToken,
		});

		// Still condemned, so the client factory refuses the config
		// (client.ts: OAUTH2 + needsReauth → OAUTH_AUTH_REQUIRED, pinned by
		// packages/mcp/lib/__tests__/client-needs-reauth.test.ts).
		expect(store.row).toMatchObject({
			encryptedAccessToken: "encrypted:access-1",
			needsReauth: true,
			status: "UNAVAILABLE",
			refreshFailureCount: 3,
		});
	});

	it("the same plaintext re-imported over a row stored without a hash does not reset", async () => {
		// Stored without a hash, under an earlier encryption of the same
		// plaintext: only decrypting the stored token shows it is the same.
		if (store.row) {
			store.row.accessTokenHash = null;
			store.row.encryptedAccessToken = "encrypted-v1:access-1";
		}

		await upsertTokens({ accessToken: "access-1" });

		expect(store.row).toMatchObject({
			needsReauth: true,
			status: "UNAVAILABLE",
			tokenExpiresAt: expiredAt,
		});
	});

	it("a client entered together with imported tokens on a custom server never makes the tokens refreshable at the row's endpoint", async () => {
		// The owner points the custom row at an endpoint of their choosing.
		store.server = {
			...store.server,
			oauthTokenEndpoint: "https://attacker.example.com/token",
			oauthAuthorizationEndpoint:
				"https://attacker.example.com/authorize",
		};

		await upsertTokens({
			oauthClientId: "manual-client",
			oauthClientSecret: "manual-secret",
			accessToken: "imported-access",
			refreshToken: "imported-refresh",
		});

		expect(store.row).toMatchObject({
			oauthClientId: "manual-client",
			oauthBinding: { mode: "bearer-only" },
		});
		expect(JSON.stringify(store.row?.oauthBinding)).not.toContain(
			"attacker.example.com",
		);

		// Expire it and ask the refresh service to refresh: nothing is sent.
		if (store.row) {
			store.row.tokenExpiresAt = new Date(Date.now() - 60_000);
			store.row.needsReauth = false;
		}
		const { refreshMcpOAuthAccessToken } = await import(
			"@repo/database/prisma/queries/mcp-oauth-refresh"
		);
		const outcome = await refreshMcpOAuthAccessToken("cfg_1");
		expect(outcome).toEqual({ status: "reconnect-required" });
		expect(store.refreshRequests).toHaveLength(0);
	});

	describe("an import that keeps the stored client", () => {
		// A system catalog row naming its AS independently of the MCP server:
		// imported tokens are bound to it, and the stored client kept.
		const catalogServer = () => ({
			...store.server,
			key: "example-catalog",
			isSystemProvided: true,
			userId: null,
			oauthTokenEndpoint: "https://as.example.com/token",
			oauthAuthorizationEndpoint: "https://as.example.com/authorize",
		});
		const boundRow = async (
			secretNow: string,
			boundTo = "https://as.example.com",
		) => {
			const { buildMcpOAuthBinding, withCredentialFingerprint } =
				await import(
					"@repo/database/prisma/queries/lib/mcp-oauth-binding"
				);
			return {
				...store.row,
				needsReauth: false,
				status: "HEALTHY",
				refreshFailureCount: 0,
				oauthClientId: "client-1",
				encryptedOauthClientSecret: secretNow,
				// Written by the credential module for client-1 / secret-1.
				oauthBinding: withCredentialFingerprint(
					buildMcpOAuthBinding({
						authorizationServerUrl: boundTo,
						tokenEndpoint: `${boundTo}/token`,
						source: "catalog",
					}),
					{
						oauthClientId: "client-1",
						encryptedOauthClientSecret: "encrypted:secret-1",
						encryptedRefreshToken: "encrypted:refresh-1",
					},
				),
			};
		};
		async function refreshAfterImport() {
			await upsertTokens({
				accessToken: "imported-access",
				refreshToken: "imported-refresh",
			});
			if (store.row) {
				store.row.tokenExpiresAt = new Date(Date.now() - 60_000);
			}
			const { refreshMcpOAuthAccessToken } = await import(
				"@repo/database/prisma/queries/mcp-oauth-refresh"
			);
			return refreshMcpOAuthAccessToken("cfg_1");
		}

		it("re-fingerprints the binding over an intact client, which then refreshes", async () => {
			store.server = catalogServer();
			store.row = await boundRow("encrypted:secret-1");

			const outcome = await refreshAfterImport();

			expect(outcome.status).toBe("refreshed");
			expect(store.refreshRequests).toEqual([
				expect.objectContaining({
					tokenEndpoint: "https://as.example.com/token",
					refreshToken: "imported-refresh",
					clientId: "client-1",
					clientSecret: "secret-1",
				}),
			]);
		});

		it("never re-points an intact client at another AS: a SYSTEM row naming another endpoint stores the import bearer-only", async () => {
			// The client was verified for as-old; the catalog now names as.
			store.server = catalogServer();
			store.row = await boundRow(
				"encrypted:secret-1",
				"https://as-old.example.com",
			);

			const outcome = await refreshAfterImport();

			expect(store.row?.oauthBinding).toMatchObject({
				mode: "bearer-only",
			});
			expect(outcome).toEqual({ status: "reconnect-required" });
			expect(store.refreshRequests).toHaveLength(0);
		});

		it("a CUSTOM server reusing a pinned provider's key gets nothing pinned: the import is bearer-only and the secret goes nowhere", async () => {
			// The owner keyed their custom server `github-remote`, connected it
			// through their own AS, and now echoes tokens back through upsert.
			store.server = {
				...store.server,
				key: "github-remote",
				isSystemProvided: false,
				defaultUrl: "https://mcp.example.com/mcp",
				oauthTokenEndpoint: "https://as-custom.example.com/token",
				oauthAuthorizationEndpoint:
					"https://as-custom.example.com/authorize",
			};
			store.row = await boundRow(
				"encrypted:secret-1",
				"https://as-custom.example.com",
			);

			const outcome = await refreshAfterImport();

			expect(store.row?.oauthBinding).toMatchObject({
				mode: "bearer-only",
			});
			expect(JSON.stringify(store.row?.oauthBinding)).not.toContain(
				"github.com",
			);
			expect(outcome).toEqual({ status: "reconnect-required" });
			expect(store.refreshRequests).toHaveLength(0);
		});

		it("never launders a client a legacy writer replaced: nothing is sent", async () => {
			store.server = catalogServer();
			// The previous app version replaced the secret by id.
			store.row = await boundRow("encrypted:secret-from-elsewhere");

			const outcome = await refreshAfterImport();

			expect(store.row?.oauthBinding).not.toHaveProperty(
				"credentialFingerprint",
			);
			expect(outcome).toEqual({ status: "reconnect-required" });
			expect(store.refreshRequests).toHaveLength(0);
		});
	});

	it("a client entered WITHOUT tokens on a custom server is still bound to the row's endpoints at entry", async () => {
		store.server = {
			...store.server,
			oauthTokenEndpoint: "https://as.example.com/token",
			oauthAuthorizationEndpoint: "https://as.example.com/authorize",
		};

		await upsertTokens({
			oauthClientId: "manual-client",
			oauthClientSecret: "manual-secret",
		});

		expect(store.row?.oauthBinding).toMatchObject({
			tokenEndpoint: "https://as.example.com/token",
		});
	});
});
