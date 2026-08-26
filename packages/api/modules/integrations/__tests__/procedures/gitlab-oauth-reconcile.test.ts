/**
 * Procedure-level tests for `integrations.gitlab.reconcile`.
 *
 * Reconcile validates a stored GitLab token and backfills the missing token
 * store. Its failure path used to condemn the credential on ANY error — a
 * GitLab outage, a probe hiccup or a failed database write all returned
 * NEEDS_REAUTH and called `markNeedsReauth`. That flag is a circuit breaker
 * (a flagged MCPConfig is refused at client creation and filtered out of tool
 * discovery, and only a fresh OAuth grant clears it), so a false positive
 * hard-blocks a working integration.
 *
 * Reconcile now never writes that flag at all. A 401/403 on `/user` still
 * returns NEEDS_REAUTH, but only as an ADVISORY prompt to reconnect: a probe
 * 401 shows the ACCESS token is unusable right now — usually just expired —
 * while the refresh token behind it may be perfectly good, and a 403 may be
 * scope or an administrator restriction. Everything else surfaces as an error.
 *
 * The breaker also runs in the other direction: a credential that is ALREADY
 * condemned must not be reconciled back to life. Only a fresh OAuth grant
 * clears the flag, so reconcile — which reuses the existing token — declines
 * up front rather than probing and re-persisting, and hands
 * `persistGitLabToken` no reset authority even on the paths that do write.
 * The last describe below pins the other end of that contract: the OAuth
 * callback, the one caller that DOES hold a new grant, still clears it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockGitlabFetch,
	mockLoadGitLabToken,
	mockPersistGitLabToken,
	mockMarkNeedsReauth,
	mockWorkflowIntegrationFindFirst,
	mockMcpConfigFindFirst,
	mockMcpConfigFindMany,
	mockDataConnectionUpdateMany,
	mockDecodeOAuthState,
	mockExchangeCodeForToken,
	mockGetGitLabUser,
	mockGetOAuthProvider,
	mockGetOAuthCredentialsWithDb,
} = vi.hoisted(() => ({
	mockGitlabFetch: vi.fn(),
	mockLoadGitLabToken: vi.fn(),
	mockPersistGitLabToken: vi.fn(),
	mockMarkNeedsReauth: vi.fn(),
	mockWorkflowIntegrationFindFirst: vi.fn(),
	mockMcpConfigFindFirst: vi.fn(),
	mockMcpConfigFindMany: vi.fn(),
	mockDataConnectionUpdateMany: vi.fn(),
	mockDecodeOAuthState: vi.fn(),
	mockExchangeCodeForToken: vi.fn(),
	mockGetGitLabUser: vi.fn(),
	mockGetOAuthProvider: vi.fn(),
	mockGetOAuthCredentialsWithDb: vi.fn(),
}));

vi.mock("@repo/integrations/gitlab", async () => {
	// Pull `GitLabApiError` from the real leaf module so the SUT's
	// `instanceof` check matches the errors these tests throw.
	const { fileURLToPath } = await import("node:url");
	const path = await import("node:path");
	const here = path.dirname(fileURLToPath(import.meta.url));
	const restClientPath = path.resolve(
		here,
		"../../../../../integrations/src/gitlab/rest-client.ts",
	);
	const { GitLabApiError } =
		await vi.importActual<typeof import("@repo/integrations/gitlab")>(
			restClientPath,
		);
	return {
		GitLabApiError,
		getValidGitLabAccessToken: vi.fn(),
		gitlabFetch: mockGitlabFetch,
	};
});

vi.mock("../../lib/gitlab-token", async () => {
	const { fileURLToPath } = await import("node:url");
	const path = await import("node:path");
	const here = path.dirname(fileURLToPath(import.meta.url));
	const oauthRefreshPath = path.resolve(
		here,
		"../../../../../integrations/src/gitlab/oauth-refresh.ts",
	);
	const { GitLabReauthRequiredError } =
		await vi.importActual<typeof import("@repo/integrations/gitlab")>(
			oauthRefreshPath,
		);
	return {
		GitLabReauthRequiredError,
		loadGitLabToken: mockLoadGitLabToken,
		persistGitLabToken: mockPersistGitLabToken,
		markNeedsReauth: mockMarkNeedsReauth,
	};
});

vi.mock("../../lib/gitlab-recheck", () => ({
	recheckGitlabCapabilities: vi.fn(),
	GitLabIntegrationNotConnectedError: class extends Error {},
}));

// Stub heavy barrel imports so the procedure file loads without real DB /
// Temporal / permissions wiring. Reconcile reads only the finders; the
// callback describe additionally reaches `mCPConfig.findMany` (tool ingestion)
// and `dataConnection.updateMany` (auto-heal).
vi.mock("@repo/database", () => ({
	db: {
		workflowIntegration: { findFirst: mockWorkflowIntegrationFindFirst },
		mCPConfig: {
			findFirst: mockMcpConfigFindFirst,
			findMany: mockMcpConfigFindMany,
		},
		dataConnection: { updateMany: mockDataConnectionUpdateMany },
	},
	getProjectMemberRole: vi.fn(),
	logRepoIntegrationActivity: vi.fn(),
	syncLegacyProjectRepoOnConnect: vi.fn(),
}));

vi.mock("@repo/permissions", () => ({
	hasPermission: vi.fn(),
	Permissions: {},
	resolveProjectPermissions: vi.fn(),
}));

vi.mock("@repo/temporal", () => ({
	triggerMcpToolIngestion: vi.fn(),
}));

vi.mock("@repo/utils", () => ({
	encryptApiKey: (v: string) => `enc_${v}`,
}));

vi.mock("../../lib/gitlab-oauth", () => ({
	exchangeCodeForToken: mockExchangeCodeForToken,
	generatePkce: vi.fn(),
	getGitLabOAuthUrl: vi.fn(),
	getGitLabUser: mockGetGitLabUser,
	listGitLabBranches: vi.fn(),
	listGitLabProjects: vi.fn(),
	recordToolIngestError: vi.fn(),
	refreshGitLabToken: vi.fn(),
	resolveOrgIdForQuery: () => null,
}));

vi.mock("../../lib/enable-gitlab-pm-for-project", () => ({
	enableGitLabPMForProject: vi.fn(),
}));

vi.mock("../../lib/oauth-providers", () => ({
	getOAuthCredentialsWithDb: mockGetOAuthCredentialsWithDb,
	getOAuthProvider: mockGetOAuthProvider,
}));

vi.mock("../../lib/oauth-state", () => ({
	decodeOAuthState: mockDecodeOAuthState,
	encodeOAuthState: vi.fn(),
}));

vi.mock("../../../../orpc/procedures", () => {
	const chain = {
		route: () => chain,
		input: () => chain,
		output: () => chain,
		use: () => chain,
		handler: (fn: unknown) => ({ handler: fn }),
	};
	return {
		tenantProtectedProcedure: chain,
		publicProcedure: chain,
		requirePermission: () => (handler: unknown) => handler,
		requireInputOrgPermission: () => (handler: unknown) => handler,
		Permissions: { INTEGRATION_USE: "integration:use" },
	};
});

import { gitlabOAuthProcedures } from "../../procedures/gitlab-oauth";

const baseCtx = {
	user: { id: "user-1" },
	session: { id: "session-1", activeOrganizationId: null },
};

const GITLAB_USER = {
	id: 7,
	username: "example-user",
	name: "Example User",
	avatar_url: "https://gitlab.example.com/avatar.png",
};

function getReconcileHandler() {
	return (
		gitlabOAuthProcedures.reconcile as unknown as {
			handler: (args: {
				input: { organizationId?: string | null };
				context: typeof baseCtx;
			}) => Promise<{ status: string }>;
		}
	).handler;
}

function runReconcile() {
	return getReconcileHandler()({
		input: { organizationId: null },
		context: baseCtx,
	});
}

/**
 * Reconcile makes two `mCPConfig.findFirst` reads — the presence check on the
 * primary `gitlab` row and the breaker check on `gitlab-official` — so the
 * double keys off the server key. Defaults: no primary row (the case reconcile
 * exists for) and a healthy official row.
 */
