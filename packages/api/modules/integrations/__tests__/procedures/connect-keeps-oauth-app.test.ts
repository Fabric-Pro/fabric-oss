/**
 * Connecting must never write the user's token onto the `<PROVIDER>_OAUTH_APP`
 * row that `saveAppCredentials` stores the OAuth client id and secret in.
 *
 * Both rows are `WorkflowIntegration`s with the same provider, user and
 * organization; only `name` tells them apart. Every connect path looked up
 * "the user's existing connection" by provider, user and organization alone,
 * so for the admin who had saved the app credentials it found the app row and
 * overwrote it: `persistGitLabToken` replaced the client credentials with the
 * token (keeping the app name), and the GitHub and generic callbacks also
 * renamed the row into a connection. Either way `getOAuthCredentialsWithDb`
 * no longer found client credentials and OAuth switched off for the whole
 * organization the moment that admin connected.
 *
 * The store applies the real `where` clauses to real rows and returns the
 * first match in insertion order, with the app row seeded first (the admin
 * saved the credentials before connecting), so a selector that does not
 * exclude the app row finds it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	store,
	mockGetOrganizationMembership,
	mockGitHubExchangeCodeForToken,
	mockGetGitHubUser,
	mockExchangeCodeForTokens,
	mockGetUserInfo,
} = await vi.hoisted(async () => {
	process.env.ENCRYPTION_KEY = "test-encryption-key-for-oauth-state";
	process.env.FABRIC_GITHUB_CLIENT_ID = "gh-client-id";
	process.env.FABRIC_GITHUB_CLIENT_SECRET = "gh-client-secret";
	const { createWorkflowIntegrationStore } = await import(
		"./workflow-integration-store"
	);
	return {
		store: createWorkflowIntegrationStore(),
		mockGetOrganizationMembership: vi.fn(),
		mockGitHubExchangeCodeForToken: vi.fn(),
		mockGetGitHubUser: vi.fn(),
		mockExchangeCodeForTokens: vi.fn(),
		mockGetUserInfo: vi.fn(),
	};
});

vi.mock("@repo/database", () => {
	const tx = {
		mCPServer: { findFirst: async () => ({ id: "gitlab-server" }) },
		mCPConfig: {
			findFirst: async () => null,
			create: async () => ({ id: "mcp-config" }),
			update: async () => ({ id: "mcp-config" }),
			delete: async () => ({}),
		},
		workflowIntegration: store.delegate,
	};
	return {
		db: {
			workflowIntegration: store.delegate,
			dataConnection: { updateMany: vi.fn() },
			mCPConfig: {
				updateMany: vi.fn(),
				findMany: async () => [],
				// No MCPConfig token, so token reads fall through to the
				// WorkflowIntegration store under test.
				findFirst: async () => null,
			},
			$transaction: async <T>(cb: (client: typeof tx) => Promise<T>) =>
				cb(tx),
		},
		createDataConnection: vi.fn(),
		getDataConnectionByProvider: vi.fn().mockResolvedValue(null),
		updateDataConnection: vi.fn(),
		getOrganizationMembership: mockGetOrganizationMembership,
		getProjectMemberRole: vi.fn(),
		createProjectRepoIntegration: vi.fn(),
		logRepoIntegrationActivity: vi.fn(),
		syncLegacyProjectRepoOnConnect: vi.fn(),
	};
});

vi.mock("@repo/connectors", () => ({
	integrationStatusForRepoAccess: vi.fn(),
	resolveDefaultBranch: vi.fn(),
	verifyRepositoryAccess: vi.fn(),
}));

vi.mock("@repo/integrations", () => ({
	getGitHubToken: vi.fn(),
}));

vi.mock("@repo/integrations/gitlab", () => ({
	GITLAB_MCP_PROBE_DEFAULT_TIMEOUT_MS: 2000,
	GITLAB_TOKEN_EXCHANGE_TIMEOUT_MS: 10000,
	GitLabApiError: class extends Error {},
	GitLabReauthRequiredError: class extends Error {},
	getValidGitLabAccessToken: vi.fn(),
	gitlabFetch: vi.fn(),
	probeGitLabMcp: async () => ({
		status: "not-found",
		capable: false,
		httpStatus: 404,
	}),
}));

vi.mock("@repo/permissions", () => ({
	hasPermission: vi.fn().mockReturnValue(true),
	Permissions: {},
	resolveOrgPermissions: vi.fn().mockReturnValue([]),
	resolveProjectPermissions: vi.fn(),
}));

vi.mock("@repo/temporal", () => ({
	triggerMcpToolIngestion: vi.fn(),
	triggerOAuthServerIngestion: vi.fn().mockResolvedValue(undefined),
	triggerOAuthToolIngestion: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@repo/utils", () => ({
	encryptApiKey: (v: string) => `enc_${v}`,
	decryptApiKey: (v: string) => v.replace(/^enc_/, ""),
	hashApiKey: (v: string) => `hash_${v}`,
}));

vi.mock("../../../../lib/project-permissions", () => ({
	userHasProjectPermission: vi.fn(),
}));

vi.mock("../../../../lib/redis-client", () => ({
	getRedisClient: () => null,
}));

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

vi.mock("../../lib/sync-gitlab-official-mcp", () => ({
	syncGitlabOfficialMcpConfig: async () => ({
		ok: true,
		action: "noop",
	}),
	resetGitlabOfficialMcpBreaker: async () => ({ ok: true }),
}));

vi.mock("../../lib/github-oauth", () => ({
	exchangeCodeForToken: mockGitHubExchangeCodeForToken,
	getGitHubOAuthUrl: vi.fn(),
	getGitHubUser: mockGetGitHubUser,
	listGitHubBranches: vi.fn(),
}));

vi.mock("../../lib/oauth-providers", () => ({
	exchangeCodeForTokens: mockExchangeCodeForTokens,
	generateAuthorizationUrl: vi.fn(),
	getOAuthCredentials: vi.fn(),
	getOAuthCredentialsWithDb: async () => ({
		clientId: "client-id",
		clientSecret: "client-secret",
	}),
	getOAuthProvider: (type: string) => ({
		type,
		name: type === "SLACK" ? "Slack" : "GitLab",
		getUserInfo: mockGetUserInfo,
	}),
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

import { db } from "@repo/database";
import {
	getValidGitLabToken,
	loadGitLabToken,
	persistGitLabToken,
} from "../../lib/gitlab-token";
import { encodeOAuthState } from "../../lib/oauth-state";
import { __resetInMemoryOAuthStateStoreForTests } from "../../lib/oauth-state-store";
import { githubOAuthProcedures } from "../../procedures/github-oauth";
import { gitlabOAuthProcedures } from "../../procedures/gitlab-oauth";
import { genericOAuthProcedures } from "../../procedures/oauth";

type Handler<I, O> = {
	handler: (args: {
		input: I;
		context: {
			user: { id: string };
			session: { id: string; activeOrganizationId: string | null };
		};
	}) => Promise<O>;
};

const ADMIN = "user-admin";
const ORG = "example-org";
const REDIRECT_URI = "https://app.example.com/api/integrations/oauth/callback";

const appCredentials = () =>
	`enc_${JSON.stringify({
		client_id: "client-id",
		client_secret: "client-secret",
	})}`;

/** The admin saved the provider's OAuth app credentials before connecting. */
function seedAppRow(provider: string): string {
	store.rows.push({
		id: "app-row",
		userId: ADMIN,
		organizationId: ORG,
		provider,
		name: `${provider}_OAUTH_APP`,
		isActive: true,
		credentials: appCredentials(),
	});
	return "app-row";
}

