/**
 * Procedure-level tests for the OAuth circuit-breaker reset on
 * `configProcedures.upsert`.
 *
 * `MCPConfig.needsReauth` describes an OAuth GRANT and its only exit is a
 * successful OAuth reconnect. Editing a tripped OAuth config to API_KEY used
 * to leave the flag behind, and because the flag is ENFORCED — refused at MCP
 * client creation, filtered out of tool discovery — the config stayed dead
 * with a working credential and no user-reachable way to clear it.
 *
 * The reset must fire ONLY on an actual departure from OAUTH2: an OAuth config
 * edited while staying OAuth must not be able to launder a condemned grant by
 * touching an unrelated field.
 *
 * Mocking strategy mirrors `oauth-refresh-needs-reauth.test.ts`: the
 * procedure-builder is mocked so `.handler(fn)` captures the handler under
 * `._handler`, then we invoke it directly with a stubbed `{input, context}`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	getMcpConfigByIdMock,
	getMcpConfigForTenantAndServerMock,
	getMcpServerByIdMock,
	updateManyMock,
	findUniqueOrThrowMock,
	upsertMcpConfigMock,
	createMcpConfigMock,
	serverFindUniqueMock,
	findUsableGitLabConnectionMock,
	triggerMcpToolIngestionMock,
} = vi.hoisted(() => ({
	getMcpConfigByIdMock: vi.fn(),
	getMcpConfigForTenantAndServerMock: vi.fn(),
	getMcpServerByIdMock: vi.fn(),
	updateManyMock: vi.fn(),
	findUniqueOrThrowMock: vi.fn(),
	upsertMcpConfigMock: vi.fn(),
	createMcpConfigMock: vi.fn(),
	serverFindUniqueMock: vi.fn(),
	findUsableGitLabConnectionMock: vi.fn(),
	triggerMcpToolIngestionMock: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	// Mirrors the real predicate (prisma/queries/lib/gitlab-personal-keys.ts).
	isGitLabPersonalMcpServerKey: (key: string | null | undefined) =>
		key === "gitlab" || key === "gitlab-official",
	clearMcpConfigFromReportInstances: vi.fn(),
	createMcpClientSession: vi.fn(),
	createMcpConfig: (...args: unknown[]) => createMcpConfigMock(...args),
	db: {
		mCPConfig: {
			updateMany: (...args: unknown[]) => updateManyMock(...args),
			findUniqueOrThrow: (...args: unknown[]) =>
				findUniqueOrThrowMock(...args),
		},
		mCPServer: {
			findUnique: (...args: unknown[]) => serverFindUniqueMock(...args),
		},
	},
	deleteMcpConfig: vi.fn(),
	getMcpConfigById: (...args: unknown[]) => getMcpConfigByIdMock(...args),
	getMcpConfigForTenantAndServer: (...args: unknown[]) =>
		getMcpConfigForTenantAndServerMock(...args),
	getMcpServerById: (...args: unknown[]) => getMcpServerByIdMock(...args),
	getOrganizationById: vi.fn(),
	listMcpConfigsForTenant: vi.fn(),
	recordAudit: vi.fn(),
	updateMcpConfigEnabled: vi.fn(),
	upsertMcpConfig: (...args: unknown[]) => upsertMcpConfigMock(...args),
}));

vi.mock("@repo/temporal", () => ({
	triggerMcpServerIngestion: vi.fn(),
	triggerMcpToolDeletion: vi.fn(),
	triggerMcpToolIngestion: (...args: unknown[]) =>
		triggerMcpToolIngestionMock(...args),
}));

vi.mock("@repo/integrations/gitlab", () => ({
	findUsableGitLabConnection: (...args: unknown[]) =>
		findUsableGitLabConnectionMock(...args),
}));

vi.mock("@repo/utils", () => ({
	decryptApiKey: vi.fn((s: string) => s),
	encryptApiKey: vi.fn((s: string) => `encrypted:${s}`),
	hashApiKey: vi.fn((s: string) => `hashed:${s}`),
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
			MCP_CREATE: "mcp:create",
			MCP_DELETE: "mcp:delete",
			MCP_READ: "mcp:read",
			MCP_UPDATE: "mcp:update",
		} as const,
	};
});

// The GitLab tile Delete path pulls in the audit writer (and its oRPC
// middleware); this file exercises authType transitions only.
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

const handler = (
	configProcedures.upsert as unknown as {
		_handler: (args: {
			input: Record<string, unknown>;
			context: { user: { id: string } };
		}) => Promise<unknown>;
	}
)._handler;

/** A config the breaker has condemned, mid-way through its OAuth life. */
function condemnedOAuthConfig(overrides: Record<string, unknown> = {}) {
	return {
		id: "cfg_1",
		mcpServerId: "srv_1",
		userId: "user_1",
		organizationId: null,
		authType: "OAUTH2",
		baseUrl: "https://mcp.example.com/v1/mcp",
		isManagedDefault: false,
		needsReauth: true,
		refreshFailureCount: 3,
		lastRefreshFailedAt: new Date("2026-08-01T00:00:00Z"),
		lastRefreshError: "invalid_grant",
		status: "UNAVAILABLE",
		// A server that offers every auth type by default, so the existing
		// transition cases below exercise the reset itself rather than the
		// server-support gate — that gate gets its own tests further down.
		mcpServer: { authMethods: ["OAUTH2", "API_KEY", "NONE"] },
		...overrides,
	};
}

