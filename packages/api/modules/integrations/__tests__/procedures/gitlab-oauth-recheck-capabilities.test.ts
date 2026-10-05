/**
 * Procedure-level tests for `integrations.gitlab.recheckCapabilities`
 * error-mapping (F4 in fix/gitlab-error-ux-hardening).
 *
 * The helper `recheckGitlabCapabilities` can throw two domain errors —
 * `GitLabReauthRequiredError` (refresh-token died) and
 * `GitLabIntegrationNotConnectedError` (no WI row for tenant). Both must be
 * translated to user-actionable ORPCErrors at the procedure boundary, so the
 * Integrations page surfaces a reconnect / connect CTA instead of a generic
 * 500. Anything else must re-throw unchanged.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockRecheckGitlabCapabilities } = vi.hoisted(() => ({
	mockRecheckGitlabCapabilities: vi.fn(),
}));

vi.mock("../../lib/gitlab-recheck", async () => {
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

	class GitLabIntegrationNotConnectedError extends Error {
		constructor(message = "GitLab integration not connected") {
			super(message);
			this.name = "GitLabIntegrationNotConnectedError";
		}
	}

	return {
		recheckGitlabCapabilities: mockRecheckGitlabCapabilities,
		GitLabIntegrationNotConnectedError,
		// Also re-export the reauth error from the real leaf so the SUT's
		// `instanceof` check matches the class we throw below.
		GitLabReauthRequiredError,
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
		persistGitLabToken: vi.fn(),
	};
});

// Stub heavy barrel imports so the procedure file loads without DB / Temporal /
// permissions wiring. Each export the procedure file consumes returns a stub
// adequate for module evaluation; the recheckCapabilities handler doesn't
// actually touch any of these at runtime.
vi.mock("@repo/database", () => ({
	db: {},
	getProjectMemberRole: vi.fn(),
	logRepoIntegrationActivity: vi.fn(),
	syncLegacyProjectRepoOnConnect: vi.fn(),
}));

// `gitlabFetch` / `GitLabApiError` are only touched by the reconcile
// handler, but the mock must still carry every export the procedure file
// imports or the namespace access throws when an unrelated path reaches one.
vi.mock("@repo/integrations/gitlab", () => ({
	getValidGitLabAccessToken: vi.fn(),
	GitLabApiError: class GitLabApiError extends Error {},
	gitlabFetch: vi.fn(),
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

vi.mock("../../lib/enable-gitlab-pm-for-project", () => ({
	enableGitLabPMForProject: vi.fn(),
}));

vi.mock("../../lib/oauth-providers", () => ({
	getOAuthCredentialsWithDb: vi.fn(),
	getOAuthProvider: vi.fn(),
}));

vi.mock("../../lib/oauth-state", () => ({
	decodeOAuthState: vi.fn(),
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
		protectedProcedure: chain,
		requirePermission: () => (handler: unknown) => handler,
		// The real resolver's rule for the organization a request names (the
		// input's, else the session's; an explicit null suppresses the session
		// fallback; none refused when required). Membership and role are
		// exercised for real in gitlab-request-authorization.test.ts.
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
		requireInputOrgPermission: () => (handler: unknown) => handler,
		requireOrganizationMembership: vi.fn(),
		resolveOrganizationIdForCaller: vi.fn(),
		Permissions: { INTEGRATION_USE: "integration:use" },
	};
});

import { gitlabOAuthProcedures } from "../../procedures/gitlab-oauth";

// Each call names an organization: re-checking with none is refused before
// the helper runs (gitlab-request-authorization.test.ts covers that and the
// membership check), and these tests are about mapping the helper's errors.
const baseCtx = {
	user: { id: "user-1" },
	session: { id: "session-1", activeOrganizationId: null },
};

function getRecheckHandler() {
	return (
		gitlabOAuthProcedures.recheckCapabilities as unknown as {
			handler: (args: {
				input: { organizationId?: string | null };
				context: typeof baseCtx;
			}) => Promise<unknown>;
		}
	).handler;
}

describe("integrations.gitlab.recheckCapabilities — error mapping", () => {
	beforeEach(() => {
		mockRecheckGitlabCapabilities.mockReset();
	});

	it("maps GitLabReauthRequiredError to UNAUTHORIZED with reconnect copy", async () => {
		const { GitLabReauthRequiredError } = await import(
			"../../lib/gitlab-token"
		);
		mockRecheckGitlabCapabilities.mockRejectedValue(
			new GitLabReauthRequiredError(),
		);

		await expect(
			getRecheckHandler()({
				input: { organizationId: "org-1" },
				context: baseCtx,
			}),
		).rejects.toMatchObject({
			code: "UNAUTHORIZED",
			message: expect.stringMatching(
				/expired.*reconnect.*Settings.*Integrations/i,
			),
		});
	});

	it("maps GitLabIntegrationNotConnectedError to PRECONDITION_FAILED with connect CTA", async () => {
		const { GitLabIntegrationNotConnectedError } = await import(
			"../../lib/gitlab-recheck"
		);
		mockRecheckGitlabCapabilities.mockRejectedValue(
			new GitLabIntegrationNotConnectedError(),
		);

		await expect(
			getRecheckHandler()({
				input: { organizationId: "org-1" },
				context: baseCtx,
			}),
		).rejects.toMatchObject({
			code: "PRECONDITION_FAILED",
			message: expect.stringMatching(
				/not connected.*Settings.*Integrations/i,
			),
		});
	});

	it("re-throws unrelated errors unchanged (no wrapping)", async () => {
		const original = new TypeError("ECONNRESET");
		mockRecheckGitlabCapabilities.mockRejectedValue(original);

		await expect(
			getRecheckHandler()({
				input: { organizationId: "org-1" },
				context: baseCtx,
			}),
		).rejects.toBe(original);
	});

	it("returns the helper result verbatim on the happy path (no catch interference)", async () => {
		const expected = {
			useOfficialMcp: true,
			mcpProbe: {
				status: "ok" as const,
				httpStatus: 200,
				checkedAt: "2026-05-28T00:00:00Z",
				baseUrl: "https://gitlab.com",
			},
		};
		mockRecheckGitlabCapabilities.mockResolvedValue(expected);

		const result = await getRecheckHandler()({
			input: { organizationId: "org-1" },
			context: baseCtx,
		});
		expect(result).toEqual(expected);
	});
});