function connectionRows(provider: string) {
	return store.rows.filter(
		(row) =>
			row.provider === provider && row.name !== `${provider}_OAUTH_APP`,
	);
}

function decrypted(credentials: string | null): Record<string, unknown> {
	return JSON.parse((credentials ?? "").replace(/^enc_/, ""));
}

const context = {
	user: { id: ADMIN },
	session: { id: "session-1", activeOrganizationId: ORG },
};

const fetchMock = vi.fn();

beforeEach(() => {
	store.reset();
	__resetInMemoryOAuthStateStoreForTests();
	fetchMock.mockReset();
	fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
	vi.stubGlobal("fetch", fetchMock);
	mockGetOrganizationMembership.mockResolvedValue({
		organization: { id: ORG },
		role: "owner",
	});
});

describe("GitLab: save app credentials, connect, disconnect", () => {
	const persist = async (accessToken: string) => {
		return persistGitLabToken(db as never, {
			userId: ADMIN,
			organizationId: ORG,
			token: {
				accessToken,
				refreshToken: `${accessToken}-refresh`,
				expiresAt: new Date(Date.now() + 7_200_000),
				scopes: ["api"],
			},
			gitlabUser: {
				id: 42,
				username: "example-user",
				name: "Example User",
				avatarUrl: null,
			},
			freshGrant: true,
		});
	};

	it("keeps the app credentials through connect, reconnect and disconnect", async () => {
		const appRowId = seedAppRow("GITLAB");

		const first = await persist("first-token");

		// The app row still configures OAuth: same name, client credentials,
		// active.
		expect(store.row(appRowId)).toMatchObject({
			name: "GITLAB_OAUTH_APP",
			isActive: true,
			credentials: appCredentials(),
		});
		// The token went to a separate connection row.
		expect(first.workflowIntegrationId).not.toBe(appRowId);
		expect(connectionRows("GITLAB")).toHaveLength(1);
		expect(store.row(first.workflowIntegrationId)).toMatchObject({
			name: "GitLab: example-user",
			isActive: true,
		});
		expect(
			decrypted(store.row(first.workflowIntegrationId).credentials),
		).toMatchObject({ access_token: "first-token" });

		// A reconnect updates that connection row, not the app row.
		const second = await persist("second-token");
		expect(second.workflowIntegrationId).toBe(first.workflowIntegrationId);
		expect(connectionRows("GITLAB")).toHaveLength(1);
		expect(
			decrypted(store.row(first.workflowIntegrationId).credentials),
		).toMatchObject({ access_token: "second-token" });
		expect(store.row(appRowId).credentials).toBe(appCredentials());

		await (
			gitlabOAuthProcedures.disconnect as unknown as Handler<
				{ organizationId: string },
				{ success: boolean }
			>
		).handler({ input: { organizationId: ORG }, context });

		expect(store.row(first.workflowIntegrationId).isActive).toBe(false);
		expect(store.row(appRowId)).toMatchObject({
			isActive: true,
			credentials: appCredentials(),
		});
	});
});