function upsertInput(overrides: Record<string, unknown> = {}) {
	return {
		configId: "cfg_1",
		mcpServerId: "srv_1",
		organizationId: null,
		scopes: [],
		enabled: true,
		...overrides,
	};
}

/** The `data` payload the explicit-configId update path wrote. */
function writtenData(): Record<string, unknown> {
	expect(updateManyMock).toHaveBeenCalledOnce();
	return updateManyMock.mock.calls[0]![0].data;
}

const BREAKER_COLUMNS = [
	"needsReauth",
	"refreshFailureCount",
	"lastRefreshFailedAt",
	"lastRefreshError",
	"status",
];

beforeEach(() => {
	vi.clearAllMocks();
	getMcpServerByIdMock.mockResolvedValue({
		id: "srv_1",
		name: "Example MCP",
		transport: "HTTP",
		defaultUrl: "https://mcp.example.com/v1/mcp",
	});
	// The server row's key, by id. Mirrors whatever server the test set up,
	// so a test that names a GitLab server is read as one.
	serverFindUniqueMock.mockImplementation(async () => {
		const server = await getMcpServerByIdMock();
		return server ? { key: server.key ?? "example" } : null;
	});
	findUsableGitLabConnectionMock.mockResolvedValue(null);
	updateManyMock.mockResolvedValue({ count: 1 });
	findUniqueOrThrowMock.mockImplementation(async () => ({
		id: "cfg_1",
		authType: "API_KEY",
		enabled: true,
		displayName: "Example MCP",
	}));
});

