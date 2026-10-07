/**
 * `mcp.oauth.start` resolves ONE authorization server (AS) and the callback
 * uses exactly that — the MCP server cannot redirect the code, the client
 * secret or a stored client to another AS by changing what it advertises.
 *
 * - start reuses a stored client only when it belongs to the AS start
 *   resolved; a dynamically registered client bound elsewhere is replaced by
 *   registering at the new AS, a hand-entered one is refused;
 * - Fabric's pre-registered clients take their AS from the catalog only;
 * - the callback exchanges the code at the snapshot's token endpoint, with
 *   the registered client authentication, and refuses a flow whose config
 *   changed since start.
 *
 * Harness as in `oauth-start-atlassian.test.ts`: the procedure builder is
 * mocked so the handler runs directly; the network is a URL-routing mock.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const serverAccess = vi.hoisted(() => ({
	accessible: true,
	calls: [] as unknown[][],
}));

const {
	readGitLabConnectionIssuerMock,
	getMcpConfigByIdInternalMock,
	createOauthStateMock,
	getOauthStateMock,
	deleteOauthStateMock,
	safeFetchOutboundMock,
	replaceMcpOAuthRegistrationMock,
	saveMcpOAuthGrantMock,
} = vi.hoisted(() => ({
	readGitLabConnectionIssuerMock: vi.fn(),
	getMcpConfigByIdInternalMock: vi.fn(),
	createOauthStateMock: vi.fn(),
	getOauthStateMock: vi.fn(),
	deleteOauthStateMock: vi.fn(),
	safeFetchOutboundMock: vi.fn(),
	replaceMcpOAuthRegistrationMock: vi.fn(),
	saveMcpOAuthGrantMock: vi.fn(),
}));

vi.mock("@repo/database", async () => ({
	// The config's server is one its tenant may use, unless a test says
	// otherwise (`serverAccess.accessible = false`).
	getMcpServerForTenant: async (...args: unknown[]) => {
		serverAccess.calls.push(args);
		return serverAccess.accessible ? { isSystemProvided: true } : null;
	},
	...(await vi.importActual<Record<string, unknown>>(
		"@repo/database/prisma/queries/lib/mcp-oauth-binding",
	)),
	clearRefreshFailures: vi.fn(),
	createOauthState: (...args: unknown[]) => createOauthStateMock(...args),
	db: { mCPConfig: { update: vi.fn() } },
	deleteOauthState: (...args: unknown[]) => deleteOauthStateMock(...args),
	getGoogleAccountEmail: vi.fn(),
	getMcpConfigByIdInternal: (...args: unknown[]) =>
		getMcpConfigByIdInternalMock(...args),
	getMcpServerDefaultTokenExpiry: () => null,
	getOauthState: (...args: unknown[]) => getOauthStateMock(...args),
	getOrganizationById: vi.fn(),
	refreshMcpOAuthAccessToken: vi.fn(),
	replaceMcpOAuthRegistration: (...args: unknown[]) =>
		replaceMcpOAuthRegistrationMock(...args),
	saveMcpOAuthGrant: (...args: unknown[]) => saveMcpOAuthGrantMock(...args),
}));

vi.mock("@repo/temporal", () => ({ triggerMcpToolIngestion: vi.fn() }));

vi.mock("@repo/integrations/gitlab", async (importOriginal) => ({
	...(await importOriginal<object>()),
	readGitLabConnectionIssuer: (...args: unknown[]) =>
		readGitLabConnectionIssuerMock(...args),
}));

vi.mock("@repo/utils", () => ({
	decryptApiKey: vi.fn((s: string) => s.replace(/^encrypted:/, "")),
	encryptApiKey: vi.fn((s: string) => `encrypted:${s}`),
	hashApiKey: vi.fn((s: string) => `hashed:${s}`),
}));
vi.mock("@repo/utils/url-security", async (importOriginal) => ({
	// The real address checks; only the transport is replaced.
	...(await importOriginal<object>()),
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
		authorizeInputOrganization: vi.fn(),
		Permissions: { MCP_CONNECT: "mcp:connect", MCP_UPDATE: "mcp:update" },
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

import { credentialFingerprint } from "@repo/database/prisma/queries/lib/mcp-oauth-binding";
import { oauthClientFingerprint } from "../../lib/oauth-authorization-server";
import { oauthProcedures } from "../oauth";

type StartHandler = (args: {
	input: Record<string, unknown>;
	context: { user: { id: string } };
}) => Promise<{ authorizationUrl: string; state: string }>;
type CallbackHandler = (args: {
	input: Record<string, unknown>;
}) => Promise<{ success: boolean; message: string }>;

const start = (oauthProcedures.start as unknown as { _handler: StartHandler })
	._handler;
const callback = (
	oauthProcedures.callback as unknown as { _handler: CallbackHandler }
)._handler;

const AS_A = "https://as-a.example.com";
const AS_B = "https://as-b.example.com";
let advertisedAs = AS_B;

function json(body: unknown, status = 200) {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: () => Promise.resolve(body),
	} as unknown as Response;
}

function routeFetch(url: string) {
	if (url.endsWith("/.well-known/oauth-protected-resource")) {
		return Promise.resolve(
			json({
				resource: "https://mcp.example.com",
				authorization_servers: [advertisedAs],
			}),
		);
	}
	for (const as of [AS_A, AS_B]) {
		if (url.startsWith(`${as}/.well-known/`)) {
			return Promise.resolve(
				json({
					issuer: as,
					authorization_endpoint: `${as}/authorize`,
					token_endpoint: `${as}/token`,
					registration_endpoint: `${as}/register`,
					response_types_supported: ["code"],
				}),
			);
		}
		if (url === `${as}/register`) {
			return Promise.resolve(
				json(
					{
						client_id: `client-from-${new URL(as).hostname}`,
						client_secret: "new-dcr-secret",
						token_endpoint_auth_method: "client_secret_basic",
					},
					201,
				),
			);
		}
		if (url === `${as}/token`) {
			return Promise.resolve(
				json({ access_token: "access", refresh_token: "refresh" }),
			);
		}
	}
	return Promise.resolve(json({}, 404));
}

function binding(as: string) {
	return {
		authorizationServerUrl: as,
		tokenEndpoint: `${as}/token`,
		authorizationServerMetadata: { token_endpoint: `${as}/token` },
		source: "discovery",
		boundAt: "2026-10-01T00:00:00.000Z",
	};
}

/**
 * A config row. A binding on it carries the fingerprint of the credentials
 * the row holds — as every write through the credential module leaves it —
 * unless the test passes `credentialFingerprint` itself.
 */