describe("GitLab reads beside the GITLAB_OAUTH_APP row", () => {
	it("loadGitLabToken never reads the app row's client credentials as a token", async () => {
		const appRowId = seedAppRow("GITLAB");

		await expect(
			loadGitLabToken(db as never, {
				userId: ADMIN,
				organizationId: ORG,
			}),
		).resolves.toBeNull();
		expect(store.row(appRowId)).toMatchObject({
			name: "GITLAB_OAUTH_APP",
			credentials: appCredentials(),
		});
	});

	it("an MCPConfig-sourced refresh keeps the identity stored on the connection row", async () => {
		const appRowId = seedAppRow("GITLAB");
		store.rows.push({
			id: "connection-row",
			userId: ADMIN,
			organizationId: ORG,
			provider: "GITLAB",
			name: "GitLab: example-user",
			isActive: true,
			credentials: `enc_${JSON.stringify({ access_token: "stale" })}`,
			settings: { gitlabUserId: 42, gitlabUsername: "example-user" },
		});
		// The token lives on MCPConfig (the primary store), so the refresh
		// reads the identity it re-persists from the WorkflowIntegration row.
		const mcpRow = {
			id: "mcp-config",
			encryptedAccessToken: "enc_stale",
			encryptedRefreshToken: "enc_rtok",
			tokenExpiresAt: new Date(Date.now() + 10_000),
			needsReauth: false,
		};
		const tx = {
			$executeRaw: async () => 1,
			mCPServer: { findFirst: async () => ({ id: "gitlab-server" }) },
			mCPConfig: {
				findFirst: async () => mcpRow,
				create: async () => ({ id: "mcp-config" }),
				update: async () => ({ id: "mcp-config" }),
				updateMany: async () => ({ count: 1 }),
				delete: async () => ({}),
			},
			workflowIntegration: store.delegate,
		};
		const refreshDb = {
			...tx,
			$transaction: async <T>(cb: (client: typeof tx) => Promise<T>) =>
				cb(tx),
		};
		fetchMock.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					access_token: "renewed",
					refresh_token: "rtok-2",
					expires_in: 7200,
					created_at: Math.floor(Date.now() / 1000),
					scope: "api read_user",
					token_type: "bearer",
				}),
				{ status: 200 },
			),
		);

		const token = await getValidGitLabToken(
			refreshDb as never,
			{ userId: ADMIN, organizationId: ORG },
			{ credentials: { clientId: "client-id", clientSecret: "secret" } },
		);

		expect(token).toBe("renewed");
		expect(store.row("connection-row").settings).toMatchObject({
			gitlabUserId: 42,
			gitlabUsername: "example-user",
		});
		expect(
			decrypted(store.row("connection-row").credentials),
		).toMatchObject({
			access_token: "renewed",
		});
		expect(store.row(appRowId)).toMatchObject({
			name: "GITLAB_OAUTH_APP",
			credentials: appCredentials(),
		});
	});
});

