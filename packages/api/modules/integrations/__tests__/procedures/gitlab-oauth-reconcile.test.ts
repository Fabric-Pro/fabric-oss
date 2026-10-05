/**
 * Procedure-level tests for `integrations.gitlab.reconcile`, and the paired
 * callback path.
 *
 * Reconcile adds the `gitlab` registry entry the MCP page lists for a person
 * whose GitLab connection is usable. It adopts nothing (a legacy MCP token
 * copy is not a connection), never writes a credential, never refreshes one
 * with a client
 * other than its issuer, and never condemns: a `/user` 401/403 is only an
 * ADVISORY prompt to reconnect (the access token is unusable now; the grant
 * behind it may be fine). Everything else surfaces as an error.
 *
 * A connection already marked reconnect-required is not reconciled back to
 * life: only a fresh grant — the OAuth callback — clears that, and the last
 * describe pins that the callback still passes it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockGitlabFetch,
	mockGetGitLabConnectionToken,
	mockGetGitLabConnectionGeneration,
	mockIdentifyGitLabIssuer,
	mockPersistGitLabToken,
	mockEnsureGitLabRegistryRow,
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
	mockGetGitLabConnectionToken: vi.fn(),
	mockGetGitLabConnectionGeneration: vi.fn(),
	mockIdentifyGitLabIssuer: vi.fn(),
	mockPersistGitLabToken: vi.fn(),
	mockEnsureGitLabRegistryRow: vi.fn(),
	mockMcpConfigFindFirst: vi.fn(),
	mockMcpConfigFindMany: vi.fn(),
	mockDataConnectionUpdateMany: vi.fn(),
	mockDecodeOAuthState: vi.fn(),
	mockExchangeCodeForToken: vi.fn(),
	mockGetGitLabUser: vi.fn(),
	mockGetOAuthProvider: vi.fn(),
	mockGetOAuthCredentialsWithDb: vi.fn(),
}));

vi.mock("@repo/integrations/gitlab", async (importOriginal) => ({
	...(await importOriginal<object>()),
	getGitLabConnectionToken: mockGetGitLabConnectionToken,
	getGitLabConnectionGeneration: mockGetGitLabConnectionGeneration,
	identifyGitLabIssuer: mockIdentifyGitLabIssuer,
	gitlabFetch: mockGitlabFetch,
}));

vi.mock("../../lib/gitlab-token", async (importOriginal) => ({
	...(await importOriginal<object>()),
	persistGitLabToken: mockPersistGitLabToken,
	ensureGitLabRegistryRow: mockEnsureGitLabRegistryRow,
}));

vi.mock("../../lib/gitlab-recheck", () => ({
	recheckGitlabCapabilities: vi.fn(),
	GitLabIntegrationNotConnectedError: class extends Error {},
}));

// Stub heavy barrel imports so the procedure file loads without real DB /
// Temporal / permissions wiring. Reconcile reads only the finders; the
// callback describe additionally reaches `mCPConfig.findMany` (tool ingestion)
// and `dataConnection.updateMany` (auto-heal).
// Stub heavy barrel imports so the procedure file loads without real DB /
// Temporal / permissions wiring.
vi.mock("@repo/database", () => ({
	db: {
		mCPConfig: {
			findFirst: mockMcpConfigFindFirst,
			findMany: mockMcpConfigFindMany,
		},
		dataConnection: { updateMany: mockDataConnectionUpdateMany },
	},
	// The callback guard's live membership check for the organization the
	// state names; the caller is always still a member there.
	getOrganizationMembership: vi
		.fn()
		.mockImplementation(async (organizationId: string) => ({
			organization: { id: organizationId },
			role: "member",
		})),
	getProjectMemberRole: vi.fn(),
	logRepoIntegrationActivity: vi.fn(),
	syncLegacyProjectRepoOnConnect: vi.fn(),
}));

vi.mock("@repo/permissions", () => ({
	// The guard resolves the caller's role to its permission set and asks
	// for INTEGRATION_USE; the role → permission table is stubbed permissive
	// here because this suite is about the breaker, not the guard (the
	// session-binding suite exercises the real table).
	hasPermission: vi.fn().mockReturnValue(true),
	Permissions: {},
	resolveOrgPermissions: vi.fn().mockReturnValue([]),
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
	resolveOrgIdForQuery: (state: { organizationId?: string | null }) =>
		state.organizationId ?? null,
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

// The callback spends its state nonce through the shared store; this suite is
// about the breaker, so the store always answers "first presentation".
vi.mock("../../lib/oauth-state-store", () => ({
	consumeOAuthStateNonce: vi.fn().mockResolvedValue("consumed"),
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
		protectedProcedure: chain,
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
		requirePermission: () => (handler: unknown) => handler,
		requireInputOrgPermission: () => (handler: unknown) => handler,
		requireOrganizationMembership: vi.fn(),
		resolveOrganizationIdForCaller: vi.fn(),
		Permissions: { INTEGRATION_USE: "integration:use" },
	};
});

import { GitLabApiError } from "@repo/integrations/gitlab";
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

function runReconcile(organizationId: string | null = "org-1") {
	return (
		gitlabOAuthProcedures.reconcile as unknown as {
			handler: (args: {
				input: { organizationId?: string | null };
				context: typeof baseCtx;
			}) => Promise<{ status: string }>;
		}
	).handler({ input: { organizationId }, context: baseCtx });
}

const okToken = {
	ok: true,
	accessToken: "tok",
	issuer: {
		kind: "app",
		clientId: "client-id",
		origin: "https://gitlab.com",
	},
	origin: "https://gitlab.com",
	integrationId: "wi-1",
	generation: 2,
	settings: {},
};

const apiError = (status: number, message: string) =>
	new GitLabApiError(status, message);

beforeEach(() => {
	vi.clearAllMocks();
	mockGetGitLabConnectionToken.mockResolvedValue(okToken);
	// The registry entry is missing — the case reconcile exists for.
	mockMcpConfigFindFirst.mockResolvedValue(null);
	mockGitlabFetch.mockResolvedValue({ id: 7 });
	mockEnsureGitLabRegistryRow.mockResolvedValue(undefined);
});

describe("integrations.gitlab.reconcile", () => {
	it("adds the registry entry after GitLab accepts the token", async () => {
		await expect(runReconcile()).resolves.toEqual({ status: "RECONCILED" });
		expect(mockGitlabFetch).toHaveBeenCalledWith(
			{ token: "tok", apiBase: "https://gitlab.com/api/v4" },
			"/user",
		);
		expect(mockEnsureGitLabRegistryRow).toHaveBeenCalledOnce();
		// Reconcile never writes a credential.
		expect(mockPersistGitLabToken).not.toHaveBeenCalled();
	});

	it("checks a self-hosted token against its own instance", async () => {
		mockGetGitLabConnectionToken.mockResolvedValue({
			...okToken,
			origin: "https://gitlab.example.com",
		});

		await runReconcile();

		expect(mockGitlabFetch).toHaveBeenCalledWith(
			{ token: "tok", apiBase: "https://gitlab.example.com/api/v4" },
			"/user",
		);
	});

	it("reads the token strictly, from the connection alone", async () => {
		await runReconcile();
		expect(mockGetGitLabConnectionToken).toHaveBeenCalledWith(
			{ userId: "user-1", organizationId: "org-1" },
			{ mode: "strict", anyOrigin: true },
		);
	});

	it("short-circuits without probing when nothing is missing", async () => {
		mockMcpConfigFindFirst.mockResolvedValue({ id: "cfg-gitlab" });
		await expect(runReconcile()).resolves.toEqual({
			status: "ALREADY_BOTH",
		});
		expect(mockGitlabFetch).not.toHaveBeenCalled();
	});

	it("scopes the registry lookup exclusively to the tenant context", async () => {
		await runReconcile("org-1");
		expect(mockMcpConfigFindFirst.mock.calls[0][0].where).toMatchObject({
			userId: "user-1",
			organizationId: "org-1",
			mcpServer: { key: "gitlab" },
		});
		mockMcpConfigFindFirst.mockClear();
		// No organization: refused before any read (ADR-018).
		await expect(runReconcile(null)).rejects.toThrow(
			/requires an organization context/,
		);
		expect(mockMcpConfigFindFirst).not.toHaveBeenCalled();
	});

	it("prompts a reconnect on a /user 401 without writing anything", async () => {
		mockGitlabFetch.mockRejectedValue(apiError(401, "Unauthorized"));
		await expect(runReconcile()).resolves.toEqual({
			status: "NEEDS_REAUTH",
		});
		expect(mockEnsureGitLabRegistryRow).not.toHaveBeenCalled();
		expect(mockPersistGitLabToken).not.toHaveBeenCalled();
	});

	it("prompts a reconnect on a /user 403 without writing anything", async () => {
		mockGitlabFetch.mockRejectedValue(apiError(403, "Forbidden"));
		await expect(runReconcile()).resolves.toEqual({
			status: "NEEDS_REAUTH",
		});
		expect(mockEnsureGitLabRegistryRow).not.toHaveBeenCalled();
	});

	it("declines a connection already marked reconnect-required, without probing", async () => {
		mockGetGitLabConnectionToken.mockResolvedValue({
			ok: false,
			reason: "needs-reauth",
			message: "the GitLab connection needs to be reconnected",
		});
		await expect(runReconcile()).resolves.toEqual({
			status: "NEEDS_REAUTH",
		});
		expect(mockGitlabFetch).not.toHaveBeenCalled();
		expect(mockEnsureGitLabRegistryRow).not.toHaveBeenCalled();
	});

	it("asks for a reconnect when the client that issued the token is gone", async () => {
		mockGetGitLabConnectionToken.mockResolvedValue({
			ok: false,
			reason: "client-unavailable",
			message:
				"the OAuth client that issued the GitLab token is not available",
		});
		await expect(runReconcile()).resolves.toEqual({
			status: "NEEDS_REAUTH",
		});
		expect(mockGitlabFetch).not.toHaveBeenCalled();
	});

	it("reports NOT_FOUND when there is no connection to reconcile", async () => {
		mockGetGitLabConnectionToken.mockResolvedValue({
			ok: false,
			reason: "not-connected",
			message: "GitLab is not connected",
		});
		await expect(runReconcile()).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
	});

	it("surfaces a transient token failure as an error, not a reconnect prompt", async () => {
		mockGetGitLabConnectionToken.mockResolvedValue({
			ok: false,
			reason: "transient",
			message: "the GitLab token refresh did not complete",
		});
		await expect(runReconcile()).rejects.toMatchObject({
			code: "INTERNAL_SERVER_ERROR",
		});
	});

	it("surfaces a 5xx from GitLab instead of prompting", async () => {
		const outage = apiError(503, "503 Service Unavailable");
		mockGitlabFetch.mockRejectedValue(outage);
		await expect(runReconcile()).rejects.toBe(outage);
	});

	it("surfaces a 429 from GitLab instead of prompting", async () => {
		const limited = apiError(429, "Too many requests");
		mockGitlabFetch.mockRejectedValue(limited);
		await expect(runReconcile()).rejects.toBe(limited);
	});

	it("surfaces a network error instead of prompting", async () => {
		const network = new TypeError("fetch failed");
		mockGitlabFetch.mockRejectedValue(network);
		await expect(runReconcile()).rejects.toBe(network);
	});

	it("surfaces a failed registry write after the token validated", async () => {
		const dbDown = new Error("could not connect to the database");
		mockEnsureGitLabRegistryRow.mockRejectedValue(dbDown);
		await expect(runReconcile()).rejects.toBe(dbDown);
	});
});

/**
 * The paired half: the one caller that completes an authorization-code
 * exchange writes through the connection service with the issuing client, a
 * fresh grant, and the generation it read before the exchange.
 */
