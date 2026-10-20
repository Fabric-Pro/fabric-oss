/**
 * The database-backed OAuth provider pins every credential to the
 * authorization server (AS) its config is bound to.
 *
 * These run the REAL MCP SDK `auth()` (no mock of
 * `@modelcontextprotocol/sdk/client/auth.js`) against the real provider, the
 * real `@repo/database` refresh service and credential writes, over a
 * simulated `mcp_config` row: only the Prisma client and the network are
 * replaced. The MCP server in these tests advertises a different AS ("B")
 * than the one the credentials are bound to ("A"); nothing may ever send B a
 * refresh token, client secret or authorization code.
 *
 * Fabric's refresh service is the only refresher: the SDK is never handed a
 * refresh token, and a 401 from the MCP server is refreshed and resent once
 * by the transport fetch in `../client` (`retryOnceAfterUnauthorized`).
 */
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

// -----------------------------------------------------------------------------
// Simulated database row
// -----------------------------------------------------------------------------

let storedRow: Record<string, unknown> | null = null;
/** Runs right after the tenant-scoped read (a concurrent write landing). */
let onTenantRead: (() => void) | null = null;

function matches(where: Record<string, unknown>): boolean {
	if (!storedRow) {
		return false;
	}
	return Object.entries(where).every(
		([column, value]) => storedRow?.[column] === value,
	);
}

function apply(data: Record<string, unknown>) {
	if (!storedRow) {
		return;
	}
	for (const [column, value] of Object.entries(data)) {
		if (
			value &&
			typeof value === "object" &&
			"increment" in (value as Record<string, unknown>)
		) {
			storedRow[column] =
				(storedRow[column] as number) +
				(value as { increment: number }).increment;
		} else {
			storedRow[column] = value === "DbNull" ? null : value;
		}
	}
}

vi.mock("@repo/database/prisma/client", () => {
	class PrismaClientKnownRequestError extends Error {
		code = "";
	}
	return {
		Prisma: { DbNull: "DbNull", PrismaClientKnownRequestError },
		db: {
			mCPConfig: {
				findUnique: vi.fn(async () =>
					storedRow ? structuredClone(storedRow) : null,
				),
				// `getMcpConfigById` (the tenant-scoped read client.ts builds
				// the transport from).
				findFirst: vi.fn(async () => {
					const row = storedRow ? structuredClone(storedRow) : null;
					onTenantRead?.();
					return row;
				}),
				updateMany: vi.fn(
					async (args: {
						where: Record<string, unknown>;
						data: Record<string, unknown>;
					}) => {
						if (!matches(args.where)) {
							return { count: 0 };
						}
						apply(args.data);
						return { count: 1 };
					},
				),
				update: vi.fn(
					async (args: {
						where: Record<string, unknown>;
						data: Record<string, unknown>;
					}) => {
						if (!matches(args.where)) {
							const error = new PrismaClientKnownRequestError(
								"P2025",
							);
							error.code = "P2025";
							throw error;
						}
						apply(args.data);
						return {
							oauthGrantGeneration:
								storedRow?.oauthGrantGeneration,
						};
					},
				),
			},
		},
	};
});

// The real query modules, over the simulated client above.
vi.mock("@repo/database", async () => {
	const mcp = await import("@repo/database/prisma/queries/mcp");
	const credentials = await import(
		"@repo/database/prisma/queries/mcp-oauth-credentials"
	);
	const refresh = await import(
		"@repo/database/prisma/queries/mcp-oauth-refresh"
	);
	return {
		...mcp,
		...credentials,
		...refresh,
		// The organization gate (./organization-access) is not under test.
		canConnectOrganizationMcpConfigs: async () => true,
		canReadOrganizationMcpConfigs: async () => true,
		isOrganizationMember: async () => true,
	};
});

// The pre-connect DNS check resolves the MCP host to a public address.
vi.mock("node:dns", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:dns")>();
	const lookup = (
		_hostname: string,
		options: unknown,
		callback?: (
			error: Error | null,
			addresses: { address: string; family: number }[],
		) => void,
	) => {
		const cb = (typeof options === "function" ? options : callback) as (
			error: Error | null,
			addresses: { address: string; family: number }[],
		) => void;
		cb(null, [{ address: "93.184.216.34", family: 4 }]);
	};
	return { ...actual, default: { ...actual, lookup }, lookup };
});

vi.mock("@repo/utils", () => ({
	decryptApiKey: (value: string) => value.replace(/^ENC:/, ""),
	encryptApiKey: (value: string) => `ENC:${value}`,
	hashApiKey: (value: string) => `HASH:${value}`,
}));

// -----------------------------------------------------------------------------
// Network
// -----------------------------------------------------------------------------

type Recorded = { url: string; body: string; headers: string };
const requests: Recorded[] = [];

const AS_A = "https://as-a.example.com";
const AS_B = "https://as-b.example.com";

function record(input: string | URL, init?: RequestInit) {
	const headerPairs: Array<[string, string]> = [];
	new Headers(init?.headers).forEach((value, name) => {
		headerPairs.push([name, value]);
	});
	requests.push({
		url: String(input),
		body: String(init?.body ?? ""),
		headers: JSON.stringify(headerPairs),
	});
}

function respond(url: string): Response {
	const json = (body: unknown, status = 200) =>
		new Response(JSON.stringify(body), {
			status,
			headers: { "content-type": "application/json" },
		});
	if (
		url.startsWith(
			"https://mcp.example.com/.well-known/oauth-protected-resource",
		)
	) {
		// The MCP server now names AS B.
		return json({
			resource: "https://mcp.example.com/mcp",
			authorization_servers: [AS_B],
		});
	}
	if (url.startsWith(`${AS_B}/.well-known/`)) {
		return json({
			issuer: AS_B,
			authorization_endpoint: `${AS_B}/authorize`,
			token_endpoint: `${AS_B}/token`,
			registration_endpoint: `${AS_B}/register`,
			response_types_supported: ["code"],
			code_challenge_methods_supported: ["S256"],
		});
	}
	if (url === `${AS_B}/token` || url === `${AS_B}/register`) {
		return json({
			access_token: "b-access",
			refresh_token: "b-refresh",
			client_id: "b-client",
		});
	}
	if (url === `${AS_A}/oauth/token`) {
		return json({
			access_token: "a-access-2",
			refresh_token: "a-refresh-2",
			token_type: "Bearer",
			expires_in: 3600,
		});
	}
	return json({}, 404);
}

const sdkFetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
	record(input, init);
	return respond(String(input));
}) as unknown as typeof fetch;