describe("integrations.github.callback", () => {
	it("creates a connection row beside the GITHUB_OAUTH_APP row instead of renaming it", async () => {
		const appRowId = seedAppRow("GITHUB");
		mockGitHubExchangeCodeForToken.mockResolvedValue({
			access_token: "gh-access",
			token_type: "bearer",
			scope: "repo,read:user",
		});
		mockGetGitHubUser.mockResolvedValue({
			id: 7,
			login: "octocat",
			name: "Octo",
			avatar_url: "",
		});

		const result = await (
			githubOAuthProcedures.callback as unknown as Handler<
				{ code: string; state: string },
				{ success: boolean; message: string }
			>
		).handler({
			input: {
				code: "code",
				state: encodeOAuthState({
					userId: ADMIN,
					organizationId: ORG,
					provider: "github",
					redirectUri: REDIRECT_URI,
				}),
			},
			context,
		});

		expect(result).toMatchObject({ success: true });
		expect(store.row(appRowId)).toMatchObject({
			name: "GITHUB_OAUTH_APP",
			isActive: true,
			credentials: appCredentials(),
		});
		const connections = connectionRows("GITHUB");
		expect(connections).toHaveLength(1);
		expect(connections[0]).toMatchObject({
			name: "GitHub: octocat",
			userId: ADMIN,
			organizationId: ORG,
			isActive: true,
		});
		expect(decrypted(connections[0].credentials)).toMatchObject({
			access_token: "gh-access",
		});
	});
});

describe.each([
	{ provider: "SLACK", displayName: "Slack" },
	{ provider: "GITLAB", displayName: "GitLab" },
])("integrations.oauth.callback ($provider)", ({ provider, displayName }) => {
	it(`creates a connection row beside the ${provider}_OAUTH_APP row instead of renaming it`, async () => {
		const appRowId = seedAppRow(provider);
		mockExchangeCodeForTokens.mockResolvedValue({
			access_token: "generic-access",
			token_type: "bearer",
			scope: "read",
		});
		mockGetUserInfo.mockResolvedValue({
			id: "U1",
			login: "example",
			name: "Example",
			email: null,
			avatarUrl: null,
		});

		const result = await (
			genericOAuthProcedures.callback as unknown as Handler<
				{ code: string; state: string },
				{ success: boolean; message: string }
			>
		).handler({
			input: {
				code: "code",
				state: encodeOAuthState({
					userId: ADMIN,
					organizationId: ORG,
					provider,
					redirectUri: REDIRECT_URI,
				}),
			},
			context,
		});

		expect(result).toMatchObject({ success: true });
		expect(store.row(appRowId)).toMatchObject({
			name: `${provider}_OAUTH_APP`,
			isActive: true,
			credentials: appCredentials(),
		});
		const connections = connectionRows(provider);
		expect(connections).toHaveLength(1);
		expect(connections[0]).toMatchObject({
			name: `${displayName}: example`,
			isActive: true,
		});
		expect(decrypted(connections[0].credentials)).toMatchObject({
			access_token: "generic-access",
		});
	});
});