function mockMcpConfigRows(rows: {
	gitlab?: { id: string } | null;
	official?: { needsReauth: boolean } | null;
}) {
	mockMcpConfigFindFirst.mockImplementation(
		async (args: { where?: { mcpServer?: { key?: string } } }) =>
			args?.where?.mcpServer?.key === "gitlab-official"
				? (rows.official ?? { needsReauth: false })
				: (rows.gitlab ?? null),
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	mockLoadGitLabToken.mockResolvedValue({
		accessToken: "tok",
		refreshToken: "ref",
		expiresAt: null,
	});
	// One store present, the other missing — the case reconcile exists for.
	mockWorkflowIntegrationFindFirst.mockResolvedValue({ id: "wi-1" });
	mockMcpConfigRows({});
});

describe("integrations.gitlab.reconcile — never writes the breaker", () => {
	it("backfills the missing store when GitLab accepts the token", async () => {
		mockGitlabFetch.mockResolvedValue(GITLAB_USER);

		await expect(runReconcile()).resolves.toEqual({
			status: "RECONCILED",
		});
		expect(mockGitlabFetch).toHaveBeenCalledWith("tok", "/user");
		expect(mockPersistGitLabToken).toHaveBeenCalledOnce();
		expect(mockPersistGitLabToken.mock.calls[0]![1]).toMatchObject({
			gitlabUser: {
				id: 7,
				username: "example-user",
				name: "Example User",
			},
		});
		expect(mockMarkNeedsReauth).not.toHaveBeenCalled();
	});

	it("prompts a reconnect on a 401 WITHOUT condemning the credential", async () => {
		// A `/user` 401 only proves the access token is unusable right now.
		// The refresh token may be fine, so the advisory status goes out but
		// the enforced breaker stays unwritten — otherwise a routinely expired
		// access token would hard-block an integration a refresh would heal.
		const { GitLabApiError } = await import("@repo/integrations/gitlab");
		mockGitlabFetch.mockRejectedValue(
			new GitLabApiError(401, "401 Unauthorized"),
		);

		await expect(runReconcile()).resolves.toEqual({
			status: "NEEDS_REAUTH",
		});
		expect(mockMarkNeedsReauth).not.toHaveBeenCalled();
		expect(mockPersistGitLabToken).not.toHaveBeenCalled();
	});

	it("prompts a reconnect on a 403 WITHOUT condemning the credential", async () => {
		// 403 may be scope, user/instance policy or an administrator
		// restriction — none of which say the stored grant is dead.
		const { GitLabApiError } = await import("@repo/integrations/gitlab");
		mockGitlabFetch.mockRejectedValue(
			new GitLabApiError(403, "403 Forbidden"),
		);

		await expect(runReconcile()).resolves.toEqual({
			status: "NEEDS_REAUTH",
		});
		expect(mockMarkNeedsReauth).not.toHaveBeenCalled();
		expect(mockPersistGitLabToken).not.toHaveBeenCalled();
	});

	it("prompts a reconnect on GitLabReauthRequiredError without writing the breaker", async () => {
		// `gitlabFetch` does no refresh and only throws `GitLabApiError`, so
		// this cannot arrive in production today; the handler still maps the
		// typed error to the prompt rather than a 500 in case a refreshing
		// probe is wired in later. Either way reconcile writes nothing —
		// persisting the flag is the refresh path's job, at the point it has
		// an `invalid_grant` in hand.
		const { GitLabReauthRequiredError } = await import(
			"../../lib/gitlab-token"
		);
		mockGitlabFetch.mockRejectedValue(new GitLabReauthRequiredError());

		await expect(runReconcile()).resolves.toEqual({
			status: "NEEDS_REAUTH",
		});
		expect(mockMarkNeedsReauth).not.toHaveBeenCalled();
		expect(mockPersistGitLabToken).not.toHaveBeenCalled();
	});

	it("does NOT condemn on a 5xx from GitLab — the error surfaces instead", async () => {
		const { GitLabApiError } = await import("@repo/integrations/gitlab");
		const outage = new GitLabApiError(503, "503 Service Unavailable");
		mockGitlabFetch.mockRejectedValue(outage);

		await expect(runReconcile()).rejects.toBe(outage);
		expect(mockMarkNeedsReauth).not.toHaveBeenCalled();
		expect(mockPersistGitLabToken).not.toHaveBeenCalled();
	});

	it("does NOT condemn on a 429 from GitLab", async () => {
		const { GitLabApiError } = await import("@repo/integrations/gitlab");
		const throttled = new GitLabApiError(429, "Too many requests");
		mockGitlabFetch.mockRejectedValue(throttled);

		await expect(runReconcile()).rejects.toBe(throttled);
		expect(mockMarkNeedsReauth).not.toHaveBeenCalled();
	});

	it("does NOT condemn on a network error (untyped rejection)", async () => {
		const network = new TypeError("fetch failed");
		mockGitlabFetch.mockRejectedValue(network);

		await expect(runReconcile()).rejects.toBe(network);
		expect(mockMarkNeedsReauth).not.toHaveBeenCalled();
	});

	it("does NOT condemn when the write fails after the token validated", async () => {
		mockGitlabFetch.mockResolvedValue(GITLAB_USER);
		const dbDown = new Error("could not connect to the database");
		mockPersistGitLabToken.mockRejectedValueOnce(dbDown);

		await expect(runReconcile()).rejects.toBe(dbDown);
		expect(mockMarkNeedsReauth).not.toHaveBeenCalled();
	});

	it("short-circuits without probing when both stores already exist", async () => {
		mockMcpConfigRows({ gitlab: { id: "mcp-1" } });

		await expect(runReconcile()).resolves.toEqual({
			status: "ALREADY_BOTH",
		});
		expect(mockGitlabFetch).not.toHaveBeenCalled();
		expect(mockMarkNeedsReauth).not.toHaveBeenCalled();
	});

	it("declines an already-condemned credential without probing or persisting", async () => {
		// The ACCESS token may still work even after the REFRESH token died,
		// so the `/user` probe would pass and `persistGitLabToken` would clear
		// needsReauth, refreshFailureCount and the UNAVAILABLE status —
		// resurrecting a config whose grant is dead and restarting the failure
		// cycle without the user ever completing a fresh OAuth grant.
		mockLoadGitLabToken.mockResolvedValue({
			accessToken: "tok",
			refreshToken: "dead-ref",
			expiresAt: null,
			needsReauth: true,
		});

		await expect(runReconcile()).resolves.toEqual({
			status: "NEEDS_REAUTH",
		});
		expect(mockGitlabFetch).not.toHaveBeenCalled();
		expect(mockPersistGitLabToken).not.toHaveBeenCalled();
	});

	it("declines a condemned credential even when both stores already exist", async () => {
		// Ordering guard: the condemned check must run BEFORE the
		// ALREADY_BOTH short-circuit, or a condemned-but-complete pair
		// reports a healthy no-op and the UI never offers the Connect flow.
		mockLoadGitLabToken.mockResolvedValue({
			accessToken: "tok",
			refreshToken: "dead-ref",
			expiresAt: null,
			needsReauth: true,
		});
		mockMcpConfigRows({ gitlab: { id: "mcp-1" } });

		await expect(runReconcile()).resolves.toEqual({
			status: "NEEDS_REAUTH",
		});
		expect(mockGitlabFetch).not.toHaveBeenCalled();
		expect(mockPersistGitLabToken).not.toHaveBeenCalled();
	});

	it("declines when only the gitlab-official row is condemned", async () => {
		// `loadGitLabToken` reads the primary `gitlab` row (falling back to
		// WorkflowIntegration) and never looks at `gitlab-official` — but that
		// is the row the PM adapter and the Temporal resolver condemn, and
		// reconcile runs precisely when the two have diverged. Without the
		// second read the guard passes on a healthy primary, the `/user` probe
		// succeeds on a still-live access token, and the official row is
		// rewritten with the same dead refresh token behind it.
		mockMcpConfigRows({ official: { needsReauth: true } });

		await expect(runReconcile()).resolves.toEqual({
			status: "NEEDS_REAUTH",
		});
		expect(mockGitlabFetch).not.toHaveBeenCalled();
		expect(mockPersistGitLabToken).not.toHaveBeenCalled();
	});

	it("scopes the gitlab-official breaker read to the tenant (XOR)", async () => {
		mockGitlabFetch.mockResolvedValue(GITLAB_USER);

		await runReconcile();

		expect(mockMcpConfigFindFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					userId: "user-1",
					// Personal context: null is REQUIRED, never omitted — an
					// absent field would match another tenant's row.
					organizationId: null,
					mcpServer: { key: "gitlab-official" },
				}),
			}),
		);
	});

	it("persists without breaker-reset authority when it does write", async () => {
		// Reconcile reuses the token it read out of the other store, so it has
		// no new grant and `persistGitLabToken` must write the token fields
		// only. Passing `freshGrant: true` from here would clear needsReauth,
		// the failure counters and the UNAVAILABLE status on a credential
		// nobody re-authorized.
		mockGitlabFetch.mockResolvedValue(GITLAB_USER);

		await expect(runReconcile()).resolves.toEqual({
			status: "RECONCILED",
		});
		expect(mockPersistGitLabToken.mock.calls[0]![1]).toMatchObject({
			freshGrant: false,
		});
	});
});

