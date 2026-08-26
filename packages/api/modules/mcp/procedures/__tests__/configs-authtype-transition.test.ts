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
} = vi.hoisted(() => ({
	getMcpConfigByIdMock: vi.fn(),
	getMcpConfigForTenantAndServerMock: vi.fn(),
	getMcpServerByIdMock: vi.fn(),
	updateManyMock: vi.fn(),
	findUniqueOrThrowMock: vi.fn(),
	upsertMcpConfigMock: vi.fn(),
	createMcpConfigMock: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	clearMcpConfigFromReportInstances: vi.fn(),
	createMcpClientSession: vi.fn(),
	createMcpConfig: (...args: unknown[]) => createMcpConfigMock(...args),
	db: {
		mCPConfig: {
			updateMany: (...args: unknown[]) => updateManyMock(...args),
			findUniqueOrThrow: (...args: unknown[]) =>
				findUniqueOrThrowMock(...args),
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
	triggerMcpToolIngestion: vi.fn(),
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
