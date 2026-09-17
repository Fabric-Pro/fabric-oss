/**
 * `integrations.gitlab.callback` / `integrations.gitlab.start` — the same
 * session binding and single-use state as the generic and GitHub callbacks.
 * The mock preamble follows `gitlab-oauth-reconcile.test.ts`, which already
 * loads this procedure file without real DB, Temporal or GitLab wiring.
 */

import { ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockExchangeCodeForToken,
	mockGetGitLabUser,
	mockGetGitLabOAuthUrl,
	mockPersistGitLabToken,
	mockGetOrganizationMembership,
	mockResolveOrganizationIdForCaller,
	startMiddlewareCalls,
	mockGetOAuthCredentialsWithDb,
	mockDataConnectionUpdateMany,
	mockMcpConfigFindMany,
} = vi.hoisted(() => {
	process.env.ENCRYPTION_KEY = "test-encryption-key-for-oauth-state";
	return {
		mockExchangeCodeForToken: vi.fn(),
		mockGetGitLabUser: vi.fn(),
		mockGetGitLabOAuthUrl: vi.fn(),
		mockPersistGitLabToken: vi.fn(),
		mockGetOrganizationMembership: vi.fn(),
		mockResolveOrganizationIdForCaller: vi.fn(),
		// Recorded at module load, so a plain array rather than a vi.fn —
		// `vi.clearAllMocks()` in `beforeEach` would wipe a mock's calls.
		startMiddlewareCalls: [] as unknown[][],
		mockGetOAuthCredentialsWithDb: vi.fn(),
		mockDataConnectionUpdateMany: vi.fn(),
		mockMcpConfigFindMany: vi.fn(),
	};
});

vi.mock("@repo/connectors", () => ({
	integrationStatusForRepoAccess: vi.fn(),
	resolveDefaultBranch: vi.fn(),
	verifyRepositoryAccess: vi.fn(),
}));

vi.mock("@repo/integrations/gitlab", () => ({
	GitLabApiError: class GitLabApiError extends Error {
		status = 500;
	},
	getValidGitLabAccessToken: vi.fn(),
	gitlabFetch: vi.fn(),
}));

vi.mock("../../lib/gitlab-token", () => ({
	GitLabReauthRequiredError: class GitLabReauthRequiredError extends Error {},
	loadGitLabToken: vi.fn(),
	persistGitLabToken: mockPersistGitLabToken,
	markNeedsReauth: vi.fn(),
}));

vi.mock("../../lib/gitlab-recheck", () => ({
	recheckGitlabCapabilities: vi.fn(),
	GitLabIntegrationNotConnectedError: class extends Error {},
}));

vi.mock("@repo/database", () => ({
	db: {
		workflowIntegration: { findFirst: vi.fn() },
		mCPConfig: { findFirst: vi.fn(), findMany: mockMcpConfigFindMany },
		dataConnection: { updateMany: mockDataConnectionUpdateMany },
	},
	getOrganizationMembership: mockGetOrganizationMembership,
	getProjectMemberRole: vi.fn(),
	logRepoIntegrationActivity: vi.fn(),
	syncLegacyProjectRepoOnConnect: vi.fn(),
}));

// `@repo/permissions` is NOT stubbed here, unlike the reconcile suite: the
// callback guard resolves the caller's current role to its permission set,
// and that resolution is what the demotion cases below exercise.

vi.mock("@repo/temporal", () => ({
	triggerMcpToolIngestion: vi.fn(),
}));

vi.mock("@repo/utils", () => ({
	encryptApiKey: (v: string) => `enc_${v}`,
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../../projects/lib/code-indexing-trigger", () => ({
	startCodeIndexingForProject: vi.fn(),
}));

vi.mock("../../lib/gitlab-oauth", () => ({
	exchangeCodeForToken: mockExchangeCodeForToken,
	generatePkce: () => ({ codeVerifier: "verifier", codeChallenge: "chal" }),
	getGitLabOAuthUrl: mockGetGitLabOAuthUrl,
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
	getOAuthProvider: () => ({ id: "GITLAB", name: "GitLab" }),
}));

