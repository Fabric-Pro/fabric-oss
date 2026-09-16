/**
 * `integrations.oauth.callback` / `integrations.oauth.start` — the session
 * binding and the single-use state.
 *
 * The callback used to be public and to store the provider token under the
 * user named in the signed state. The state proves who STARTED the flow, not
 * whose browser is finishing it: an attacker who started one could have a
 * victim's browser complete it and land the victim's token in the attacker's
 * account. The callback now requires a session and the session must be that
 * user; an organization-scoped flow also re-checks, live, that the caller still
 * belongs to the organization the STATE names with a role that grants
 * INTEGRATION_USE there (the callback's own middleware only sees the session's
 * active organization); and the state's nonce is spent once, so a second
 * presentation is refused before the code exchange.
 *
 * The real state codec, guard, permission tables and (in-memory) nonce store
 * run here; the procedure builders and every I/O boundary are stubbed, with
 * membership stubbed at the database query so the role → permission
 * resolution is the real one.
 */

import { ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockExchangeCodeForTokens,
	mockGetUserInfo,
	mockGetOAuthCredentialsWithDb,
	mockGenerateAuthorizationUrl,
	mockGetOrganizationMembership,
	mockResolveOrganizationIdForCaller,
	startMiddlewareCalls,
	mockWorkflowIntegrationFindFirst,
	mockWorkflowIntegrationCreate,
	mockWorkflowIntegrationUpdate,
	mockGetDataConnectionByProvider,
	mockCreateDataConnection,
	mockUpdateDataConnection,
} = vi.hoisted(() => {
	process.env.ENCRYPTION_KEY = "test-encryption-key-for-oauth-state";
	return {
		mockExchangeCodeForTokens: vi.fn(),
		mockGetUserInfo: vi.fn(),
		mockGetOAuthCredentialsWithDb: vi.fn(),
		mockGenerateAuthorizationUrl: vi.fn(),
		mockGetOrganizationMembership: vi.fn(),
		mockResolveOrganizationIdForCaller: vi.fn(),
		// Recorded at module load, so a plain array rather than a vi.fn —
		// `vi.clearAllMocks()` in `beforeEach` would wipe a mock's calls.
		startMiddlewareCalls: [] as unknown[][],
		mockWorkflowIntegrationFindFirst: vi.fn(),
		mockWorkflowIntegrationCreate: vi.fn(),
		mockWorkflowIntegrationUpdate: vi.fn(),
		mockGetDataConnectionByProvider: vi.fn(),
		mockCreateDataConnection: vi.fn(),
		mockUpdateDataConnection: vi.fn(),
	};
});

vi.mock("@repo/database", () => ({
	db: {
		workflowIntegration: {
			findFirst: mockWorkflowIntegrationFindFirst,
			create: mockWorkflowIntegrationCreate,
			update: mockWorkflowIntegrationUpdate,
		},
	},
	createDataConnection: mockCreateDataConnection,
	getDataConnectionByProvider: mockGetDataConnectionByProvider,
	getOrganizationMembership: mockGetOrganizationMembership,
	updateDataConnection: mockUpdateDataConnection,
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@repo/temporal", () => ({
	triggerOAuthServerIngestion: vi.fn().mockResolvedValue(undefined),
	triggerOAuthToolIngestion: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@repo/utils", () => ({
	encryptApiKey: (v: string) => `enc_${v}`,
	decryptApiKey: (v: string) => v.replace("enc_", ""),
}));

// No Redis in this suite: the store falls back to its in-memory map (the test
// environment is not production), which is enough to exercise single use.
vi.mock("../../../../lib/redis-client", () => ({
	getRedisClient: () => null,
}));

vi.mock("../../lib/oauth-providers", () => ({
	exchangeCodeForTokens: mockExchangeCodeForTokens,
	generateAuthorizationUrl: mockGenerateAuthorizationUrl,
	getOAuthCredentials: vi.fn(),
	getOAuthCredentialsWithDb: mockGetOAuthCredentialsWithDb,
	getOAuthProvider: (type: string) =>
		type === "SLACK"
			? { id: "SLACK", name: "Slack", getUserInfo: mockGetUserInfo }
			: null,
	mapOAuthToWorkflowProvider: (type: string) =>
		type === "SLACK" ? "SLACK" : null,
}));

vi.mock("../../../../orpc/procedures", () => {
	// Each builder tags what it produces so a test can assert WHICH builder a
	// procedure was declared on — the session requirement lives in the real
	// `protectedProcedure`, so declaring the callback on it is the property.
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
		resolveOrganizationId: vi.fn(),
		resolveOrganizationIdForCaller: mockResolveOrganizationIdForCaller,
		Permissions: {
			INTEGRATION_USE: "integration:use",
			INTEGRATION_READ: "integration:read",
			INTEGRATION_DISCONNECT: "integration:disconnect",
		},
	};
});

