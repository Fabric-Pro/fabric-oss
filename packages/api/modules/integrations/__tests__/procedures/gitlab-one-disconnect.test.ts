/**
 * One GitLab disconnect everywhere. Every surface that disconnects a person's
 * GitLab — the integration settings, the generic OAuth disconnect, the
 * generic workflow-integration delete and disconnect-by-type, the MCP server
 * tile's Delete and Revoke, and the REST API's MCP config delete — runs the
 * connection service's core disconnect, leaves the person's project
 * repository links exactly as they were, and writes one
 * `org.integration.disconnected` audit row naming the surface.
 *
 * Also covered: the MCP tile's Revoke (Fizzy #2859) reaches a real handler,
 * refuses another person's or another organization's config, and clears a
 * non-GitLab server's tokens; the tile's Delete for a GitLab server keeps the
 * row and its client registration; deleting a GitLab Data Connection is not a
 * disconnect.
 *
 * The procedures, the shared disconnect and the connection service are real;
 * the database is the GitLab fake that applies `where` clauses.
 */

import { Hono } from "hono";
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
	audit: null as unknown as ReturnType<typeof vi.fn>,
}));

vi.mock("../../../../lib/audit", async () => {
	const { vi: vitest } = await import("vitest");
	state.audit = vitest.fn();
	return {
		recordAuditFromRequest: (...args: unknown[]) => state.audit(...args),
	};
});