// No Redis in this suite: the store falls back to its in-memory map.
vi.mock("../../../../lib/redis-client", () => ({
	getRedisClient: () => null,
}));

vi.mock("../../../../orpc/procedures", () => {
	const builder = (kind: string) => {
		const chain: Record<string, unknown> = {};
		Object.assign(chain, {
			use: () => chain,
			route: () => chain,
			input: () => chain,
			output: () => chain,
			handler: (fn: unknown) => ({ handler: fn, builder: kind }),
		});
		return chain;
	};
	return {
		tenantProtectedProcedure: builder("tenantProtected"),
		protectedProcedure: builder("protected"),
		publicProcedure: builder("public"),
		requirePermission: () => ({}),
		requireInputOrgPermission: (...args: unknown[]) => {
			startMiddlewareCalls.push(args);
			return {};
		},
		requireOrganizationMembership: vi.fn(),
		resolveOrganizationIdForCaller: mockResolveOrganizationIdForCaller,
		Permissions: { INTEGRATION_USE: "integration:use" },
	};
});

import { MISSING_ORGANIZATION_CONTEXT_ERROR_CODE } from "../../../../lib/missing-organization-context";
import { decodeOAuthState, encodeOAuthState } from "../../lib/oauth-state";
import { __resetInMemoryOAuthStateStoreForTests } from "../../lib/oauth-state-store";
import { gitlabOAuthProcedures } from "../../procedures/gitlab-oauth";

type Handler<I, O> = {
	handler: (args: {
		input: I;
		context: {
			user: { id: string };
			session: { id: string; activeOrganizationId: string | null };
		};
	}) => Promise<O>;
	builder: string;
};

const callback = gitlabOAuthProcedures.callback as unknown as Handler<
	{ code?: string; state?: string },
	{ success: boolean; message: string }
>;
const start = gitlabOAuthProcedures.start as unknown as Handler<
	{ redirectUri: string; organizationId?: string | null },
	{ authorizationUrl: string }
>;

const REDIRECT_URI =
	"https://app.example.com/api/integrations/gitlab/oauth/callback";

function contextFor(
	userId: string,
	activeOrganizationId: string | null = null,
) {
	return {
		user: { id: userId },
		session: { id: "session-1", activeOrganizationId },
	};
}

/** Membership rows by organization, as the guard's live lookup sees them. */
function memberOf(roles: Record<string, string>) {
	mockGetOrganizationMembership.mockImplementation(
		async (organizationId: string, userId: string) =>
			userId === "user-1" && roles[organizationId]
				? {
						organization: { id: organizationId },
						role: roles[organizationId],
					}
				: null,
	);
}

function mintState(organizationId: string) {
	return encodeOAuthState({
		userId: "user-1",
		organizationId,
		provider: "gitlab",
		redirectUri: REDIRECT_URI,
		codeVerifier: "verifier",
	});
}

