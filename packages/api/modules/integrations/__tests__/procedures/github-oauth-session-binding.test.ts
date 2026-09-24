/**
 * `integrations.github.callback` / `integrations.github.start` — the same
 * session binding and single-use state as the generic callback. The GitHub
 * flow has its own procedure file and had the same gap: a public callback
 * storing the token under whoever the signed state named.
 */

import { ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockExchangeCodeForToken,
	mockGetGitHubUser,
	mockGetGitHubOAuthUrl,
	mockGetOrganizationMembership,
	mockResolveOrganizationIdForCaller,
	startMiddlewareCalls,
	mockWorkflowIntegrationFindFirst,
	mockWorkflowIntegrationCreate,
	mockWorkflowIntegrationUpdate,
	mockDataConnectionUpdateMany,
} = vi.hoisted(() => {
	process.env.ENCRYPTION_KEY = "test-encryption-key-for-oauth-state";
	process.env.FABRIC_GITHUB_CLIENT_ID = "gh-client-id";
	process.env.FABRIC_GITHUB_CLIENT_SECRET = "gh-client-secret";
	return {
		mockExchangeCodeForToken: vi.fn(),
		mockGetGitHubUser: vi.fn(),
		mockGetGitHubOAuthUrl: vi.fn(),
		mockGetOrganizationMembership: vi.fn(),
		mockResolveOrganizationIdForCaller: vi.fn(),
		// Recorded at module load, so a plain array rather than a vi.fn —
		// `vi.clearAllMocks()` in `beforeEach` would wipe a mock's calls.
		startMiddlewareCalls: [] as unknown[][],
		mockWorkflowIntegrationFindFirst: vi.fn(),
		mockWorkflowIntegrationCreate: vi.fn(),
		mockWorkflowIntegrationUpdate: vi.fn(),
		mockDataConnectionUpdateMany: vi.fn(),
	};
});

vi.mock("@repo/connectors", () => ({
	integrationStatusForRepoAccess: vi.fn(),
	resolveDefaultBranch: vi.fn(),
	verifyRepositoryAccess: vi.fn(),
}));

vi.mock("@repo/database", async (importOriginal) => {
	// `parseRepoUrl` is real (not stubbed) here: the project-target start
	// tests below exercise `resolveProjectRepositoryIdentity`, which needs
	// the actual canonicalisation/refusal behaviour, not a mock.
	const actual = await importOriginal<typeof import("@repo/database")>();
	return {
		...actual,
		db: {
			workflowIntegration: {
				findFirst: mockWorkflowIntegrationFindFirst,
				create: mockWorkflowIntegrationCreate,
				update: mockWorkflowIntegrationUpdate,
			},
			dataConnection: { updateMany: mockDataConnectionUpdateMany },
			projectRepositoryIntegration: {
				findFirst: vi.fn(),
				create: vi.fn(),
				update: vi.fn(),
			},
		},
		createProjectRepoIntegration: vi.fn(),
		getOrganizationMembership: mockGetOrganizationMembership,
		logRepoIntegrationActivity: vi.fn(),
		syncLegacyProjectRepoOnConnect: vi.fn(),
	};
});

vi.mock("@repo/integrations", () => ({
	getGitHubToken: vi.fn(),
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@repo/utils", () => ({
	encryptApiKey: (v: string) => `enc_${v}`,
}));

vi.mock("../../../../lib/project-permissions", () => ({
	userHasProjectPermission: vi.fn(),
}));

vi.mock("../../../projects/lib/code-indexing-trigger", () => ({
	startCodeIndexingForProject: vi.fn(),
}));

// No Redis in this suite: the store falls back to its in-memory map.
vi.mock("../../../../lib/redis-client", () => ({
	getRedisClient: () => null,
}));

vi.mock("../../lib/github-oauth", () => ({
	exchangeCodeForToken: mockExchangeCodeForToken,
	getGitHubOAuthUrl: mockGetGitHubOAuthUrl,
	getGitHubUser: mockGetGitHubUser,
	listGitHubBranches: vi.fn(),
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
		Permissions: {
			INTEGRATION_USE: "integration:use",
			INTEGRATION_READ: "integration:read",
			INTEGRATION_DISCONNECT: "integration:disconnect",
			PROJECT_SETTINGS_EDIT: "project:settings:edit",
		},
	};
});

import { MISSING_ORGANIZATION_CONTEXT_ERROR_CODE } from "../../../../lib/missing-organization-context";
import { decodeOAuthState, encodeOAuthState } from "../../lib/oauth-state";
import { __resetInMemoryOAuthStateStoreForTests } from "../../lib/oauth-state-store";
import { githubOAuthProcedures } from "../../procedures/github-oauth";

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

const callback = githubOAuthProcedures.callback as unknown as Handler<
	{ code?: string; state?: string },
	{ success: boolean; message: string }
