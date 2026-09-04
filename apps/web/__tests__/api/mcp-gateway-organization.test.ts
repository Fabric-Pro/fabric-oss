/**
 * `POST /api/mcp-gateway` — a personal API key resolves to an organization,
 * and a cached session does not outlive that decision.
 *
 * The gateway has three authentication branches. An organization API key
 * carries its own tenant and a browser session carries the one the user
 * switched into; both are taken from something the server already trusts. The
 * third — a personal key — used to carry no tenant at all and hardcoded a null
 * organization. It now resolves one: either the organization the caller named
 * on the `x-organization-id` header, honoured only after this route checks
 * their membership itself, or the shared resolver's answer.
 *
 * Two things are worth saying about what these tests are for.
 *
 * The resolver's own rule — one membership resolves, several resolve to a
 * still-valid last active, everything else is an absence — is pinned by
 * `packages/database/__tests__/resolve-user-organization.test.ts`. What is
 * pinned here is what this ROUTE does with each of its three answers, which is
 * why the scenarios below are named after the user rather than after a union
 * variant.
 *
 * And the session tests are not an afterthought. Gateway sessions live for
 * twenty-four hours and used to be reused on user identity alone, so a session
 * opened before a membership change kept running in its old organization for
 * the rest of its life. Resolving per request means nothing if a day-old
 * session can ignore the result, so the reuse rules are exercised against the
 * real session store rather than a stub of it.
 */

import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const verifyUserApiKey = vi.fn();
vi.mock("@repo/api/modules/users/procedures/api-keys", () => ({
	verifyUserApiKey: (rawKey: string) => verifyUserApiKey(rawKey),
}));

const getSession = vi.fn();
vi.mock("@repo/auth", () => ({
	auth: { api: { getSession: (args: unknown) => getSession(args) } },
}));

const executePlatformTool = vi.fn();
vi.mock("@saas/mcp/lib/gateway", async () => {
	// The real session store, so the reuse rules are exercised rather than
	// described. Everything else is stubbed — this file is about which tenant a
	// request runs in, not about what the tools do with it.
	const store = await import(
		"../../modules/saas/mcp/lib/gateway/session-store"
	);
	return {
		createGatewaySession: store.createGatewaySession,
		getGatewaySession: store.getGatewaySession,
		deleteGatewaySession: store.deleteGatewaySession,
		updateSessionOrganization: store.updateSessionOrganization,
		executePlatformTool: (...args: unknown[]) =>
			executePlatformTool(...args),
		executeConnectedServerTool: vi.fn(),
		getAggregatedTools: vi
			.fn()
			.mockResolvedValue({ tools: [], servers: [] }),
	};
});

vi.mock("@saas/mcp/lib/gateway/authority-service", () => ({
	enforceAuthority: vi.fn().mockResolvedValue({ authorized: true }),
	generateRequestFingerprint: vi.fn().mockResolvedValue("fingerprint"),
	resolveProviderKeyFromToolPrefix: vi.fn().mockReturnValue(undefined),
}));

const userFindUnique = vi.fn();
const getOrganizationApiKeyByPrefix = vi.fn();
const updateOrganizationApiKeyUsage = vi.fn();
const isOrganizationMember = vi.fn();
const resolveUserOrganization = vi.fn();
vi.mock("@repo/database", () => ({
	db: { user: { findUnique: (args: unknown) => userFindUnique(args) } },
	getOrganizationApiKeyByPrefix: (prefix: string) =>
		getOrganizationApiKeyByPrefix(prefix),
	updateOrganizationApiKeyUsage: (id: string) =>
		updateOrganizationApiKeyUsage(id),
	isOrganizationMember: (userId: string, organizationId: string) =>
		isOrganizationMember(userId, organizationId),
	resolveUserOrganization: (userId: string) =>
		resolveUserOrganization(userId),
}));

const GATEWAY_URL = "http://localhost:3001/api/mcp-gateway";
const USER_ID = "user-1";
const PERSONAL_KEY = "Bearer fab_personal_key";
/** Organizations the caller belongs to in most scenarios. */
const ALPHA = "org-example-alpha";
const BETA = "org-example-beta";
/** An organization the caller never belongs to in any scenario. */
const OUTSIDE = "org-example-outside";

/** The raw organization key, its prefix, and the hash the store would hold. */
const ORG_KEY = "org_abcd_secret";
const ORG_KEY_PREFIX = "org_abcd";
const ORG_KEY_HASH = createHash("sha256").update(ORG_KEY).digest("hex");

