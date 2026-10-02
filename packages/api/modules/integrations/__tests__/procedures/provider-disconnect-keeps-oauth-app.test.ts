/**
 * `integrations.gitlab.disconnect`, `integrations.github.disconnect` and
 * `integrations.oauth.disconnect` must deactivate only the user's CONNECTION
 * rows, never the `<PROVIDER>_OAUTH_APP` row that `saveAppCredentials` stores
 * beside them.
 *
 * Both rows are `WorkflowIntegration`s with the same provider, user and
 * organization; only `name` tells them apart. The app row holds the OAuth
 * client id and secret that `getOAuthCredentialsWithDb` reads (active rows
 * only) to decide whether OAuth is configured at all. The provider-specific
 * disconnect handlers filtered on provider alone, so disconnecting as the
 * admin who saved the app credentials switched OAuth off for the whole
 * organization and left only the personal-access-token form.
 *
 * The store applies the handlers' `where` clauses to real rows, so the
 * assertions are about which rows end up active and which tokens are revoked,
 * not about the clause text.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { store, mockRevokeAccessToken } = await vi.hoisted(async () => {
	process.env.FABRIC_GITHUB_CLIENT_ID = "gh-client-id";
	process.env.FABRIC_GITHUB_CLIENT_SECRET = "gh-client-secret";
	const { createWorkflowIntegrationStore } = await import(
		"./workflow-integration-store"
	);
	return {
		store: createWorkflowIntegrationStore(),
		mockRevokeAccessToken: vi.fn(),
	};
});

vi.mock("@repo/database", () => ({
	db: {
		workflowIntegration: store.delegate,
		dataConnection: { updateMany: vi.fn() },
		mCPConfig: { updateMany: vi.fn() },
	},
	createDataConnection: vi.fn(),
	getDataConnectionByProvider: vi.fn(),
	updateDataConnection: vi.fn(),
	getOrganizationMembership: vi.fn(),
	getProjectMemberRole: vi.fn(),
	createProjectRepoIntegration: vi.fn(),
	logRepoIntegrationActivity: vi.fn(),
	syncLegacyProjectRepoOnConnect: vi.fn(),
}));

vi.mock("@repo/connectors", () => ({
	integrationStatusForRepoAccess: vi.fn(),
	resolveDefaultBranch: vi.fn(),
	verifyRepositoryAccess: vi.fn(),
}));

vi.mock("@repo/integrations", () => ({
	getGitHubToken: vi.fn(),
}));

vi.mock("@repo/integrations/gitlab", () => ({
	GitLabApiError: class extends Error {},
	getValidGitLabAccessToken: vi.fn(),
	gitlabFetch: vi.fn(),
}));

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

vi.mock("@repo/utils", () => ({
	encryptApiKey: (v: string) => `enc_${v}`,
	decryptApiKey: (v: string) => {
		if (!v.startsWith("enc_")) {
			throw new Error("unsupported state or unable to authenticate data");
		}
		return v.slice("enc_".length);
	},
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

vi.mock("../../lib/gitlab-token", () => ({
	GitLabReauthRequiredError: class extends Error {},
	loadGitLabToken: vi.fn(),
	persistGitLabToken: vi.fn(),
	markNeedsReauth: vi.fn(),
}));

vi.mock("../../lib/github-oauth", () => ({
	exchangeCodeForToken: vi.fn(),
	getGitHubOAuthUrl: vi.fn(),
	getGitHubUser: vi.fn(),
	listGitHubBranches: vi.fn(),
}));

vi.mock("../../lib/oauth-providers", () => ({
	exchangeCodeForTokens: vi.fn(),
	generateAuthorizationUrl: vi.fn(),
	getOAuthCredentials: vi.fn(),
	getOAuthCredentialsWithDb: async () => ({
		clientId: "gl-client-id",
		clientSecret: "gl-client-secret",
	}),
	getOAuthProvider: (type: string) => ({
		type,
		name: type,
		revokeAccessToken: mockRevokeAccessToken,
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

import { githubOAuthProcedures } from "../../procedures/github-oauth";
import { gitlabOAuthProcedures } from "../../procedures/gitlab-oauth";
import { genericOAuthProcedures } from "../../procedures/oauth";

type DisconnectHandler = {
	handler: (args: {
		input: { organizationId?: string | null; provider?: string };
		context: {
			user: { id: string };
			session: { id: string; activeOrganizationId: string | null };
		};
	}) => Promise<{ success: boolean }>;
};

const ADMIN = "user-admin";

const appCredentials = () =>
	`enc_${JSON.stringify({
		client_id: "client-id",
		client_secret: "client-secret",
	})}`;

const tokenCredentials = (accessToken: string) =>
	`enc_${JSON.stringify({ access_token: accessToken })}`;

function seed(
	provider: string,
	organizationId: string | null,
): { appRowId: string; connectionRowId: string } {
	store.rows.push(
		{
			id: "app-row",
			userId: ADMIN,
			organizationId,
			provider,
			name: `${provider}_OAUTH_APP`,
			isActive: true,
			credentials: appCredentials(),
		},
		{
			id: "connection-row",
			userId: ADMIN,
			organizationId,
			provider,
			name: `${provider} (example-user)`,
			isActive: true,
			credentials: tokenCredentials("connection-token"),
		},
	);
	return { appRowId: "app-row", connectionRowId: "connection-row" };
}

const fetchMock = vi.fn();

/** Every token a handler asked the provider to revoke. */
function revokedTokens(): string[] {
	const fromFetch = fetchMock.mock.calls.map(([, init]) => {
		const body = String((init as RequestInit).body);
		// GitLab posts a form body, GitHub a JSON one.
		return body.startsWith("{")
			? (JSON.parse(body) as { access_token: string }).access_token
			: (new URLSearchParams(body).get("token") ?? "");
	});
	const fromProvider = mockRevokeAccessToken.mock.calls.map(
		([token]) => token as string,
	);
	return [...fromFetch, ...fromProvider];
}

