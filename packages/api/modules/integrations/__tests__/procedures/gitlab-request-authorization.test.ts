/**
 * Authorization of the GitLab connection surfaces, through the real
 * permission code: the procedures' own permission middlewares
 * (`requirePermission` / `requireInputOrgPermission`, run from each
 * procedure's definition), the in-handler `authorizeInputOrganization`, the
 * real role-to-permission table in `@repo/permissions`, and for the REST API
 * the real `requireScope` middleware. Only the database (the GitLab fake,
 * which applies `where` clauses) and the membership lookup are stand-ins.
 *
 * Pinned:
 *  - an omitted organization resolves like every other surface (input, else
 *    the session's) and never reads or writes into a no-organization tenant;
 *    nothing resolved is refused;
 *  - an explicit organization the caller is not a member of is refused
 *    before anything is read or written;
 *  - a member may disconnect their own GitLab (`MCP_CONNECT`), a viewer may
 *    not;
 *  - a REST API key reaches the GitLab Delete only while its owner holds
 *    `MCP_DELETE` now, wildcard keys included, and that refusal is
 *    distinguishable from a missing scope.
 */

import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	createGitLabFakeDb,
	encryptedCredential,
} from "../../../../../integrations/__tests__/gitlab/helpers/gitlab-fake-db";

const state = vi.hoisted(() => ({
	fake: null as unknown as ReturnType<
		typeof import("../../../../../integrations/__tests__/gitlab/helpers/gitlab-fake-db").createGitLabFakeDb
	>,
	/** organizationId -> userId -> role */
	members: {} as Record<string, Record<string, string>>,
	/** What the permission middleware set on this request's tenant context. */
	tenantContext: {} as { effectiveWriteOrgId?: string },
}));

vi.mock("@repo/auth", () => ({ auth: { api: { getSession: vi.fn() } } }));

vi.mock("@repo/database", async () => {
	const { vi: vitest } = await import("vitest");
	const keys = await import(
		"../../../../../database/prisma/queries/lib/gitlab-personal-keys"
	);
	const tenant = (userId: string, organizationId?: string | null) =>
		organizationId
			? { userId, organizationId }
			: { userId, organizationId: null };
	const membership = async (organizationId: string, userId: string) => {
		const role = state.members[organizationId]?.[userId];
		return role ? { organization: { id: organizationId }, role } : null;
	};
	return {
		get db() {
			return state.fake.db;
		},
		...keys,
		Prisma: { PrismaClientKnownRequestError: class extends Error {} },
		WorkflowIntegrationProviderSchema: (await import("zod")).z.string(),
		deleteWorkflowIntegrationByType: vitest.fn(),
		getMcpConfigByIdInternal: (id: string) =>
			state.fake.db.mCPConfig.findFirst({ where: { id } }),
		getOrganizationById: async (id: string) => ({ id }),
		listProjectsBoundToIntegration: vitest.fn(async () => []),
		// Tools cached while GitLab was connected.
		getMcpConfigCachedTools: vitest.fn(async () => ({
			tools: [
				{
					name: "gitlab_list_issues",
					description: "List issues",
					inputSchema: {},
				},
			],
			toolCount: 1,
			cachedAt: new Date("2026-01-01T00:00:00Z"),
		})),
		getTenantContext: () => state.tenantContext,
		getOrganizationMembership: membership,
		recordAudit: vitest.fn(),
		resolveUserOrganization: async () => ({
			kind: "resolved",
			organizationId: "example-org",
		}),
		listAvailablePmTools: vitest.fn(async () => []),
		// The document route's own access check (it ignores its organization
		// argument, like the real one): the caller can reach the project.
		hasProjectAccess: vitest.fn(async () => true),
		createDataConnection: vitest.fn(),
		getDataConnectionByProvider: vitest.fn(),
		updateDataConnection: vitest.fn(),
		getProjectMemberRole: vitest.fn(),
		createProjectRepoIntegration: vitest.fn(),
		logRepoIntegrationActivity: vitest.fn(),
		syncLegacyProjectRepoOnConnect: vitest.fn(),
		clearMcpConfigFromReportInstances: async () => 0,
		getMcpServerById: async () => null,
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
		deleteMcpConfig: vitest.fn(),
		// The REST API key middleware's imports; the keys themselves are
		// injected by the test app below.
		OAUTH_ACCESS_TOKEN_PREFIX: "fat_",
		canExecuteOrganizationAgents: async () => true,
		canRunOrganizationWorkflows: async () => true,
		verifyOAuthAccessToken: vitest.fn(),
		verifyOrganizationApiKey: vitest.fn(),
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
	closeMcpClient: vi.fn(),
	createMcpClientForConfig: vi.fn(async () => {
		throw new Error("no live MCP connection in this test");
	}),
	GitLabMcpCredentialError: class extends Error {},
	getValidMcpAccessToken: vi.fn(),
	isGitLabPersonalMcpConfig: vi.fn(),
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
vi.mock("../../../../lib/audit", () => ({
	recordAuditFromRequest: vi.fn(),
}));
// The project-permission middleware runs for real; only its resolver's
// database reads are replaced: the caller's role in the project's
// organization decides, as on the resolver's organization path.
vi.mock("../../../../lib/effective-project-permissions", async () => {
	const { resolveOrgPermissions } = await import("@repo/permissions");
	return {
		resolveEffectiveProjectPermissions: async (
			projectId: string,
			userId: string,
		) => {
			const project = state.fake.tables.project.find(
				(row) => row.id === projectId,
			);
			if (!project) {
				return null;
			}
			const organizationId = (project.organizationId ?? null) as
				| string
				| null;
			const role = organizationId
				? state.members[organizationId]?.[userId]
				: undefined;
			return role
				? {
						permissions: resolveOrgPermissions(role),
						source: "org",
						organizationId,
					}
				: { permissions: [], source: "none", organizationId };
		},
	};
});
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
	listGitLabProjects: vi.fn(async () => []),
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
	verifyOrganizationMembership: async (
		organizationId: string,
		userId: string,
	) => {
		const role = state.members[organizationId]?.[userId];
		return role ? { role } : null;
	},
}));
vi.mock("../../../users/procedures/api-keys/verify", () => ({
	verifyUserApiKey: vi.fn(),
}));

