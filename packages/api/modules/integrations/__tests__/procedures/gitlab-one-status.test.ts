/**
 * One GitLab status everywhere: for the same (user, organization), every
 * server surface that reports a person's GitLab connection gives the same
 * answer — connected, needs reconnect, or not connected — and a project
 * repository link alone never makes the person connected.
 *
 * The surfaces are the real procedures; the GitLab connection service and its
 * classification are real; the database is the GitLab fake that applies `where`
 * clauses. The PM picker's query cannot import the connection service, so
 * its procedure hands it the status: the test checks that hand-off, and the
 * query's own tests (`packages/database/__tests__/available-pm-tools.test.ts`)
 * check what it does with it. The MCP tile's status route is covered in
 * `apps/web/app/api/mcp/oauth/status/[configId]/__tests__/route.test.ts`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	createGitLabFakeDb,
	encryptedCredential,
} from "../../../../../integrations/__tests__/gitlab/helpers/gitlab-fake-db";

const state = vi.hoisted(() => ({
	fake: null as unknown as ReturnType<
		typeof import("../../../../../integrations/__tests__/gitlab/helpers/gitlab-fake-db").createGitLabFakeDb
	>,
	listAvailablePmTools: null as unknown as ReturnType<typeof vi.fn>,
}));

vi.mock("@repo/database", async () => {
	const { vi: vitest } = await import("vitest");
	const keys = await import(
		"../../../../../database/prisma/queries/lib/gitlab-personal-keys"
	);
	state.listAvailablePmTools = vitest.fn(async () => []);
	const appRowNames = ["GITLAB_OAUTH_APP"];
	const listRows = (where: Record<string, unknown>) =>
		state.fake.db.workflowIntegration.findMany({
			where: {
				...where,
				isActive: true,
				NOT: { name: { in: appRowNames } },
			},
		});
	return {
		get db() {
			return state.fake.db;
		},
		...keys,
		createDataConnection: vitest.fn(),
		getDataConnectionByProvider: vitest.fn(),
		updateDataConnection: vitest.fn(),
		getOrganizationMembership: vitest.fn(),
		getProjectMemberRole: vitest.fn(),
		createProjectRepoIntegration: vitest.fn(),
		logRepoIntegrationActivity: vitest.fn(),
		syncLegacyProjectRepoOnConnect: vitest.fn(),
		listWorkflowIntegrations: (options: {
			userId: string;
			organizationId?: string;
			provider?: string;
		}) =>
			listRows({
				userId: options.userId,
				organizationId: options.organizationId ?? null,
				...(options.provider ? { provider: options.provider } : {}),
			}),
		// GitLab is personal-only, so the tenant-wide list sees only the
		// caller's own GitLab rows — the same rows as the owner-scoped list.
		listWorkflowIntegrationsInTenant: (options: {
			userId: string;
			organizationId?: string;
			provider?: string;
		}) =>
			listRows({
				userId: options.userId,
				organizationId: options.organizationId ?? null,
				...(options.provider ? { provider: options.provider } : {}),
			}),
		get listAvailablePmTools() {
			return state.listAvailablePmTools;
		},
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

import { resetGitLabConnectionDepsForTests } from "@repo/integrations/gitlab";
import { listAvailablePmToolsProcedure } from "../../../mcp/procedures/available-pm-tools";
import { listIntegrationStatusProcedure } from "../../../workflows/procedures/integrations/list-integration-status";
import { listIntegrationsProcedure } from "../../../workflows/procedures/integrations/list-integrations";
import { gitlabOAuthProcedures } from "../../procedures/gitlab-oauth";
import { genericOAuthProcedures } from "../../procedures/oauth";

type State = "connected" | "needs-reconnect" | "not-connected";
type AnyHandler = {
	handler: (args: {
		input: Record<string, unknown>;
		context: Record<string, unknown>;
	}) => Promise<any>;
};
const run = (procedure: unknown, input: Record<string, unknown>) =>
	(procedure as AnyHandler).handler({
		input,
		context: {
			user: { id: USER, email: "dev@example.com", name: "Dev" },
			session: { id: "session-1", activeOrganizationId: ORG },
		},
	});

const USER = "user-1";
const ORG = "example-org";

const appIssuer = {
	kind: "app",
	clientId: "gl-client-id",
	origin: "https://gitlab.com",
};

function connectionRow(overrides: Record<string, unknown> = {}) {
	return {
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
			issuer: appIssuer,
			connectionGeneration: 1,
		}),
		settings: {
			gitlabUsername: "example-user",
			gitlabName: "Example User",
		},
		createdAt: new Date("2026-01-01T00:00:00Z"),
		updatedAt: new Date("2026-01-01T00:00:00Z"),
		...overrides,
	};
}

/** The `gitlab-official` row a disconnect keeps: enabled, registration, no token. */
function officialTransportRow() {
	return {
		id: "cfg-official",
		userId: USER,
		organizationId: ORG,
		mcpServerId: "srv-gitlab-official",
		enabled: true,
		authType: "OAUTH2",
		baseUrl: null,
		oauthClientId: "dcr-client-id",
		encryptedOauthClientSecret: null,
		dcrClientMetadata: { token_endpoint_auth_method: "none" },
		encryptedAccessToken: null,
		encryptedRefreshToken: null,
		accessTokenHash: null,
		tokenExpiresAt: null,
		needsReauth: true,
		createdAt: new Date("2026-01-01T00:00:00Z"),
		updatedAt: new Date("2026-01-02T00:00:00Z"),
	};
}