interface DescribedUser {
	memberships: string[];
	lastActive?: string | null;
}

/**
 * The answer `resolveUserOrganization` gives for a described user, mirroring
 * the rule its own tests pin. Keeping the scenarios described as users rather
 * than as union variants is what makes "a multi-organization user whose last
 * active is stale" a readable test name.
 */
function resolutionFor(user: DescribedUser) {
	const { memberships, lastActive = null } = user;

	if (memberships.length === 0) {
		return { kind: "no_membership" as const };
	}
	if (memberships.length === 1) {
		return { kind: "resolved" as const, organizationId: memberships[0] };
	}
	if (lastActive && memberships.includes(lastActive)) {
		return { kind: "resolved" as const, organizationId: lastActive };
	}
	return { kind: "ambiguous" as const, organizationIds: memberships };
}

/**
 * Point the personal-key branch at a described user. The membership check and
 * the resolver are driven from the same membership list, so they cannot
 * disagree in a way the real database never would.
 */
function signedInAs(user: DescribedUser): void {
	verifyUserApiKey.mockResolvedValue({ valid: true, userId: USER_ID });
	resolveUserOrganization.mockImplementation(async () => resolutionFor(user));
	isOrganizationMember.mockImplementation(
		async (_userId: string, organizationId: string) =>
			user.memberships.includes(organizationId),
	);
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
	return {
		host: "localhost:3001",
		"content-type": "application/json",
		accept: "application/json",
		...extra,
	};
}

function initializeBody(): unknown {
	return {
		jsonrpc: "2.0",
		id: 1,
		method: "initialize",
		params: { protocolVersion: "2025-03-26", capabilities: {} },
	};
}

function toolCallBody(): unknown {
	return {
		jsonrpc: "2.0",
		id: 2,
		method: "tools/call",
		params: { name: "fabric_get_identity", arguments: {} },
	};
}

async function post(
	body: unknown,
	extra: Record<string, string> = {},
): Promise<{
	response: Response;
	sessionId: string | null;
	payload: Record<string, string>;
}> {
	const { POST } = await import("../../app/api/mcp-gateway/route");
	const response = await POST(
		new Request(GATEWAY_URL, {
			method: "POST",
			headers: headers(extra),
			body: JSON.stringify(body),
		}) as never,
	);

	return {
		response,
		sessionId: response.headers.get("mcp-session-id"),
		payload: await response.json(),
	};
}

/** The gateway session handed to the tool executor on the last call. */
function lastToolSession(): { organizationId: string | null; userId: string } {
	return executePlatformTool.mock.calls.at(-1)?.[2];
}

async function storedSession(sessionId: string) {
	const store = await import(
		"../../modules/saas/mcp/lib/gateway/session-store"
	);
	return store.getGatewaySession(sessionId);
}

/** Open a session with a personal key and return the id it handed out. */
async function openSession(extra: Record<string, string> = {}) {
	const { response, sessionId } = await post(initializeBody(), {
		authorization: PERSONAL_KEY,
		...extra,
	});
	expect(response.status).toBe(200);
	expect(sessionId).toBeTruthy();
	executePlatformTool.mockClear();
	return sessionId as string;
}

beforeEach(() => {
	vi.clearAllMocks();
	userFindUnique.mockResolvedValue({
		name: "Test User",
		email: "dev@example.com",
		role: "user",
	});
	getSession.mockResolvedValue(null);
	getOrganizationApiKeyByPrefix.mockResolvedValue(null);
	updateOrganizationApiKeyUsage.mockResolvedValue(undefined);
	executePlatformTool.mockResolvedValue({
		content: [{ type: "text", text: "ok" }],
	});
	signedInAs({ memberships: [ALPHA] });
});