>;
const start = githubOAuthProcedures.start as unknown as Handler<
	{ redirectUri: string; organizationId?: string | null },
	{ authorizationUrl: string }
>;
type ProjectTargetStartInput = {
	redirectUri: string;
	organizationId?: string | null;
	targetType?: "user" | "project";
	projectId?: string;
	repositoryUrl?: string;
	repositoryOwner?: string;
	repositoryName?: string;
	defaultBranch?: string;
};
const startProjectTarget = githubOAuthProcedures.start as unknown as Handler<
	ProjectTargetStartInput,
	{ authorizationUrl: string }
>;

const REDIRECT_URI =
	"https://app.example.com/api/integrations/github/oauth/callback";

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
		provider: "github",
		redirectUri: REDIRECT_URI,
	});
}

/** A signed state with no organization: a legacy in-flight or hand-built one. */
function mintOrganizationlessState() {
	return encodeOAuthState({
		userId: "user-1",
		organizationId: undefined as unknown as string,
		provider: "github",
		redirectUri: REDIRECT_URI,
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	__resetInMemoryOAuthStateStoreForTests();
	memberOf({ "org-1": "member" });
	mockExchangeCodeForToken.mockResolvedValue({
		access_token: "gh-access",
		token_type: "bearer",
		scope: "repo,read:user",
	});
	mockGetGitHubUser.mockResolvedValue({
		id: 1,
		login: "octocat",
		name: "Octo",
		avatar_url: "",
	});
	mockWorkflowIntegrationFindFirst.mockResolvedValue(null);
	mockWorkflowIntegrationCreate.mockResolvedValue({ id: "wi-1" });
	mockDataConnectionUpdateMany.mockResolvedValue({ count: 0 });
});

describe("integrations.github.callback", () => {
	it("is declared on protectedProcedure", () => {
		expect(callback.builder).toBe("protected");
	});

	it("refuses a session that is not the user who started the flow, and writes nothing", async () => {
		await expect(
			callback.handler({
				input: { code: "code", state: mintState("org-1") },
				context: contextFor("user-2"),
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });

		expect(mockExchangeCodeForToken).not.toHaveBeenCalled();
		expect(mockWorkflowIntegrationCreate).not.toHaveBeenCalled();
		expect(mockWorkflowIntegrationUpdate).not.toHaveBeenCalled();
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
		expect(mockWorkflowIntegrationCreate).not.toHaveBeenCalled();
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
		expect(mockWorkflowIntegrationCreate).not.toHaveBeenCalled();
		expect(mockDataConnectionUpdateMany).not.toHaveBeenCalled();
	});

	it("checks the state's organization, not the session's active one", async () => {
		// Session in org-a (admin there); the state targets org-b, where the
		// caller is now a viewer. The token would be stored in org-b.
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
		expect(mockWorkflowIntegrationCreate).not.toHaveBeenCalled();
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
		expect(mockWorkflowIntegrationCreate).not.toHaveBeenCalled();
	});

	it("stores the token under the state's user and organization for the matching member", async () => {
		await expect(
			callback.handler({
				input: { code: "code", state: mintState("org-1") },
				context: contextFor("user-1"),
			}),
		).resolves.toMatchObject({
			success: true,
			message: "Connected GitHub account: octocat",
		});

		expect(mockWorkflowIntegrationCreate).toHaveBeenCalledTimes(1);
		expect(
			mockWorkflowIntegrationCreate.mock.calls[0]?.[0].data,
		).toMatchObject({
			userId: "user-1",
			organizationId: "org-1",
			provider: "GITHUB",
			credentials: expect.stringMatching(/^enc_/),
		});
		expect(mockDataConnectionUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					userId: "user-1",
					organizationId: "org-1",
				}),
			}),
		);
	});

	it("refuses a replayed state before the exchange, so the token is not written twice", async () => {
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
		expect(mockWorkflowIntegrationCreate).toHaveBeenCalledTimes(1);
	});
});

describe("integrations.github.start", () => {
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

		expect(mockGetGitHubOAuthUrl).not.toHaveBeenCalled();
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
		expect(mockGetGitHubOAuthUrl).not.toHaveBeenCalled();
	});

	it("signs the resolved organization into the state", async () => {
		mockResolveOrganizationIdForCaller.mockResolvedValue("org-1");
		mockGetGitHubOAuthUrl.mockReturnValue(
			"https://github.com/login/oauth/authorize?state=x",
		);

		await expect(
			start.handler({
				input: { redirectUri: REDIRECT_URI, organizationId: "org-1" },
				context: contextFor("user-1"),
			}),
		).resolves.toEqual({
			authorizationUrl:
				"https://github.com/login/oauth/authorize?state=x",
		});

		const signedState = mockGetGitHubOAuthUrl.mock.calls[0]?.[2];
		expect(decodeOAuthState(signedState as string)).toMatchObject({
			userId: "user-1",
			organizationId: "org-1",
			provider: "github",
		});
	});
});