const FIXTURES: Array<{
	name: string;
	expected: State;
	seed: () => void;
}> = [
	{
		name: "connected",
		expected: "connected",
		seed: () => {
			state.fake.tables.workflowIntegration.push(connectionRow());
		},
	},
	{
		name: "needs reconnect (active row, dead grant, enabled MCP transport row)",
		expected: "needs-reconnect",
		seed: () => {
			state.fake.tables.workflowIntegration.push(
				connectionRow({
					settings: {
						gitlabUsername: "example-user",
						needsReauth: true,
						reauthReason: "invalid_grant",
					},
				}),
			);
			state.fake.tables.mCPConfig.push(officialTransportRow());
		},
	},
	{
		name: "disconnected (tombstone, enabled MCP transport row kept)",
		expected: "not-connected",
		seed: () => {
			state.fake.tables.workflowIntegration.push(
				connectionRow({
					isActive: false,
					credentials: encryptedCredential({
						connectionGeneration: 2,
						disconnectedAt: "2026-02-01T00:00:00.000Z",
					}),
					settings: { connectionState: "disconnected" },
				}),
			);
			state.fake.tables.mCPConfig.push(officialTransportRow());
		},
	},
	{
		name: "repository link only",
		expected: "not-connected",
		seed: () => {
			state.fake.tables.project.push({
				id: "project-1",
				organizationId: ORG,
			});
			state.fake.tables.projectRepositoryIntegration.push({
				id: "pri-1",
				projectId: "project-1",
				provider: "GITLAB",
				encryptedAccessToken: "enc:repo-token",
				encryptedRefreshToken: "enc:repo-refresh",
			});
		},
	},
];

function fromListRow(
	rows: Array<{
		provider: string;
		hasCredentials: boolean;
		connectionState?: State;
	}>,
): State {
	const row = rows.find((each) => each.provider === "GITLAB");
	if (!row) {
		return "not-connected";
	}
	return (
		row.connectionState ??
		(row.hasCredentials ? "connected" : "not-connected")
	);
}

/** Every surface's answer, normalized to the three states. */
async function everySurface(): Promise<Record<string, State>> {
	const gitlabStatus = await run(gitlabOAuthProcedures.status, {
		organizationId: ORG,
	});
	const connectionState = await run(gitlabOAuthProcedures.connectionState, {
		organizationId: ORG,
	});
	const oauthStatus = await run(genericOAuthProcedures.status, {
		provider: "GITLAB",
		organizationId: ORG,
	});
	const list = await run(listIntegrationsProcedure, {
		organizationId: ORG,
		provider: "GITLAB",
	});
	const listAll = await run(listIntegrationsProcedure, {
		organizationId: ORG,
	});
	const listStatus = await run(listIntegrationStatusProcedure, {
		organizationId: ORG,
	});
	state.listAvailablePmTools.mockClear();
	await run(listAvailablePmToolsProcedure, { organizationId: ORG });
	const pickerGitLab = state.listAvailablePmTools.mock.calls[0]?.[0]?.gitlab;

	return {
		"integrations.gitlab.status":
			gitlabStatus.state ??
			(gitlabStatus.connected
				? gitlabStatus.needsReauth
					? "needs-reconnect"
					: "connected"
				: "not-connected"),
		"integrations.gitlab.connectionState":
			connectionState.hasWorkflowIntegration
				? connectionState.needsReauth
					? "needs-reconnect"
					: "connected"
				: "not-connected",
		"integrations.oauth.status":
			oauthStatus.connectionState ??
			(oauthStatus.connected ? "connected" : "not-connected"),
		"workflows.integrations.list (GITLAB)": fromListRow(list.integrations),
		"workflows.integrations.list (all)": fromListRow(listAll.integrations),
		"workflows.integrations.listStatus": fromListRow(
			listStatus.integrations,
		),
		"mcp.availablePmTools (status handed to the query)":
			pickerGitLab?.state ?? "missing",
	};
}

beforeEach(() => {
	state.fake = createGitLabFakeDb({
		mCPServer: [
			{
				id: "srv-gitlab-official",
				key: "gitlab-official",
				defaultUrl: "https://gitlab.com/api/v4/mcp",
			},
		],
	});
	resetGitLabConnectionDepsForTests();
	vi.stubEnv("GITLAB_CLIENT_ID", "gl-client-id");
	vi.stubEnv("GITLAB_CLIENT_SECRET", "gl-client-secret");
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("one GitLab status on every surface", () => {
	it.each(FIXTURES)(
		"every surface reports $expected for: $name",
		async ({ seed, expected }) => {
			seed();
			const answers = await everySurface();
			for (const [surface, answer] of Object.entries(answers)) {
				expect({ surface, answer }).toEqual({
					surface,
					answer: expected,
				});
			}
		},
	);

	it("a needs-reconnect connection is not reported as connected by the generic OAuth status", async () => {
		FIXTURES[1].seed();
		const result = await run(genericOAuthProcedures.status, {
			provider: "GITLAB",
			organizationId: ORG,
		});
		expect(result.connected).toBe(false);
	});

	it("the account and instance come from the connection", async () => {
		FIXTURES[0].seed();
		const result = await run(gitlabOAuthProcedures.status, {
			organizationId: ORG,
		});
		expect(result).toMatchObject({
			connected: true,
			state: "connected",
			origin: "https://gitlab.com",
			username: "example-user",
			name: "Example User",
		});
	});

	it("the picker's personal-scope hint is read without writing to the personal scope", async () => {
		await run(listAvailablePmToolsProcedure, { organizationId: ORG });
		const gitlab = state.listAvailablePmTools.mock.calls[0]?.[0]?.gitlab;
		expect(gitlab).toEqual({
			state: "not-connected",
			personalScopeConnected: false,
		});
		// No row was created for the personal scope (inspect never writes).
		expect(
			state.fake.tables.workflowIntegration.filter(
				(row) => row.organizationId === null,
			),
		).toEqual([]);
	});
});
