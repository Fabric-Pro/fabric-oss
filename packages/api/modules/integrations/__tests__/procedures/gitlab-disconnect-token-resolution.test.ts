/**
 * After `integrations.gitlab.disconnect`, nothing may resolve a GitLab token
 * for that user and organization, and `integrations.gitlab.status` must report
 * the right state on both sides of it.
 *
 * Everything under test is real: the procedures, the GitLab connection
 * service they call (disconnect, status), and every token reader
 * (`getGitLabAccessToken`, `getGitLabToken`, `resolveGitLabSource`). They run
 * against an in-memory database that applies the real `where` clauses
 * (`@repo/integrations`' GitLab fake), so a reader that ignored `isActive`, or
 * a disconnect that missed a store, shows up as a resolved token.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	createGitLabFakeDb,
	encryptedCredential,
	readCredential,
} from "../../../../../integrations/__tests__/gitlab/helpers/gitlab-fake-db";

const state = vi.hoisted(() => ({
	fake: null as unknown as ReturnType<
		typeof import("../../../../../integrations/__tests__/gitlab/helpers/gitlab-fake-db").createGitLabFakeDb
	>,
	dataConnectionUpdateMany: null as unknown as ReturnType<typeof vi.fn>,
}));

vi.mock("@repo/database", async () => {
	const { vi: vitest } = await import("vitest");
	state.dataConnectionUpdateMany = vitest.fn(async () => ({ count: 0 }));
	return {
		get db() {
			return {
				...state.fake.db,
				dataConnection: { updateMany: state.dataConnectionUpdateMany },
			};
		},
		createDataConnection: vitest.fn(),
		getDataConnectionByProvider: vitest.fn(),
		updateDataConnection: vitest.fn(),
		getOrganizationMembership: vitest.fn(),
		getProjectMemberRole: vitest.fn(),
		createProjectRepoIntegration: vitest.fn(),
		logRepoIntegrationActivity: vitest.fn(),
		syncLegacyProjectRepoOnConnect: vitest.fn(),
	};
});

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
		"../../../../../integrations/__tests__/gitlab/helpers/gitlab-fake-db"
	);
	return {
		...(await importOriginal<object>()),
		encryptApiKey: helpers.fakeEncrypt,
		decryptApiKey: helpers.fakeDecrypt,
		hashApiKey: (v: string) => `hash:${v}`,
	};
});

vi.mock("@repo/connectors", () => ({
	integrationStatusForRepoAccess: vi.fn(),
	resolveDefaultBranch: vi.fn(),
	verifyRepositoryAccess: vi.fn(),
}));

vi.mock("@repo/integrations", () => ({ getGitHubToken: vi.fn() }));

vi.mock("@repo/permissions", () => ({
	hasPermission: vi.fn().mockReturnValue(true),
	Permissions: {},
	resolveOrgPermissions: vi.fn().mockReturnValue([]),
	resolveProjectPermissions: vi.fn(),
}));

vi.mock("@repo/temporal", () => ({
	triggerMcpToolIngestion: vi.fn(),
	triggerOAuthServerIngestion: vi.fn(),
	triggerOAuthToolIngestion: vi.fn(),
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../../../lib/project-permissions", () => ({
	userHasProjectPermission: vi.fn(),
}));
vi.mock("../../../../lib/redis-client", () => ({ getRedisClient: () => null }));
vi.mock("../../../../lib/mcp-registry-cache", () => ({
	invalidateSystemServersCache: vi.fn(),
}));
vi.mock("../../../projects/lib/code-indexing-trigger", () => ({
	startCodeIndexingForProject: vi.fn(),
}));
vi.mock("../../lib/enable-gitlab-pm-for-project", () => ({
	enableGitLabPMForProject: vi.fn(),
}));
vi.mock("../../lib/gitlab-oauth", () => ({
	exchangeCodeForToken: vi.fn(),
	generatePkce: vi.fn(),
	getGitLabOAuthUrl: vi.fn(),
	getGitLabUser: vi.fn(),
	listGitLabBranches: vi.fn(),
	listGitLabProjects: vi.fn(),
	recordToolIngestError: vi.fn(),
	refreshGitLabToken: vi.fn(),
	resolveOrgIdForQuery: vi.fn(),
}));
vi.mock("../../lib/gitlab-recheck", () => ({
	recheckGitlabCapabilities: vi.fn(),
	GitLabIntegrationNotConnectedError: class extends Error {},
}));
vi.mock("../../lib/oauth-providers", () => ({
	exchangeCodeForTokens: vi.fn(),
	generateAuthorizationUrl: vi.fn(),
	getOAuthCredentials: vi.fn(),
	getOAuthCredentialsWithDb: async () => ({
		clientId: "gl-client-id",
		clientSecret: "gl-client-secret",
	}),
	getOAuthProvider: (type: string) => ({ type, name: type }),
	mapOAuthToWorkflowProvider: (type: string) => type,
}));

vi.mock("../../../../orpc/procedures", () => {
	const chain: Record<string, unknown> = {};
	Object.assign(chain, {
		use: () => chain,
		route: () => chain,
		input: () => chain,
		output: () => chain,
		handler: (fn: unknown) => ({ handler: fn }),
	});
	return {
		tenantProtectedProcedure: chain,
		protectedProcedure: chain,
		publicProcedure: chain,
		requirePermission: () => ({}),
		requireInputOrgPermission: () => ({}),
		requireOrganizationMembership: vi.fn(),
		// The resolution `authorizeInputOrganization` performs (input, else
		// session; an explicit null suppresses the session fallback; none
		// refused when required). It models no guest write organization
		// (`effectiveWriteOrgId`), which the real resolver lets win even over
		// an explicit null. Membership and role are exercised for real in
		// gitlab-request-authorization.test.ts.
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
		resolveOrganizationId: vi.fn(),
		resolveOrganizationIdForCaller: vi.fn(),
		Permissions: {
			INTEGRATION_USE: "integration:use",
			INTEGRATION_READ: "integration:read",
			INTEGRATION_CONNECT: "integration:connect",
			INTEGRATION_DISCONNECT: "integration:disconnect",
			PROJECT_SETTINGS_EDIT: "project:settings:edit",
		},
	};
});

import {
	connectGitLab,
	getGitLabAccessToken,
	getGitLabToken,
	resetGitLabConnectionDepsForTests,
	resolveGitLabSource,
} from "@repo/integrations/gitlab";
import { gitlabOAuthProcedures } from "../../procedures/gitlab-oauth";

type Handler<I, O> = {
	handler: (args: {
		input: I;
		context: {
			user: { id: string };
			session: { id: string; activeOrganizationId: string | null };
		};
	}) => Promise<O>;
};

const USER = "user-1";
const ORG = "example-org";
const SERVERS = [
	{
		id: "srv-gitlab",
		key: "gitlab",
		defaultUrl: "https://app.example.com/api/mcp/gitlab",
	},
	{
		id: "srv-gitlab-official",
		key: "gitlab-official",
		defaultUrl: "https://gitlab.com/api/v4/mcp",
	},
];

const ctx = (organizationId: string | null) => ({
	user: { id: USER },
	session: { id: "session-1", activeOrganizationId: organizationId },
});

const disconnect = (organizationId: string | null) =>
	(
		gitlabOAuthProcedures.disconnect as unknown as Handler<
			{ organizationId: string | null },
			{ success: boolean }
		>
	).handler({ input: { organizationId }, context: ctx(organizationId) });

const status = (organizationId: string | null) =>
	(
		gitlabOAuthProcedures.status as unknown as Handler<
			{ organizationId: string | null },
			{
				connected: boolean;
				needsReauth?: boolean;
			}
		>
	).handler({ input: { organizationId }, context: ctx(organizationId) });

function seedConnection(organizationId: string | null) {
	state.fake.tables.workflowIntegration.push({
		id: `gl-wi-${organizationId ?? "personal"}`,
		userId: USER,
		organizationId,
		provider: "GITLAB",
		name: "GitLab: example-user",
		workflowId: null,
		isActive: true,
		credentials: encryptedCredential({
			access_token: "wi-token",
			refresh_token: "wi-refresh",
			expires_in: 7200,
			token_obtained_at: new Date().toISOString(),
			issuer: {
				kind: "app",
				clientId: "gl-client-id",
				origin: "https://gitlab.com",
			},
			connectionGeneration: 1,
		}),
		settings: {},
		createdAt: new Date("2026-01-01T00:00:00Z"),
		updatedAt: new Date("2026-01-01T00:00:00Z"),
	});
}

type McpSeed = Record<string, unknown> & {
	userId?: string;
	serverKey?: string;
};

function seedMcpConfig(organizationId: string | null, overrides: McpSeed = {}) {
	const { serverKey = "gitlab", ...rest } = overrides;
	const userId = (rest.userId as string | undefined) ?? USER;
	state.fake.tables.mCPConfig.push({
		id: `${serverKey}-${userId}-${organizationId ?? "personal"}`,
		userId,
		organizationId,
		mcpServerId: `srv-${serverKey}`,
		enabled: true,
		displayName: "GitLab",
		scopes: ["api"],
		baseUrl: null,
		authType: "OAUTH2",
		encryptedAccessToken: "enc:mcp-token",
		encryptedRefreshToken: "enc:mcp-refresh",
		accessTokenHash: "hash:mcp-token",
		tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
		needsReauth: false,
		oauthClientId: null,
		encryptedOauthClientSecret: null,
		dcrClientMetadata: null,
		dcrRegisteredAt: null,
		createdAt: new Date("2026-01-01T00:00:00Z"),
		updatedAt: new Date("2026-01-02T00:00:00Z"),
		...rest,
	});
}

/** The `gitlab-official` config, with the DCR registration that issued its copy. */
function seedOfficialConfig(
	organizationId: string | null,
	overrides: McpSeed = {},
) {
	seedMcpConfig(organizationId, {
		serverKey: "gitlab-official",
		displayName: "GitLab (Official)",
		oauthClientId: "dcr-client-id",
		encryptedOauthClientSecret: "enc:dcr-client-secret",
		dcrRegisteredAt: new Date("2026-01-01T00:00:00Z"),
		accessTokenHash: "hash:official-token",
		encryptedAccessToken: "enc:official-token",
		encryptedRefreshToken: "enc:official-refresh",
		...overrides,
	});
}