// Fabric's own refresher goes through the guarded outbound fetch.
vi.mock("@repo/utils/url-security", async (importOriginal) => ({
	...(await importOriginal<object>()),
	safeFetchOutbound: vi.fn(
		async (input: string | URL, init?: RequestInit) => {
			record(input, init);
			return respond(String(input));
		},
	),
	assertSafeOutboundUrl: vi.fn(),
}));

import {
	buildMcpOAuthBinding,
	withCredentialFingerprint,
} from "@repo/database/prisma/queries/lib/mcp-oauth-binding";
import { oauthRequestsRefuseRedirects } from "../client";
import {
	createOAuthClientProvider,
	type FabricRefreshingOAuthClientProvider,
	OAuthAuthorizationRequiredError,
} from "../oauth-provider";

const BINDING_A_UNFINGERPRINTED = buildMcpOAuthBinding({
	authorizationServerUrl: AS_A,
	tokenEndpoint: `${AS_A}/oauth/token`,
	metadata: {
		issuer: AS_A,
		authorization_endpoint: `${AS_A}/authorize`,
		// A stale metadata copy naming another endpoint loses to the binding.
		token_endpoint: `${AS_B}/token`,
		token_endpoint_auth_methods_supported: ["client_secret_basic"],
	},
	source: "discovery",
});

/** The credential columns `baseRow()` stores. */
const STORED_CREDENTIALS = {
	oauthClientId: "client_a",
	encryptedOauthClientSecret: "ENC:secret-a",
	encryptedRefreshToken: "ENC:a-refresh-1",
};

// Written by a new-code grant: carries the fingerprint of the credential set
// stored beside it.
const BINDING_A = withCredentialFingerprint(
	BINDING_A_UNFINGERPRINTED,
	STORED_CREDENTIALS,
);

function baseRow(overrides: Record<string, unknown> = {}) {
	return {
		id: "config_x",
		userId: "user_a",
		organizationId: "org_a",
		displayName: "Test Server",
		authType: "OAUTH2",
		status: "HEALTHY",
		baseUrl: "https://mcp.example.com/mcp",
		mcpServer: {
			key: "custom-server",
			name: "Test Server",
			defaultUrl: "https://mcp.example.com/mcp",
			// The catalog and the cache both name B; neither may matter.
			oauthTokenEndpoint: `${AS_B}/token`,
		},
		oauthMetadataCache: { token_endpoint: `${AS_B}/token` },
		oauthBinding: structuredClone(BINDING_A),
		oauthGrantGeneration: 7,
		oauthClientId: "client_a",
		encryptedOauthClientSecret: "ENC:secret-a",
		dcrClientMetadata: {
			token_endpoint_auth_method: "client_secret_basic",
		},
		dcrRegistrationEndpoint: `${AS_A}/register`,
		dcrRegisteredAt: new Date("2026-01-01T00:00:00Z"),
		encryptedAccessToken: "ENC:a-access-1",
		accessTokenHash: "HASH:a-access-1",
		encryptedRefreshToken: "ENC:a-refresh-1",
		tokenExpiresAt: new Date(Date.now() + 3_600_000),
		updatedAt: new Date(),
		scopes: [],
		needsReauth: false,
		refreshFailureCount: 0,
		lastRefreshError: null,
		...overrides,
	};
}

function makeProvider(onAuthorizationRequired?: () => void) {
	return createOAuthClientProvider({
		configId: "config_x",
		userId: "user_a",
		organizationId: "org_a",
		redirectUri: "https://app.example.com/api/mcp/oauth/callback",
		onAuthorizationRequired,
	});
}

/** Nothing sent to B carries any credential. */
function expectNothingSentToB(...secrets: string[]) {
	for (const request of requests.filter(
		(r) => new URL(r.url).origin === AS_B,
	)) {
		for (const secret of secrets) {
			expect(request.body).not.toContain(secret);
			expect(request.headers).not.toContain(secret);
			expect(request.headers).not.toContain(btoa(`client_a:${secret}`));
		}
	}
}