import { listAvailablePmTools } from "@repo/database";
import { resetGitLabConnectionDepsForTests } from "@repo/integrations/gitlab";
import { PERMISSION_MIDDLEWARE_TAG } from "../../../../orpc/middleware/require-permission";
import { linkFromWorkflowIntegrationProcedure } from "../../../data-connections/procedures/link-workflow-integration";
import { listAvailablePmToolsProcedure } from "../../../mcp/procedures/available-pm-tools";
import { connectProcedures } from "../../../mcp/procedures/connect";
import { listToolsProcedure } from "../../../mcp/procedures/list-tools";
import { oauthProcedures as mcpOAuthProcedures } from "../../../mcp/procedures/oauth";
import { executeGitLabToolProcedure } from "../../../projects/procedures/documents/execute-gitlab-tool";
import { listGitLabProjectsProcedure } from "../../../projects/procedures/gitlab/list-projects";
import { registerMcpRoutes } from "../../../v1/mcp";
import { disconnectByTypeProcedure } from "../../../workflows/procedures/integrations/disconnect-by-type";
import { saveIntegrationProcedure } from "../../../workflows/procedures/integrations/save-integration";
import { recheckGitlabCapabilities } from "../../lib/gitlab-recheck";
import { gitlabOAuthProcedures } from "../../procedures/gitlab-oauth";
import { genericOAuthProcedures } from "../../procedures/oauth";

const USER = "user-1";
const ORG = "example-org";
const OTHER_ORG = "other-org";

type Definition = {
	"~orpc": {
		middlewares: unknown[];
		handler: (options: Record<string, unknown>) => Promise<unknown>;
	};
};

/**
 * Run a procedure the way its definition says: every permission middleware
 * it declares (the real ones), then its handler. The session and tenant
 * context are what the tenant-context middleware would have set for a caller
 * whose active organization is `sessionOrg` with role `sessionRole`.
 */
async function call(
	procedure: unknown,
	input: Record<string, unknown>,
	session: { org: string | null; role?: string | null } = {
		org: ORG,
		role: "member",
	},
): Promise<any> {
	const def = (procedure as Definition)["~orpc"];
	// The tag `requirePermission` / `requireInputOrgPermission` put on the
	// middleware they return (the middlewares are functions, which
	// `getPermissionFromMiddleware` does not look at).
	const permissionMiddlewares = def.middlewares.filter(
		(mw) =>
			typeof mw === "function" &&
			(mw as unknown as Record<symbol, unknown>)[
				PERMISSION_MIDDLEWARE_TAG
			] !== undefined,
	);
	// A guard against a test that silently runs no permission code at all.
	expect(permissionMiddlewares.length).toBeGreaterThan(0);
	const base = {
		user: { id: USER, email: "dev@example.com", name: "Dev" },
		session: { id: "session-1", activeOrganizationId: session.org },
		tenantContext: session.org
			? {
					userId: USER,
					type: "organization",
					organizationId: session.org,
				}
			: // What the tenant-context middleware builds for a session naming
				// no workspace: `requirePermission` passes it through, so only
				// the handler's own resolution stands between it and a write.
				{ userId: USER, type: "personal", organizationId: null },
		activeOrganizationRole: session.role ?? null,
		allowedProjectIds: [],
	};
	const step = async (
		index: number,
		context: Record<string, unknown>,
	): Promise<{ output: unknown }> => {
		if (index === permissionMiddlewares.length) {
			return {
				output: await def.handler({
					input,
					context,
					path: [],
					procedure,
					signal: undefined,
					lastEventId: undefined,
					errors: {},
				}),
			};
		}
		const mw = permissionMiddlewares[index] as (
			options: Record<string, unknown>,
			input: unknown,
			output: unknown,
		) => Promise<{ output: unknown }>;
		return mw(
			{
				context,
				path: [],
				procedure,
				signal: undefined,
				lastEventId: undefined,
				errors: {},
				next: (options?: { context?: Record<string, unknown> }) =>
					step(index + 1, {
						...context,
						...(options?.context ?? {}),
					}),
			},
			input,
			(output: unknown) => ({ output }),
		);
	};
	return (await step(0, base)).output;
}