function config(overrides: Record<string, unknown> = {}) {
	const row = rawConfig(overrides);
	const stored = row.oauthBinding as Record<string, unknown> | null;
	if (
		!stored ||
		!("authorizationServerUrl" in stored) ||
		"credentialFingerprint" in stored
	) {
		return row;
	}
	return {
		...row,
		oauthBinding: {
			...stored,
			credentialFingerprint: credentialFingerprint({
				oauthClientId: (row.oauthClientId as string | null) ?? null,
				encryptedOauthClientSecret:
					(row.encryptedOauthClientSecret as string | null) ?? null,
				encryptedRefreshToken:
					((row as Record<string, unknown>).encryptedRefreshToken as
						| string
						| null) ?? null,
			}),
		},
	};
}

/** The client fingerprint `start` records for the default client. */
const CLIENT_A_FINGERPRINT = () =>
	oauthClientFingerprint({
		oauthClientId: "client-a",
		encryptedOauthClientSecret: "encrypted:secret-a",
	});

function rawConfig(overrides: Record<string, unknown> = {}) {
	return {
		id: "cfg_1",
		userId: "user_1",
		organizationId: null,
		mcpServerId: "srv_1",
		baseUrl: "https://mcp.example.com/mcp",
		enabled: false,
		scopes: [],
		oauthGrantGeneration: 4,
		oauthBinding: binding(AS_A),
		oauthClientId: "client-a",
		encryptedOauthClientSecret: "encrypted:secret-a",
		dcrClientMetadata: {
			token_endpoint_auth_method: "client_secret_basic",
		},
		dcrRegisteredAt: new Date("2026-01-01T00:00:00Z"),
		mcpServer: {
			id: "srv_1",
			key: "custom-mcp",
			defaultUrl: "https://mcp.example.com/mcp",
			oauthDiscoveryUrl: null,
			oauthAuthorizationEndpoint: null,
			oauthTokenEndpoint: null,
		},
		...overrides,
	};
}

/** The row the mocked registration write starts from. */
let rowForWrites: Record<string, unknown>;

const startInput = {
	configId: "cfg_1",
	redirectUri: "https://app.example.com/api/mcp/oauth/callback",
	autoDiscoverAndRegister: true,
};
const context = { user: { id: "user_1" } };

beforeEach(() => {
	vi.clearAllMocks();
	serverAccess.accessible = true;
	serverAccess.calls.length = 0;
	// `clearAllMocks` keeps queued `mockResolvedValueOnce` values.
	getMcpConfigByIdInternalMock.mockReset();
	advertisedAs = AS_B;
	safeFetchOutboundMock.mockImplementation(routeFetch);
	createOauthStateMock.mockResolvedValue("state-1");
	rowForWrites = config();
	// The registration write returns the row exactly as it wrote it.
	replaceMcpOAuthRegistrationMock.mockImplementation(
		async (args: {
			expectedGeneration: number;
			client: Record<string, unknown> | null;
			binding: unknown;
		}) => {
			const generation = args.expectedGeneration + 1;
			return {
				written: true,
				generation,
				config: {
					...rowForWrites,
					...(args.client ?? {
						oauthClientId: null,
						encryptedOauthClientSecret: null,
					}),
					oauthBinding: args.binding,
					oauthGrantGeneration: generation,
				},
			};
		},
	);
	readGitLabConnectionIssuerMock.mockResolvedValue(null);
	saveMcpOAuthGrantMock.mockResolvedValue({ written: true, generation: 6 });
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
});

function fetchedUrls(): string[] {
	return safeFetchOutboundMock.mock.calls.map((call) => String(call[0]));
}

