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
	for (const request of requests.filter((r) => r.url.startsWith(AS_B))) {
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
	it("refreshes at the bound AS's pinned token endpoint and sends B nothing", async () => {
		const provider = await makeProvider();

		const result = await auth(provider, {
			serverUrl: "https://mcp.example.com/mcp",
			fetchFn: sdkFetch,
		});

		expect(result).toBe("AUTHORIZED");
		const refresh = requests.find((r) => r.url === `${AS_A}/oauth/token`);
		expect(refresh?.body).toContain("refresh_token=a-refresh-1");
		// The registered client authentication: HTTP Basic.
		expect(refresh?.headers).toContain(
			`Basic ${btoa("client_a:secret-a")}`,
		);
		// B is never asked anything, let alone sent a credential.
		expect(requests.some((r) => r.url.startsWith(AS_B))).toBe(false);
		expectNothingSentToB("a-refresh-1", "secret-a");
		// The SDK's result is saved through the compare-and-set write.
		expect(storedRow).toMatchObject({
			encryptedAccessToken: "ENC:a-access-2",
			encryptedRefreshToken: "ENC:a-refresh-2",
			oauthGrantGeneration: 7,
			// Same binding, re-fingerprinted for the rotated refresh token.
			oauthBinding: withCredentialFingerprint(BINDING_A, {
				...STORED_CREDENTIALS,
				encryptedRefreshToken: "ENC:a-refresh-2",
			}),
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

		expect(requests.some((r) => r.url.startsWith(AS_B))).toBe(false);
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
			refresh_token: "a-refresh-2",
			issuer: AS_A,
		});
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

	it("the SDK's refresh result is dropped when the grant changed while it was in flight", async () => {
		const provider = await makeProvider();
		const fetchThatRevokes = vi.fn(
			async (input: string | URL, init?: RequestInit) => {
				record(input, init);
				if (String(input) === `${AS_A}/oauth/token`) {
					Object.assign(storedRow ?? {}, {
						encryptedAccessToken: null,
						encryptedRefreshToken: null,
						oauthGrantGeneration: 8,
					});
				}
				return respond(String(input));
			},
		) as unknown as typeof fetch;

		await expect(
			auth(provider, {
				serverUrl: "https://mcp.example.com/mcp",
				fetchFn: fetchThatRevokes,
			}),
		).rejects.toBeInstanceOf(OAuthAuthorizationRequiredError);
		expect(storedRow).toMatchObject({
			encryptedAccessToken: null,
			encryptedRefreshToken: null,
		});
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

	it("tokens() never hands the SDK a replaced refresh token", async () => {
		storedRow = baseRow({
			encryptedRefreshToken: "ENC:refresh-from-another-as",
			encryptedAccessToken: "ENC:access-from-another-as",
		});
		const provider = await makeProvider();

		await expect(provider.tokens()).rejects.toBeInstanceOf(
			OAuthAuthorizationRequiredError,
		);
		expect(storedRow?.needsReauth).toBe(true);
		expect(requests).toHaveLength(0);
	});

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

	it("a legacy write landing after tokens() makes the SDK's refresh result unsavable", async () => {
		const provider = await makeProvider();
		await provider.tokens();
		// The previous app version replaces the client secret by id.
		Object.assign(storedRow ?? {}, {
			encryptedOauthClientSecret: "ENC:secret-from-another-as",
		});

		await provider.saveTokens({
			access_token: "a-access-2",
			refresh_token: "a-refresh-2",
			token_type: "Bearer",
			issuer: AS_A,
		} as never);

		// Fenced on the client handed out with the refresh token: nothing is
		// written, and the binding is not re-fingerprinted over the new secret.
		expect(storedRow).toMatchObject({
			encryptedAccessToken: "ENC:a-access-1",
			oauthBinding: BINDING_A,
		});
	});
});

describe("SDK token errors never carry what the token endpoint echoed", () => {
	const SECRET = "a-refresh-1";

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
			const errors: unknown[] = [];
			const errorSpy = vi
				.spyOn(console, "error")
				.mockImplementation((...args) => {
					errors.push(args);
				});

			const thrown = await auth(provider, {
				serverUrl: "https://mcp.example.com/mcp",
				// The guarded fetch the transports are given in client.ts.
				fetchFn: oauthRequestsRefuseRedirects(
					new URL("https://mcp.example.com/mcp"),
					echoingFetch(body, status, contentType),
				),
			}).then(
				() => null,
				(error: unknown) => error,
			);

			// The refresh was attempted with the secret...
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

	it("nor does the error createMcpClient throws, its cause, or its logs", async () => {
		const { createMcpClient } = await import("../client");
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
					// The MCP server asks for authorization; the SDK refreshes.
					return new Response("{}", {
						status: 401,
						headers: { "content-type": "application/json" },
					});
				}
				if (url === `${AS_A}/oauth/token`) {
					return new Response(
						JSON.stringify({
							error: "invalid_scope",
							error_description: `refresh token ${SECRET} is not valid`,
						}),
						{
							status: 400,
							headers: { "content-type": "application/json" },
						},
					);
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
					r.url === `${AS_A}/oauth/token` && r.body.includes(SECRET),
			),
		).toBe(true);
		expect(everythingSaidAbout(thrown)).not.toContain(SECRET);
		expect(JSON.stringify(logged)).not.toContain(SECRET);
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
	it("tokens: wipes the tokens, moves the generation and flags reconnect, keeping client and binding", async () => {
		const provider = await makeProvider();
		await provider.tokens();

		await provider.invalidateCredentials?.("tokens");

		expect(storedRow).toMatchObject({
			encryptedAccessToken: null,
			encryptedRefreshToken: null,
			oauthGrantGeneration: 8,
			needsReauth: true,
			oauthClientId: "client_a",
			// Kept, re-fingerprinted for the credentials the wipe leaves.
			oauthBinding: withCredentialFingerprint(BINDING_A, {
				...STORED_CREDENTIALS,
				encryptedRefreshToken: null,
			}),
		});
	});

	it("tokens: leaves a token another refresh rotated in place", async () => {
		const provider = await makeProvider();
		await provider.tokens();
		Object.assign(storedRow ?? {}, {
			encryptedRefreshToken: "ENC:rotated-by-another",
		});

		await provider.invalidateCredentials?.("tokens");

		expect(storedRow).toMatchObject({
			encryptedRefreshToken: "ENC:rotated-by-another",
			oauthGrantGeneration: 7,
		});
	});

	it.each(["client", "all"] as const)(
		"%s: also clears the client, keeping the binding",
		async (scope) => {
			const provider = await makeProvider();

			await provider.invalidateCredentials?.(scope);

			expect(storedRow).toMatchObject({
				encryptedAccessToken: null,
				oauthClientId: null,
				encryptedOauthClientSecret: null,
				dcrClientMetadata: null,
				oauthGrantGeneration: 8,
				needsReauth: true,
				oauthBinding: withCredentialFingerprint(BINDING_A, {
					oauthClientId: null,
					encryptedOauthClientSecret: null,
					encryptedRefreshToken: null,
				}),
			});
		},
	);

	it.each(["discovery", "verifier"] as const)(
		"%s: makes no durable change",
		async (scope) => {
			const provider = await makeProvider();
			const before = structuredClone(storedRow);

			await provider.invalidateCredentials?.(scope);

			expect(storedRow).toEqual(before);
		},
	);

	it("from a provider whose grant was replaced, changes nothing", async () => {
		const provider = await makeProvider();
		Object.assign(storedRow ?? {}, {
			encryptedAccessToken: "ENC:new-grant",
			oauthGrantGeneration: 8,
		});

		await provider.invalidateCredentials?.("all");

		expect(storedRow).toMatchObject({
			encryptedAccessToken: "ENC:new-grant",
			oauthClientId: "client_a",
			oauthGrantGeneration: 8,
		});
	});
});