describe("integrations.github.start — project-target repository identity (Fizzy #2662 Codex round 2)", () => {
	beforeEach(() => {
		mockResolveOrganizationIdForCaller.mockResolvedValue("org-1");
		mockGetGitHubOAuthUrl.mockReturnValue(
			"https://github.com/login/oauth/authorize?state=x",
		);
	});

	function mintedState(): ReturnType<typeof decodeOAuthState> {
		const signedState = mockGetGitHubOAuthUrl.mock.calls.at(-1)?.[2];
		return decodeOAuthState(signedState as string);
	}

	// A URL that fails to parse (userinfo aside — that's stripped, not
	// refused) must never reach `encodeOAuthState`.
	it("signs a userinfo-free canonical URL when the candidate carries userinfo", async () => {
		const withUserinfo = new URL("https://github.com/acme/widgets");
		withUserinfo.username = "someuser";
		withUserinfo.password = "somepassword";

		await expect(
			startProjectTarget.handler({
				input: {
					redirectUri: REDIRECT_URI,
					organizationId: "org-1",
					targetType: "project",
					projectId: "proj-1",
					repositoryUrl: withUserinfo.toString(),
					repositoryOwner: "acme",
					repositoryName: "widgets",
				},
				context: contextFor("user-1"),
			}),
		).resolves.toMatchObject({ authorizationUrl: expect.any(String) });

		const state = mintedState();
		expect(state?.repositoryUrl).toBe("https://github.com/acme/widgets");
		expect(state?.repositoryUrl).not.toContain("@");
	});

	it.each([
		["a query string", "https://github.com/acme/widgets?ref=main"],
		["a fragment", "https://github.com/acme/widgets#readme"],
		["a non-default port", "https://github.com:8443/acme/widgets"],
	])("mints no state when repositoryUrl carries %s", async (_label, url) => {
		await expect(
			startProjectTarget.handler({
				input: {
					redirectUri: REDIRECT_URI,
					organizationId: "org-1",
					targetType: "project",
					projectId: "proj-1",
					repositoryUrl: url,
					repositoryOwner: "acme",
					repositoryName: "widgets",
				},
				context: contextFor("user-1"),
			}),
		).rejects.toMatchObject({ message: "Cannot parse repository URL" });

		expect(mockGetGitHubOAuthUrl).not.toHaveBeenCalled();
	});

	// `repositoryOwner`/`repositoryName` sent WITHOUT a `repositoryUrl` build
	// the same `https://github.com/{owner}/{name}` fallback the callback
	// uses — this must also be validated (and canonicalised) before signing,
	// not left to the callback.
	it("mints no state when the owner/name fallback candidate carries a query string", async () => {
		const repositoryNameWithQuery = ["widgets", "ref=main"].join("?");
		await expect(
			startProjectTarget.handler({
				input: {
					redirectUri: REDIRECT_URI,
					organizationId: "org-1",
					targetType: "project",
					projectId: "proj-1",
					repositoryOwner: "acme",
					repositoryName: repositoryNameWithQuery,
				},
				context: contextFor("user-1"),
			}),
		).rejects.toMatchObject({ message: "Cannot parse repository URL" });

		expect(mockGetGitHubOAuthUrl).not.toHaveBeenCalled();
	});

	// Codex round-3 item 3: previously, when the helper couldn't build ANY
	// candidate (too little identity info), the raw partial fields were
	// still signed into the state and the OAuth flow started anyway. A
	// project-target request now requires `projectId` and a resolvable
	// identity before minting anything.
	it.each([
		[
			"owner-only (no repositoryName, no repositoryUrl)",
			{
				projectId: "proj-1",
				repositoryOwner: "acme",
			},
		],
		[
			"name-only (no repositoryOwner, no repositoryUrl)",
			{
				projectId: "proj-1",
				repositoryName: "widgets",
			},
		],
		[
			"no identity at all",
			{
				projectId: "proj-1",
			},
		],
		[
			"a full identity but no projectId",
			{
				repositoryUrl: "https://github.com/acme/widgets",
				repositoryOwner: "acme",
				repositoryName: "widgets",
			},
		],
	])(
		"mints no state for a project-target request with %s",
		async (_label, extra) => {
			await expect(
				startProjectTarget.handler({
					input: {
						redirectUri: REDIRECT_URI,
						organizationId: "org-1",
						targetType: "project",
						...extra,
					},
					context: contextFor("user-1"),
				}),
			).rejects.toMatchObject({
				message:
					"Missing project integration fields (projectId, repositoryOwner, or repositoryName)",
			});

			expect(mockGetGitHubOAuthUrl).not.toHaveBeenCalled();
		},
	);
});