describe("MCP gateway — a personal key resolves an organization", () => {
	it("resolves a single-organization user into that organization", async () => {
		signedInAs({ memberships: [ALPHA] });

		const sessionId = await openSession();
		const { response } = await post(toolCallBody(), {
			authorization: PERSONAL_KEY,
			"mcp-session-id": sessionId,
		});

		expect(response.status).toBe(200);
		expect(resolveUserOrganization).toHaveBeenCalledWith(USER_ID);
		expect(lastToolSession().organizationId).toBe(ALPHA);
	});

	it("resolves a multi-organization user into their last active organization", async () => {
		signedInAs({ memberships: [ALPHA, BETA], lastActive: BETA });

		const sessionId = await openSession();
		const { response } = await post(toolCallBody(), {
			authorization: PERSONAL_KEY,
			"mcp-session-id": sessionId,
		});

		expect(response.status).toBe(200);
		expect(lastToolSession().organizationId).toBe(BETA);
	});

	it("refuses a multi-organization user with no usable last active, and honours the one they then name", async () => {
		signedInAs({ memberships: [ALPHA, BETA], lastActive: null });

		const refused = await post(initializeBody(), {
			authorization: PERSONAL_KEY,
		});

		// 400: underspecified, not forbidden — see the note on the
		// no-membership test below. The hosted server answers the same.
		expect(refused.response.status).toBe(400);
		expect(refused.payload.reason).toBe("ambiguous_organization");
		// The refusal is answerable: it names the header and the organizations
		// that may be named on it.
		expect(refused.payload.error).toContain("x-organization-id");
		expect(refused.payload.error).toContain(ALPHA);
		expect(refused.payload.error).toContain(BETA);
		// Nothing carries the unresolved caller forward.
		expect(refused.sessionId).toBeNull();

		const sessionId = await openSession({ "x-organization-id": BETA });
		const { response } = await post(toolCallBody(), {
			authorization: PERSONAL_KEY,
			"x-organization-id": BETA,
			"mcp-session-id": sessionId,
		});

		expect(response.status).toBe(200);
		expect(isOrganizationMember).toHaveBeenCalledWith(USER_ID, BETA);
		expect(lastToolSession().organizationId).toBe(BETA);
	});

	it("refuses an organization the caller does not belong to", async () => {
		signedInAs({ memberships: [ALPHA, BETA], lastActive: ALPHA });

		const { response, payload, sessionId } = await post(initializeBody(), {
			authorization: PERSONAL_KEY,
			"x-organization-id": OUTSIDE,
		});

		// The check runs on this route, against the user this request
		// authenticated — not on the strength of any other route having run it.
		expect(isOrganizationMember).toHaveBeenCalledWith(USER_ID, OUTSIDE);
		expect(response.status).toBe(403);
		expect(payload.reason).toBe("not_a_member");
		expect(payload.error).toContain("not a member");
		expect(payload.error).toContain(OUTSIDE);
		// No session is handed out, so nothing carries the named tenant on.
		expect(sessionId).toBeNull();
		expect(executePlatformTool).not.toHaveBeenCalled();
		// And a named organization is never quietly swapped for the one the
		// resolver would have chosen.
		expect(resolveUserOrganization).not.toHaveBeenCalled();
	});

	it("refuses a caller with no membership, distinguishably from one who has not chosen", async () => {
		signedInAs({ memberships: [] });
		const nowhere = await post(initializeBody(), {
			authorization: PERSONAL_KEY,
		});

		expect(nowhere.response.status).toBe(403);
		expect(nowhere.payload.reason).toBe("no_membership");
		expect(nowhere.payload.error).toContain("belongs to no organization");
		// It does not send them after a header that cannot help them.
		expect(nowhere.payload.error).not.toContain("Name one on");
		expect(nowhere.sessionId).toBeNull();

		signedInAs({ memberships: [ALPHA, BETA], lastActive: null });
		const unchosen = await post(initializeBody(), {
			authorization: PERSONAL_KEY,
		});

		// 400, not 403: this request is underspecified rather than forbidden —
		// the caller names one of their own organizations on the header and it
		// succeeds. The hosted server answers the same way, and the two must
		// not drift.
		expect(unchosen.response.status).toBe(400);
		expect(unchosen.payload.reason).toBe("ambiguous_organization");
		expect(unchosen.payload.error).not.toBe(nowhere.payload.error);
	});

	it("takes an organization key's tenant from the key record, header or no header", async () => {
		getOrganizationApiKeyByPrefix.mockResolvedValue({
			id: "key-1",
			isActive: true,
			expiresAt: null,
			keyHash: ORG_KEY_HASH,
			organizationId: ALPHA,
			createdByUserId: USER_ID,
		});
		isOrganizationMember.mockResolvedValue(true);

		const { response, sessionId } = await post(initializeBody(), {
			authorization: `Bearer ${ORG_KEY}`,
			"x-organization-id": OUTSIDE,
		});

		expect(response.status).toBe(200);
		expect(getOrganizationApiKeyByPrefix).toHaveBeenCalledWith(
			ORG_KEY_PREFIX,
		);
		// The resolver is not asked — the key names its own tenant, and the
		// header is ignored, which is what this test is really about.
		expect(resolveUserOrganization).not.toHaveBeenCalled();

		await post(toolCallBody(), {
			authorization: `Bearer ${ORG_KEY}`,
			"x-organization-id": OUTSIDE,
			"mcp-session-id": sessionId as string,
		});

		expect(lastToolSession().organizationId).toBe(ALPHA);
	});

	// This test previously asserted the opposite — that membership was NEVER
	// checked on the organization-key branch, on the reasoning that a key
	// carrying its own tenant had nothing left to verify. That is true of the
	// tenant and false of the person: the key outlived its creator's
	// membership, so removing someone from the organization left every key
	// they had minted working until a human found and deleted the row.
	// Membership is now re-read on every request (Fizzy #2380).
	it("refuses an organization key whose creator has left the organization", async () => {
		getOrganizationApiKeyByPrefix.mockResolvedValue({
			id: "key-1",
			isActive: true,
			expiresAt: null,
			keyHash: ORG_KEY_HASH,
			organizationId: ALPHA,
			createdByUserId: USER_ID,
		});
		isOrganizationMember.mockResolvedValue(false);

		const { response } = await post(initializeBody(), {
			authorization: `Bearer ${ORG_KEY}`,
		});

		expect(isOrganizationMember).toHaveBeenCalledWith(USER_ID, ALPHA);
		// 401, the same answer a revoked or expired key gets: a caller holding
		// a departed member's still-valid secret learns nothing about which of
		// the two happened.
		expect(response.status).toBe(401);
	});

	// This asserted that such a session stayed in no organization and the
	// resolver was never asked — correct while personal context was somewhere a
	// browser could legitimately sit, and the comment here said retargeting
	// belonged with the removal work. This is that work. FR4 admits no code
	// path resolving to no organization, and this branch was the last one.
	it("resolves a browser session that names no organization", async () => {
		signedInAs({ memberships: [ALPHA] });
		getSession.mockResolvedValue({
			user: { id: USER_ID, name: "Test User", email: "dev@example.com" },
			session: { activeOrganizationId: null },
		});

		const { response, sessionId } = await post(initializeBody(), {});

		expect(response.status).toBe(200);
		expect(resolveUserOrganization).toHaveBeenCalledWith(USER_ID);

		await post(toolCallBody(), {
			"mcp-session-id": sessionId as string,
		});

		expect(lastToolSession().organizationId).toBe(ALPHA);
	});

	it("refuses a browser session naming none when the caller belongs nowhere", async () => {
		signedInAs({ memberships: [] });
		getSession.mockResolvedValue({
			user: { id: USER_ID, name: "Test User", email: "dev@example.com" },
			session: { activeOrganizationId: null },
		});

		const { response } = await post(initializeBody(), {});

		expect(response.status).toBe(403);
	});

	// Fail-closed rather than picking one — guessing would run the caller's
	// tools in a tenant they never named.
	it("refuses a browser session naming none when the choice is ambiguous", async () => {
		signedInAs({ memberships: [ALPHA, BETA] });
		getSession.mockResolvedValue({
			user: { id: USER_ID, name: "Test User", email: "dev@example.com" },
			session: { activeOrganizationId: null },
		});

		const { response } = await post(initializeBody(), {});

		expect(response.status).toBe(400);
	});
});