/** The person's `gitlab-official` config: its registration, no token copy. */
function seedOfficialConfig(organizationId: string | null) {
	state.fake.tables.mCPConfig.push({
		id: `official-${organizationId ?? "none"}`,
		userId: USER,
		organizationId,
		mcpServerId: "srv-gitlab-official",
		enabled: true,
		displayName: "GitLab (Official)",
		scopes: ["api"],
		baseUrl: null,
		authType: "OAUTH2",
		encryptedAccessToken: null,
		encryptedRefreshToken: null,
		accessTokenHash: null,
		tokenExpiresAt: null,
		needsReauth: false,
		oauthClientId: "dcr-client-id",
		encryptedOauthClientSecret: "enc:dcr-client-secret",
		dcrClientMetadata: null,
		dcrRegisteredAt: new Date("2026-01-01T00:00:00Z"),
		createdAt: new Date("2026-01-01T00:00:00Z"),
		updatedAt: new Date("2026-01-02T00:00:00Z"),
	});
}

/**
 * State a read in this tenant would write if it ran: the official config,
 * and a legacy connection row that records no issuer, which a service read
 * classifies (writing the issuer into it). Returns the tenant's connection
 * rows as seeded, so a test can show nothing there was written.
 */
function seedWritableLegacyState(organizationId: string | null) {
	seedOfficialConfig(organizationId);
	state.fake.tables.workflowIntegration.push({
		id: `legacy-wi-${organizationId ?? "none"}`,
		userId: USER,
		organizationId,
		provider: "GITLAB",
		name: "GitLab",
		workflowId: null,
		isActive: true,
		credentials: encryptedCredential({ GITLAB_ACCESS_TOKEN: "legacy-pat" }),
		settings: {},
		createdAt: new Date("2026-01-01T00:00:00Z"),
		updatedAt: new Date("2026-01-01T00:00:00Z"),
	});
	return structuredClone(connectionRowsIn(organizationId));
}

function seedConnection(
	organizationId: string,
	settings: Record<string, unknown> = {},
) {
	state.fake.tables.workflowIntegration.push({
		id: `gl-wi-${organizationId}`,
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
		settings,
		createdAt: new Date("2026-01-01T00:00:00Z"),
		updatedAt: new Date("2026-01-01T00:00:00Z"),
	});
}

const connectionRowsIn = (organizationId: string | null) =>
	state.fake.tables.workflowIntegration.filter(
		(row) =>
			row.provider === "GITLAB" && row.organizationId === organizationId,
	);