describe("mcp.configs.upsert — OAuth breaker reset on auth-type transition", () => {
	it("clears the breaker when an OAuth config is edited to API_KEY", async () => {
		getMcpConfigByIdMock.mockResolvedValue(condemnedOAuthConfig());

		await handler({
			input: upsertInput({ authType: "API_KEY", apiKey: "live-key" }),
			context: { user: { id: "user_1" } },
		});

		const data = writtenData();
		expect(data).toMatchObject({
			authType: "API_KEY",
			needsReauth: false,
			refreshFailureCount: 0,
			lastRefreshFailedAt: null,
			lastRefreshError: null,
			// The row was UNAVAILABLE because the breaker put it there, so the
			// reset takes the status with it.
			status: "HEALTHY",
		});
	});

	it("clears the breaker when an OAuth config is edited to NONE", async () => {
		getMcpConfigByIdMock.mockResolvedValue(condemnedOAuthConfig());

		await handler({
			input: upsertInput({ authType: "NONE" }),
			context: { user: { id: "user_1" } },
		});

		expect(writtenData()).toMatchObject({
			authType: "NONE",
			needsReauth: false,
			refreshFailureCount: 0,
		});
	});

	it("leaves a non-breaker status alone on the same transition", async () => {
		// Only the breaker's own verdict is lifted. DEGRADED came from health
		// checks, which own that column and will re-evaluate it themselves.
		getMcpConfigByIdMock.mockResolvedValue(
			condemnedOAuthConfig({ status: "DEGRADED" }),
		);

		await handler({
			input: upsertInput({ authType: "API_KEY", apiKey: "live-key" }),
			context: { user: { id: "user_1" } },
		});

		const data = writtenData();
		expect(data).toMatchObject({ needsReauth: false });
		expect(data).not.toHaveProperty("status");
	});

	it("does NOT lift an UNAVAILABLE status the breaker never set", async () => {
		// `UNAVAILABLE` on a config that was never condemned came from
		// somewhere else — failed health checks own that column. The auth-type
		// edit knows nothing about them, so reporting the config HEALTHY off
		// the back of one would announce a recovery that never happened and
		// hide a live problem until the next check re-evaluates it.
		getMcpConfigByIdMock.mockResolvedValue(
			condemnedOAuthConfig({
				needsReauth: false,
				refreshFailureCount: 0,
				lastRefreshFailedAt: null,
				lastRefreshError: null,
				status: "UNAVAILABLE",
			}),
		);

		await handler({
			input: upsertInput({ authType: "API_KEY", apiKey: "live-key" }),
			context: { user: { id: "user_1" } },
		});

		const data = writtenData();
		// Retiring the OAuth-only columns still happens — they describe a
		// grant this config no longer has either way.
		expect(data).toMatchObject({ needsReauth: false });
		expect(data).not.toHaveProperty("status");
	});

	it("does NOT clear the breaker when an OAuth config stays OAuth", async () => {
		// The laundering path: touching an unrelated field on a condemned
		// OAuth config must not lift a verdict only a fresh grant may lift.
		getMcpConfigByIdMock.mockResolvedValue(condemnedOAuthConfig());

		await handler({
			input: upsertInput({
				authType: "OAUTH2",
				displayName: "Renamed",
			}),
			context: { user: { id: "user_1" } },
		});

		const data = writtenData();
		for (const column of BREAKER_COLUMNS) {
			expect(data).not.toHaveProperty(column);
		}
	});

	it("does NOT clear the breaker when the edit omits authType entirely", async () => {
		// `authType` is optional on the input, so an omitted one inherits the
		// stored OAUTH2 — an edit that stays OAuth by default rather than by
		// declaration. Same verdict.
		getMcpConfigByIdMock.mockResolvedValue(condemnedOAuthConfig());

		await handler({
			input: upsertInput({ displayName: "Renamed" }),
			context: { user: { id: "user_1" } },
		});

		const data = writtenData();
		expect(data).toMatchObject({ authType: "OAUTH2" });
		for (const column of BREAKER_COLUMNS) {
			expect(data).not.toHaveProperty(column);
		}
	});

	it("writes no breaker columns when the config was never OAuth", async () => {
		// The gate is the STORED type, not merely "the new type isn't OAuth".
		// An API_KEY → NONE edit is no transition away from an OAuth grant, so
		// it has no breaker state of its own to speak for.
		getMcpConfigByIdMock.mockResolvedValue(
			condemnedOAuthConfig({
				authType: "API_KEY",
				needsReauth: false,
				refreshFailureCount: 0,
				lastRefreshFailedAt: null,
				lastRefreshError: null,
				status: "HEALTHY",
			}),
		);

		await handler({
			input: upsertInput({ authType: "NONE" }),
			context: { user: { id: "user_1" } },
		});

		const data = writtenData();
		for (const column of BREAKER_COLUMNS) {
			expect(data).not.toHaveProperty(column);
		}
	});

	it("carries the reset through the upsert-by-server path too", async () => {
		// The same `data` payload feeds `upsertMcpConfig` when the caller
		// edits by (server, tenant) instead of by config id — the OAuth
		// callback's route. A reset wired only into the explicit-id branch
		// would miss it.
		getMcpConfigForTenantAndServerMock.mockResolvedValue(
			condemnedOAuthConfig(),
		);
		upsertMcpConfigMock.mockResolvedValue({
			id: "cfg_1",
			authType: "API_KEY",
			enabled: true,
		});

		await handler({
			input: upsertInput({
				configId: undefined,
				authType: "API_KEY",
				apiKey: "live-key",
			}),
			context: { user: { id: "user_1" } },
		});

		expect(updateManyMock).not.toHaveBeenCalled();
		expect(upsertMcpConfigMock).toHaveBeenCalledOnce();
		expect(upsertMcpConfigMock.mock.calls[0]![0].data).toMatchObject({
			needsReauth: false,
			refreshFailureCount: 0,
			lastRefreshFailedAt: null,
			lastRefreshError: null,
			status: "HEALTHY",
		});
	});
});