beforeEach(() => {
	store.reset();
	fetchMock.mockReset();
	fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
	vi.stubGlobal("fetch", fetchMock);
	mockRevokeAccessToken.mockReset();
	mockRevokeAccessToken.mockResolvedValue(undefined);
});

describe.each([
	{
		label: "integrations.gitlab.disconnect",
		provider: "GITLAB",
		disconnect: gitlabOAuthProcedures.disconnect,
	},
	{
		label: "integrations.github.disconnect",
		provider: "GITHUB",
		disconnect: githubOAuthProcedures.disconnect,
	},
	{
		label: "integrations.oauth.disconnect",
		provider: "GITLAB",
		disconnect: genericOAuthProcedures.disconnect,
	},
])(
	"$label keeps the stored OAuth app credentials",
	({ provider, disconnect }) => {
		const run = (organizationId: string | null) =>
			(disconnect as unknown as DisconnectHandler).handler({
				input: { organizationId, provider },
				context: {
					user: { id: ADMIN },
					session: {
						id: "session-1",
						activeOrganizationId: organizationId,
					},
				},
			});

		it.each([
			{ scope: "organization", organizationId: "example-org" },
			{ scope: "personal", organizationId: null },
		])(
			"deactivates the connection but not the app row ($scope)",
			async ({ organizationId }) => {
				const { appRowId, connectionRowId } = seed(
					provider,
					organizationId,
				);

				await expect(run(organizationId)).resolves.toMatchObject({
					success: true,
				});

				expect(store.row(connectionRowId).isActive).toBe(false);
				expect(store.row(appRowId).isActive).toBe(true);
				expect(store.row(appRowId).credentials).toBe(appCredentials());
			},
		);

		it("revokes only the connection token, never anything from the app row", async () => {
			seed(provider, "example-org");

			await run("example-org");

			expect(revokedTokens()).toEqual(["connection-token"]);
		});
	},
);

describe("integrations.oauth.disconnect with several connection rows", () => {
	it("revokes and deactivates every connection row and keeps the app row", async () => {
		const { appRowId, connectionRowId } = seed("GITLAB", "example-org");
		store.rows.push({
			id: "second-connection-row",
			userId: ADMIN,
			organizationId: "example-org",
			provider: "GITLAB",
			name: "GITLAB (second-account)",
			isActive: true,
			credentials: tokenCredentials("second-token"),
		});

		await (
			genericOAuthProcedures.disconnect as unknown as DisconnectHandler
		).handler({
			input: { organizationId: "example-org", provider: "GITLAB" },
			context: {
				user: { id: ADMIN },
				session: {
					id: "session-1",
					activeOrganizationId: "example-org",
				},
			},
		});

		expect(revokedTokens().sort()).toEqual([
			"connection-token",
			"second-token",
		]);
		expect(store.row(connectionRowId).isActive).toBe(false);
		expect(store.row("second-connection-row").isActive).toBe(false);
		expect(store.row(appRowId)).toMatchObject({
			isActive: true,
			credentials: appCredentials(),
		});
	});
});