vi.mock("@repo/database", async () => {
	const { vi: vitest } = await import("vitest");
	const keys = await import(
		"../../../../../database/prisma/queries/lib/gitlab-personal-keys"
	);
	const tenant = (userId: string, organizationId?: string | null) =>
		organizationId
			? { userId, organizationId }
			: { userId, organizationId: null };
	return {
		get db() {
			return state.fake.db;
		},
		...keys,
		Prisma: { PrismaClientKnownRequestError: class extends Error {} },
		WorkflowIntegrationProviderSchema: (await import("zod")).z.string(),
		recordAudit: vitest.fn(),
		resolveUserOrganization: async () => ({
			kind: "resolved",
			organizationId: "example-org",
		}),
		createDataConnection: vitest.fn(),
		getDataConnectionByProvider: vitest.fn(),
		updateDataConnection: vitest.fn(),
		getOrganizationMembership: vitest.fn(),
		getProjectMemberRole: vitest.fn(),
		createProjectRepoIntegration: vitest.fn(),
		logRepoIntegrationActivity: vitest.fn(),
		syncLegacyProjectRepoOnConnect: vitest.fn(),
		listProjectsBoundToIntegration: async () => [],
		clearMcpConfigFromReportInstances: async () => 0,
		getMcpServerById: async () => null,
		getWorkflowIntegrationById: (
			id: string,
			userId: string,
			organizationId?: string,
		) =>
			state.fake.db.workflowIntegration.findFirst({
				where: { id, ...tenant(userId, organizationId) },
			}),
		deleteWorkflowIntegration: (
			id: string,
			userId: string,
			organizationId?: string,
		) =>
			state.fake.db.workflowIntegration.delete({
				where: { id, ...tenant(userId, organizationId) },
			}),
		deleteWorkflowIntegrationByType: vitest.fn(),
		// The exclusive tenant filter `getMcpConfigById` applies.
		getMcpConfigById: (
			id: string,
			opts?: { userId: string; organizationId?: string },
		) =>
			opts?.userId
				? state.fake.db.mCPConfig.findFirst({
						where: {
							id,
							...tenant(opts.userId, opts.organizationId),
						},
					})
				: null,
		deleteMcpConfig: (id: string) =>
			state.fake.db.mCPConfig.delete({ where: { id } }),
		// The one owner-scoped write `revokeOAuthTokens` makes (its own test,
		// packages/database/__tests__/mcp-revoke-oauth-tokens.test.ts, pins
		// that it is one update clearing both sets).
		revokeOAuthTokens: (
			configId: string,
			owner?: { userId: string; organizationId: string | null },
		) =>
			state.fake.db.mCPConfig.updateMany({
				where: {
					id: configId,
					...(owner
						? tenant(owner.userId, owner.organizationId)
						: {}),
				},
				data: {
					encryptedAccessToken: null,
					accessTokenHash: null,
					encryptedRefreshToken: null,
					tokenExpiresAt: null,
					status: "UNAVAILABLE",
					encryptedAtlassianCloudAccessToken: null,
					encryptedAtlassianCloudRefreshToken: null,
					atlassianCloudTokenExpiresAt: null,
				},
			}),
		// A separate Atlassian Cloud clear is the step that used to fail
		// after the primary tokens were already gone; it fails here, so a
		// Revoke that still depends on it is caught.
		clearMcpAtlassianCloudTokens: async () => {
			throw new Error("chained-token clear failed");
		},
		getDataConnectionById: (args: { id: string }) =>
			state.fake.db.dataConnection.findFirst({ where: { id: args.id } }),
		deleteDataConnection: (args: { id: string }) =>
			state.fake.db.dataConnection.deleteMany({ where: { id: args.id } }),
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
vi.mock("@repo/mcp", () => ({
	GitLabMcpCredentialError: class extends Error {},
	getValidMcpAccessToken: vi.fn(),
	isGitLabPersonalMcpConfig: vi.fn(),
}));
vi.mock("@repo/permissions", () => ({
	hasPermission: vi.fn().mockReturnValue(true),
	Permissions: {},
	resolveOrgPermissions: vi.fn().mockReturnValue([]),
	resolveProjectPermissions: vi.fn(),
}));
vi.mock("@repo/temporal", () => ({
	triggerMcpToolIngestion: vi.fn(),
	triggerMcpToolDeletion: vi.fn(),
	triggerMcpServerIngestion: vi.fn(),
	triggerOAuthServerIngestion: vi.fn(),
	triggerOAuthToolIngestion: vi.fn(),
}));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
	logDataEvent: vi.fn(),
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
	resolveOrgIdForQuery: ({
		organizationId,
	}: {
		organizationId: string | null;
	}) => organizationId,
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
vi.mock("../../../organizations/lib/membership", () => ({
	verifyOrganizationMembership: async () => ({ role: "member" }),
}));
vi.mock("../../../external-api/middleware/api-key-auth", () => ({
	requireScope: () => async (_c: unknown, next: () => Promise<void>) => {
		await next();
	},
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
		requirePermission: () => ({}),
		requireInputOrgPermission: () => ({}),
		requireOrganizationMembership: vi.fn(),
		resolveOrganizationId: (orgId: string | null | undefined) =>
			orgId ?? undefined,
		resolveOrganizationIdForCaller: async (orgId: string | null) => orgId,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
	};
});

import { getOrganizationMembership } from "@repo/database";
import {
	connectGitLab,
	getGitLabAccessToken,
	resetGitLabConnectionDepsForTests,
} from "@repo/integrations/gitlab";
import { triggerMcpToolDeletion } from "@repo/temporal";
import { deleteProcedure as deleteDataConnectionProcedure } from "../../../data-connections/procedures/delete";
import { configProcedures } from "../../../mcp/procedures/configs";
import { revokeMcpOAuthProcedure } from "../../../mcp/procedures/oauth-revoke";
import { registerMcpRoutes } from "../../../v1/mcp";
import { deleteIntegrationProcedure } from "../../../workflows/procedures/integrations/delete-integration";
import { disconnectByTypeProcedure } from "../../../workflows/procedures/integrations/disconnect-by-type";
import { gitlabOAuthProcedures } from "../../procedures/gitlab-oauth";
import { genericOAuthProcedures } from "../../procedures/oauth";

const USER = "user-1";
const OTHER_USER = "user-2";
const ORG = "example-org";
const OTHER_ORG = "other-org";

type AnyHandler = {
	handler: (args: {
		input: Record<string, unknown>;
		context: Record<string, unknown>;
	}) => Promise<any>;
};
const run = (
	procedure: unknown,
	input: Record<string, unknown>,
	userId = USER,
) =>
	(procedure as AnyHandler).handler({
		input,
		context: {
			user: { id: userId, email: "dev@example.com", name: "Dev" },
			session: { id: "session-1", activeOrganizationId: ORG },
		},
	});

function v1App() {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set(
			"externalApiContext" as never,
			{
				keyType: "personal",
				keyId: "key-1",
				keyPrefix: "fab_test",
				userId: USER,
				organizationId: undefined,
				scopes: ["mcp:write"],
			} as never,
		);
		await next();
	});
	registerMcpRoutes(app as never);
	return app;
}

const SERVERS = [
	{
		id: "srv-gitlab",
		key: "gitlab",
		name: "GitLab",
		defaultUrl: "https://app.example.com/api/mcp/gitlab",
	},
	{
		id: "srv-gitlab-official",
		key: "gitlab-official",
		name: "GitLab (Official)",
		defaultUrl: "https://gitlab.com/api/v4/mcp",
	},
	{
		id: "srv-linear",
		key: "linear-remote",
		name: "Linear",
		defaultUrl: "https://mcp.example.com/linear",
	},
];

function mcpRow(
	serverKey: string,
	overrides: Record<string, unknown> = {},
): Record<string, unknown> & { id: string } {
	const userId = (overrides.userId as string | undefined) ?? USER;
	const organizationId =
		(overrides.organizationId as string | null | undefined) ?? ORG;
	return {
		id: `cfg-${serverKey}-${userId}-${organizationId}`,
		userId,
		organizationId,
		mcpServerId: `srv-${serverKey}`,
		displayName: null,
		enabled: true,
		authType: "OAUTH2",
		isManagedDefault: false,
		baseUrl: null,
		oauthClientId: null,
		encryptedOauthClientSecret: null,
		dcrClientMetadata: null,
		encryptedAccessToken: `enc:${serverKey}-token`,
		accessTokenHash: `hash:${serverKey}-token`,
		encryptedRefreshToken: `enc:${serverKey}-refresh`,
		tokenExpiresAt: new Date(Date.now() + 3_600_000),
		needsReauth: false,
		encryptedAtlassianCloudAccessToken: null,
		createdAt: new Date("2026-01-01T00:00:00Z"),
		updatedAt: new Date("2026-01-02T00:00:00Z"),
		...overrides,
	};
}

const PRI = {
	id: "pri-1",
	projectId: "project-1",
	provider: "GITLAB",
	authMethod: "OAUTH",
	repositoryOwner: "example-group",
	repositoryName: "example-repo",
	encryptedAccessToken: "enc:repo-token",
	encryptedRefreshToken: "enc:repo-refresh",
	status: "ACTIVE",
};

function seedConnectedPerson() {
	state.fake.tables.workflowIntegration.push({
		id: "gl-wi",
		userId: USER,
		organizationId: ORG,
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
	state.fake.tables.mCPConfig.push(
		mcpRow("gitlab-official", {
			oauthClientId: "dcr-client-id",
			dcrClientMetadata: { token_endpoint_auth_method: "none" },
		}),
		mcpRow("gitlab"),
	);
	state.fake.tables.project.push({ id: "project-1", organizationId: ORG });
	state.fake.tables.projectRepositoryIntegration.push({ ...PRI });
	state.fake.tables.dataConnection.push({
		id: "dc-1",
		userId: USER,
		organizationId: ORG,
		provider: "GITLAB",
		status: "CONNECTED",
		accessToken: "enc:dc-token",
		credentialId: "credential-1",
	});
}

const row = (table: "mCPConfig", id: string) =>
	state.fake.tables[table].find((each) => each.id === id);
const OFFICIAL_ID = `cfg-gitlab-official-${USER}-${ORG}`;
const REGISTRY_ID = `cfg-gitlab-${USER}-${ORG}`;

function disconnectAudits() {
	return state.audit.mock.calls
		.map((call) => call[1] as Record<string, any>)
		.filter((input) => input.action === "org.integration.disconnected");
}

/** What every disconnect surface must leave behind. */
async function expectPersonDisconnected(surface: string) {
	const personal = state.fake.tables.workflowIntegration.find(
		(each) => each.id === "gl-wi",
	);
	expect(personal?.isActive).toBe(false);
	expect(readCredential(personal as never)).not.toHaveProperty(
		"access_token",
	);
	expect(await getGitLabAccessToken(USER, ORG)).toBeNull();
	for (const id of [OFFICIAL_ID, REGISTRY_ID]) {
		expect(row("mCPConfig", id)).toMatchObject({
			encryptedAccessToken: null,
			encryptedRefreshToken: null,
			accessTokenHash: null,
		});
	}
	// The client registration a reconnect reuses is kept.
	expect(row("mCPConfig", OFFICIAL_ID)?.oauthClientId).toBe("dcr-client-id");
	// Project repository links are a team grant: untouched.
	expect(state.fake.tables.projectRepositoryIntegration).toEqual([PRI]);
	// The person's own Data Connection is marked, never deleted.
	expect(state.fake.tables.dataConnection[0]).toMatchObject({
		id: "dc-1",
		status: "EXPIRED",
		accessToken: null,
		credentialId: null,
	});
	const audits = disconnectAudits();
	expect(audits).toHaveLength(1);
	expect(audits[0]).toMatchObject({
		organizationId: ORG,
		resource: { type: "gitlab_connection", id: "gl-wi" },
		metadata: { provider: "GITLAB", surface },
	});
}

beforeEach(() => {
	state.fake = createGitLabFakeDb({
		mCPServer: SERVERS.map((each) => ({ ...each })),
	});
	state.audit.mockClear();
	vi.mocked(triggerMcpToolDeletion).mockClear();
	// The REST API's live permission check reads the key owner's membership.
	vi.mocked(getOrganizationMembership).mockResolvedValue({
		role: "admin",
	} as never);
	resetGitLabConnectionDepsForTests();
	vi.stubEnv("GITLAB_CLIENT_ID", "gl-client-id");
	vi.stubEnv("GITLAB_CLIENT_SECRET", "gl-client-secret");
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(null, { status: 200 })),
	);
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("every GitLab disconnect surface runs the one disconnect", () => {
	it("integrations.gitlab.disconnect", async () => {
		seedConnectedPerson();
		await run(gitlabOAuthProcedures.disconnect, { organizationId: ORG });
		await expectPersonDisconnected("integrations.gitlab.disconnect");
	});

	it("integrations.oauth.disconnect for GITLAB", async () => {
		seedConnectedPerson();
		await run(genericOAuthProcedures.disconnect, {
			provider: "GITLAB",
			organizationId: ORG,
		});
		await expectPersonDisconnected("integrations.oauth.disconnect");
	});

	it("workflows.integrations.disconnectByType GITLAB", async () => {
		seedConnectedPerson();
		await run(disconnectByTypeProcedure, {
			type: "GITLAB",
			organizationId: ORG,
		});
		await expectPersonDisconnected(
			"workflows.integrations.disconnectByType",
		);
	});

	it("workflows.integrations.delete on the personal connection row", async () => {
		seedConnectedPerson();
		await run(deleteIntegrationProcedure, {
			integrationId: "gl-wi",
			organizationId: ORG,
		});
		await expectPersonDisconnected("workflows.integrations.delete");
	});

	it("MCP tile Revoke on the gitlab-official server", async () => {
		seedConnectedPerson();
		const result = await run(revokeMcpOAuthProcedure, {
			configId: OFFICIAL_ID,
			organizationId: ORG,
		});
		expect(result.success).toBe(true);
		await expectPersonDisconnected("mcp.oauth.revoke");
		// Revoke is not Delete: the server stays on.
		expect(row("mCPConfig", OFFICIAL_ID)?.enabled).toBe(true);
	});

	it.each([
		["gitlab-official", OFFICIAL_ID],
		["gitlab", REGISTRY_ID],
	])(
		"MCP tile Delete on the %s server disconnects, turns it off and keeps the row and registration",
		async (_key, configId) => {
			seedConnectedPerson();
			await run(configProcedures.delete, {
				id: configId,
				organizationId: ORG,
			});
			await expectPersonDisconnected("mcp.configs.delete");
			expect(row("mCPConfig", configId)).toMatchObject({
				enabled: false,
			});
			expect(state.fake.tables.mCPConfig).toHaveLength(2);
			// One curated event: the disconnect, carrying the config it
			// turned off. No second `mcp.config.updated` row.
			expect(state.audit).toHaveBeenCalledTimes(1);
			expect(disconnectAudits()[0].metadata).toMatchObject({
				mcpConfigId: configId,
				mcpConfigDisabled: true,
			});
		},
	);

	it("REST API DELETE /mcp/configs/:id on the gitlab-official server", async () => {
		seedConnectedPerson();
		const response = await v1App().request(`/mcp/configs/${OFFICIAL_ID}`, {
			method: "DELETE",
		});
		expect(response.status).toBe(200);
		await expectPersonDisconnected("v1.mcp.configs.delete");
		expect(row("mCPConfig", OFFICIAL_ID)).toMatchObject({ enabled: false });
		expect(disconnectAudits()[0].actor).toEqual({
			type: "api_key",
			userId: USER,
		});
	});
});

describe("a reconnect that lands while the disconnect is still revoking", () => {
	// The disconnect commits, releases the lifecycle lock and only then calls
	// GitLab to revoke. A reconnect in that window used to be followed by the
	// disconnect's late writes: the Data Connection expired and the server
	// turned off under a person who was connected again.
	it.each([
		[
			"integrations.gitlab.disconnect",
			() =>
				run(gitlabOAuthProcedures.disconnect, { organizationId: ORG }),
		],
		[
			"MCP tile Delete",
			() =>
				run(configProcedures.delete, {
					id: OFFICIAL_ID,
					organizationId: ORG,
				}),
		],
	])(
		"%s leaves what the reconnect restored",
		async (_surface, disconnectNow) => {
			seedConnectedPerson();
			let reconnected = false;
			vi.mocked(fetch).mockImplementation(async (url) => {
				if (String(url).endsWith("/oauth/revoke") && !reconnected) {
					reconnected = true;
					// The person reconnects while GitLab answers the revoke...
					await connectGitLab(
						{ userId: USER, organizationId: ORG },
						{
							accessToken: "new-token",
							refreshToken: "new-refresh",
							expiresAt: new Date(Date.now() + 7_200_000),
							scopes: ["api"],
							issuer: {
								kind: "app",
								clientId: "gl-client-id",
								origin: "https://gitlab.com",
							},
							freshGrant: true,
						},
					);
					// ...and the reconnect restores what it owns: the expired
					// Data Connection healed, the server back on.
					await state.fake.db.dataConnection.updateMany({
						where: {
							userId: USER,
							organizationId: ORG,
							provider: "GITLAB",
							status: "EXPIRED",
						},
						data: { status: "CONNECTED" },
					} as never);
					await state.fake.db.mCPConfig.updateMany({
						where: { id: OFFICIAL_ID },
						data: { enabled: true },
					} as never);
				}
				return new Response(null, { status: 200 });
			});

			await disconnectNow();

			expect(reconnected).toBe(true);
			expect(await getGitLabAccessToken(USER, ORG)).toBe("new-token");
			expect(state.fake.tables.dataConnection[0]?.status).toBe(
				"CONNECTED",
			);
			expect(row("mCPConfig", OFFICIAL_ID)?.enabled).toBe(true);
			// Nor does any background cleanup start after the disconnect: the
			// tool-deletion workflow deletes by server name, user and
			// organization, and would remove what the reconnect's ingestion
			// indexes.
			expect(vi.mocked(triggerMcpToolDeletion)).not.toHaveBeenCalled();
		},
	);
});

describe("a disconnect write that fails", () => {
	it("rolls the whole disconnect back and fails the request, leaving the person connected", async () => {
		seedConnectedPerson();
		const updateMany = state.fake.db.dataConnection.updateMany;
		state.fake.db.dataConnection.updateMany = (async () => {
			throw new Error("data connection write failed");
		}) as never;

		await expect(
			run(gitlabOAuthProcedures.disconnect, { organizationId: ORG }),
		).rejects.toThrow(/data connection write failed/);

		state.fake.db.dataConnection.updateMany = updateMany;
		// Nothing half-done: the connection still works, the server's token
		// copy is still there, and no disconnect was recorded.
		expect(await getGitLabAccessToken(USER, ORG)).toBe("wi-token");
		expect(row("mCPConfig", OFFICIAL_ID)?.encryptedAccessToken).toBe(
			"enc:gitlab-official-token",
		);
		expect(disconnectAudits()).toEqual([]);
	});
});

describe("MCP tile Revoke", () => {
	it("refuses another person's config in the same organization", async () => {
		seedConnectedPerson();
		const theirs = mcpRow("gitlab-official", {
			userId: OTHER_USER,
			oauthClientId: "their-client",
		});
		state.fake.tables.mCPConfig.push(theirs);

		await expect(
			run(revokeMcpOAuthProcedure, {
				configId: theirs.id,
				organizationId: ORG,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(row("mCPConfig", theirs.id)?.encryptedAccessToken).toBe(
			"enc:gitlab-official-token",
		);
		// The caller's own connection is untouched too.
		expect(await getGitLabAccessToken(USER, ORG)).toBe("wi-token");
		expect(state.audit).not.toHaveBeenCalled();
	});

	it("refuses the caller's own config in another organization", async () => {
		seedConnectedPerson();
		const elsewhere = mcpRow("linear-remote", {
			organizationId: OTHER_ORG,
		});
		state.fake.tables.mCPConfig.push(elsewhere);

		await expect(
			run(revokeMcpOAuthProcedure, {
				configId: elsewhere.id,
				organizationId: ORG,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(row("mCPConfig", elsewhere.id)?.encryptedAccessToken).toBe(
			"enc:linear-remote-token",
		);
	});

	it("clears a non-GitLab server's tokens and its chained Atlassian Cloud tokens together, keeps the row and registration, and audits it", async () => {
		seedConnectedPerson();
		const linear = mcpRow("linear-remote", {
			oauthClientId: "linear-client",
			encryptedAtlassianCloudAccessToken: "enc:cloud-token",
		});
		state.fake.tables.mCPConfig.push(linear);

		const result = await run(revokeMcpOAuthProcedure, {
			configId: linear.id,
			organizationId: ORG,
		});

		expect(result.success).toBe(true);
		expect(result.revocationWarning).toMatch(/not revoked at the provider/);
		expect(row("mCPConfig", linear.id)).toMatchObject({
			encryptedAccessToken: null,
			accessTokenHash: null,
			encryptedRefreshToken: null,
			tokenExpiresAt: null,
			encryptedAtlassianCloudAccessToken: null,
			oauthClientId: "linear-client",
			enabled: true,
		});
		expect(state.audit).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				action: "mcp.config.updated",
				organizationId: ORG,
				resource: expect.objectContaining({ id: linear.id }),
				metadata: expect.objectContaining({
					change: "oauth_tokens_revoked",
				}),
			}),
		);
		// Not a GitLab disconnect.
		expect(disconnectAudits()).toEqual([]);
		expect(await getGitLabAccessToken(USER, ORG)).toBe("wi-token");
	});

	it("refuses a config that is not on OAuth", async () => {
		const apiKey = mcpRow("linear-remote", { authType: "API_KEY" });
		state.fake.tables.mCPConfig.push(apiKey);
		await expect(
			run(revokeMcpOAuthProcedure, {
				configId: apiKey.id,
				organizationId: ORG,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});
});

describe("not a disconnect", () => {
	it("MCP tile Delete of a non-GitLab server still deletes just that row", async () => {
		seedConnectedPerson();
		const linear = mcpRow("linear-remote");
		state.fake.tables.mCPConfig.push(linear);

		await run(configProcedures.delete, {
			id: linear.id,
			organizationId: ORG,
		});

		expect(row("mCPConfig", linear.id)).toBeUndefined();
		expect(await getGitLabAccessToken(USER, ORG)).toBe("wi-token");
		expect(disconnectAudits()).toEqual([]);
	});

	it("deleting a GitLab Data Connection removes only that source", async () => {
		seedConnectedPerson();

		await run(deleteDataConnectionProcedure, {
			id: "dc-1",
			organizationId: ORG,
		});

		expect(state.fake.tables.dataConnection).toEqual([]);
		expect(await getGitLabAccessToken(USER, ORG)).toBe("wi-token");
		expect(row("mCPConfig", OFFICIAL_ID)?.encryptedAccessToken).toBe(
			"enc:gitlab-official-token",
		);
		expect(disconnectAudits()).toEqual([]);
	});
});