describe("oauth.start — which client and AS", () => {
	it("re-registers at the newly advertised AS instead of reusing a client bound to another", async () => {
		getMcpConfigByIdInternalMock
			.mockResolvedValueOnce(config())
			.mockResolvedValueOnce(
				config({
					oauthClientId: "client-from-as-b.example.com",
					encryptedOauthClientSecret: "encrypted:new-dcr-secret",
					oauthBinding: binding(AS_B),
					oauthGrantGeneration: 5,
				}),
			);

		const result = await start({ input: startInput, context });

		expect(fetchedUrls()).toContain(`${AS_B}/register`);
		const write = replaceMcpOAuthRegistrationMock.mock.calls[0]?.[0];
		expect(write).toMatchObject({
			expectedGeneration: 4,
			client: { oauthClientId: "client-from-as-b.example.com" },
			binding: {
				authorizationServerUrl: AS_B,
				tokenEndpoint: `${AS_B}/token`,
			},
		});
		const url = new URL(result.authorizationUrl);
		expect(url.origin).toBe(AS_B);
		// Client A is never put in front of AS B.
		expect(url.searchParams.get("client_id")).toBe(
			"client-from-as-b.example.com",
		);
		for (const call of safeFetchOutboundMock.mock.calls) {
			expect(JSON.stringify(call)).not.toContain("client-a");
			expect(JSON.stringify(call)).not.toContain("secret-a");
		}
	});

	it("reuses the stored client when it belongs to the AS start resolved", async () => {
		advertisedAs = AS_A;
		getMcpConfigByIdInternalMock.mockResolvedValue(config());

		const result = await start({ input: startInput, context });

		expect(replaceMcpOAuthRegistrationMock).not.toHaveBeenCalled();
		expect(fetchedUrls().some((u) => u.endsWith("/register"))).toBe(false);
		const url = new URL(result.authorizationUrl);
		expect(url.origin).toBe(AS_A);
		expect(url.searchParams.get("client_id")).toBe("client-a");
		expect(createOauthStateMock.mock.calls[0]?.[0]).toMatchObject({
			expectedGrantGeneration: 4,
			authorizationServerSnapshot: {
				clientId: "client-a",
				// What the callback checks the stored client against.
				clientFingerprint: CLIENT_A_FINGERPRINT(),
				binding: { tokenEndpoint: `${AS_A}/token` },
			},
		});
	});

	it("refuses a hand-entered client bound to another AS rather than sending it there", async () => {
		getMcpConfigByIdInternalMock.mockResolvedValue(
			config({ dcrClientMetadata: null, dcrRegisteredAt: null }),
		);

		await expect(
			start({ input: startInput, context }),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: expect.stringContaining("different authorization server"),
		});
		expect(replaceMcpOAuthRegistrationMock).not.toHaveBeenCalled();
		expect(createOauthStateMock).not.toHaveBeenCalled();
	});

	describe("a stored client its binding was not written with", () => {
		// The binding was written for client-a / secret-a; the previous app
		// version then replaced the secret (or id) by id, without touching
		// the binding or the generation.
		const LEGACY = {
			encryptedOauthClientSecret: "encrypted:secret-from-elsewhere",
		};
		const legacyRow = (overrides: Record<string, unknown> = {}) =>
			config({
				oauthBinding: {
					...binding(AS_A),
					credentialFingerprint: credentialFingerprint({
						oauthClientId: "client-a",
						encryptedOauthClientSecret: "encrypted:secret-a",
						encryptedRefreshToken: null,
					}),
				},
				...LEGACY,
				...overrides,
			});

		it("a registered client is replaced by a fresh registration, never reused at its bound AS", async () => {
			advertisedAs = AS_A;
			getMcpConfigByIdInternalMock.mockResolvedValue(legacyRow());

			const result = await start({ input: startInput, context });

			expect(fetchedUrls()).toContain(`${AS_A}/register`);
			expect(
				replaceMcpOAuthRegistrationMock.mock.calls[0]?.[0],
			).toMatchObject({
				client: { oauthClientId: "client-from-as-a.example.com" },
			});
			expect(
				new URL(result.authorizationUrl).searchParams.get("client_id"),
			).toBe("client-from-as-a.example.com");
			for (const call of safeFetchOutboundMock.mock.calls) {
				expect(JSON.stringify(call)).not.toContain(
					"secret-from-elsewhere",
				);
			}
		});

		it("a hand-entered client is refused: no state, no request carrying it", async () => {
			advertisedAs = AS_A;
			getMcpConfigByIdInternalMock.mockResolvedValue(
				legacyRow({ dcrClientMetadata: null, dcrRegisteredAt: null }),
			);

			await expect(
				start({ input: startInput, context }),
			).rejects.toMatchObject({
				code: "BAD_REQUEST",
				message: expect.stringContaining("changed outside"),
			});
			expect(replaceMcpOAuthRegistrationMock).not.toHaveBeenCalled();
			expect(createOauthStateMock).not.toHaveBeenCalled();
		});

		it("Fabric's own client is reinstalled from its pinned configuration", async () => {
			process.env.GOOGLE_CLIENT_ID = "fabric-google-client";
			process.env.GOOGLE_CLIENT_SECRET = "fabric-google-secret";
			try {
				const googleServer = {
					id: "srv_gd",
					key: "google-drive",
					isSystemProvided: true,
					defaultUrl: null,
				};
				rowForWrites = config({
					baseUrl: null,
					mcpServer: googleServer,
				});
				getMcpConfigByIdInternalMock.mockResolvedValue(
					config({
						baseUrl: null,
						mcpServer: googleServer,
						oauthClientId: "fabric-google-client",
						encryptedOauthClientSecret: "encrypted:replaced-secret",
						dcrClientMetadata: null,
						dcrRegisteredAt: null,
						oauthBinding: {
							...binding("https://accounts.google.com"),
							credentialFingerprint: "written-for-another-secret",
						},
					}),
				);

				await start({
					input: { ...startInput, autoDiscoverAndRegister: false },
					context,
				});

				expect(
					replaceMcpOAuthRegistrationMock.mock.calls[0]?.[0],
				).toMatchObject({
					client: {
						oauthClientId: "fabric-google-client",
						encryptedOauthClientSecret:
							"encrypted:fabric-google-secret",
					},
				});
			} finally {
				delete process.env.GOOGLE_CLIENT_ID;
				delete process.env.GOOGLE_CLIENT_SECRET;
			}
		});
	});

	it("takes the AS of Fabric's pre-registered client from the catalog, never from discovery", async () => {
		process.env.SLACK_CLIENT_ID = "fabric-slack-client";
		process.env.SLACK_CLIENT_SECRET = "fabric-slack-secret";
		try {
			getMcpConfigByIdInternalMock
				.mockResolvedValueOnce(
					config({
						baseUrl: "https://mcp.slack.com/mcp",
						oauthBinding: null,
						oauthClientId: null,
						encryptedOauthClientSecret: null,
						dcrClientMetadata: null,
						dcrRegisteredAt: null,
						mcpServer: {
							id: "srv_slack",
							key: "slack-remote",
							isSystemProvided: true,
							defaultUrl: "https://mcp.slack.com/mcp",
						},
					}),
				)
				.mockResolvedValueOnce(
					config({
						baseUrl: "https://mcp.slack.com/mcp",
						oauthClientId: "fabric-slack-client",
						encryptedOauthClientSecret:
							"encrypted:fabric-slack-secret",
						dcrClientMetadata: null,
						dcrRegisteredAt: null,
						oauthGrantGeneration: 5,
						mcpServer: {
							id: "srv_slack",
							key: "slack-remote",
							isSystemProvided: true,
							defaultUrl: "https://mcp.slack.com/mcp",
						},
					}),
				);
			// The MCP server answers discovery with AS B; it must not matter.
			safeFetchOutboundMock.mockImplementation(routeFetch);
			rowForWrites = config({
				baseUrl: "https://mcp.slack.com/mcp",
				mcpServer: {
					id: "srv_slack",
					key: "slack-remote",
					isSystemProvided: true,
					defaultUrl: "https://mcp.slack.com/mcp",
				},
			});

			const result = await start({
				input: { ...startInput, autoDiscoverAndRegister: false },
				context,
			});

			const write = replaceMcpOAuthRegistrationMock.mock.calls[0]?.[0];
			expect(write).toMatchObject({
				client: {
					oauthClientId: "fabric-slack-client",
					// Recorded per client, not a global default.
					dcrClientMetadata: {
						token_endpoint_auth_method: "client_secret_post",
					},
				},
				binding: {
					authorizationServerUrl: "https://mcp.slack.com",
					tokenEndpoint: "https://slack.com/api/oauth.v2.user.access",
					source: "catalog",
				},
			});
			expect(new URL(result.authorizationUrl).origin).toBe(
				"https://slack.com",
			);
			expect(createOauthStateMock.mock.calls[0]?.[0]).toMatchObject({
				authorizationServerSnapshot: {
					binding: {
						tokenEndpoint:
							"https://slack.com/api/oauth.v2.user.access",
					},
				},
			});
		} finally {
			delete process.env.SLACK_CLIENT_ID;
			delete process.env.SLACK_CLIENT_SECRET;
		}
	});
});