describe("integrations.gitlab.callback — the path that DOES hold a fresh grant", () => {
	function runCallback() {
		return (
			gitlabOAuthProcedures.callback as unknown as {
				handler: (args: {
					input: { code?: string; state?: string };
					context: typeof baseCtx;
				}) => Promise<{ success: boolean; message: string }>;
			}
		).handler({
			input: { code: "auth-code", state: "signed-state" },
			context: baseCtx,
		});
	}

	const ISSUER = {
		kind: "app",
		clientId: "client-id",
		origin: "https://gitlab.com",
	};

	beforeEach(() => {
		mockDecodeOAuthState.mockReturnValue({
			provider: "gitlab",
			nonce: "nonce-1",
			userId: "user-1",
			organizationId: "org-1",
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
		mockGetGitLabConnectionGeneration.mockResolvedValue(5);
		mockIdentifyGitLabIssuer.mockResolvedValue(ISSUER);
		mockPersistGitLabToken.mockResolvedValue({
			written: true,
			workflowIntegrationId: "wi-1",
			generation: 6,
		});
		mockDataConnectionUpdateMany.mockResolvedValue({ count: 0 });
		mockMcpConfigFindMany.mockResolvedValue([]);
	});

	it("persists the exchanged token as a fresh grant, with its issuer, fenced on the generation read before the exchange", async () => {
		await expect(runCallback()).resolves.toMatchObject({ success: true });

		expect(mockIdentifyGitLabIssuer).toHaveBeenCalledWith(
			{ userId: "user-1", organizationId: "org-1" },
			{ clientId: "client-id", origin: "https://gitlab.com" },
		);
		expect(mockPersistGitLabToken).toHaveBeenCalledOnce();
		expect(mockPersistGitLabToken.mock.calls[0]![0]).toMatchObject({
			userId: "user-1",
			organizationId: "org-1",
			token: expect.objectContaining({
				accessToken: "brand-new-access",
				refreshToken: "brand-new-refresh",
			}),
			issuer: ISSUER,
			freshGrant: true,
			expectedGeneration: 5,
		});
		// The generation was read before the code exchange.
		expect(
			mockGetGitLabConnectionGeneration.mock.invocationCallOrder[0],
		).toBeLessThan(mockExchangeCodeForToken.mock.invocationCallOrder[0]);
	});

	it("heals an EXPIRED GitLab Data Connection's status without copying the token onto it", async () => {
		await expect(runCallback()).resolves.toMatchObject({ success: true });

		expect(mockDataConnectionUpdateMany).toHaveBeenCalledOnce();
		const [args] = mockDataConnectionUpdateMany.mock.calls[0]!;
		expect(args.where).toMatchObject({
			userId: "user-1",
			organizationId: "org-1",
			provider: "GITLAB",
			status: "EXPIRED",
		});
		expect(args.data).toEqual({
			accessToken: null,
			refreshToken: null,
			tokenExpiresAt: null,
			credentialId: null,
			status: "CONNECTED",
		});
		expect(JSON.stringify(args)).not.toContain("brand-new");
	});

	it("reports failure (and writes nothing further) when a disconnect landed during the exchange", async () => {
		mockPersistGitLabToken.mockResolvedValue({
			written: false,
			reason: "stale",
		});

		await expect(runCallback()).resolves.toMatchObject({ success: false });
		expect(mockDataConnectionUpdateMany).not.toHaveBeenCalled();
	});
});