describe("mcp.configs.upsert — breaker reset gated on server authMethods support", () => {
	it("does NOT clear the breaker when the server only offers OAuth (GitLab-style laundering)", async () => {
		// `gitlab-official` / `gitlab` both declare `authMethods: ["OAUTH2"]`
		// only. Every consumer of those rows (source resolution, token
		// refresh) dispatches on `mcpServer.key`, not `authType`, so an edit
		// to API_KEY here doesn't actually move the config off OAuth — the
		// OAuth token columns stay live and stay in use. Retiring the
		// breaker would resurrect a condemned grant instead of retiring it.
		getMcpConfigByIdMock.mockResolvedValue(
			condemnedOAuthConfig({
				mcpServer: { authMethods: ["OAUTH2"] },
			}),
		);

		await handler({
			input: upsertInput({ authType: "API_KEY", apiKey: "live-key" }),
			context: { user: { id: "user_1" } },
		});

		const data = writtenData();
		expect(data).not.toHaveProperty("needsReauth");
	});

	it("clears the breaker when the server also offers the target auth type", async () => {
		// Proves the gate doesn't break the legitimate case: a server that
		// genuinely supports both OAuth and API_KEY still gets the reset.
		getMcpConfigByIdMock.mockResolvedValue(
			condemnedOAuthConfig({
				mcpServer: { authMethods: ["OAUTH2", "API_KEY"] },
			}),
		);

		await handler({
			input: upsertInput({ authType: "API_KEY", apiKey: "live-key" }),
			context: { user: { id: "user_1" } },
		});

		const data = writtenData();
		expect(data).toMatchObject({
			needsReauth: false,
			refreshFailureCount: 0,
			lastRefreshFailedAt: null,
			lastRefreshError: null,
		});
	});
});

/**
 * The GitLab personal servers' credential is the person's GitLab connection,
 * written only by the GitLab connection service. A token supplied through the
 * generic config upsert would be a second copy of that grant — the copy whose
 * refreshes rotate (and kill) it — so the upsert never stores one for them.
 */