describe("oauth.start — a metadata document cannot borrow another AS's identity", () => {
	it("refuses a document that claims A's issuer while naming B's endpoints, and sends A's client nowhere", async () => {
		// The catalog points discovery at a document the MCP server (B)
		// serves; the document claims to be AS A but names B's endpoints.
		getMcpConfigByIdInternalMock.mockResolvedValue(
			config({
				mcpServer: {
					id: "srv_1",
					key: "custom-mcp",
					defaultUrl: "https://mcp.example.com/mcp",
					oauthDiscoveryUrl:
						"https://mcp.example.com/.well-known/oauth-authorization-server",
				},
			}),
		);
		safeFetchOutboundMock.mockImplementation((url: string) =>
			url ===
			"https://mcp.example.com/.well-known/oauth-authorization-server"
				? Promise.resolve(
						json({
							issuer: AS_A,
							authorization_endpoint: `${AS_B}/authorize`,
							token_endpoint: `${AS_B}/token`,
							registration_endpoint: `${AS_B}/register`,
							response_types_supported: ["code"],
						}),
					)
				: routeFetch(url),
		);

		await expect(
			start({ input: startInput, context }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });

		expect(createOauthStateMock).not.toHaveBeenCalled();
		expect(replaceMcpOAuthRegistrationMock).not.toHaveBeenCalled();
		for (const call of safeFetchOutboundMock.mock.calls) {
			expect(JSON.stringify(call)).not.toContain("client-a");
			expect(JSON.stringify(call)).not.toContain("secret-a");
		}
	});

	it("reusing a bound client keeps the binding's pinned token endpoint, not the newly fetched document's", async () => {
		advertisedAs = AS_A;
		getMcpConfigByIdInternalMock.mockResolvedValue(config());
		// AS A's document now names another token endpoint.
		safeFetchOutboundMock.mockImplementation((url: string) =>
			url.startsWith(`${AS_A}/.well-known/`)
				? Promise.resolve(
						json({
							issuer: AS_A,
							authorization_endpoint: `${AS_A}/authorize`,
							token_endpoint: `${AS_B}/token`,
							response_types_supported: ["code"],
						}),
					)
				: routeFetch(url),
		);

		await start({ input: startInput, context });

		expect(createOauthStateMock.mock.calls[0]?.[0]).toMatchObject({
			authorizationServerSnapshot: {
				clientId: "client-a",
				binding: { tokenEndpoint: `${AS_A}/token` },
			},
		});
	});
});