import { MISSING_ORGANIZATION_CONTEXT_ERROR_CODE } from "../../../../lib/missing-organization-context";
import { decodeOAuthState, encodeOAuthState } from "../../lib/oauth-state";
import { __resetInMemoryOAuthStateStoreForTests } from "../../lib/oauth-state-store";
import { genericOAuthProcedures } from "../../procedures/oauth";

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

const callback = genericOAuthProcedures.callback as unknown as Handler<
	{ code?: string; state?: string },
	{ success: boolean; message: string }
>;
const start = genericOAuthProcedures.start as unknown as Handler<
	{
		provider: string;
		redirectUri: string;
		organizationId?: string | null;
	},
	{ authorizationUrl: string }
>;

const REDIRECT_URI =
	"https://app.example.com/api/integrations/slack/oauth/callback";

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
		provider: "SLACK",
		redirectUri: REDIRECT_URI,
	});
}

/**
 * A signed state with no organization. `encodeOAuthState` no longer accepts
 * one, so this bypasses its type to stand in for a legacy in-flight state or
 * a hand-built one signed with a leaked key.
 */
function mintOrganizationlessState() {
	return encodeOAuthState({
		userId: "user-1",
		organizationId: undefined as unknown as string,
		provider: "SLACK",
		redirectUri: REDIRECT_URI,
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
	mockExchangeCodeForTokens.mockResolvedValue({
		access_token: "fresh-access",
		token_type: "bearer",
		scope: "channels:read",
	});
	mockGetUserInfo.mockResolvedValue({
		id: "U1",
		login: "example",
		name: "Example",
		email: null,
		avatarUrl: null,
	});
	mockWorkflowIntegrationFindFirst.mockResolvedValue(null);
	mockWorkflowIntegrationCreate.mockResolvedValue({ id: "wi-1" });
	mockGetDataConnectionByProvider.mockResolvedValue(null);
	mockCreateDataConnection.mockResolvedValue({ id: "dc-1" });
});

describe("integrations.oauth.callback — builder", () => {
	it("is declared on protectedProcedure, so a request without a session is refused before the handler", () => {
		expect(callback.builder).toBe("protected");
	});
});

describe("integrations.oauth.callback — session binding", () => {
	it("refuses a session that is not the user who started the flow, without exchanging the code or writing", async () => {
		const state = mintState("org-1");

		await expect(
			callback.handler({
				input: { code: "code", state },
				context: contextFor("user-2"),
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });

		expect(mockExchangeCodeForTokens).not.toHaveBeenCalled();
		expect(mockWorkflowIntegrationCreate).not.toHaveBeenCalled();
		expect(mockWorkflowIntegrationUpdate).not.toHaveBeenCalled();
		expect(mockCreateDataConnection).not.toHaveBeenCalled();
		expect(mockUpdateDataConnection).not.toHaveBeenCalled();
	});

	it("refuses when the caller no longer belongs to the organization the flow targets", async () => {
		memberOf({});
		const state = mintState("org-1");

		await expect(
			callback.handler({
				input: { code: "code", state },
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
		expect(mockExchangeCodeForTokens).not.toHaveBeenCalled();
		expect(mockWorkflowIntegrationCreate).not.toHaveBeenCalled();
	});

	it("refuses when the caller's role in the state's organization was demoted below INTEGRATION_USE after start", async () => {
		// A viewer holds no INTEGRATION_USE; `start` ran while they were a
		// member. The permission is re-derived from the CURRENT role.
		memberOf({ "org-1": "viewer" });
		const state = mintState("org-1");

		await expect(
			callback.handler({
				input: { code: "code", state },
				context: contextFor("user-1", "org-1"),
			}),
		).rejects.toMatchObject({
			code: "FORBIDDEN",
			message: expect.stringMatching(/no longer allows connecting/i),
		});

		expect(mockExchangeCodeForTokens).not.toHaveBeenCalled();
		expect(mockWorkflowIntegrationCreate).not.toHaveBeenCalled();
		expect(mockCreateDataConnection).not.toHaveBeenCalled();
	});

	it("checks the state's organization, not the session's active one, so switching to an organization where the role still holds does not complete another's flow", async () => {
		// The middleware's INTEGRATION_USE check ran against the SESSION
		// organization (org-a, where user-1 is an admin). The state targets
		// org-b, where user-1 is now a viewer. The token would land in org-b.
		memberOf({ "org-a": "admin", "org-b": "viewer" });
		const state = mintState("org-b");

		await expect(
			callback.handler({
				input: { code: "code", state },
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
		expect(mockExchangeCodeForTokens).not.toHaveBeenCalled();
		expect(mockWorkflowIntegrationCreate).not.toHaveBeenCalled();
		expect(mockCreateDataConnection).not.toHaveBeenCalled();
	});

	it("refuses a state that carries no organization before the nonce, the exchange and the write", async () => {
		// `start` can no longer mint such a state (see the start suite below).
		// A legacy one still in flight, or a hand-built one, must not land the
		// token in an organization-less row no tenant can see or revoke
		// (ADR-018): the decoder treats it as invalid, so nothing happens.
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
		expect(mockExchangeCodeForTokens).not.toHaveBeenCalled();
		expect(mockWorkflowIntegrationCreate).not.toHaveBeenCalled();
		expect(mockCreateDataConnection).not.toHaveBeenCalled();
	});

	it("stores the token under the state's user and organization when the caller is that user and a member", async () => {
		const state = mintState("org-1");

		await expect(
			callback.handler({
				input: { code: "code", state },
				context: contextFor("user-1"),
			}),
		).resolves.toMatchObject({
			success: true,
			message: "Connected Slack account: example",
		});

		expect(mockGetOrganizationMembership).toHaveBeenCalledWith(
			"org-1",
			"user-1",
		);
		expect(mockExchangeCodeForTokens).toHaveBeenCalledTimes(1);
		expect(mockWorkflowIntegrationCreate).toHaveBeenCalledTimes(1);
		expect(
			mockWorkflowIntegrationCreate.mock.calls[0]?.[0].data,
		).toMatchObject({
			userId: "user-1",
			organizationId: "org-1",
			provider: "SLACK",
			credentials: expect.stringMatching(/^enc_/),
		});
		expect(mockCreateDataConnection).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "user-1",
				organizationId: "org-1",
				provider: "SLACK",
			}),
		);
	});
});

describe("integrations.oauth.callback — single-use state", () => {
	it("refuses a replayed state before the code exchange, so nothing is written a second time", async () => {
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

		expect(mockExchangeCodeForTokens).toHaveBeenCalledTimes(1);
		expect(mockWorkflowIntegrationCreate).toHaveBeenCalledTimes(1);
		expect(mockCreateDataConnection).toHaveBeenCalledTimes(1);
	});

	it("does not spend the nonce on a refused principal, so the real user can still complete the flow", async () => {
		const state = mintState("org-1");

		await expect(
			callback.handler({
				input: { code: "code", state },
				context: contextFor("user-2"),
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });

		await expect(
			callback.handler({
				input: { code: "code", state },
				context: contextFor("user-1"),
			}),
		).resolves.toMatchObject({ success: true });
	});
});

describe("integrations.oauth.start — organization resolution", () => {
	it("is declared on tenantProtectedProcedure", () => {
		expect(start.builder).toBe("tenantProtected");
	});

	it("mounts the INTEGRATION_USE middleware with an organization required, so an explicit null is refused before the handler", () => {
		expect(startMiddlewareCalls).toContainEqual([
			"integration:use",
			expect.objectContaining({ requireOrganization: true }),
		]);
	});

	it("refuses an explicit null organization in the handler too, and mints no state", async () => {
		// The handler's own copy of the rule: with the middleware out of the
		// picture (stubbed here), resolving no organization must still refuse
		// before any state is minted, and say why in machine-readable form.
		mockResolveOrganizationIdForCaller.mockResolvedValue(undefined);

		await expect(
			start.handler({
				input: {
					provider: "SLACK",
					redirectUri: REDIRECT_URI,
					organizationId: null,
				},
				context: contextFor("user-1"),
			}),
		).rejects.toMatchObject({
			code: "FORBIDDEN",
			data: { errorCode: MISSING_ORGANIZATION_CONTEXT_ERROR_CODE },
		});

		expect(mockGetOAuthCredentialsWithDb).not.toHaveBeenCalled();
		expect(mockGenerateAuthorizationUrl).not.toHaveBeenCalled();
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
					provider: "SLACK",
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
		expect(mockGenerateAuthorizationUrl).not.toHaveBeenCalled();
	});

	it("signs the resolved, membership-checked organization into the state", async () => {
		mockResolveOrganizationIdForCaller.mockResolvedValue("org-1");
		mockGetOAuthCredentialsWithDb.mockResolvedValue({ clientId: "cid" });
		mockGenerateAuthorizationUrl.mockReturnValue(
			"https://slack.com/oauth/v2/authorize?state=x",
		);

		await expect(
			start.handler({
				input: {
					provider: "SLACK",
					redirectUri: REDIRECT_URI,
					organizationId: "org-1",
				},
				context: contextFor("user-1"),
			}),
		).resolves.toEqual({
			authorizationUrl: "https://slack.com/oauth/v2/authorize?state=x",
		});

		const signedState = mockGenerateAuthorizationUrl.mock.calls[0]?.[3];
		expect(typeof signedState).toBe("string");
		expect(decodeOAuthState(signedState as string)).toMatchObject({
			userId: "user-1",
			organizationId: "org-1",
			provider: "SLACK",
		});
	});
});