beforeEach(() => {
	storedRow = baseRow();
	onTenantRead = null;
	requests.length = 0;
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("the SDK's auth() with an MCP server that names another AS", () => {
	it("never refreshes: it ends in a reconnect prompt without contacting a token endpoint", async () => {
		const provider = await makeProvider();

		await expect(
			auth(provider, {
				serverUrl: "https://mcp.example.com/mcp",
				fetchFn: sdkFetch,
			}),
		).rejects.toBeInstanceOf(OAuthAuthorizationRequiredError);

		// No token endpoint, A's or B's, is asked anything (the SDK may still
		// read the MCP server's own protected-resource metadata), and B is
		// not contacted at all.
		expect(requests.some((r) => r.url.includes("/token"))).toBe(false);
		expect(requests.some((r) => new URL(r.url).origin === AS_B)).toBe(
			false,
		);
		expectNothingSentToB("a-refresh-1", "secret-a");
		expect(storedRow).toMatchObject({
			encryptedAccessToken: "ENC:a-access-1",
			encryptedRefreshToken: "ENC:a-refresh-1",
			oauthGrantGeneration: 7,
			needsReauth: false,
		});
	});

	it("never sends an authorization code or the secret to B, and saves no grant from a background context", async () => {
		const provider = await makeProvider();
		await provider.saveCodeVerifier("verifier-1");

		await expect(
			auth(provider, {
				serverUrl: "https://mcp.example.com/mcp",
				authorizationCode: "code-xyz",
				fetchFn: sdkFetch,
			}),
		).rejects.toBeInstanceOf(OAuthAuthorizationRequiredError);

		expect(requests.some((r) => new URL(r.url).origin === AS_B)).toBe(
			false,
		);
		expectNothingSentToB("code-xyz", "secret-a");
		expect(storedRow).toMatchObject({
			encryptedAccessToken: "ENC:a-access-1",
			oauthGrantGeneration: 7,
		});
	});

	it("never registers a client: a config without one fails closed", async () => {
		storedRow = baseRow({
			oauthClientId: null,
			encryptedOauthClientSecret: null,
			encryptedAccessToken: null,
			encryptedRefreshToken: null,
		});
		const provider = await makeProvider(() => {});

		await expect(
			auth(provider, {
				serverUrl: "https://mcp.example.com/mcp",
				fetchFn: sdkFetch,
			}),
		).rejects.toBeInstanceOf(OAuthAuthorizationRequiredError);
		expect(requests.some((r) => r.url.includes("/register"))).toBe(false);
	});
});

describe("the provider's own proactive refresh", () => {
	it("posts only to the pinned endpoint when tokens() finds an expired token", async () => {
		storedRow = baseRow({ tokenExpiresAt: new Date(Date.now() - 60_000) });
		const provider = await makeProvider();

		const tokens = await provider.tokens();

		expect(tokens).toMatchObject({
			access_token: "a-access-2",
			issuer: AS_A,
		});
		// The SDK never gets a refresh token to spend.
		expect(tokens).not.toHaveProperty("refresh_token");
		expect(storedRow?.encryptedRefreshToken).toBe("ENC:a-refresh-2");
		expect(requests.map((r) => r.url)).toEqual([`${AS_A}/oauth/token`]);
		expect(requests[0]?.headers).toContain(
			`Basic ${btoa("client_a:secret-a")}`,
		);
		expect(requests[0]?.body).not.toContain("secret-a");
	});

	it("refuses an unbound config before any request", async () => {
		storedRow = baseRow({
			oauthBinding: null,
			tokenExpiresAt: new Date(Date.now() - 60_000),
		});

		await expect(makeProvider()).rejects.toBeInstanceOf(
			OAuthAuthorizationRequiredError,
		);
		expect(requests).toHaveLength(0);
	});

	it("fails closed, without a request, once the config becomes unbound", async () => {
		const provider = await makeProvider();
		storedRow = baseRow({
			oauthBinding: null,
			tokenExpiresAt: new Date(Date.now() - 60_000),
		});

		await expect(provider.tokens()).rejects.toBeInstanceOf(
			OAuthAuthorizationRequiredError,
		);
		expect(requests).toHaveLength(0);
	});
});

describe("the refresh circuit breaker", () => {
	it("returns no token and makes no request for a hard-expired token once needsReauth is set", async () => {
		storedRow = baseRow({
			needsReauth: true,
			tokenExpiresAt: new Date(Date.now() - 60_000),
		});
		const provider = await makeProvider();

		await expect(provider.tokens()).resolves.toBeUndefined();
		expect(requests).toHaveLength(0);
		expect(storedRow?.refreshFailureCount).toBe(0);
	});

	it("keeps serving a token that is only in the soft proactive window", async () => {
		// mcp.notion.com has a known 3600s lifetime; 83% of it has passed.
		storedRow = baseRow({
			needsReauth: true,
			baseUrl: "https://mcp.notion.com/mcp",
			tokenExpiresAt: null,
			updatedAt: new Date(Date.now() - 3600 * 1000 * 0.83),
		});
		const provider = await makeProvider();

		await expect(provider.tokens()).resolves.toMatchObject({
			access_token: "a-access-1",
		});
		expect(requests).toHaveLength(0);
	});
});

describe("generation fencing", () => {
	it("a cached provider fails closed after the grant changes", async () => {
		const provider = await makeProvider();
		await expect(provider.tokens()).resolves.toMatchObject({
			access_token: "a-access-1",
		});

		// A reconnect writes a new grant: new tokens, next generation.
		Object.assign(storedRow ?? {}, {
			encryptedAccessToken: "ENC:reconnected-access",
			oauthGrantGeneration: 8,
		});

		await expect(provider.tokens()).rejects.toBeInstanceOf(
			OAuthAuthorizationRequiredError,
		);
		await expect(provider.clientInformation()).rejects.toBeInstanceOf(
			OAuthAuthorizationRequiredError,
		);
		await expect(provider.discoveryState?.()).rejects.toBeInstanceOf(
			OAuthAuthorizationRequiredError,
		);
	});

	it("a refresh that started before a revoke does not restore the old tokens", async () => {
		storedRow = baseRow({ tokenExpiresAt: new Date(Date.now() - 60_000) });
		const provider = await makeProvider();
		const { safeFetchOutbound } = await import("@repo/utils/url-security");
		vi.mocked(safeFetchOutbound).mockImplementationOnce(
			async (input, init) => {
				record(input, init);
				// revokeOAuthTokens lands while the token request is in flight.
				Object.assign(storedRow ?? {}, {
					encryptedAccessToken: null,
					encryptedRefreshToken: null,
					oauthGrantGeneration: 8,
				});
				return respond(String(input));
			},
		);

		await expect(provider.tokens()).rejects.toBeInstanceOf(
			OAuthAuthorizationRequiredError,
		);
		expect(storedRow).toMatchObject({
			encryptedAccessToken: null,
			encryptedRefreshToken: null,
			oauthGrantGeneration: 8,
		});
	});

	it("a refresh after a 401 that races a revoke does not restore the old tokens", async () => {
		const provider =
			(await makeProvider()) as FabricRefreshingOAuthClientProvider;
		const { safeFetchOutbound } = await import("@repo/utils/url-security");
		vi.mocked(safeFetchOutbound).mockImplementationOnce(
			async (input, init) => {
				record(input, init);
				Object.assign(storedRow ?? {}, {
					encryptedAccessToken: null,
					encryptedRefreshToken: null,
					oauthGrantGeneration: 8,
				});
				return respond(String(input));
			},
		);

		await expect(
			provider.refreshAfterUnauthorized("a-access-1"),
		).resolves.toBeNull();
		expect(storedRow).toMatchObject({
			encryptedAccessToken: null,
			encryptedRefreshToken: null,
			oauthGrantGeneration: 8,
		});
	});

	it("a refresh after a 401 from a provider whose grant was replaced sends nothing", async () => {
		const provider =
			(await makeProvider()) as FabricRefreshingOAuthClientProvider;
		Object.assign(storedRow ?? {}, {
			encryptedAccessToken: "ENC:reconnected-access",
			oauthGrantGeneration: 8,
		});

		await expect(
			provider.refreshAfterUnauthorized("a-access-1"),
		).resolves.toBeNull();
		expect(requests).toHaveLength(0);
	});
});

describe("the transport and the credentials come from one grant", () => {
	it("a provider created for an older generation refuses before any request", async () => {
		await expect(
			createOAuthClientProvider({
				configId: "config_x",
				userId: "user_a",
				organizationId: "org_a",
				redirectUri: "https://app.example.com/api/mcp/oauth/callback",
				expectedGrantGeneration: 6,
			}),
		).rejects.toBeInstanceOf(OAuthAuthorizationRequiredError);
		expect(requests).toHaveLength(0);
	});

	it("createMcpClientForConfig fails closed when the URL it read is retired before the provider loads", async () => {
		const { createMcpClientForConfig } = await import("../client");
		// Between client.ts reading the row (and its URL) and the provider
		// loading it, a URL change retires the credentials.
		storedRow = baseRow({ enabled: true, transport: "HTTP" });
		onTenantRead = () => {
			Object.assign(storedRow ?? {}, {
				baseUrl: "https://moved.example.com/mcp",
				oauthGrantGeneration: 8,
			});
		};

		const error = await createMcpClientForConfig({
			configId: "config_x",
			userId: "user_a",
			organizationId: "org_a",
		}).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(OAuthAuthorizationRequiredError);
		expect(requests).toHaveLength(0);
	});
});

describe("bearer-only imported tokens", () => {
	const bearerOnly = (overrides: Record<string, unknown> = {}) =>
		baseRow({
			oauthBinding: {
				mode: "bearer-only",
				importedAt: "2026-10-06T00:00:00.000Z",
			},
			tokenExpiresAt: new Date(Date.now() + 3_600_000),
			...overrides,
		});

	it("serves the imported access token, and nothing else, until it expires", async () => {
		storedRow = bearerOnly();
		const provider = await makeProvider();

		const tokens = await provider.tokens();

		expect(tokens?.access_token).toBe("a-access-1");
		expect(tokens).not.toHaveProperty("refresh_token");
		expect(tokens).not.toHaveProperty("issuer");
		await expect(provider.clientInformation()).rejects.toBeInstanceOf(
			OAuthAuthorizationRequiredError,
		);
		expect(requests).toHaveLength(0);
	});

	it("ends a 401 in a reconnect prompt without contacting any server", async () => {
		storedRow = bearerOnly();
		const provider = await makeProvider();

		await expect(
			auth(provider, {
				serverUrl: "https://mcp.example.com/mcp",
				fetchFn: sdkFetch,
			}),
		).rejects.toBeInstanceOf(OAuthAuthorizationRequiredError);
		expect(requests).toHaveLength(0);
	});

	it("never refreshes an expired one: reconnect, with no request", async () => {
		storedRow = bearerOnly({
			tokenExpiresAt: new Date(Date.now() - 60_000),
		});
		const provider = await makeProvider();

		await expect(provider.tokens()).rejects.toBeInstanceOf(
			OAuthAuthorizationRequiredError,
		);
		expect(requests).toHaveLength(0);
	});

	it("a legacy unbound row (no marker) is still refused outright", async () => {
		storedRow = baseRow({ oauthBinding: null });

		await expect(makeProvider()).rejects.toBeInstanceOf(
			OAuthAuthorizationRequiredError,
		);
	});
});

describe("credentials the binding was not written with", () => {
	// A new-code grant bound the row with the fingerprint of its client id,
	// secret and refresh token; then a previous-version writer replaced one
	// of them by id alone, without touching the binding or the generation.
	const LEGACY_WRITES = [
		["the client id alone", { oauthClientId: "client-from-another-as" }],
		[
			"the client secret alone (same id)",
			{ encryptedOauthClientSecret: "ENC:secret-from-another-as" },
		],
		[
			"the refresh token alone",
			{ encryptedRefreshToken: "ENC:refresh-from-another-as" },
		],
	] as const;
	const SENT_BY_LEGACY = [
		"client-from-another-as",
		"secret-from-another-as",
		"refresh-from-another-as",
		btoa("client-from-another-as:secret-a"),
		btoa("client_a:secret-from-another-as"),
	];
	function expectNoLegacyCredentialSent() {
		for (const r of requests) {
			for (const value of [
				...SENT_BY_LEGACY,
				"a-refresh-1",
				"secret-a",
			]) {
				expect(r.body).not.toContain(value);
				expect(r.headers).not.toContain(value);
			}
		}
	}

	it.each(LEGACY_WRITES)(
		"after a legacy write of %s, the SDK's own refresh in auth() sends nothing and the config is flagged",
		async (_label, legacyWrite) => {
			storedRow = baseRow(legacyWrite);
			const provider = await makeProvider(() => {});

			await expect(
				auth(provider, {
					serverUrl: "https://mcp.example.com/mcp",
					fetchFn: sdkFetch,
				}),
			).rejects.toBeInstanceOf(OAuthAuthorizationRequiredError);
			expect(requests.some((r) => r.url.endsWith("/token"))).toBe(false);
			expectNoLegacyCredentialSent();
			expect(storedRow?.needsReauth).toBe(true);
		},
	);

	it.each(LEGACY_WRITES)(
		"after a legacy write of %s, the provider's own refresh of an expired token sends nothing",
		async (_label, legacyWrite) => {
			storedRow = baseRow({
				...legacyWrite,
				tokenExpiresAt: new Date(Date.now() - 60_000),
			});
			const provider = await makeProvider();

			await expect(provider.tokens()).rejects.toBeInstanceOf(
				OAuthAuthorizationRequiredError,
			);
			expect(requests).toHaveLength(0);
			expect(storedRow?.needsReauth).toBe(true);
		},
	);

	it.each(LEGACY_WRITES)(
		"after a legacy write of %s, tokens() hands out not even the access token, and the config is flagged",
		async (_label, legacyWrite) => {
			// The access token written beside a replaced credential may belong
			// to another authorization server.
			storedRow = baseRow(legacyWrite);
			const provider = await makeProvider();

			await expect(provider.tokens()).rejects.toBeInstanceOf(
				OAuthAuthorizationRequiredError,
			);
			expect(requests).toHaveLength(0);
			expect(storedRow?.needsReauth).toBe(true);
		},
	);

	it.each(LEGACY_WRITES)(
		"after a legacy write of %s, a 401 is not resent with a token stored beside it",
		async (_label, legacyWrite) => {
			storedRow = baseRow({
				...legacyWrite,
				encryptedAccessToken: "ENC:a-access-other",
			});
			const provider =
				(await makeProvider()) as FabricRefreshingOAuthClientProvider;

			await expect(
				provider.refreshAfterUnauthorized("a-access-1"),
			).resolves.toBeNull();
			expect(requests).toHaveLength(0);
			expect(storedRow?.needsReauth).toBe(true);
		},
	);

	it("tokens() hands the SDK no refresh token", async () => {
		const provider = await makeProvider();

		const tokens = await provider.tokens();

		expect(tokens?.access_token).toBe("a-access-1");
		expect(tokens).not.toHaveProperty("refresh_token");
		expect(requests).toHaveLength(0);
	});

	it.each(LEGACY_WRITES)(
		"after a legacy write of %s, a refresh after a 401 sends nothing and the config is flagged",
		async (_label, legacyWrite) => {
			storedRow = baseRow(legacyWrite);
			const provider =
				(await makeProvider()) as FabricRefreshingOAuthClientProvider;

			await expect(
				provider.refreshAfterUnauthorized("a-access-1"),
			).resolves.toBeNull();
			expect(requests).toHaveLength(0);
			expectNoLegacyCredentialSent();
			expect(storedRow?.needsReauth).toBe(true);
		},
	);

	it.each(LEGACY_WRITES.slice(0, 2))(
		"clientInformation() never hands the SDK a client after a legacy write of %s",
		async (_label, legacyWrite) => {
			storedRow = baseRow(legacyWrite);
			const provider = await makeProvider();

			await expect(provider.clientInformation()).rejects.toBeInstanceOf(
				OAuthAuthorizationRequiredError,
			);
			expect(storedRow?.needsReauth).toBe(true);
		},
	);

	it("saveTokens refuses even tokens stamped with the bound AS", async () => {
		const provider = await makeProvider();
		await provider.tokens();
		const before = structuredClone(storedRow);

		await expect(
			provider.saveTokens({
				access_token: "a-access-2",
				refresh_token: "a-refresh-2",
				token_type: "Bearer",
				issuer: AS_A,
			} as never),
		).rejects.toBeInstanceOf(OAuthAuthorizationRequiredError);

		expect(storedRow).toEqual(before);
	});
});

describe("SDK token errors never carry what the token endpoint echoed", () => {
	// The SDK no longer refreshes; the one token request it can still make is
	// an authorization-code exchange, so the echoed secret is the code.
	const SECRET = "code-secret-1";

	function echoingFetch(body: string, status: number, contentType: string) {
		return vi.fn(async (input: string | URL, init?: RequestInit) => {
			record(input, init);
			if (String(input) === `${AS_A}/oauth/token`) {
				return new Response(body, {
					status,
					headers: { "content-type": contentType },
				});
			}
			return respond(String(input));
		}) as unknown as typeof fetch;
	}

	function everythingSaidAbout(error: unknown): string {
		const parts: string[] = [];
		let current: unknown = error;
		for (let depth = 0; current && depth < 6; depth++) {
			if (current instanceof Error) {
				parts.push(current.message, String(current.stack ?? ""));
				current = (current as { cause?: unknown }).cause;
			} else {
				parts.push(JSON.stringify(current));
				break;
			}
		}
		parts.push(JSON.stringify(error));
		return parts.join("\n");
	}

	it.each([
		[
			"an OAuth error with an echoed description",
			JSON.stringify({
				error: "invalid_scope",
				error_description: `refresh token ${SECRET} is not valid for this scope`,
			}),
			400,
			"application/json",
		],
		[
			"an unrecognised error code that is the token itself",
			JSON.stringify({ error: SECRET }),
			400,
			"application/json",
		],
		[
			"a non-OAuth error body",
			`bad request: refresh_token=${SECRET}`,
			400,
			"text/plain",
		],
		[
			"a 2xx error body",
			JSON.stringify({ error: SECRET }),
			200,
			"application/json",
		],
	])(
		"%s is reduced to its classified code before the SDK sees it",
		async (_label, body, status, contentType) => {
			const provider = await makeProvider(() => {});
			await provider.saveCodeVerifier("verifier-1");
			const errors: unknown[] = [];
			const errorSpy = vi
				.spyOn(console, "error")
				.mockImplementation((...args) => {
					errors.push(args);
				});

			const thrown = await auth(provider, {
				serverUrl: "https://mcp.example.com/mcp",
				authorizationCode: SECRET,
				// The guarded fetch the transports are given in client.ts.
				fetchFn: oauthRequestsRefuseRedirects(
					new URL("https://mcp.example.com/mcp"),
					echoingFetch(body, status, contentType),
				),
			}).then(
				() => null,
				(error: unknown) => error,
			);

			// The exchange was attempted with the secret...
			expect(
				requests.some(
					(r) =>
						r.url === `${AS_A}/oauth/token` &&
						r.body.includes(SECRET),
				),
			).toBe(true);
			// ...and nothing the SDK produced from the answer repeats it.
			expect(everythingSaidAbout(thrown)).not.toContain(SECRET);
			expect(JSON.stringify(errors)).not.toContain(SECRET);
			errorSpy.mockRestore();
		},
	);

	it("nor does the error createMcpClient throws, its cause, its logs, or the stored refresh error after Fabric's refresh on a 401", async () => {
		const REFRESH_SECRET = "a-refresh-1";
		const { createMcpClient } = await import("../client");
		const { safeFetchOutbound } = await import("@repo/utils/url-security");
		vi.mocked(safeFetchOutbound).mockImplementationOnce(
			async (input, init) => {
				record(input, init);
				return new Response(
					JSON.stringify({
						error: "invalid_scope",
						error_description: `refresh token ${REFRESH_SECRET} is not valid`,
					}),
					{
						status: 400,
						headers: { "content-type": "application/json" },
					},
				);
			},
		);
		const provider = await makeProvider(() => {});
		const logged: unknown[] = [];
		for (const level of ["error", "warn", "log"] as const) {
			vi.spyOn(console, level).mockImplementation((...args) => {
				logged.push(args);
			});
		}
		const fetchFn = vi.fn(
			async (input: string | URL, init?: RequestInit) => {
				record(input, init);
				const url = String(input);
				if (url === "https://mcp.example.com/mcp") {
					// The MCP server asks for authorization; Fabric refreshes.
					return new Response("{}", {
						status: 401,
						headers: { "content-type": "application/json" },
					});
				}
				return respond(url);
			},
		);

		const thrown = await createMcpClient({
			serverUrl: "https://mcp.example.com/mcp",
			transport: "HTTP",
			authProvider: provider,
			fetch: fetchFn as never,
		}).then(
			() => null,
			(error: unknown) => error,
		);

		expect(thrown).toBeInstanceOf(Error);
		expect(
			requests.some(
				(r) =>
					r.url === `${AS_A}/oauth/token` &&
					r.body.includes(REFRESH_SECRET),
			),
		).toBe(true);
		expect(everythingSaidAbout(thrown)).not.toContain(REFRESH_SECRET);
		expect(JSON.stringify(logged)).not.toContain(REFRESH_SECRET);
		expect(String(storedRow?.lastRefreshError ?? "")).not.toContain(
			REFRESH_SECRET,
		);
	});
});

describe("what the provider hands the SDK", () => {
	it("returns the bound AS as discovery state, with the pinned token endpoint", async () => {
		const provider = await makeProvider();

		const state = await provider.discoveryState?.();

		expect(state?.authorizationServerUrl).toBe(AS_A);
		expect(state?.authorizationServerMetadata).toMatchObject({
			token_endpoint: `${AS_A}/oauth/token`,
			authorization_endpoint: `${AS_A}/authorize`,
			response_types_supported: ["code"],
		});
		await provider.saveDiscoveryState?.({
			authorizationServerUrl: AS_B,
		});
		expect(storedRow?.oauthBinding).toEqual(BINDING_A);
	});

	it("stamps tokens and client information with the bound AS and the registered auth method", async () => {
		const provider = await makeProvider();

		expect(await provider.tokens()).toMatchObject({ issuer: AS_A });
		expect(await provider.clientInformation()).toMatchObject({
			client_id: "client_a",
			client_secret: "secret-a",
			token_endpoint_auth_method: "client_secret_basic",
			issuer: AS_A,
		});
	});

	it("refuses tokens stamped for another AS", async () => {
		const provider = await makeProvider();
		await provider.tokens();

		await expect(
			provider.saveTokens({
				access_token: "b-access",
				token_type: "Bearer",
				issuer: AS_B,
			} as never),
		).rejects.toBeInstanceOf(OAuthAuthorizationRequiredError);
		expect(storedRow?.encryptedAccessToken).toBe("ENC:a-access-1");
	});

	it("accepts only a re-stamp of the stored client with the bound AS", async () => {
		const provider = await makeProvider();
		const read = await provider.clientInformation();

		await expect(
			provider.saveClientInformation?.({
				...read,
				issuer: AS_A,
			} as never),
		).resolves.toBeUndefined();
		await expect(
			provider.saveClientInformation?.({
				client_id: "b-client",
				issuer: AS_B,
			} as never),
		).rejects.toBeInstanceOf(OAuthAuthorizationRequiredError);
		await expect(
			provider.saveClientInformation?.({
				...read,
				client_secret: "another-secret",
				issuer: AS_A,
			} as never),
		).rejects.toBeInstanceOf(OAuthAuthorizationRequiredError);
		expect(storedRow).toMatchObject({
			oauthClientId: "client_a",
			encryptedOauthClientSecret: "ENC:secret-a",
			dcrClientMetadata: {
				token_endpoint_auth_method: "client_secret_basic",
			},
			oauthGrantGeneration: 7,
		});
	});
});

describe("invalidateCredentials", () => {
	// The SDK calls this after a token request of its own is rejected. It no
	// longer makes one, and a wipe here would skip the refresh service's
	// strike count, so no scope changes the row.
	it.each(["tokens", "client", "all", "discovery", "verifier"] as const)(
		"%s: makes no durable change",
		async (scope) => {
			const provider = await makeProvider();
			await provider.tokens();
			const before = structuredClone(storedRow);

			await provider.invalidateCredentials?.(scope);

			expect(storedRow).toEqual(before);
			expect(storedRow).toMatchObject({
				encryptedAccessToken: "ENC:a-access-1",
				encryptedRefreshToken: "ENC:a-refresh-1",
				oauthClientId: "client_a",
				oauthGrantGeneration: 7,
				needsReauth: false,
			});
		},
	);
});

describe("a 401 from the MCP server, through the real SDK transports", () => {
	const MCP_URL = "https://mcp.example.com/mcp";
	const SSE_MESSAGES_URL = "https://mcp.example.com/messages";
	const encoder = new TextEncoder();

	type JsonRpc = {
		id?: number;
		method: string;
		params?: { protocolVersion?: string };
	};

	function resultFor(message: JsonRpc) {
		return {
			jsonrpc: "2.0",
			id: message.id,
			result:
				message.method === "initialize"
					? {
							protocolVersion: message.params?.protocolVersion,
							capabilities: { tools: {} },
							serverInfo: { name: "example", version: "1.0.0" },
						}
					: message.method === "tools/list"
						? { tools: [] }
						: {},
		};
	}

	/** Bearer tokens the MCP server saw on each JSON-RPC POST, in order. */
	let posts: Array<{ method: string; bearer: string | null }> = [];

	function bearerOf(init?: RequestInit): string | null {
		const header = new Headers(init?.headers).get("authorization");
		return header?.replace(/^Bearer /, "") ?? null;
	}

	/**
	 * A simulated MCP server, as the transport `fetch` `createMcpClient` is
	 * given. `accepts` decides whether a POST's bearer token is accepted;
	 * `onReject` runs before each 401. With `sse`, it speaks the legacy SSE
	 * transport (GET event stream + POST endpoint), else Streamable HTTP.
	 */
	function mcpServer(options: {
		accepts: (bearer: string | null) => boolean;
		onReject?: () => void;
		sse?: boolean;
	}) {
		let stream: ReadableStreamDefaultController<Uint8Array> | null = null;
		return vi.fn(async (input: string | URL, init?: RequestInit) => {
			record(input, init);
			const url = String(input);
			if (!url.startsWith("https://mcp.example.com/")) {
				return respond(url);
			}
			const method = (init?.method ?? "GET").toUpperCase();
			if (method === "GET") {
				if (!options.sse) {
					return new Response(null, { status: 405 });
				}
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							stream = controller;
							controller.enqueue(
								encoder.encode(
									`event: endpoint\ndata: ${SSE_MESSAGES_URL}\n\n`,
								),
							);
						},
					}),
					{
						status: 200,
						headers: { "content-type": "text/event-stream" },
					},
				);
			}
			const message = JSON.parse(String(init?.body)) as JsonRpc;
			const bearer = bearerOf(init);
			posts.push({ method: message.method, bearer });
			if (!options.accepts(bearer)) {
				options.onReject?.();
				return new Response("unauthorized", { status: 401 });
			}
			if (message.id === undefined) {
				return new Response(null, { status: 202 });
			}
			if (options.sse) {
				stream?.enqueue(
					encoder.encode(
						`event: message\ndata: ${JSON.stringify(resultFor(message))}\n\n`,
					),
				);
				return new Response(null, { status: 202 });
			}
			return new Response(JSON.stringify(resultFor(message)), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});
	}

	const tokenRequests = () =>
		requests.filter((r) => r.url === `${AS_A}/oauth/token`);

	async function connect(
		server: ReturnType<typeof mcpServer>,
		transport: "HTTP" | "SSE" = "HTTP",
	) {
		const { createMcpClient } = await import("../client");
		return createMcpClient({
			serverUrl: MCP_URL,
			transport,
			authProvider: await makeProvider(),
			fetch: server as never,
		});
	}

	beforeEach(() => {
		posts = [];
	});

	it.each(["HTTP", "SSE"] as const)(
		"%s: refreshes once through Fabric's service and resends once with the new token",
		async (transport) => {
			const server = mcpServer({
				accepts: (bearer) => bearer === "a-access-2",
				sse: transport === "SSE",
			});

			const client = await connect(server, transport);
			await client.close();

			// Exactly one token-endpoint call, made by Fabric's refresh
			// service (the transport fetch never carried one: the SDK did
			// not refresh).
			expect(tokenRequests()).toHaveLength(1);
			expect(tokenRequests()[0]?.body).toContain(
				"refresh_token=a-refresh-1",
			);
			expect(
				server.mock.calls.some(([url]) =>
					String(url).includes("/token"),
				),
			).toBe(false);
			if (transport === "SSE") {
				// The legacy transport: event stream opened, messages POSTed
				// to the endpoint it named.
				expect(
					server.mock.calls.some(
						([url]) => String(url) === SSE_MESSAGES_URL,
					),
				).toBe(true);
			}
			// initialize was sent twice: rejected, then resent once.
			expect(posts.filter((p) => p.method === "initialize")).toEqual([
				{ method: "initialize", bearer: "a-access-1" },
				{ method: "initialize", bearer: "a-access-2" },
			]);
			expect(storedRow).toMatchObject({
				encryptedAccessToken: "ENC:a-access-2",
				encryptedRefreshToken: "ENC:a-refresh-2",
				oauthGrantGeneration: 7,
				needsReauth: false,
			});
		},
	);

	it("resends with the token another replica already stored, without a token-endpoint call", async () => {
		const server = mcpServer({
			accepts: (bearer) => bearer === "a-access-other",
			// Another replica refreshes after this request read its token.
			onReject: () => {
				// As `saveMcpOAuthRefresh` writes it: re-fingerprinted for
				// the rotated refresh token.
				Object.assign(storedRow ?? {}, {
					encryptedAccessToken: "ENC:a-access-other",
					accessTokenHash: "HASH:a-access-other",
					encryptedRefreshToken: "ENC:a-refresh-other",
					oauthBinding: withCredentialFingerprint(
						BINDING_A_UNFINGERPRINTED,
						{
							...STORED_CREDENTIALS,
							encryptedRefreshToken: "ENC:a-refresh-other",
						},
					),
				});
			},
		});

		const client = await connect(server);
		await client.close();

		expect(tokenRequests()).toHaveLength(0);
		expect(posts.filter((p) => p.method === "initialize")).toEqual([
			{ method: "initialize", bearer: "a-access-1" },
			{ method: "initialize", bearer: "a-access-other" },
		]);
		expect(storedRow?.encryptedRefreshToken).toBe("ENC:a-refresh-other");
	});

	it("a second 401 ends in OAuthAuthorizationRequiredError, after one refresh and one resend", async () => {
		const server = mcpServer({ accepts: () => false });

		const thrown = await connect(server).catch((error: unknown) => error);

		expect(thrown).toBeInstanceOf(OAuthAuthorizationRequiredError);
		expect(tokenRequests()).toHaveLength(1);
		expect(posts.filter((p) => p.method === "initialize")).toEqual([
			{ method: "initialize", bearer: "a-access-1" },
			{ method: "initialize", bearer: "a-access-2" },
		]);
		// The grant is not condemned by a rejected access token.
		expect(storedRow).toMatchObject({
			encryptedAccessToken: "ENC:a-access-2",
			oauthGrantGeneration: 7,
			needsReauth: false,
		});
	});

	it("makes no refresh once the chat turn stopped while the rejected request was in flight", async () => {
		const { runWithDispatchGuard } = await import(
			"@repo/utils/dispatch-guard"
		);
		const STOP = new Error("the chat turn stopped");
		let stopped = false;
		const guard = {
			key: "turn-example-2",
			assertDispatchable: async () => undefined,
			abortSignal: () => undefined,
			rethrowIfStopped: () => {
				if (stopped) {
					throw STOP;
				}
			},
			throwIfStopped: () => {
				if (stopped) {
					throw STOP;
				}
			},
		};
		const server = mcpServer({
			accepts: (bearer) => bearer === "a-access-2",
			// The turn stops after the send passed its check, before the 401.
			onReject: () => {
				stopped = true;
			},
		});

		const thrown = await runWithDispatchGuard(guard, () =>
			connect(server),
		).catch((error: unknown) => error);

		expect(thrown).toBeInstanceOf(Error);
		// No refresh token was spent, and nothing was resent.
		expect(tokenRequests()).toHaveLength(0);
		expect(posts).toEqual([{ method: "initialize", bearer: "a-access-1" }]);
		expect(storedRow?.encryptedRefreshToken).toBe("ENC:a-refresh-1");
	});

	it("refuses the resend once the chat turn stopped during the refresh", async () => {
		const { runWithDispatchGuard } = await import(
			"@repo/utils/dispatch-guard"
		);
		const STOP = new Error("the chat turn stopped");
		let stopped = false;
		const guard = {
			key: "turn-example-1",
			assertDispatchable: async () => undefined,
			abortSignal: () => undefined,
			rethrowIfStopped: () => {
				if (stopped) {
					throw STOP;
				}
			},
			throwIfStopped: () => {
				if (stopped) {
					throw STOP;
				}
			},
		};
		const { safeFetchOutbound } = await import("@repo/utils/url-security");
		vi.mocked(safeFetchOutbound).mockImplementationOnce(
			async (input, init) => {
				record(input, init);
				// The turn stops while the refresh is in flight.
				stopped = true;
				return respond(String(input));
			},
		);
		const server = mcpServer({
			accepts: (bearer) => bearer === "a-access-2",
		});

		const thrown = await runWithDispatchGuard(guard, () =>
			connect(server),
		).catch((error: unknown) => error);

		expect(thrown).toBeInstanceOf(Error);
		expect(tokenRequests()).toHaveLength(1);
		// Only the rejected first send reached the server.
		expect(posts).toEqual([{ method: "initialize", bearer: "a-access-1" }]);
	});

	it("an invalid_grant counts one failure strike and wipes nothing", async () => {
		const { safeFetchOutbound } = await import("@repo/utils/url-security");
		vi.mocked(safeFetchOutbound).mockImplementationOnce(
			async (input, init) => {
				record(input, init);
				return new Response(
					JSON.stringify({ error: "invalid_grant" }),
					{
						status: 400,
						headers: { "content-type": "application/json" },
					},
				);
			},
		);
		const server = mcpServer({ accepts: () => false });

		const thrown = await connect(server).catch((error: unknown) => error);

		expect(thrown).toBeInstanceOf(OAuthAuthorizationRequiredError);
		expect(tokenRequests()).toHaveLength(1);
		// No resend: there was no token to resend with.
		expect(posts).toHaveLength(1);
		expect(storedRow).toMatchObject({
			encryptedAccessToken: "ENC:a-access-1",
			encryptedRefreshToken: "ENC:a-refresh-1",
			oauthClientId: "client_a",
			oauthGrantGeneration: 7,
			needsReauth: false,
			refreshFailureCount: 1,
		});
	});

	it("resends with another replica's token when its own refresh failed on the rotation race", async () => {
		const { safeFetchOutbound } = await import("@repo/utils/url-security");
		vi.mocked(safeFetchOutbound).mockImplementationOnce(
			async (input, init) => {
				record(input, init);
				return new Response(
					JSON.stringify({ error: "invalid_grant" }),
					{
						status: 400,
						headers: { "content-type": "application/json" },
					},
				);
			},
		);
		// Another replica rotated the token first, and its write commits only
		// after this replica's refresh service has reloaded the row and
		// counted the failure: the service reports "failed", not "superseded".
		const { db } = await import("@repo/database/prisma/client");
		const otherReplicaCommits = () =>
			Object.assign(storedRow ?? {}, {
				encryptedAccessToken: "ENC:a-access-other",
				accessTokenHash: "HASH:a-access-other",
				encryptedRefreshToken: "ENC:a-refresh-other",
				oauthBinding: withCredentialFingerprint(
					BINDING_A_UNFINGERPRINTED,
					{
						...STORED_CREDENTIALS,
						encryptedRefreshToken: "ENC:a-refresh-other",
					},
				),
			});
		type Impl = (...args: unknown[]) => unknown;
		const restores: Array<() => void> = [];
		for (const method of ["update", "updateMany"] as const) {
			const mock = vi.mocked(db.mCPConfig[method]) as unknown as {
				getMockImplementation(): Impl;
				mockImplementation(fn: Impl): void;
			};
			const original = mock.getMockImplementation();
			restores.push(() => mock.mockImplementation(original));
			mock.mockImplementation(async (...args: unknown[]) => {
				const result = await original(...args);
				const data = (args[0] as { data?: Record<string, unknown> })
					.data;
				if (data && "refreshFailureCount" in data) {
					otherReplicaCommits();
				}
				return result;
			});
		}
		try {
			const provider =
				(await makeProvider()) as FabricRefreshingOAuthClientProvider;

			await expect(
				provider.refreshAfterUnauthorized("a-access-1"),
			).resolves.toBe("a-access-other");
			expect(tokenRequests()).toHaveLength(1);
			expect(storedRow).toMatchObject({
				refreshFailureCount: 1,
				needsReauth: false,
			});
		} finally {
			for (const restore of restores) {
				restore();
			}
		}
	});

	it("never refreshes or resends for a config already flagged for reconnect", async () => {
		const provider =
			(await makeProvider()) as FabricRefreshingOAuthClientProvider;
		// Even a newer stored token is not handed out once reconnect is due.
		Object.assign(storedRow ?? {}, {
			needsReauth: true,
			encryptedAccessToken: "ENC:a-access-other",
		});

		await expect(
			provider.refreshAfterUnauthorized("a-access-1"),
		).resolves.toBeNull();
		expect(requests).toHaveLength(0);
	});
});