describe("oauth.start — an unbound client is never sent to a discovered AS", () => {
	// An unbound PUBLIC client (no secret): the only unbound client start
	// reuses or binds. Unbound clients holding a secret are covered below.
	const unbound = (overrides: Record<string, unknown> = {}) =>
		config({
			oauthBinding: null,
			encryptedOauthClientSecret: null,
			dcrClientMetadata: { token_endpoint_auth_method: "none" },
			dcrRegisteredAt: null,
			...overrides,
		});

	describe("an unbound client holding a secret is never reused or bound", () => {
		const confidential = (overrides: Record<string, unknown> = {}) =>
			unbound({
				encryptedOauthClientSecret: "encrypted:secret-a",
				dcrClientMetadata: {
					token_endpoint_auth_method: "client_secret_post",
				},
				// A SYSTEM catalog row naming A independently: a public
				// client would be reused there.
				mcpServer: {
					id: "srv_1",
					key: "custom-mcp",
					isSystemProvided: true,
					defaultUrl: "https://mcp.example.com/mcp",
					oauthTokenEndpoint: `${AS_A}/token`,
					oauthAuthorizationEndpoint: `${AS_A}/authorize`,
				},
				...overrides,
			});

		it("a hand-entered one is refused: enter it again", async () => {
			getMcpConfigByIdInternalMock.mockResolvedValue(confidential());

			await expect(
				start({ input: startInput, context }),
			).rejects.toMatchObject({
				code: "BAD_REQUEST",
				message: expect.stringContaining("changed outside"),
			});
			expect(replaceMcpOAuthRegistrationMock).not.toHaveBeenCalled();
			expect(createOauthStateMock).not.toHaveBeenCalled();
		});

		it("a registered one is replaced by a new registration", async () => {
			advertisedAs = AS_A;
			getMcpConfigByIdInternalMock.mockResolvedValue(
				confidential({
					dcrRegisteredAt: new Date("2026-01-01T00:00:00Z"),
					// A discovered server like Notion or Atlassian: no catalog
					// endpoints, its registration endpoint from discovery.
					mcpServer: {
						id: "srv_1",
						key: "notion-remote",
						isSystemProvided: true,
						defaultUrl: "https://mcp.example.com/mcp",
					},
				}),
			);

			const result = await start({ input: startInput, context });

			expect(fetchedUrls()).toContain(`${AS_A}/register`);
			expect(
				new URL(result.authorizationUrl).searchParams.get("client_id"),
			).toBe("client-from-as-a.example.com");
			for (const call of safeFetchOutboundMock.mock.calls) {
				expect(JSON.stringify(call)).not.toContain("secret-a");
			}
		});

		it("Fabric's own client is reinstalled, even under a client id the configuration no longer names", async () => {
			process.env.GOOGLE_CLIENT_ID = "fabric-google-client";
			process.env.GOOGLE_CLIENT_SECRET = "fabric-google-secret";
			try {
				const googleServer = {
					id: "srv_gd",
					key: "google-drive",
					isSystemProvided: true,
					defaultUrl: null,
				};
				rowForWrites = config({
					baseUrl: null,
					mcpServer: googleServer,
				});
				getMcpConfigByIdInternalMock.mockResolvedValue(
					confidential({
						baseUrl: null,
						mcpServer: googleServer,
						oauthClientId: "previous-fabric-google-client",
						dcrClientMetadata: null,
					}),
				);

				await start({
					input: { ...startInput, autoDiscoverAndRegister: false },
					context,
				});

				expect(
					replaceMcpOAuthRegistrationMock.mock.calls[0]?.[0],
				).toMatchObject({
					client: {
						oauthClientId: "fabric-google-client",
						encryptedOauthClientSecret:
							"encrypted:fabric-google-secret",
					},
				});
			} finally {
				delete process.env.GOOGLE_CLIENT_ID;
				delete process.env.GOOGLE_CLIENT_SECRET;
			}
		});
	});

	it("drops a hand-entered unbound client and registers fresh at the advertised AS", async () => {
		getMcpConfigByIdInternalMock.mockResolvedValue(unbound());

		const result = await start({ input: startInput, context });

		expect(fetchedUrls()).toContain(`${AS_B}/register`);
		expect(
			new URL(result.authorizationUrl).searchParams.get("client_id"),
		).toBe("client-from-as-b.example.com");
		for (const call of safeFetchOutboundMock.mock.calls) {
			expect(JSON.stringify(call)).not.toContain("client-a");
			expect(JSON.stringify(call)).not.toContain("secret-a");
		}
	});

	it("refuses with a configure/reconnect error when the server cannot register a client", async () => {
		getMcpConfigByIdInternalMock.mockResolvedValue(unbound());
		safeFetchOutboundMock.mockImplementation((url: string) =>
			url.endsWith("/register")
				? Promise.resolve(json({ error: "access_denied" }, 403))
				: routeFetch(url),
		);

		await expect(
			start({ input: startInput, context }),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: expect.stringContaining("cannot confirm"),
		});
		expect(createOauthStateMock).not.toHaveBeenCalled();
	});

	it("never binds an unbound client to a CUSTOM row's endpoints, which its owner can edit", async () => {
		getMcpConfigByIdInternalMock.mockResolvedValue(
			unbound({
				mcpServer: {
					id: "srv_1",
					key: "custom-mcp",
					isSystemProvided: false,
					defaultUrl: "https://mcp.example.com/mcp",
					oauthTokenEndpoint: `${AS_B}/token`,
					oauthAuthorizationEndpoint: `${AS_B}/authorize`,
				},
			}),
		);
		safeFetchOutboundMock.mockImplementation((url: string) =>
			url.endsWith("/register")
				? Promise.resolve(json({ error: "access_denied" }, 403))
				: routeFetch(url),
		);

		await expect(
			start({ input: startInput, context }),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: expect.stringContaining("cannot confirm"),
		});
		expect(createOauthStateMock).not.toHaveBeenCalled();
	});

	it("binds an unbound client to a SYSTEM catalog row's AS, configured independently of the MCP server", async () => {
		getMcpConfigByIdInternalMock.mockResolvedValue(
			unbound({
				mcpServer: {
					id: "srv_1",
					key: "custom-mcp",
					isSystemProvided: true,
					defaultUrl: "https://mcp.example.com/mcp",
					oauthTokenEndpoint: `${AS_A}/token`,
					oauthAuthorizationEndpoint: `${AS_A}/authorize`,
				},
			}),
		);

		const result = await start({ input: startInput, context });

		expect(new URL(result.authorizationUrl).origin).toBe(AS_A);
		expect(createOauthStateMock.mock.calls[0]?.[0]).toMatchObject({
			authorizationServerSnapshot: {
				clientId: "client-a",
				binding: { tokenEndpoint: `${AS_A}/token`, source: "catalog" },
			},
		});
		expect(fetchedUrls().some((u) => u.startsWith(AS_B))).toBe(false);
	});

	it("recognises Fabric's pre-registered client on the server's default URL", async () => {
		process.env.SLACK_CLIENT_ID = "fabric-slack-client";
		process.env.SLACK_CLIENT_SECRET = "fabric-slack-secret";
		try {
			getMcpConfigByIdInternalMock.mockResolvedValue(
				unbound({
					baseUrl: null,
					oauthClientId: "fabric-slack-client",
					encryptedOauthClientSecret: "encrypted:fabric-slack-secret",
					mcpServer: {
						id: "srv_slack",
						key: "slack-remote",
						isSystemProvided: true,
						defaultUrl: "https://mcp.slack.com/mcp",
					},
				}),
			);

			const result = await start({ input: startInput, context });

			expect(new URL(result.authorizationUrl).origin).toBe(
				"https://slack.com",
			);
			// Catalog only: the MCP server was never asked.
			expect(fetchedUrls()).toEqual([]);
		} finally {
			delete process.env.SLACK_CLIENT_ID;
			delete process.env.SLACK_CLIENT_SECRET;
		}
	});

	describe("GitLab", () => {
		const gitlabUnbound = () =>
			unbound({
				baseUrl: "https://gitlab.example.com/api/v4/mcp",
				oauthClientId: "gl-client",
				encryptedOauthClientSecret: null,
				dcrClientMetadata: { token_endpoint_auth_method: "none" },
				dcrRegisteredAt: new Date("2026-01-01T00:00:00Z"),
				mcpServer: {
					id: "srv_gl",
					key: "gitlab-official",
					defaultUrl: null,
				},
			});

		it("binds to the instance recorded on the person's GitLab connection", async () => {
			getMcpConfigByIdInternalMock.mockResolvedValue(gitlabUnbound());
			readGitLabConnectionIssuerMock.mockResolvedValue({
				kind: "mcp-dcr",
				mcpConfigId: "cfg_1",
				serverKey: "gitlab-official",
				clientId: "gl-client",
				origin: "https://gitlab.example.com",
			});

			const result = await start({ input: startInput, context });

			expect(new URL(result.authorizationUrl).origin).toBe(
				"https://gitlab.example.com",
			);
			expect(createOauthStateMock.mock.calls[0]?.[0]).toMatchObject({
				authorizationServerSnapshot: {
					binding: {
						tokenEndpoint: "https://gitlab.example.com/oauth/token",
						source: "connection",
					},
				},
			});
			// The grant goes to the person's connection, never through
			// `saveMcpOAuthGrant`, so start binds the kept client itself —
			// to that instance, fenced on the generation it read — or the
			// connection would refuse to refresh with it.
			expect(replaceMcpOAuthRegistrationMock).toHaveBeenCalledTimes(1);
			expect(
				replaceMcpOAuthRegistrationMock.mock.calls[0]?.[0],
			).toMatchObject({
				configId: "cfg_1",
				expectedGeneration: 4,
				client: { oauthClientId: "gl-client" },
				binding: {
					authorizationServerUrl: "https://gitlab.example.com",
					source: "connection",
				},
			});
		});

		it("refuses without a recorded issuer for this client, never binding from discovery", async () => {
			getMcpConfigByIdInternalMock.mockResolvedValue(gitlabUnbound());
			readGitLabConnectionIssuerMock.mockResolvedValue({
				kind: "mcp-dcr",
				mcpConfigId: "cfg_1",
				serverKey: "gitlab-official",
				clientId: "some-other-client",
				origin: "https://gitlab.example.com",
			});

			await expect(
				start({ input: startInput, context }),
			).rejects.toMatchObject({
				code: "BAD_REQUEST",
				message: expect.stringContaining("Reconnect GitLab"),
			});
			expect(createOauthStateMock).not.toHaveBeenCalled();
		});
	});
});