/**
 * The paired half of the same authority: withholding it everywhere would leave
 * a condemned credential with no way back, so the one caller that completes an
 * authorization-code exchange must still carry it.
 */
describe("integrations.gitlab.callback — the path that DOES hold a fresh grant", () => {
	function runCallback() {
		return (
			gitlabOAuthProcedures.callback as unknown as {
				handler: (args: {
					input: { code?: string; state?: string };
				}) => Promise<{ success: boolean; message: string }>;
			}
		).handler({ input: { code: "auth-code", state: "signed-state" } });
	}

	beforeEach(() => {
		mockDecodeOAuthState.mockReturnValue({
			provider: "gitlab",
			userId: "user-1",
			organizationId: null,
			redirectUri: "https://app.example.com/oauth/callback",
			codeVerifier: "pkce-verifier",
		});
		mockGetOAuthProvider.mockReturnValue({ id: "GITLAB" });
		mockGetOAuthCredentialsWithDb.mockResolvedValue({
			clientId: "client-id",
			clientSecret: "client-secret",
		});
		mockExchangeCodeForToken.mockResolvedValue({
			access_token: "brand-new-access",
			refresh_token: "brand-new-refresh",
			expires_in: 7200,
			scope: "api read_user",
		});
		mockGetGitLabUser.mockResolvedValue(GITLAB_USER);
		mockPersistGitLabToken.mockResolvedValue({
			mcpConfigId: "mcp-1",
			workflowIntegrationId: "wi-1",
		});
		mockDataConnectionUpdateMany.mockResolvedValue({ count: 0 });
		mockMcpConfigFindMany.mockResolvedValue([]);
	});

	it("persists the exchanged token WITH breaker-reset authority", async () => {
		await expect(runCallback()).resolves.toMatchObject({ success: true });

		expect(mockPersistGitLabToken).toHaveBeenCalledOnce();
		expect(mockPersistGitLabToken.mock.calls[0]![1]).toMatchObject({
			userId: "user-1",
			organizationId: null,
			token: expect.objectContaining({
				accessToken: "brand-new-access",
				refreshToken: "brand-new-refresh",
			}),
			// The user just re-authorized: this is the only signal that clears
			// `needsReauth` and the failure counters, so a reconnect has to be
			// able to lift a tripped breaker.
			freshGrant: true,
		});
	});
});