describe("MCP gateway — a session does not outlive its organization", () => {
	it("reuses a session while it still agrees with what the request resolves to", async () => {
		signedInAs({ memberships: [ALPHA] });
		const sessionId = await openSession();

		const { response, sessionId: served } = await post(toolCallBody(), {
			authorization: PERSONAL_KEY,
			"mcp-session-id": sessionId,
		});

		expect(response.status).toBe(200);
		expect(served).toBe(sessionId);
		expect(lastToolSession().organizationId).toBe(ALPHA);
	});

	it("rejects a session whose stored organization differs from the resolved one", async () => {
		signedInAs({ memberships: [ALPHA, BETA], lastActive: ALPHA });
		const sessionId = await openSession();

		// The caller's last active organization moves while the session lives.
		signedInAs({ memberships: [ALPHA, BETA], lastActive: BETA });
		const { response, sessionId: served } = await post(toolCallBody(), {
			authorization: PERSONAL_KEY,
			"mcp-session-id": sessionId,
		});

		expect(response.status).toBe(200);
		expect(served).not.toBe(sessionId);
		expect(lastToolSession().organizationId).toBe(BETA);
		// The stale one is gone from the store, not merely bypassed for this
		// request.
		expect(await storedSession(sessionId)).toBeNull();
	});

	it("does not serve a session created before organizations were resolved", async () => {
		// Exactly the shape the personal-key path produced before this change:
		// a live session, this caller's own, carrying no organization at all.
		const store = await import(
			"../../modules/saas/mcp/lib/gateway/session-store"
		);
		const legacy = await store.createGatewaySession({
			userId: USER_ID,
			organizationId: null,
			userName: "Test User",
			email: "dev@example.com",
			role: "user",
		});

		signedInAs({ memberships: [ALPHA] });
		const { response, sessionId } = await post(toolCallBody(), {
			authorization: PERSONAL_KEY,
			"mcp-session-id": legacy.sessionId,
		});

		expect(response.status).toBe(200);
		expect(sessionId).not.toBe(legacy.sessionId);
		expect(lastToolSession().organizationId).toBe(ALPHA);
		expect(await storedSession(legacy.sessionId)).toBeNull();
	});

	it("stops resolving into an organization the caller has left", async () => {
		signedInAs({ memberships: [ALPHA] });
		const sessionId = await openSession();

		// Membership is revoked while the session is still live.
		signedInAs({ memberships: [] });
		const { response, payload } = await post(toolCallBody(), {
			authorization: PERSONAL_KEY,
			"mcp-session-id": sessionId,
		});

		expect(response.status).toBe(403);
		expect(payload.reason).toBe("no_membership");
		expect(executePlatformTool).not.toHaveBeenCalled();
	});

	it("does not serve a live session once the caller's selector is denied", async () => {
		signedInAs({ memberships: [ALPHA] });
		const sessionId = await openSession();

		const { response, payload } = await post(toolCallBody(), {
			authorization: PERSONAL_KEY,
			"x-organization-id": OUTSIDE,
			"mcp-session-id": sessionId,
		});

		expect(response.status).toBe(403);
		expect(payload.reason).toBe("not_a_member");
		// The stored session still names an organization this caller belongs
		// to; the point is that the refusal is not answered from it.
		expect(executePlatformTool).not.toHaveBeenCalled();
	});

	it("refuses a browser caller once the membership behind their session is gone", async () => {
		// `activeOrganizationId` is a stored field that outlives the membership
		// being revoked, so it is the one branch whose organization has to be
		// re-read. An earlier revision re-read it during session reuse, which
		// was too late to refuse: the only thing after that check was creating
		// a session in the same organization, so the revoked caller was served
		// anyway under a new id. The check now runs while authenticating, and
		// this test pins that it REFUSES rather than re-issues.
		//
		// R6's exclusion is about a NULL organization on this branch, not a
		// stale one — a browser sitting in personal context is a real place to
		// be; a browser naming an organization it was removed from is not.
		getSession.mockResolvedValue({
			user: { id: USER_ID, name: "Test User", email: "dev@example.com" },
			session: { activeOrganizationId: ALPHA },
		});
		isOrganizationMember.mockResolvedValue(true);

		const { sessionId } = await post(initializeBody(), {});
		expect(sessionId).toBeTruthy();

		isOrganizationMember.mockResolvedValue(false);
		const { response, payload } = await post(toolCallBody(), {
			"mcp-session-id": sessionId as string,
		});

		expect(response.status).toBe(403);
		expect(payload.reason).toBe("not_a_member");
		expect(executePlatformTool).not.toHaveBeenCalled();
	});
});