describe("oauth.start — Fabric's own client goes only to its pinned AS on a system server", () => {
	it("never installs it on a CUSTOM server that reuses an env-credential key, whatever endpoints that row names", async () => {
		process.env.GOOGLE_CLIENT_ID = "fabric-google-client";
		process.env.GOOGLE_CLIENT_SECRET = "fabric-google-secret";
		try {
			getMcpConfigByIdInternalMock.mockResolvedValue(
				config({
					baseUrl: null,
					oauthBinding: null,
					oauthClientId: null,
					encryptedOauthClientSecret: null,
					dcrClientMetadata: null,
					dcrRegisteredAt: null,
					mcpServer: {
						id: "srv_evil",
						key: "google-drive",
						isSystemProvided: false,
						defaultUrl: null,
						oauthAuthorizationEndpoint: `${AS_B}/authorize`,
						oauthTokenEndpoint: `${AS_B}/token`,
					},
				}),
			);

			await expect(
				start({
					input: { ...startInput, autoDiscoverAndRegister: false },
					context,
				}),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });

			for (const call of replaceMcpOAuthRegistrationMock.mock.calls) {
				expect(JSON.stringify(call)).not.toContain("fabric-google");
			}
			expect(createOauthStateMock).not.toHaveBeenCalled();
		} finally {
			delete process.env.GOOGLE_CLIENT_ID;
			delete process.env.GOOGLE_CLIENT_SECRET;
		}
	});

	it("on a system server, binds it to Fabric's pinned AS even when the catalog row names other endpoints", async () => {
		process.env.GOOGLE_CLIENT_ID = "fabric-google-client";
		process.env.GOOGLE_CLIENT_SECRET = "fabric-google-secret";
		try {
			rowForWrites = config({ baseUrl: null });
			getMcpConfigByIdInternalMock.mockResolvedValue(
				config({
					baseUrl: null,
					oauthBinding: null,
					oauthClientId: null,
					encryptedOauthClientSecret: null,
					dcrClientMetadata: null,
					dcrRegisteredAt: null,
					mcpServer: {
						id: "srv_gd",
						key: "google-drive",
						isSystemProvided: true,
						defaultUrl: null,
						oauthAuthorizationEndpoint: `${AS_B}/authorize`,
						oauthTokenEndpoint: `${AS_B}/token`,
					},
				}),
			);

			await start({
				input: { ...startInput, autoDiscoverAndRegister: false },
				context,
			});

			expect(
				replaceMcpOAuthRegistrationMock.mock.calls[0]?.[0],
			).toMatchObject({
				client: { oauthClientId: "fabric-google-client" },
				binding: {
					authorizationServerUrl: "https://accounts.google.com",
					tokenEndpoint: "https://oauth2.googleapis.com/token",
				},
			});
			expect(createOauthStateMock.mock.calls[0]?.[0]).toMatchObject({
				authorizationServerSnapshot: {
					binding: {
						tokenEndpoint: "https://oauth2.googleapis.com/token",
					},
				},
			});
		} finally {
			delete process.env.GOOGLE_CLIENT_ID;
			delete process.env.GOOGLE_CLIENT_SECRET;
		}
	});
});