describe("mcp.configs.upsert — GitLab personal servers take no token", () => {
	const TOKEN_COLUMNS = [
		"encryptedAccessToken",
		"accessTokenHash",
		"encryptedRefreshToken",
	];

	function healthyOAuthConfig(serverKey: string) {
		return condemnedOAuthConfig({
			needsReauth: false,
			status: "HEALTHY",
			mcpServer: { key: serverKey, authMethods: ["OAUTH2"] },
		});
	}

	function gitlabServer(serverKey: string) {
		getMcpServerByIdMock.mockResolvedValue({
			id: "srv_1",
			key: serverKey,
			name: "GitLab",
			transport: "HTTP",
			defaultUrl: "https://gitlab.com/api/v4/mcp",
		});
	}

	const SUPPLIED_SECRETS: Array<[string, Record<string, unknown>]> = [
		["a plaintext access token", { authType: "OAUTH2", accessToken: "a" }],
		[
			"a plaintext refresh token",
			{ authType: "OAUTH2", refreshToken: "r" },
		],
		[
			"a pre-encrypted access token",
			{ authType: "OAUTH2", encryptedAccessToken: "enc-access" },
		],
		[
			"a pre-encrypted refresh token",
			{ authType: "OAUTH2", encryptedRefreshToken: "enc-refresh" },
		],
		["a plaintext API key", { authType: "API_KEY", apiKey: "glpat-x" }],
		[
			"a pre-encrypted API key",
			{ authType: "API_KEY", encryptedApiKey: "enc-key" },
		],
		// The auth type does not open a path: an API key sent with OAUTH2 or
		// NONE is refused all the same.
		[
			"an API key sent as OAUTH2",
			{ authType: "OAUTH2", apiKey: "glpat-x" },
		],
		["an API key sent as NONE", { authType: "NONE", apiKey: "glpat-x" }],
	];

	for (const serverKey of ["gitlab", "gitlab-official"]) {
		it.each(SUPPLIED_SECRETS)(
			`refuses ${serverKey} with %s and writes nothing`,
			async (_label, fields) => {
				getMcpConfigByIdMock.mockResolvedValue(
					healthyOAuthConfig(serverKey),
				);
				gitlabServer(serverKey);

				await expect(
					handler({
						input: upsertInput(fields),
						context: { user: { id: "user_1" } },
					}),
				).rejects.toMatchObject({ code: "BAD_REQUEST" });
				expect(updateManyMock).not.toHaveBeenCalled();
			},
		);

		it.each(["API_KEY", "NONE", undefined])(
			`saves a ${serverKey} config sent as %s with no credential column, stored as OAUTH2`,
			async (authType) => {
				// An older row (or a form built from one) naming another auth
				// type, or an edit that sends none at all.
				getMcpConfigByIdMock.mockResolvedValue(
					condemnedOAuthConfig({
						needsReauth: false,
						status: "HEALTHY",
						authType: authType ?? "API_KEY",
						mcpServer: { key: serverKey, authMethods: ["OAUTH2"] },
					}),
				);
				gitlabServer(serverKey);

				await handler({
					input: upsertInput(authType ? { authType } : {}),
					context: { user: { id: "user_1" } },
				});

				const written = writtenData();
				expect(written.authType).toBe("OAUTH2");
				expect(written.apiKeyMethod).toBeUndefined();
				for (const column of [...TOKEN_COLUMNS, "encryptedApiKey"]) {
					expect(written).not.toHaveProperty(column);
				}
			},
		);
	}

	it("does not clear a stored API key when a gitlab edit sends encryptedApiKey: null", async () => {
		// Clearing is the GitLab connection's job (disconnect) and the
		// migration's; the settings path writes no credential column at all.
		getMcpConfigByIdMock.mockResolvedValue(healthyOAuthConfig("gitlab"));
		gitlabServer("gitlab");

		await handler({
			input: upsertInput({ authType: "OAUTH2", encryptedApiKey: null }),
			context: { user: { id: "user_1" } },
		});

		expect(writtenData()).not.toHaveProperty("encryptedApiKey");
	});

	it("still stores a token for any other OAuth server (control)", async () => {
		getMcpConfigByIdMock.mockResolvedValue(healthyOAuthConfig("linear"));
		getMcpServerByIdMock.mockResolvedValue({
			id: "srv_1",
			key: "linear",
			name: "Linear",
			transport: "HTTP",
			defaultUrl: "https://mcp.linear.app/mcp",
		});

		await handler({
			input: upsertInput({
				authType: "OAUTH2",
				accessToken: "linear-access",
				refreshToken: "linear-refresh",
			}),
			context: { user: { id: "user_1" } },
		});

		expect(writtenData()).toMatchObject({
			encryptedAccessToken: "encrypted:linear-access",
			accessTokenHash: "hashed:linear-access",
			encryptedRefreshToken: "encrypted:linear-refresh",
		});
	});
});