describe("MCP gateway — a tool executor failure is logged safely", () => {
	it("logs the tool name as a structured object argument, never in the message or a %s placeholder (js/log-injection)", async () => {
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		signedInAs({ memberships: [ALPHA] });
		const sessionId = await openSession();
		executePlatformTool.mockRejectedValueOnce(new Error("boom"));

		const { response, payload } = await post(toolCallBody(), {
			authorization: PERSONAL_KEY,
			"mcp-session-id": sessionId,
		});

		// The route swallows the executor error into a JSON-RPC success whose
		// result carries isError: true — it does not propagate as an HTTP error.
		expect(response.status).toBe(200);
		const rpcResult = (
			payload as unknown as { result: { isError: boolean } }
		).result;
		expect(rpcResult.isError).toBe(true);

		const call = consoleError.mock.calls.find(([msg]) =>
			typeof msg === "string" ? msg.includes("tools/call") : false,
		);
		expect(call).toBeDefined();
		const [message, ...args] = call as unknown[];
		// The tool name from toolCallBody() ("fabric_get_identity") must arrive
		// as a structured argument, not interpolated into the message (a %s
		// placeholder counts as interpolation for CodeQL js/log-injection).
		expect(message).not.toContain("fabric_get_identity");
		expect(args).toContainEqual({ toolName: "fabric_get_identity" });

		consoleError.mockRestore();
	});
});