/** A signed state with no organization: a legacy in-flight or hand-built one. */
function mintOrganizationlessState() {
	return encodeOAuthState({
		userId: "user-1",
		organizationId: undefined as unknown as string,
		provider: "gitlab",
		redirectUri: REDIRECT_URI,
		codeVerifier: "verifier",
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	__resetInMemoryOAuthStateStoreForTests();
	memberOf({ "org-1": "member" });
	mockGetOAuthCredentialsWithDb.mockResolvedValue({
		clientId: "client-id",
		clientSecret: "client-secret",
	});
	mockExchangeCodeForToken.mockResolvedValue({
		access_token: "gl-access",
		refresh_token: "gl-refresh",
		expires_in: 7200,
		scope: "api read_user",
	});
	mockGetGitLabUser.mockResolvedValue({
		id: 7,
		username: "example-user",
		name: "Example",
		avatar_url: null,
	});
	mockPersistGitLabToken.mockResolvedValue({
		mcpConfigId: "mcp-1",
		workflowIntegrationId: "wi-1",
	});
	mockDataConnectionUpdateMany.mockResolvedValue({ count: 0 });
	mockMcpConfigFindMany.mockResolvedValue([]);
});

describe("integrations.gitlab.callback", () => {
	it("is declared on protectedProcedure", () => {
		expect(callback.builder).toBe("protected");
	});

	it("refuses a session that is not the user who started the flow, and persists nothing", async () => {
		await expect(
			callback.handler({
				input: { code: "code", state: mintState("org-1") },
				context: contextFor("user-2"),
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });

		expect(mockExchangeCodeForToken).not.toHaveBeenCalled();
		expect(mockPersistGitLabToken).not.toHaveBeenCalled();
		expect(mockDataConnectionUpdateMany).not.toHaveBeenCalled();
	});

	it("refuses when the caller is no longer a member of the state's organization", async () => {
		memberOf({});

		await expect(
			callback.handler({
				input: { code: "code", state: mintState("org-1") },
				context: contextFor("user-1"),
			}),
		).rejects.toMatchObject({
			code: "FORBIDDEN",
			message: "You are not a member of this organization",
		});

		expect(mockGetOrganizationMembership).toHaveBeenCalledWith(
			"org-1",
			"user-1",
		);
		expect(mockExchangeCodeForToken).not.toHaveBeenCalled();
		expect(mockPersistGitLabToken).not.toHaveBeenCalled();
	});

	it("refuses when the caller's role in the state's organization was demoted below INTEGRATION_USE after start", async () => {
		memberOf({ "org-1": "viewer" });

		await expect(
			callback.handler({
				input: { code: "code", state: mintState("org-1") },
				context: contextFor("user-1", "org-1"),
			}),
		).rejects.toMatchObject({
			code: "FORBIDDEN",
			message: expect.stringMatching(/no longer allows connecting/i),
		});

		expect(mockExchangeCodeForToken).not.toHaveBeenCalled();
		expect(mockPersistGitLabToken).not.toHaveBeenCalled();
		expect(mockDataConnectionUpdateMany).not.toHaveBeenCalled();
	});

	it("checks the state's organization, not the session's active one", async () => {
		memberOf({ "org-a": "admin", "org-b": "viewer" });

		await expect(
			callback.handler({
				input: { code: "code", state: mintState("org-b") },
				context: contextFor("user-1", "org-a"),
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });

		expect(mockGetOrganizationMembership).toHaveBeenCalledWith(
			"org-b",
			"user-1",
		);
		expect(mockGetOrganizationMembership).not.toHaveBeenCalledWith(
			"org-a",
			"user-1",
		);
		expect(mockExchangeCodeForToken).not.toHaveBeenCalled();
		expect(mockPersistGitLabToken).not.toHaveBeenCalled();
	});

	it("refuses a state that carries no organization before the nonce, the exchange and the write", async () => {
		await expect(
			callback.handler({
				input: { code: "code", state: mintOrganizationlessState() },
				context: contextFor("user-1"),
			}),
		).resolves.toMatchObject({
			success: false,
			message: expect.stringMatching(/invalid or expired/i),
		});

		expect(mockGetOrganizationMembership).not.toHaveBeenCalled();
		expect(mockExchangeCodeForToken).not.toHaveBeenCalled();
		expect(mockPersistGitLabToken).not.toHaveBeenCalled();
	});

	it("persists the token under the state's user and organization for the matching member", async () => {
		await expect(
			callback.handler({
				input: { code: "code", state: mintState("org-1") },
				context: contextFor("user-1"),
			}),
		).resolves.toMatchObject({
			success: true,
			message: "Connected GitLab account: example-user",
		});

		// PKCE verifier from the state still reaches the exchange.
		expect(mockExchangeCodeForToken).toHaveBeenCalledWith(
			"code",
			"client-id",
			"client-secret",
			REDIRECT_URI,
			"verifier",
		);
		expect(mockPersistGitLabToken).toHaveBeenCalledTimes(1);
		expect(mockPersistGitLabToken.mock.calls[0]?.[1]).toMatchObject({
			userId: "user-1",
			organizationId: "org-1",
			freshGrant: true,
		});
	});

	it("refuses a replayed state before the exchange, so the token is not persisted twice", async () => {
		const state = mintState("org-1");

		await expect(
			callback.handler({
				input: { code: "code-1", state },
				context: contextFor("user-1"),
			}),
		).resolves.toMatchObject({ success: true });

		await expect(
			callback.handler({
				input: { code: "code-2", state },
				context: contextFor("user-1"),
			}),
		).resolves.toMatchObject({
			success: false,
			message: expect.stringMatching(/already been used/i),
		});

		expect(mockExchangeCodeForToken).toHaveBeenCalledTimes(1);
		expect(mockPersistGitLabToken).toHaveBeenCalledTimes(1);
	});
});

describe("integrations.gitlab.start", () => {
	it("mounts the INTEGRATION_USE middleware with an organization required, so an explicit null is refused before the handler", () => {
		expect(startMiddlewareCalls).toContainEqual([
			"integration:use",
			expect.objectContaining({ requireOrganization: true }),
		]);
	});

	it("refuses an explicit null organization in the handler too, and mints no state", async () => {
		mockResolveOrganizationIdForCaller.mockResolvedValue(undefined);

		await expect(
			start.handler({
				input: { redirectUri: REDIRECT_URI, organizationId: null },
				context: contextFor("user-1"),
			}),
		).rejects.toMatchObject({
			code: "FORBIDDEN",
			data: { errorCode: MISSING_ORGANIZATION_CONTEXT_ERROR_CODE },
		});

		expect(mockGetOAuthCredentialsWithDb).not.toHaveBeenCalled();
		expect(mockGetGitLabOAuthUrl).not.toHaveBeenCalled();
	});

	it("refuses an explicit organization the caller has no tie to, and mints no state", async () => {
		mockResolveOrganizationIdForCaller.mockRejectedValue(
			new ORPCError("FORBIDDEN", {
				message: "You do not have access to this organization",
			}),
		);

		await expect(
			start.handler({
				input: {
					redirectUri: REDIRECT_URI,
					organizationId: "org-outside",
				},
				context: contextFor("user-1"),
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });

		expect(mockResolveOrganizationIdForCaller).toHaveBeenCalledWith(
			"org-outside",
			expect.objectContaining({ id: "session-1" }),
			"user-1",
		);
		expect(mockGetOAuthCredentialsWithDb).not.toHaveBeenCalled();
		expect(mockGetGitLabOAuthUrl).not.toHaveBeenCalled();
	});

	it("looks up credentials for, and signs, the resolved organization", async () => {
		mockResolveOrganizationIdForCaller.mockResolvedValue("org-1");
		mockGetGitLabOAuthUrl.mockReturnValue(
			"https://gitlab.com/oauth/authorize?state=x",
		);

		await expect(
			start.handler({
				input: { redirectUri: REDIRECT_URI, organizationId: "org-1" },
				context: contextFor("user-1"),
			}),
		).resolves.toEqual({
			authorizationUrl: "https://gitlab.com/oauth/authorize?state=x",
		});

		expect(mockGetOAuthCredentialsWithDb).toHaveBeenCalledWith(
			expect.objectContaining({ id: "GITLAB" }),
			"user-1",
			"org-1",
		);
		const signedState = mockGetGitLabOAuthUrl.mock.calls[0]?.[2];
		expect(decodeOAuthState(signedState as string)).toMatchObject({
			userId: "user-1",
			organizationId: "org-1",
			provider: "gitlab",
			codeVerifier: "verifier",
		});
	});
});