describe("retryOnceAfterUnauthorized", () => {
	const unauthorized = () => new Response("no", { status: 401 });

	async function run(init: RequestInit) {
		const { retryOnceAfterUnauthorized } = await import("../client");
		const base = vi.fn(async () => unauthorized());
		const refresh = vi.fn(async () => "fresh-token");
		const response = await retryOnceAfterUnauthorized(base, refresh)(
			"https://mcp.example.com/mcp",
			init,
		);
		return { response, base, refresh };
	}

	it("resends a string body once with the fresh bearer token", async () => {
		const { response, base, refresh } = await run({
			method: "POST",
			headers: { Authorization: "Bearer stale-token" },
			body: "{}",
		});

		expect(response.status).toBe(401);
		expect(refresh).toHaveBeenCalledWith("stale-token");
		expect(base).toHaveBeenCalledTimes(2);
		const resent = base.mock.calls[1] as unknown as [string, RequestInit];
		expect(new Headers(resent[1].headers).get("authorization")).toBe(
			"Bearer fresh-token",
		);
		expect(resent[1].body).toBe("{}");
	});

	it.each([
		[
			"a token request",
			{
				method: "POST",
				headers: { Authorization: "Bearer stale-token" },
				body: new URLSearchParams({ grant_type: "refresh_token" }),
			},
		],
		[
			"a stream body that cannot be sent twice",
			{
				method: "POST",
				headers: { Authorization: "Bearer stale-token" },
				body: new ReadableStream(),
			},
		],
		["a request with no bearer token", { method: "POST", body: "{}" }],
	])("leaves %s alone", async (_label, init) => {
		const { response, base, refresh } = await run(init as RequestInit);

		expect(response.status).toBe(401);
		expect(refresh).not.toHaveBeenCalled();
		expect(base).toHaveBeenCalledTimes(1);
	});

	it("returns the original 401, unread, when no fresh token is available", async () => {
		const { retryOnceAfterUnauthorized } = await import("../client");
		const original = unauthorized();
		const base = vi.fn(async () => original);
		const response = await retryOnceAfterUnauthorized(
			base,
			async () => null,
		)("https://mcp.example.com/mcp", {
			method: "POST",
			headers: { Authorization: "Bearer t" },
			body: "{}",
		});

		expect(response).toBe(original);
		expect(response.bodyUsed).toBe(false);
		expect(base).toHaveBeenCalledTimes(1);
	});
	it("cancels the 401 body and rethrows when the refresh throws", async () => {
		const { retryOnceAfterUnauthorized } = await import("../client");
		const original = unauthorized();
		const cancel = vi.spyOn(
			original.body as ReadableStream<Uint8Array>,
			"cancel",
		);
		const base = vi.fn(async () => original);
		const failure = new Error("database unavailable");

		await expect(
			retryOnceAfterUnauthorized(base, async () => {
				throw failure;
			})("https://mcp.example.com/mcp", {
				method: "POST",
				headers: { Authorization: "Bearer t" },
				body: "{}",
			}),
		).rejects.toBe(failure);

		expect(cancel).toHaveBeenCalledTimes(1);
		expect(base).toHaveBeenCalledTimes(1);
	});
});