describe("mcp.configs.upsert — token columns fail closed on a server lookup miss", () => {
	it("stores no token when the server's key cannot be read", async () => {
		getMcpConfigByIdMock.mockResolvedValue(
			condemnedOAuthConfig({ needsReauth: false, status: "HEALTHY" }),
		);
		// No system server matches, and no server row exists for the id.
		getMcpServerByIdMock.mockResolvedValue(null);
		serverFindUniqueMock.mockResolvedValue(null);

		await handler({
			input: upsertInput({
				authType: "OAUTH2",
				accessToken: "orphan-access",
				refreshToken: "orphan-refresh",
				encryptedAccessToken: "enc-orphan",
			}),
			context: { user: { id: "user_1" } },
		});

		const written = writtenData();
		for (const column of [
			"encryptedAccessToken",
			"accessTokenHash",
			"encryptedRefreshToken",
		]) {
			expect(written).not.toHaveProperty(column);
		}
	});

	it("stores no API key when the server's key cannot be read", async () => {
		getMcpConfigByIdMock.mockResolvedValue(
			condemnedOAuthConfig({ needsReauth: false, status: "HEALTHY" }),
		);
		getMcpServerByIdMock.mockResolvedValue(null);
		serverFindUniqueMock.mockResolvedValue(null);

		await handler({
			input: upsertInput({ authType: "API_KEY", apiKey: "orphan-key" }),
			context: { user: { id: "user_1" } },
		});

		expect(writtenData()).not.toHaveProperty("encryptedApiKey");
	});

	it("still stores an API key for a tenant-owned (non-system) server it can read", async () => {
		getMcpConfigByIdMock.mockResolvedValue(
			condemnedOAuthConfig({ needsReauth: false, status: "HEALTHY" }),
		);
		getMcpServerByIdMock.mockResolvedValue(null);
		serverFindUniqueMock.mockResolvedValue({ key: "custom:my-server" });

		await handler({
			input: upsertInput({ authType: "API_KEY", apiKey: "custom-key" }),
			context: { user: { id: "user_1" } },
		});

		expect(writtenData()).toMatchObject({
			encryptedApiKey: expect.any(String),
		});
	});

	it("still stores a token for a tenant-owned (non-system) server it can read", async () => {
		getMcpConfigByIdMock.mockResolvedValue(
			condemnedOAuthConfig({ needsReauth: false, status: "HEALTHY" }),
		);
		// `getMcpServerById` without a tenant finds only system servers.
		getMcpServerByIdMock.mockResolvedValue(null);
		serverFindUniqueMock.mockResolvedValue({ key: "custom:my-server" });

		await handler({
			input: upsertInput({
				authType: "OAUTH2",
				accessToken: "custom-access",
			}),
			context: { user: { id: "user_1" } },
		});

		expect(writtenData()).toMatchObject({
			encryptedAccessToken: "encrypted:custom-access",
			accessTokenHash: "hashed:custom-access",
		});
	});
});

describe("mcp.configs.upsert — GitLab tool ingestion follows the person's connection", () => {
	function gitlabRecord(extra: Record<string, unknown> = {}) {
		return {
			id: "cfg_1",
			authType: "OAUTH2",
			enabled: true,
			displayName: "GitLab",
			encryptedAccessToken: null,
			...extra,
		};
	}

	beforeEach(() => {
		getMcpConfigByIdMock.mockResolvedValue(
			condemnedOAuthConfig({
				needsReauth: false,
				status: "HEALTHY",
				mcpServer: { key: "gitlab-official", authMethods: ["OAUTH2"] },
			}),
		);
		getMcpServerByIdMock.mockResolvedValue({
			id: "srv_1",
			key: "gitlab-official",
			name: "GitLab",
			transport: "HTTP",
			defaultUrl: "https://gitlab.com/api/v4/mcp",
		});
	});

	it("ingests when the person's GitLab connection is usable, though the config holds no token", async () => {
		findUniqueOrThrowMock.mockResolvedValue(gitlabRecord());
		findUsableGitLabConnectionMock.mockResolvedValue({
			integrationId: "wi-1",
			origin: "https://gitlab.com",
		});

		await handler({
			input: upsertInput({ authType: "OAUTH2" }),
			context: { user: { id: "user_1" } },
		});

		expect(findUsableGitLabConnectionMock).toHaveBeenCalledWith({
			userId: "user_1",
			organizationId: null,
		});
		expect(triggerMcpToolIngestionMock).toHaveBeenCalledOnce();
	});

	it("does not ingest when GitLab is not connected, whatever token copy the config row still holds", async () => {
		findUniqueOrThrowMock.mockResolvedValue(
			gitlabRecord({ encryptedAccessToken: "enc-leftover-copy" }),
		);
		findUsableGitLabConnectionMock.mockResolvedValue(null);

		await handler({
			input: upsertInput({ authType: "OAUTH2" }),
			context: { user: { id: "user_1" } },
		});

		expect(triggerMcpToolIngestionMock).not.toHaveBeenCalled();
	});
});