const officialRow = (organizationId: string | null, userId = USER) => {
	const row = state.fake.tables.mCPConfig.find(
		(r) =>
			r.mcpServerId === "srv-gitlab-official" &&
			r.userId === userId &&
			r.organizationId === organizationId,
	);
	if (!row) {
		throw new Error("official config missing");
	}
	return row;
};

/** Every reader of "the GitLab token for this tenant". */
async function resolveToken(organizationId: string | null) {
	return {
		lenient: await getGitLabAccessToken(USER, organizationId ?? undefined),
		getter: await getGitLabToken({
			userId: USER,
			organizationId: organizationId ?? undefined,
		}),
	};
}

beforeEach(() => {
	state.fake = createGitLabFakeDb({
		mCPServer: SERVERS.map((s) => ({ ...s })),
	});
	resetGitLabConnectionDepsForTests();
	vi.stubEnv("GITLAB_CLIENT_ID", "gl-client-id");
	vi.stubEnv("GITLAB_CLIENT_SECRET", "gl-client-secret");
	vi.stubGlobal(
		"fetch",
		vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
	);
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

// A request with no organization is refused before anything is read or
// written (ADR-018: it is a resolution failure, not a personal workspace), so
// the disconnect cases run in an organization only.
describe("GitLab disconnect and status with no organization", () => {
	it("refuses a disconnect and leaves the connection as it was", async () => {
		seedConnection(null);
		const before = JSON.stringify(state.fake.tables.workflowIntegration);

		await expect(disconnect(null)).rejects.toThrow(
			/requires an organization context/,
		);

		expect(JSON.stringify(state.fake.tables.workflowIntegration)).toBe(
			before,
		);
	});

	it("refuses a status read", async () => {
		await expect(status(null)).rejects.toThrow(
			/requires an organization context/,
		);
	});
});

describe.each([{ scope: "organization", organizationId: ORG }])(
	"GitLab token resolution around disconnect ($scope)",
	({ organizationId }) => {
		it("resolves the connection's token before disconnect (the test can see a live token)", async () => {
			seedConnection(organizationId);
			seedMcpConfig(organizationId);

			expect(await resolveToken(organizationId)).toEqual({
				lenient: "wi-token",
				getter: "wi-token",
			});
		});

		it("resolves no token after disconnect", async () => {
			seedConnection(organizationId);
			seedMcpConfig(organizationId);

			await disconnect(organizationId);

			expect(await resolveToken(organizationId)).toEqual({
				lenient: null,
				getter: null,
			});
		});

		it("resolves no token, before or after disconnect, when only a legacy official MCP copy holds one", async () => {
			seedOfficialConfig(organizationId);
			// A copy is not a connection: nothing resolves it, nothing adopts it.
			expect(await resolveToken(organizationId)).toEqual({
				lenient: null,
				getter: null,
			});
			expect(state.fake.tables.workflowIntegration).toHaveLength(0);

			await disconnect(organizationId);

			expect(await resolveToken(organizationId)).toEqual({
				lenient: null,
				getter: null,
			});
		});

		it("does not treat the stored OAuth app credentials as a token", async () => {
			state.fake.tables.workflowIntegration.push({
				id: "gl-app",
				userId: USER,
				organizationId,
				provider: "GITLAB",
				name: "GITLAB_OAUTH_APP",
				workflowId: null,
				isActive: true,
				credentials: encryptedCredential({
					client_id: "c",
					client_secret: "s",
				}),
				settings: {},
				createdAt: new Date(),
				updatedAt: new Date(),
			});

			expect(await resolveToken(organizationId)).toEqual({
				lenient: null,
				getter: null,
			});
		});

		it("disconnect leaves the OAuth app row alone and empties the connection's credential", async () => {
			seedConnection(organizationId);
			state.fake.tables.workflowIntegration.push({
				id: "gl-app",
				userId: USER,
				organizationId,
				provider: "GITLAB",
				name: "GITLAB_OAUTH_APP",
				workflowId: null,
				isActive: true,
				credentials: encryptedCredential({
					client_id: "c",
					client_secret: "s",
				}),
				settings: {},
				createdAt: new Date(),
				updatedAt: new Date(),
			});

			await disconnect(organizationId);

			const [connection, app] = state.fake.tables.workflowIntegration;
			expect(connection.isActive).toBe(false);
			expect(Object.keys(readCredential(connection)).sort()).toEqual([
				"connectionGeneration",
				"disconnectedAt",
			]);
			expect(app.isActive).toBe(true);
			expect(readCredential(app)).toEqual({
				client_id: "c",
				client_secret: "s",
			});
		});
	},
);

describe("integrations.gitlab.status", () => {
	it("reports a token stored only on the gitlab MCP config as not connected", async () => {
		seedMcpConfig(ORG);

		await expect(status(ORG)).resolves.toEqual({
			connected: false,
			state: "not-connected",
		});
	});

	it("reports a lone legacy official GitLab MCP copy as not connected, and adopts nothing", async () => {
		seedOfficialConfig(ORG);

		await expect(status(ORG)).resolves.toEqual({
			connected: false,
			state: "not-connected",
		});
		expect(state.fake.tables.workflowIntegration).toHaveLength(0);
	});

	it("reports the connection's own reconnect-required state, not the MCP copy's", async () => {
		seedConnection(ORG);
		state.fake.tables.workflowIntegration[0].settings = {
			needsReauth: true,
		};
		seedMcpConfig(ORG, { needsReauth: false });

		await expect(status(ORG)).resolves.toMatchObject({
			connected: true,
			needsReauth: true,
		});
	});

	it("reports not connected after disconnect", async () => {
		seedMcpConfig(ORG);
		await disconnect(ORG);

		await expect(status(ORG)).resolves.toEqual({
			connected: false,
			state: "not-connected",
		});
	});

	it("reports connected with an active connection, and not connected after disconnect", async () => {
		seedConnection(ORG);
		seedMcpConfig(ORG);
		const before = await status(ORG);
		expect(before.connected).toBe(true);

		await disconnect(ORG);

		await expect(status(ORG)).resolves.toEqual({
			connected: false,
			state: "not-connected",
		});
	});

	it("does not leak another user's or organization's MCPConfig", async () => {
		seedMcpConfig("other-org");
		seedMcpConfig(ORG, { userId: "user-2" });

		await expect(status(ORG)).resolves.toEqual({
			connected: false,
			state: "not-connected",
		});
	});
});

describe("integrations.gitlab.disconnect and the gitlab-official MCP config", () => {
	const DCR_FIELDS = [
		"oauthClientId",
		"encryptedOauthClientSecret",
		"dcrRegisteredAt",
	] as const;

	const resolveSource = (organizationId: string | null) =>
		resolveGitLabSource({ userId: USER, organizationId });

	it.each([{ scope: "organization", organizationId: ORG as string | null }])(
		"clears the official config's token copy ($scope), keeping the row, `enabled` and its DCR registration",
		async ({ organizationId }) => {
			seedConnection(organizationId);
			seedMcpConfig(organizationId);
			seedOfficialConfig(organizationId);
			const before = { ...officialRow(organizationId) };

			await disconnect(organizationId);

			const after = officialRow(organizationId);
			expect(after).toMatchObject({
				encryptedAccessToken: null,
				accessTokenHash: null,
				encryptedRefreshToken: null,
				tokenExpiresAt: null,
			});
			expect(after.id).toBe(before.id);
			expect(after.enabled).toBe(true);
			expect(after.displayName).toBe("GitLab (Official)");
			expect(after.scopes).toEqual(["api"]);
			for (const field of DCR_FIELDS) {
				expect(after[field]).toEqual(before[field]);
				expect(after[field]).not.toBeNull();
			}
		},
	);

	it("clears an official config that exists without any `gitlab` row or connection (connected only from the MCP Servers page)", async () => {
		seedOfficialConfig(ORG);

		await disconnect(ORG);

		expect(officialRow(ORG).encryptedAccessToken).toBeNull();
	});

	it("leaves another user's and another organization's official config untouched", async () => {
		seedConnection(ORG);
		seedOfficialConfig(ORG);
		seedOfficialConfig(ORG, { userId: "user-2" });
		seedOfficialConfig("other-org");
		seedOfficialConfig(null);
		const untouched = [
			{ ...officialRow(ORG, "user-2") },
			{ ...officialRow("other-org") },
			{ ...officialRow(null) },
		];

		await disconnect(ORG);

		expect(officialRow(ORG).encryptedAccessToken).toBeNull();
		expect(officialRow(ORG, "user-2")).toEqual(untouched[0]);
		expect(officialRow("other-org")).toEqual(untouched[1]);
		expect(officialRow(null)).toEqual(untouched[2]);
	});

	it("stops resolveGitLabSource routing through the official MCP server", async () => {
		seedConnection(ORG);
		seedOfficialConfig(ORG);

		await expect(resolveSource(ORG)).resolves.toMatchObject({
			kind: "official-mcp",
		});

		await disconnect(ORG);

		await expect(resolveSource(ORG)).resolves.toBeNull();
	});

	it("resolves no GitLab source when only a legacy official copy exists, before or after disconnect", async () => {
		seedOfficialConfig(ORG);
		await expect(resolveSource(ORG)).resolves.toBeNull();

		await disconnect(ORG);

		await expect(resolveSource(ORG)).resolves.toBeNull();
	});

	it("a fresh grant through the kept registration reconnects, clears the MCP breaker, and still writes no token to the MCP row", async () => {
		seedOfficialConfig(ORG);
		await disconnect(ORG);
		const row = officialRow(ORG);

		const result = await connectGitLab(
			{ userId: USER, organizationId: ORG },
			{
				accessToken: "new-token",
				refreshToken: "new-refresh",
				expiresAt: new Date(Date.now() + 60 * 60 * 1000),
				scopes: ["api"],
				issuer: {
					kind: "mcp-dcr",
					mcpConfigId: row.id,
					serverKey: "gitlab-official",
					clientId: "dcr-client-id",
					origin: "https://gitlab.com",
				},
				freshGrant: true,
			},
		);

		expect(result.written).toBe(true);
		expect(officialRow(ORG)).toMatchObject({
			id: row.id,
			encryptedAccessToken: null,
			needsReauth: false,
			oauthClientId: "dcr-client-id",
			encryptedOauthClientSecret: "enc:dcr-client-secret",
		});
		expect(await getGitLabAccessToken(USER, ORG)).toBe("new-token");
	});
});