beforeEach(() => {
	state.fake = createGitLabFakeDb({
		mCPServer: [
			{
				id: "srv-gitlab",
				key: "gitlab",
				name: "GitLab",
				defaultUrl: "https://app.example.com/api/mcp/gitlab",
				authMethods: ["OAUTH2"],
			},
			{
				id: "srv-gitlab-official",
				key: "gitlab-official",
				name: "GitLab (Official)",
				defaultUrl: "https://gitlab.com/api/v4/mcp",
				authMethods: ["OAUTH2"],
			},
		],
	});
	state.members = { [ORG]: { [USER]: "member" } };
	state.tenantContext = {};
	resetGitLabConnectionDepsForTests();
	vi.mocked(listAvailablePmTools).mockClear();
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

describe("an omitted organization", () => {
	it("PM picker: resolves the session's organization and never writes into a no-organization tenant", async () => {
		const before = seedWritableLegacyState(null);

		await call(listAvailablePmToolsProcedure, {});

		expect(connectionRowsIn(null)).toEqual(before);
		expect(vi.mocked(listAvailablePmTools)).toHaveBeenCalledWith(
			expect.objectContaining({ userId: USER, organizationId: ORG }),
		);
	});

	it("PM picker and gitlab.status agree on the organization an omitted input means", async () => {
		seedConnection(ORG);

		const status = await call(gitlabOAuthProcedures.status, {});
		await call(listAvailablePmToolsProcedure, {});

		expect(status.state).toBe("connected");
		expect(vi.mocked(listAvailablePmTools)).toHaveBeenCalledWith(
			expect.objectContaining({
				organizationId: ORG,
				gitlab: expect.objectContaining({ state: "connected" }),
			}),
		);
	});

	it.each([
		["PM picker", listAvailablePmToolsProcedure, {}],
		["gitlab.status", gitlabOAuthProcedures.status, {}],
		["gitlab.connectionState", gitlabOAuthProcedures.connectionState, {}],
		[
			"generic OAuth status for GITLAB",
			genericOAuthProcedures.status,
			{ provider: "GITLAB" },
		],
	])(
		"%s: refused when nothing resolves, with nothing written",
		async (_name, procedure, input) => {
			const before = seedWritableLegacyState(null);

			await expect(
				call(procedure, input, { org: null, role: null }),
			).rejects.toMatchObject({
				data: { errorCode: "MISSING_ORGANIZATION_CONTEXT" },
			});
			expect(connectionRowsIn(null)).toEqual(before);
		},
	);
});

describe("an explicit organization the caller is not a member of", () => {
	it.each([
		["PM picker", listAvailablePmToolsProcedure, {}],
		["gitlab.status", gitlabOAuthProcedures.status, {}],
		["gitlab.connectionState", gitlabOAuthProcedures.connectionState, {}],
		["gitlab.disconnect", gitlabOAuthProcedures.disconnect, {}],
		["gitlab.listProjects", gitlabOAuthProcedures.listProjects, {}],
		[
			"generic OAuth status for GITLAB",
			genericOAuthProcedures.status,
			{ provider: "GITLAB" },
		],
		[
			"generic OAuth disconnect for GITLAB",
			genericOAuthProcedures.disconnect,
			{ provider: "GITLAB" },
		],
	])(
		"%s: refused, and nothing in the other organization is read into or written",
		async (_name, procedure, input) => {
			const before = seedWritableLegacyState(OTHER_ORG);

			await expect(
				call(procedure, { ...input, organizationId: OTHER_ORG }),
			).rejects.toMatchObject({
				code: "FORBIDDEN",
				message: "You are not a member of this organization",
			});
			expect(connectionRowsIn(OTHER_ORG)).toEqual(before);
		},
	);
});

describe("who may disconnect their own GitLab", () => {
	it.each([
		["gitlab.disconnect", gitlabOAuthProcedures.disconnect, {}],
		[
			"generic OAuth disconnect for GITLAB",
			genericOAuthProcedures.disconnect,
			{ provider: "GITLAB" },
		],
	])(
		"%s: a member may (MCP_CONNECT, as on the server tile)",
		async (_name, procedure, input) => {
			seedConnection(ORG);

			await call(procedure, { ...input, organizationId: ORG });

			expect(connectionRowsIn(ORG)[0]?.isActive).toBe(false);
		},
	);

	it.each([
		["gitlab.disconnect", gitlabOAuthProcedures.disconnect, {}],
		[
			"generic OAuth disconnect for GITLAB",
			genericOAuthProcedures.disconnect,
			{ provider: "GITLAB" },
		],
	])("%s: a viewer may not", async (_name, procedure, input) => {
		seedConnection(ORG);
		state.members[ORG][USER] = "viewer";

		await expect(
			call(
				procedure,
				{ ...input, organizationId: ORG },
				{ org: ORG, role: "viewer" },
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(connectionRowsIn(ORG)[0]?.isActive).toBe(true);
	});

	it("the generic OAuth disconnect still needs INTEGRATION_DISCONNECT for any other provider", async () => {
		await expect(
			call(genericOAuthProcedures.disconnect, {
				provider: "GITHUB",
				organizationId: ORG,
			}),
		).rejects.toMatchObject({
			code: "FORBIDDEN",
			message: "Missing required permission: integration:disconnect",
		});
	});
});

describe("the generic OAuth disconnect for any other provider", () => {
	const GUEST_ORG = "guest-org";

	function seedGitHubConnection(organizationId: string | null) {
		const id = `gh-wi-${organizationId ?? "none"}`;
		state.fake.tables.workflowIntegration.push({
			id,
			userId: USER,
			organizationId,
			provider: "GITHUB",
			name: "GitHub",
			workflowId: null,
			isActive: true,
			credentials: null,
			settings: {},
			createdAt: new Date("2026-01-01T00:00:00Z"),
			updatedAt: new Date("2026-01-01T00:00:00Z"),
		});
		return id;
	}
	const isActive = (id: string) =>
		state.fake.tables.workflowIntegration.find((row) => row.id === id)
			?.isActive;

	// The procedure-wide floor is MCP_CONNECT (a member may disconnect their
	// own GitLab); for any other provider the handler requires
	// INTEGRATION_DISCONNECT, which a member does not hold. It must hold
	// however the organization is given — including explicit null, which
	// resolves nothing and once skipped the role check entirely.
	it.each([
		["null, with an active organization", null, ORG, "member"],
		["null, with no active organization", null, null, null],
		["omitted (the session's)", undefined, ORG, "member"],
		["named", ORG, ORG, "member"],
	] as const)(
		"refuses a member without INTEGRATION_DISCONNECT when the organization is %s, and writes nothing",
		async (_name, organizationId, sessionOrg, sessionRole) => {
			const personal = seedGitHubConnection(null);
			const inOrg = seedGitHubConnection(ORG);

			await expect(
				call(
					genericOAuthProcedures.disconnect,
					{
						provider: "GITHUB",
						...(organizationId === undefined
							? {}
							: { organizationId }),
					},
					{ org: sessionOrg, role: sessionRole },
				),
			).rejects.toMatchObject({ code: "FORBIDDEN" });

			expect(isActive(personal)).toBe(true);
			expect(isActive(inOrg)).toBe(true);
		},
	);

	it("acts in the organization it authorized, when a guest write organization differs from the session's", async () => {
		// The caller is an admin in the guest organization the permission
		// middleware resolved for this request, and a plain member of the
		// session's organization.
		state.members[GUEST_ORG] = { [USER]: "admin" };
		state.tenantContext = { effectiveWriteOrgId: GUEST_ORG };
		const inGuestOrg = seedGitHubConnection(GUEST_ORG);
		const inSessionOrg = seedGitHubConnection(ORG);

		await call(genericOAuthProcedures.disconnect, { provider: "GITHUB" });

		expect(isActive(inGuestOrg)).toBe(false);
		expect(isActive(inSessionOrg)).toBe(true);
	});

	it("disconnects for an admin in the named organization", async () => {
		state.members[ORG][USER] = "admin";
		const inOrg = seedGitHubConnection(ORG);
		const personal = seedGitHubConnection(null);

		await call(
			genericOAuthProcedures.disconnect,
			{ provider: "GITHUB", organizationId: ORG },
			{ org: ORG, role: "admin" },
		);

		expect(isActive(inOrg)).toBe(false);
		expect(isActive(personal)).toBe(true);
	});
});

describe("re-checking GitLab's capabilities", () => {
	beforeEach(() => {
		vi.mocked(recheckGitlabCapabilities).mockReset();
		vi.mocked(recheckGitlabCapabilities).mockResolvedValue({
			useOfficialMcp: true,
			mcpProbe: {
				status: "ok",
				httpStatus: 200,
				checkedAt: "2026-01-01T00:00:00.000Z",
				baseUrl: "https://gitlab.com",
			},
		} as never);
	});

	it("refuses an organization the caller has left, before reading or writing the connection there", async () => {
		await expect(
			call(gitlabOAuthProcedures.recheckCapabilities, {
				organizationId: OTHER_ORG,
			}),
		).rejects.toMatchObject({
			code: "FORBIDDEN",
			message: "You are not a member of this organization",
		});
		expect(vi.mocked(recheckGitlabCapabilities)).not.toHaveBeenCalled();
	});

	it("re-checks in the session's organization when none is named, never in a no-organization tenant", async () => {
		await call(gitlabOAuthProcedures.recheckCapabilities, {});

		expect(vi.mocked(recheckGitlabCapabilities)).toHaveBeenCalledWith({
			input: { userId: USER, organizationId: ORG },
		});
	});

	it("refuses when no organization resolves", async () => {
		await expect(
			call(
				gitlabOAuthProcedures.recheckCapabilities,
				{ organizationId: null },
				{ org: null, role: null },
			),
		).rejects.toMatchObject({
			data: { errorCode: "MISSING_ORGANIZATION_CONTEXT" },
		});
		expect(vi.mocked(recheckGitlabCapabilities)).not.toHaveBeenCalled();
	});
});

/**
 * Every database call from here on, by model and operation, with its
 * `where`: the fake database behind a recording proxy.
 */
function recordDbCalls(): Array<{ model: string; operation: string }> {
	const calls: Array<{ model: string; operation: string }> = [];
	const db = state.fake.db as unknown as Record<
		string,
		Record<string, (...args: unknown[]) => unknown>
	>;
	const recording = new Proxy(db, {
		get(target, model: string) {
			const delegate = target[model];
			if (!delegate || typeof delegate !== "object") {
				return delegate;
			}
			return new Proxy(delegate, {
				get(inner, operation: string) {
					const fn = inner[operation];
					if (typeof fn !== "function") {
						return fn;
					}
					return (...args: unknown[]) => {
						calls.push({ model, operation });
						return fn.apply(inner, args);
					};
				},
			});
		},
	});
	state.fake = { ...state.fake, db: recording as never };
	return calls;
}

describe("the MCP connect status of a GitLab server", () => {
	// MCP configs and the GitLab connection live in an organization: a
	// request that names none (explicit null) or resolves none is refused
	// before anything is read, so no no-organization row is inspected,
	// classified or reported.
	it.each([
		[
			"getConnectInfo, organization null",
			() =>
				call(connectProcedures.getConnectInfo, {
					serverId: "srv-gitlab-official",
					organizationId: null,
				}),
		],
		[
			"getConnectionStatus, organization null",
			() =>
				call(connectProcedures.getConnectionStatus, {
					serverIds: ["srv-gitlab-official"],
					organizationId: null,
				}),
		],
		[
			"getConnectInfo, no organization in the session",
			() =>
				call(
					connectProcedures.getConnectInfo,
					{ serverId: "srv-gitlab-official" },
					{ org: null, role: null },
				),
		],
		[
			"getConnectionStatus, no organization in the session",
			() =>
				call(
					connectProcedures.getConnectionStatus,
					{ serverIds: ["srv-gitlab-official"] },
					{ org: null, role: null },
				),
		],
	])("%s: refused before anything is read", async (_name, run) => {
		const before = seedWritableLegacyState(null);
		const calls = recordDbCalls();

		await expect(run()).rejects.toMatchObject({
			data: { errorCode: "MISSING_ORGANIZATION_CONTEXT" },
		});

		expect(calls).toEqual([]);
		expect(connectionRowsIn(null)).toEqual(before);
	});

	it("reads a member's connection in the named organization", async () => {
		seedConnection(ORG);
		seedOfficialConfig(ORG);

		const info = await call(connectProcedures.getConnectInfo, {
			serverId: "srv-gitlab-official",
			organizationId: ORG,
		});

		expect(info).toMatchObject({ isConnected: true, needsReauth: false });
	});

	// Every other surface reads an omitted organization as the session's,
	// and the GitLab state is the connection's whether or not the person has
	// a config row for the server.
	it.each([
		[
			"getConnectInfo",
			async () =>
				call(connectProcedures.getConnectInfo, {
					serverId: "srv-gitlab",
				}),
		],
		[
			"getConnectionStatus",
			async () =>
				(
					await call(connectProcedures.getConnectionStatus, {
						serverIds: ["srv-gitlab"],
					})
				)[0],
		],
	])(
		"%s: an omitted organization is the session's, and GitLab connected with no config row reads connected",
		async (_name, run) => {
			seedConnection(ORG);

			expect(await run()).toMatchObject({
				isConnected: true,
				needsReauth: false,
				configProvisioned: false,
				configEnabled: false,
			});
		},
	);

	it.each([
		[
			"getConnectInfo",
			async () =>
				call(connectProcedures.getConnectInfo, {
					serverId: "srv-gitlab",
				}),
		],
		[
			"getConnectionStatus",
			async () =>
				(
					await call(connectProcedures.getConnectionStatus, {
						serverIds: ["srv-gitlab"],
					})
				)[0],
		],
	])(
		"%s: an omitted organization finds the config row in the session's organization",
		async (_name, run) => {
			seedConnection(ORG, {
				needsReauth: true,
				reauthReason: "invalid_grant",
			});
			state.fake.tables.mCPConfig.push({
				id: "cfg-gitlab-org",
				userId: USER,
				organizationId: ORG,
				mcpServerId: "srv-gitlab",
				enabled: true,
				authType: "OAUTH2",
				needsReauth: false,
				updatedAt: new Date("2026-01-02T00:00:00Z"),
			});

			expect(await run()).toMatchObject({
				isConnected: false,
				needsReauth: true,
				configProvisioned: true,
				configEnabled: true,
			});
		},
	);

	// A GitLab personal server's config holds no token, whatever auth type it
	// or its server names: an API-key config (or a server not offered over
	// OAuth) still reports the person's connection, never its own columns.
	it.each([
		[
			"getConnectInfo",
			async () =>
				call(connectProcedures.getConnectInfo, {
					serverId: "srv-gitlab",
					organizationId: ORG,
				}),
		],
		[
			"getConnectionStatus",
			async () =>
				(
					await call(connectProcedures.getConnectionStatus, {
						serverIds: ["srv-gitlab"],
						organizationId: ORG,
					})
				)[0],
		],
	])(
		"%s: a GitLab server's state is the connection even off OAuth, never the config's key",
		async (_name, run) => {
			const server = state.fake.tables.mCPServer.find(
				(row) => row.id === "srv-gitlab",
			);
			if (server) {
				server.authMethods = ["API_KEY"];
			}
			state.fake.tables.mCPConfig.push({
				id: "cfg-gitlab-api-key",
				userId: USER,
				organizationId: ORG,
				mcpServerId: "srv-gitlab",
				enabled: true,
				authType: "API_KEY",
				encryptedApiKey: "enc:pasted-key",
				encryptedAccessToken: null,
				tokenExpiresAt: null,
				needsReauth: false,
				updatedAt: new Date("2026-01-02T00:00:00Z"),
			});

			// The auth type is OAuth by the server's key, whatever the
			// registry metadata advertises: an API-key prompt would ask for
			// a key the connection never reads.
			expect(await run()).toMatchObject({
				authType: "OAUTH2",
				isConnected: false,
				needsReauth: false,
				configProvisioned: true,
			});

			seedConnection(ORG);
			expect(await run()).toMatchObject({
				authType: "OAUTH2",
				isConnected: true,
				needsReauth: false,
			});
		},
	);

	it.each([
		[
			"getConnectInfo",
			async () =>
				call(connectProcedures.getConnectInfo, {
					serverId: "srv-gitlab",
					organizationId: ORG,
				}),
		],
		[
			"getConnectionStatus",
			async () =>
				(
					await call(connectProcedures.getConnectionStatus, {
						serverIds: ["srv-gitlab"],
						organizationId: ORG,
					})
				)[0],
		],
	])(
		"%s: a turned-off config row is reported apart from the connection",
		async (_name, run) => {
			seedConnection(ORG);
			// The tile's Delete keeps the row and turns it off.
			state.fake.tables.mCPConfig.push({
				id: "cfg-gitlab-off",
				userId: USER,
				organizationId: ORG,
				mcpServerId: "srv-gitlab",
				enabled: false,
				authType: "OAUTH2",
				needsReauth: false,
				updatedAt: new Date("2026-01-02T00:00:00Z"),
			});

			expect(await run()).toMatchObject({
				isConnected: true,
				needsReauth: false,
				configProvisioned: true,
				configEnabled: false,
			});
		},
	);

	// A caller that goes on to write (the connection prompt adds the server
	// before its sign-in) writes in the organization this authorized, which
	// it can only do if it is told which one that was.
	it.each([
		["omitted", undefined, ORG],
		["named", ORG, ORG],
	])(
		"getConnectInfo returns the organization it authorized (%s)",
		async (_name, organizationId, expected) => {
			const info = await call(connectProcedures.getConnectInfo, {
				serverId: "srv-gitlab",
				...(organizationId ? { organizationId } : {}),
			});

			expect(info.organizationId).toBe(expected);
		},
	);

	it("refuses an organization the caller is not a member of", async () => {
		await expect(
			call(connectProcedures.getConnectInfo, {
				serverId: "srv-gitlab",
				organizationId: OTHER_ORG,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
});

describe("listing GitLab projects for the repository picker", () => {
	it("refuses an organization the caller has left, before reading, classifying or using the connection there", async () => {
		const before = seedWritableLegacyState(OTHER_ORG);

		await expect(
			call(listGitLabProjectsProcedure, { organizationId: OTHER_ORG }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(connectionRowsIn(OTHER_ORG)).toEqual(before);
		expect(vi.mocked(fetch)).not.toHaveBeenCalled();
	});

	it.each([
		["connected", () => seedConnection(ORG), true, "connected"],
		[
			"needs reconnecting",
			() =>
				seedConnection(ORG, {
					needsReauth: true,
					reauthReason: "invalid_grant",
				}),
			false,
			"needs-reconnect",
		],
		["not connected", () => {}, false, "not-connected"],
	])(
		"reports the canonical connection state when %s",
		async (_name, seed, configured, connectionState) => {
			seed();

			const result = await call(listGitLabProjectsProcedure, {});

			expect(result).toMatchObject({ configured, connectionState });
		},
	);
});

describe("the document editor's GitLab tool", () => {
	const PROJECT = "project-1";

	beforeEach(() => {
		state.fake.tables.project.push({
			id: PROJECT,
			organizationId: ORG,
			userId: USER,
		});
	});

	it("uses the connection in the project's organization, never one in an organization the caller names and has left", async () => {
		const before = seedWritableLegacyState(OTHER_ORG);

		await expect(
			call(executeGitLabToolProcedure, {
				projectId: PROJECT,
				organizationId: OTHER_ORG,
				methodName: "get_project",
				args: { project_id: "example-org/example-repo" },
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		// Nothing was read, classified or used in the other organization.
		expect(connectionRowsIn(OTHER_ORG)).toEqual(before);
		expect(vi.mocked(fetch)).not.toHaveBeenCalled();
	});

	it("uses the caller's connection in the project's organization", async () => {
		seedConnection(ORG);

		// No organization named: the project's is the tenant. (Naming another
		// is refused before the handler runs — the test above.)
		await call(executeGitLabToolProcedure, {
			projectId: PROJECT,
			methodName: "get_project",
			args: { project_id: "example-org/example-repo" },
		}).catch(() => undefined);

		const authorizations = vi
			.mocked(fetch)
			.mock.calls.map(([, init]) =>
				new Headers((init as RequestInit | undefined)?.headers).get(
					"authorization",
				),
			);
		expect(authorizations).toContain("Bearer wi-token");
	});
});

describe("disconnect-by-type for GitLab", () => {
	const B = "org-b";

	function seedWorkflowCredential(organizationId: string) {
		state.fake.tables.workflowIntegration.push({
			id: `gl-workflow-${organizationId}`,
			userId: USER,
			organizationId,
			provider: "GITLAB",
			name: "GitLab (workflow)",
			workflowId: "workflow-1",
			isActive: true,
			credentials: null,
			settings: {},
			createdAt: new Date("2026-01-01T00:00:00Z"),
			updatedAt: new Date("2026-01-01T00:00:00Z"),
		});
	}
	const workflowRow = (organizationId: string) =>
		state.fake.tables.workflowIntegration.find(
			(row) => row.id === `gl-workflow-${organizationId}`,
		);

	it("refuses an admin of the session's organization who is only a member of the named one, and changes nothing there", async () => {
		state.members[ORG][USER] = "admin";
		state.members[B] = { [USER]: "member" };
		seedConnection(B);
		seedWorkflowCredential(B);

		await expect(
			call(
				disconnectByTypeProcedure,
				{ type: "GITLAB", organizationId: B },
				{ org: ORG, role: "admin" },
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });

		expect(workflowRow(B)).toBeDefined();
		expect(connectionRowsIn(B)[0]?.isActive).toBe(true);
	});

	it("deletes the workflow credentials for an admin of the named organization", async () => {
		state.members[ORG][USER] = "admin";
		state.members[B] = { [USER]: "admin" };
		seedConnection(B);
		seedWorkflowCredential(B);

		await call(
			disconnectByTypeProcedure,
			{ type: "GITLAB", organizationId: B },
			{ org: ORG, role: "admin" },
		);

		expect(workflowRow(B)).toBeUndefined();
		expect(connectionRowsIn(B)[0]?.isActive).toBe(false);
	});

	it("still lets a member disconnect their own GitLab when there are no workflow credentials", async () => {
		state.members[ORG][USER] = "admin";
		state.members[B] = { [USER]: "member" };
		seedConnection(B);

		await call(
			disconnectByTypeProcedure,
			{ type: "GITLAB", organizationId: B },
			{ org: ORG, role: "admin" },
		);

		expect(connectionRowsIn(B)[0]?.isActive).toBe(false);
	});
});

describe("listing a GitLab server's tools", () => {
	it("does not serve cached tools once the person's GitLab is disconnected", async () => {
		// The server row is the person's, enabled, with tools cached from
		// when GitLab was connected; the connection itself is gone.
		state.fake.tables.mCPConfig.push({
			id: "cfg-official",
			userId: USER,
			organizationId: ORG,
			mcpServerId: "srv-gitlab-official",
			enabled: true,
			displayName: "GitLab (Official)",
			authType: "OAUTH2",
			encryptedAccessToken: null,
			encryptedRefreshToken: null,
			tokenExpiresAt: null,
			needsReauth: false,
			createdAt: new Date("2026-01-01T00:00:00Z"),
			updatedAt: new Date("2026-01-01T00:00:00Z"),
		});

		const result = await call(listToolsProcedure, {
			serverIds: ["cfg-official"],
			organizationId: ORG,
		});

		expect(result.tools).toEqual([]);
		expect(result.errors).toEqual([
			expect.objectContaining({ serverId: "cfg-official" }),
		]);
	});
});

// Other surfaces that read (and can classify) or write the person's GitLab
// connection, from the connection-service caller sweep.
describe("other GitLab connection readers and writers refuse an organization the caller has left", () => {
	it.each([
		[
			"saving a GitLab personal access token",
			() =>
				call(
					saveIntegrationProcedure,
					{
						type: "GITLAB",
						credentials: { GITLAB_ACCESS_TOKEN: "glpat-example" },
						organizationId: OTHER_ORG,
					},
					{ org: ORG, role: "admin" },
				),
		],
		[
			"linking a GitLab data connection",
			() =>
				call(
					linkFromWorkflowIntegrationProcedure,
					{
						provider: "GITLAB",
						name: "GitLab",
						organizationId: OTHER_ORG,
					},
					{ org: ORG, role: "admin" },
				),
		],
	])("%s", async (_name, run) => {
		state.members[ORG][USER] = "admin";
		const before = seedWritableLegacyState(OTHER_ORG);

		await expect(run()).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(connectionRowsIn(OTHER_ORG)).toEqual(before);
	});

	// The procedures' permission middleware checks the SESSION's
	// organization; the named one needs the same permission.
	it.each([
		[
			"saving a GitLab token as a viewer of the named organization",
			"viewer",
			() =>
				call(
					saveIntegrationProcedure,
					{
						type: "GITLAB",
						credentials: { GITLAB_ACCESS_TOKEN: "glpat-example" },
						organizationId: "org-b",
					},
					{ org: ORG, role: "admin" },
				),
		],
		[
			"linking a GitLab data connection as a member of the named organization",
			"member",
			() =>
				call(
					linkFromWorkflowIntegrationProcedure,
					{
						provider: "GITLAB",
						name: "GitLab",
						organizationId: "org-b",
					},
					{ org: ORG, role: "admin" },
				),
		],
	])("%s is refused", async (_name, roleInB, run) => {
		state.members[ORG][USER] = "admin";
		state.members["org-b"] = { [USER]: roleInB };
		const before = seedWritableLegacyState("org-b");

		await expect(run()).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(connectionRowsIn("org-b")).toEqual(before);
	});

	it("saving a GitLab token with no organization is refused, and writes no no-organization connection", async () => {
		state.members[ORG][USER] = "admin";

		await expect(
			call(
				saveIntegrationProcedure,
				{
					type: "GITLAB",
					credentials: { GITLAB_ACCESS_TOKEN: "glpat-example" },
					organizationId: null,
				},
				{ org: ORG, role: "admin" },
			),
		).rejects.toMatchObject({
			data: { errorCode: "MISSING_ORGANIZATION_CONTEXT" },
		});
		expect(connectionRowsIn(null)).toEqual([]);
	});

	it("refreshing a GitLab MCP server's connection in an organization the owner has left", async () => {
		seedConnection(OTHER_ORG);
		seedOfficialConfig(OTHER_ORG);
		const before = structuredClone(connectionRowsIn(OTHER_ORG));

		await expect(
			call(mcpOAuthProcedures.refresh, {
				configId: `official-${OTHER_ORG}`,
			}),
		).rejects.toMatchObject({
			code: "FORBIDDEN",
			message: "You are not a member of this organization",
		});
		expect(connectionRowsIn(OTHER_ORG)).toEqual(before);
	});
});

describe("REST API DELETE /mcp/configs/:id for a GitLab server", () => {
	const OFFICIAL = "official-example-org";

	function app(scopes: string[]) {
		const hono = new Hono();
		hono.use("*", async (c, next) => {
			c.set(
				"externalApiContext" as never,
				{
					keyType: "personal",
					keyId: "key-1",
					keyPrefix: "fab_test",
					userId: USER,
					organizationId: undefined,
					scopes,
				} as never,
			);
			await next();
		});
		registerMcpRoutes(hono as never);
		return hono;
	}

	const remove = (scopes: string[]) =>
		app(scopes).request(`/mcp/configs/${OFFICIAL}`, { method: "DELETE" });

	beforeEach(() => {
		seedConnection(ORG);
		seedOfficialConfig(ORG);
	});

	it("disconnects for an owner who holds MCP_DELETE", async () => {
		state.members[ORG][USER] = "admin";

		const response = await remove(["mcp:write"]);

		expect(response.status).toBe(200);
		expect(connectionRowsIn(ORG)[0]?.isActive).toBe(false);
	});

	it.each([
		["a demoted owner's mcp:write key", ["mcp:write"], "member"],
		["a wildcard key", ["*"], "viewer"],
	])(
		"refuses %s, distinguishably from a missing scope",
		async (_name, scopes, role) => {
			state.members[ORG][USER] = role;

			const response = await remove(scopes);

			expect(response.status).toBe(403);
			expect(await response.json()).toEqual({
				error: {
					message:
						"The key's owner does not have permission to delete MCP configs in this organization",
				},
			});
			expect(connectionRowsIn(ORG)[0]?.isActive).toBe(true);
		},
	);

	it("refuses a key without the scope with the scope refusal", async () => {
		state.members[ORG][USER] = "admin";

		const response = await remove(["mcp:read"]);

		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({
			error: "Missing required scope: mcp:write",
		});
		expect(connectionRowsIn(ORG)[0]?.isActive).toBe(true);
	});
});