describe("a config referring to a server its tenant may not use", () => {
	it("start refuses before any discovery, registration or state", async () => {
		serverAccess.accessible = false;
		getMcpConfigByIdInternalMock.mockResolvedValue(config());

		await expect(
			start({ input: startInput, context }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		// Checked against the config's own tenant.
		expect(serverAccess.calls[0]).toEqual([
			"srv_1",
			{ userId: "user_1", organizationId: null },
		]);
		expect(safeFetchOutboundMock).not.toHaveBeenCalled();
		expect(replaceMcpOAuthRegistrationMock).not.toHaveBeenCalled();
		expect(createOauthStateMock).not.toHaveBeenCalled();
	});

	it("the callback refuses without exchanging the code", async () => {
		serverAccess.accessible = false;
		getOauthStateMock.mockResolvedValue({
			configId: "cfg_1",
			userId: "user_1",
			organizationId: null,
			mcpServerId: "srv_1",
			codeVerifier: "verifier-1",
			redirectUri: "https://app.example.com/api/mcp/oauth/callback",
			expiresAt: new Date(Date.now() + 600_000),
			authorizationServerSnapshot: {
				clientId: "client-a",
				clientFingerprint: CLIENT_A_FINGERPRINT(),
				binding: binding(AS_A),
			},
			expectedGrantGeneration: 4,
		});
		getMcpConfigByIdInternalMock.mockResolvedValue(config());

		const result = await callback({
			input: { code: "code-1", state: "state-1" },
		});

		expect(result.success).toBe(false);
		expect(safeFetchOutboundMock).not.toHaveBeenCalled();
		expect(saveMcpOAuthGrantMock).not.toHaveBeenCalled();
	});
});

describe("oauth.start — Fabric's client and its AS come from one provider", () => {
	it("refuses a system server whose key and URL name different providers, sending neither secret anywhere", async () => {
		process.env.SLACK_CLIENT_ID = "fabric-slack-client";
		process.env.SLACK_CLIENT_SECRET = "fabric-slack-secret";
		process.env.GOOGLE_CLIENT_ID = "fabric-google-client";
		process.env.GOOGLE_CLIENT_SECRET = "fabric-google-secret";
		try {
			getMcpConfigByIdInternalMock.mockResolvedValue(
				config({
					baseUrl: "https://mcp.slack.com/mcp",
					oauthBinding: null,
					oauthClientId: null,
					encryptedOauthClientSecret: null,
					dcrClientMetadata: null,
					dcrRegisteredAt: null,
					mcpServer: {
						id: "srv_gd",
						key: "google-drive",
						isSystemProvided: true,
						defaultUrl: null,
					},
				}),
			);

			await expect(
				start({ input: startInput, context }),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
			expect(replaceMcpOAuthRegistrationMock).not.toHaveBeenCalled();
			expect(createOauthStateMock).not.toHaveBeenCalled();
		} finally {
			for (const name of [
				"SLACK_CLIENT_ID",
				"SLACK_CLIENT_SECRET",
				"GOOGLE_CLIENT_ID",
				"GOOGLE_CLIENT_SECRET",
			]) {
				delete process.env[name];
			}
		}
	});
});

describe("oauth.start — registration results are not re-read", () => {
	it("uses the row its own write returned, never a concurrent registration a re-read would find", async () => {
		// A concurrent writer has replaced the registration with client C by
		// the time anything re-reads the row.
		getMcpConfigByIdInternalMock
			.mockResolvedValueOnce(config())
			.mockResolvedValue(
				config({
					oauthClientId: "client-c",
					encryptedOauthClientSecret: "encrypted:secret-c",
					oauthBinding: binding(AS_B),
					oauthGrantGeneration: 9,
				}),
			);

		const result = await start({ input: startInput, context });

		expect(getMcpConfigByIdInternalMock).toHaveBeenCalledTimes(1);
		expect(
			new URL(result.authorizationUrl).searchParams.get("client_id"),
		).toBe("client-from-as-b.example.com");
		expect(createOauthStateMock.mock.calls[0]?.[0]).toMatchObject({
			expectedGrantGeneration: 5,
			authorizationServerSnapshot: {
				clientId: "client-from-as-b.example.com",
			},
		});
	});

	it("refuses when its own conditional write lost the race", async () => {
		getMcpConfigByIdInternalMock.mockResolvedValue(config());
		replaceMcpOAuthRegistrationMock.mockResolvedValue({
			written: false,
			generation: null,
			config: null,
		});

		await expect(
			start({ input: startInput, context }),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(createOauthStateMock).not.toHaveBeenCalled();
	});

	it("records the requested client authentication when the registration response names none", async () => {
		getMcpConfigByIdInternalMock.mockResolvedValue(config());
		safeFetchOutboundMock.mockImplementation((url: string) =>
			url === `${AS_B}/register`
				? Promise.resolve(
						json(
							{
								client_id: "b-client",
								client_secret: "b-secret",
							},
							201,
						),
					)
				: routeFetch(url),
		);

		await start({ input: startInput, context });

		expect(
			replaceMcpOAuthRegistrationMock.mock.calls[0]?.[0].client
				.dcrClientMetadata,
		).toMatchObject({ token_endpoint_auth_method: "client_secret_basic" });
	});
});

describe("oauth.callback — uses what start resolved", () => {
	function flowState(overrides: Record<string, unknown> = {}) {
		return {
			configId: "cfg_1",
			userId: "user_1",
			organizationId: null,
			mcpServerId: "srv_1",
			codeVerifier: "verifier-1",
			redirectUri: "https://app.example.com/api/mcp/oauth/callback",
			expiresAt: new Date(Date.now() + 600_000),
			authorizationServerSnapshot: {
				clientId: "client-a",
				clientFingerprint: CLIENT_A_FINGERPRINT(),
				binding: binding(AS_A),
			},
			expectedGrantGeneration: 4,
			...overrides,
		};
	}

	it("exchanges at the snapshot's token endpoint even after the MCP server changed its advertisement", async () => {
		advertisedAs = AS_B;
		getOauthStateMock.mockResolvedValue(flowState());
		getMcpConfigByIdInternalMock.mockResolvedValue(config());

		const result = await callback({
			input: { code: "code-1", state: "state-1" },
		});

		expect(result.success).toBe(true);
		// No discovery at all: exactly one request, to A's token endpoint.
		expect(fetchedUrls()).toEqual([`${AS_A}/token`]);
		const init = safeFetchOutboundMock.mock.calls[0]?.[1] as RequestInit;
		expect(init.redirect).toBe("error");
		// The registered client authentication: HTTP Basic, nothing in the body.
		expect((init.headers as Record<string, string>).authorization).toBe(
			`Basic ${Buffer.from("client-a:secret-a").toString("base64")}`,
		);
		expect(String(init.body)).not.toContain("secret-a");
		expect(String(init.body)).toContain("code=code-1");
		// Tokens and binding in one write, fenced on start's generation.
		expect(saveMcpOAuthGrantMock).toHaveBeenCalledWith(
			expect.objectContaining({
				configId: "cfg_1",
				expectedGeneration: 4,
				tokens: expect.objectContaining({
					encryptedRefreshToken: "encrypted:refresh",
				}),
				// Fenced on the client the code was exchanged with.
				client: {
					oauthClientId: "client-a",
					encryptedOauthClientSecret: "encrypted:secret-a",
				},
				binding: expect.objectContaining({
					authorizationServerUrl: AS_A,
					tokenEndpoint: `${AS_A}/token`,
				}),
			}),
		);
	});

	it("refuses, without any request, when the config's credentials changed since start", async () => {
		getOauthStateMock.mockResolvedValue(flowState());
		getMcpConfigByIdInternalMock.mockResolvedValue(
			config({ oauthGrantGeneration: 5 }),
		);

		const result = await callback({
			input: { code: "code-1", state: "state-1" },
		});

		expect(result.success).toBe(false);
		expect(safeFetchOutboundMock).not.toHaveBeenCalled();
		expect(saveMcpOAuthGrantMock).not.toHaveBeenCalled();
	});

	it("refuses, with no code exchange, when the client secret was replaced under the same id since start", async () => {
		getOauthStateMock.mockResolvedValue(flowState());
		// A legacy writer (previous app version) replaced the secret by id:
		// same client id, same generation.
		getMcpConfigByIdInternalMock.mockResolvedValue(
			config({
				encryptedOauthClientSecret: "encrypted:secret-from-elsewhere",
			}),
		);

		const result = await callback({
			input: { code: "code-1", state: "state-1" },
		});

		expect(result.success).toBe(false);
		expect(safeFetchOutboundMock).not.toHaveBeenCalled();
		expect(saveMcpOAuthGrantMock).not.toHaveBeenCalled();
	});

	it("still completes when a refresh rotated the refresh token since start", async () => {
		getOauthStateMock.mockResolvedValue(flowState());
		getMcpConfigByIdInternalMock.mockResolvedValue(
			config({ encryptedRefreshToken: "encrypted:rotated-meanwhile" }),
		);

		const result = await callback({
			input: { code: "code-1", state: "state-1" },
		});

		expect(result.success).toBe(true);
		expect(fetchedUrls()).toEqual([`${AS_A}/token`]);
	});

	it("refuses a flow whose snapshot carries no client fingerprint", async () => {
		getOauthStateMock.mockResolvedValue(
			flowState({
				authorizationServerSnapshot: {
					clientId: "client-a",
					binding: binding(AS_A),
				},
			}),
		);
		getMcpConfigByIdInternalMock.mockResolvedValue(config());

		const result = await callback({
			input: { code: "code-1", state: "state-1" },
		});

		expect(result.success).toBe(false);
		expect(safeFetchOutboundMock).not.toHaveBeenCalled();
	});

	it("refuses a flow with no snapshot (started before this release)", async () => {
		getOauthStateMock.mockResolvedValue(
			flowState({
				authorizationServerSnapshot: null,
				expectedGrantGeneration: null,
			}),
		);
		getMcpConfigByIdInternalMock.mockResolvedValue(config());

		const result = await callback({
			input: { code: "code-1", state: "state-1" },
		});

		expect(result.success).toBe(false);
		expect(safeFetchOutboundMock).not.toHaveBeenCalled();
	});

	it("reports a lost race with a reconnect as a failure, not as connected", async () => {
		getOauthStateMock.mockResolvedValue(flowState());
		getMcpConfigByIdInternalMock.mockResolvedValue(config());
		saveMcpOAuthGrantMock.mockResolvedValue({
			written: false,
			generation: null,
		});

		const result = await callback({
			input: { code: "code-1", state: "state-1" },
		});

		expect(result.success).toBe(false);
	});

	it("never echoes credentials from a failed exchange", async () => {
		getOauthStateMock.mockResolvedValue(flowState());
		getMcpConfigByIdInternalMock.mockResolvedValue(config());
		safeFetchOutboundMock.mockResolvedValue(
			json(
				{
					error: "invalid_grant",
					error_description:
						"code code-1 with client_secret=secret-a is invalid",
				},
				400,
			),
		);

		const result = await callback({
			input: { code: "code-1", state: "state-1" },
		});

		expect(result.success).toBe(false);
		expect(result.message).not.toContain("code-1");
		expect(result.message).not.toContain("secret-a");
	});
});
