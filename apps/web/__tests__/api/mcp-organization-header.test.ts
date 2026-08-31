/**
 * `POST|DELETE /mcp` — how the hosted protocol server decides which
 * organization a request runs in: a caller-supplied `x-organization-id` header
 * is only honoured after a membership check, a request that supplies nothing
 * resolves through the shared helper, and a stored session is only reused
 * while both still hold.
 *
 * The hosted protocol server has three authentication branches. Two take the
 * tenant from something the server already trusts: an organization API key
 * carries its own organization, and a browser session carries an
 * `activeOrganizationId` that was validated when the user switched into it.
 * The third — a personal API key — takes the tenant from a request header, so
 * that branch is the one that has to verify the caller is a member of what
 * they named, and the one that has to answer for a request naming nothing.
 *
 * That last case used to resolve to no organization at all, and the first
 * suite below pinned it as untouched while the membership check shipped
 * alone. R4b replaced it: a key-authenticated caller no longer runs without a
 * tenant. The assertion moved with the behaviour rather than being weakened —
 * it now lives in the "no organization supplied" suite, which owns that
 * branch end to end.
 *
 * The refusal is deliberately its own outcome rather than "no authentication".
 * Absent authentication on this route means "serve a public session", and
 * every path that reads a stored session falls back to that stored session
 * when fresh authentication produces nothing — so a refusal shaped like an
 * absence would be answered by serving the caller the tenant their session was
 * created with. These tests assert the refusal on the session-READ paths, not
 * only on the one that creates a session.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@fabricorg/mcp-server", () => ({
	UpstashSessionStore: vi.fn(),
}));

const verifyUserApiKey = vi.fn();
vi.mock("@repo/api/modules/users/procedures/api-keys", () => ({
	verifyUserApiKey: (rawKey: string) => verifyUserApiKey(rawKey),
}));

const getSession = vi.fn();
vi.mock("@repo/auth", () => ({
	auth: { api: { getSession: (args: unknown) => getSession(args) } },
}));

vi.mock("@repo/temporal", () => ({ getTemporalClient: vi.fn() }));

const executePlatformTool = vi.fn();
vi.mock("@saas/mcp/lib/gateway/platform-tools", () => ({
	executePlatformTool: (...args: unknown[]) => executePlatformTool(...args),
	PLATFORM_TOOL_DEFINITIONS: [
		{
			name: "fabric_get_identity",
			description: "Returns the session identity.",
			inputSchema: { type: "object", properties: {} },
		},
	],
}));

const organizationApiKeyFindFirst = vi.fn();
const userFindUnique = vi.fn();
const isOrganizationMember = vi.fn();
const resolveUserOrganization = vi.fn();
vi.mock("@repo/database", () => ({
	db: {
		organizationApiKey: {
			findFirst: (args: unknown) => organizationApiKeyFindFirst(args),
			update: vi.fn().mockResolvedValue({}),
		},
		user: { findUnique: (args: unknown) => userFindUnique(args) },
	},
	isOrganizationMember: (userId: string, organizationId: string) =>
		isOrganizationMember(userId, organizationId),
	resolveUserOrganization: (userId: string) =>
		resolveUserOrganization(userId),
}));

const recordAuditFromRequest = vi.fn();
vi.mock("@repo/api/lib/audit", () => ({
	recordAuditFromRequest: (...args: unknown[]) =>
		recordAuditFromRequest(...args),
}));

const MCP_URL = "http://localhost:3001/mcp";
const MEMBER_ORG = "org-example-alpha";
const OUTSIDE_ORG = "org-example-beta";
const SECOND_ORG = "org-example-gamma";

function headers(extra: Record<string, string> = {}): Record<string, string> {
	return {
		// The transport's DNS-rebinding protection reads `host`; without it
		// every request is refused before reaching a handler.
		host: "localhost:3001",
		"content-type": "application/json",
		accept: "application/json, text/event-stream",
		...extra,
	};
}

function initializeBody(): string {
	return JSON.stringify({
		jsonrpc: "2.0",
		id: 1,
		method: "initialize",
		params: {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "test-client", version: "1.0.0" },
		},
	});
}

function toolCallBody(): string {
	return JSON.stringify({
		jsonrpc: "2.0",
		id: 2,
		method: "tools/call",
		params: { name: "fabric_get_identity", arguments: {} },
	});
}

/** Pull the single JSON-RPC payload out of an SSE response body. */
function readSsePayload(body: string): Record<string, unknown> {
	const line = body
		.split("\n")
		.find((candidate) => candidate.startsWith("data:"));
	return JSON.parse(line?.slice("data:".length).trim() ?? "{}");
}

async function loadRoute() {
	return import("../../app/mcp/route");
}

/**
 * Run the initialize handshake and return the response plus the session id it
 * handed out (null when the request was refused before a session existed).
 */
async function initialize(
	requestHeaders: Record<string, string>,
): Promise<{ response: Response; sessionId: string | null; body: string }> {
	const { POST } = await loadRoute();
	const response = await POST(
		new Request(MCP_URL, {
			method: "POST",
			headers: headers(requestHeaders),
			body: initializeBody(),
		}) as never,
	);
	const body = await response.text();
	return {
		response,
		sessionId: response.headers.get("mcp-session-id"),
		body,
	};
}

/** The gateway session handed to the tool executor on the last call. */
function lastToolSession(): { organizationId: string | null; userId: string } {
	const call = executePlatformTool.mock.calls.at(-1);
	return call?.[2];
}

describe("hosted MCP server — caller-supplied organization", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// Force the in-memory session fallback; the Upstash store is not
		// exercised here and the route caches its absence on first use.
		vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
		vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");

		organizationApiKeyFindFirst.mockResolvedValue(null);
		userFindUnique.mockResolvedValue({
			name: "Test User",
			email: "dev@example.com",
			role: "user",
		});
		verifyUserApiKey.mockResolvedValue({ valid: true, userId: "user-1" });
		getSession.mockResolvedValue(null);
		isOrganizationMember.mockResolvedValue(true);
		resolveUserOrganization.mockResolvedValue({
			kind: "resolved",
			organizationId: MEMBER_ORG,
		});
		executePlatformTool.mockResolvedValue({
			content: [{ type: "text", text: "ok" }],
		});
	});

	it("resolves to an organization the caller belongs to", async () => {
		const { POST } = await loadRoute();
		const { response, sessionId } = await initialize({
			authorization: "Bearer personal-key",
			"x-organization-id": MEMBER_ORG,
		});

		expect(response.status).toBe(200);
		expect(sessionId).toBeTruthy();
		expect(isOrganizationMember).toHaveBeenCalledWith("user-1", MEMBER_ORG);

		const call = await POST(
			new Request(MCP_URL, {
				method: "POST",
				headers: headers({
					authorization: "Bearer personal-key",
					"x-organization-id": MEMBER_ORG,
					"mcp-session-id": sessionId as string,
				}),
				body: toolCallBody(),
			}) as never,
		);

		expect(call.status).toBe(200);
		expect(executePlatformTool).toHaveBeenCalledTimes(1);
		expect(lastToolSession().organizationId).toBe(MEMBER_ORG);
	});

	it("refuses an organization the caller does not belong to", async () => {
		isOrganizationMember.mockResolvedValue(false);

		const { response, body, sessionId } = await initialize({
			authorization: "Bearer personal-key",
			"x-organization-id": OUTSIDE_ORG,
		});

		expect(isOrganizationMember).toHaveBeenCalledWith(
			"user-1",
			OUTSIDE_ORG,
		);
		expect(response.status).toBe(403);
		// No session is handed out, so nothing carries the named tenant
		// forward.
		expect(sessionId).toBeNull();
		expect(JSON.parse(body).error.message).toContain("Access denied");
		expect(executePlatformTool).not.toHaveBeenCalled();
	});

	it("records the refusal in the audit ledger", async () => {
		isOrganizationMember.mockResolvedValue(false);

		await initialize({
			authorization: "Bearer personal-key",
			"x-organization-id": OUTSIDE_ORG,
		});

		// The audit write is dispatched through a dynamic import, so it lands
		// on a later microtask than the response.
		await vi.waitFor(() =>
			expect(recordAuditFromRequest).toHaveBeenCalledTimes(1),
		);

		const [context, input] = recordAuditFromRequest.mock.calls[0];
		expect(context.user).toMatchObject({ id: "user-1" });
		expect(input).toMatchObject({
			action: "mcp.session.organization_denied",
			category: "mcp",
			outcome: "failure",
			// Never attributed to the organization that was named — the caller
			// has no standing in it, so the row must not surface in its log.
			organizationId: null,
		});
		expect(input.metadata.requestedOrganizationId).toBe(OUTSIDE_ORG);
	});

	it("takes the organization from an organization key, not the header", async () => {
		organizationApiKeyFindFirst.mockResolvedValue({
			id: "key-1",
			organizationId: MEMBER_ORG,
			createdByUserId: "user-1",
		});

		const { POST } = await loadRoute();
		const { response, sessionId } = await initialize({
			authorization: "Bearer org-key",
			"x-organization-id": OUTSIDE_ORG,
		});

		expect(response.status).toBe(200);
		expect(isOrganizationMember).not.toHaveBeenCalled();

		const call = await POST(
			new Request(MCP_URL, {
				method: "POST",
				headers: headers({
					authorization: "Bearer org-key",
					"x-organization-id": OUTSIDE_ORG,
					"mcp-session-id": sessionId as string,
				}),
				body: toolCallBody(),
			}) as never,
		);

		expect(call.status).toBe(200);
		expect(lastToolSession().organizationId).toBe(MEMBER_ORG);
	});

	it("still serves an unauthenticated caller a public session", async () => {
		const { response, sessionId, body } = await initialize({});

		// 200 with a session, not the 403 a refusal produces — the two
		// outcomes stay distinguishable to the caller.
		expect(response.status).toBe(200);
		expect(sessionId).toBeTruthy();
		const payload = readSsePayload(body) as {
			result: { instructions: string };
		};
		expect(payload.result.instructions).toContain("public");
		expect(isOrganizationMember).not.toHaveBeenCalled();
	});
});

describe("hosted MCP server — stored sessions re-check the caller", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
		vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
		organizationApiKeyFindFirst.mockResolvedValue(null);
		userFindUnique.mockResolvedValue({
			name: "Test User",
			email: "dev@example.com",
			role: "user",
		});
		verifyUserApiKey.mockResolvedValue({ valid: true, userId: "user-1" });
		getSession.mockResolvedValue(null);
		isOrganizationMember.mockResolvedValue(true);
		resolveUserOrganization.mockResolvedValue({
			kind: "resolved",
			organizationId: MEMBER_ORG,
		});
		executePlatformTool.mockResolvedValue({
			content: [{ type: "text", text: "ok" }],
		});
	});

	/** Establish a live session on an organization the caller belongs to. */
	async function establishedSession(): Promise<string> {
		const { sessionId } = await initialize({
			authorization: "Bearer personal-key",
			"x-organization-id": MEMBER_ORG,
		});
		expect(sessionId).toBeTruthy();
		executePlatformTool.mockClear();
		return sessionId as string;
	}

	it("stops serving a live session once the caller is refused", async () => {
		const sessionId = await establishedSession();
		isOrganizationMember.mockResolvedValue(false);

		const { POST } = await loadRoute();
		const call = await POST(
			new Request(MCP_URL, {
				method: "POST",
				headers: headers({
					authorization: "Bearer personal-key",
					"x-organization-id": MEMBER_ORG,
					"mcp-session-id": sessionId,
				}),
				body: toolCallBody(),
			}) as never,
		);

		expect(call.status).toBe(403);
		// The stored session still names the organization it was created
		// with; the point is that it is not served from.
		expect(executePlatformTool).not.toHaveBeenCalled();
	});

	it("refuses a live session on the unparseable-body path too", async () => {
		const sessionId = await establishedSession();
		isOrganizationMember.mockResolvedValue(false);

		const { POST } = await loadRoute();
		const response = await POST(
			new Request(MCP_URL, {
				method: "POST",
				headers: headers({
					authorization: "Bearer personal-key",
					"x-organization-id": MEMBER_ORG,
					"mcp-session-id": sessionId,
				}),
				body: "not json",
			}) as never,
		);

		expect(response.status).toBe(403);
		expect(executePlatformTool).not.toHaveBeenCalled();
	});

	it("refuses a live session on the delete path too", async () => {
		const sessionId = await establishedSession();
		isOrganizationMember.mockResolvedValue(false);

		const { DELETE } = await loadRoute();
		const response = await DELETE(
			new Request(MCP_URL, {
				method: "DELETE",
				headers: headers({
					authorization: "Bearer personal-key",
					"x-organization-id": MEMBER_ORG,
					"mcp-session-id": sessionId,
				}),
			}) as never,
		);

		expect(response.status).toBe(403);
	});

	it("stops serving a live session when the request stops authenticating", async () => {
		const sessionId = await establishedSession();

		const { POST } = await loadRoute();
		const call = await POST(
			new Request(MCP_URL, {
				method: "POST",
				headers: headers({ "mcp-session-id": sessionId }),
				body: toolCallBody(),
			}) as never,
		);

		// Previously the absent fresh result meant "fall back to the stored
		// session", which let the tenancy decision taken at creation outlive
		// every later re-evaluation of it.
		expect(call.status).toBe(401);
		expect(executePlatformTool).not.toHaveBeenCalled();
	});

	it("keeps serving a live session while the caller still checks out", async () => {
		const sessionId = await establishedSession();

		const { POST } = await loadRoute();
		const call = await POST(
			new Request(MCP_URL, {
				method: "POST",
				headers: headers({
					authorization: "Bearer personal-key",
					"x-organization-id": MEMBER_ORG,
					"mcp-session-id": sessionId,
				}),
				body: toolCallBody(),
			}) as never,
		);

		expect(call.status).toBe(200);
		expect(lastToolSession().organizationId).toBe(MEMBER_ORG);
	});
});

/**
 * The branch that supplies no organization at all.
 *
 * A personal API key carries a user and nothing else, so this is where the
 * shared resolver in `@repo/database` answers "which organization". The rule
 * it applies — one membership, or a last-active organization the caller still
 * belongs to, and nothing otherwise — is pinned by that helper's own suite at
 * `packages/database/__tests__/resolve-user-organization.test.ts`. What is
 * asserted here is what this route does with each answer, which is the half
 * the helper cannot see: a resolution is honoured, and both absences refuse
 * rather than quietly serving a session with no tenant.
 *
 * The two refusals stay distinguishable to the caller, because their remedies
 * are different: a caller in several organizations fixes their request by
 * naming one, a caller in none cannot fix it at all.
 */
describe("hosted MCP server — no organization supplied", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
		vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
		organizationApiKeyFindFirst.mockResolvedValue(null);
		userFindUnique.mockResolvedValue({
			name: "Test User",
			email: "dev@example.com",
			role: "user",
		});
		verifyUserApiKey.mockResolvedValue({ valid: true, userId: "user-1" });
		getSession.mockResolvedValue(null);
		isOrganizationMember.mockResolvedValue(true);
		resolveUserOrganization.mockResolvedValue({
			kind: "resolved",
			organizationId: MEMBER_ORG,
		});
		executePlatformTool.mockResolvedValue({
			content: [{ type: "text", text: "ok" }],
		});
	});

	/** Initialize with a personal key and run one tool call on the session. */
	async function callToolWithKey(
		extraHeaders: Record<string, string> = {},
	): Promise<Response> {
		const { POST } = await loadRoute();
		const { sessionId } = await initialize({
			authorization: "Bearer personal-key",
			...extraHeaders,
		});
		expect(sessionId).toBeTruthy();

		return POST(
			new Request(MCP_URL, {
				method: "POST",
				headers: headers({
					authorization: "Bearer personal-key",
					...extraHeaders,
					"mcp-session-id": sessionId as string,
				}),
				body: toolCallBody(),
			}) as never,
		);
	}

	it("runs a caller's only membership, not personal context", async () => {
		const call = await callToolWithKey();

		expect(call.status).toBe(200);
		expect(resolveUserOrganization).toHaveBeenCalledWith("user-1");
		// Nothing was named, so there was nothing to membership-check; the
		// resolver only ever returns organizations the caller belongs to.
		expect(isOrganizationMember).not.toHaveBeenCalled();
		expect(lastToolSession().organizationId).toBe(MEMBER_ORG);
	});

	it("runs a multi-organization caller in their last active organization", async () => {
		// Which of several organizations wins is the helper's decision, and its
		// own suite pins that last-active is it. From here the observable
		// contract is narrower and still worth holding: whatever comes back as
		// `resolved` is what the session runs in.
		resolveUserOrganization.mockResolvedValue({
			kind: "resolved",
			organizationId: SECOND_ORG,
		});

		const call = await callToolWithKey();

		expect(call.status).toBe(200);
		expect(lastToolSession().organizationId).toBe(SECOND_ORG);
	});

	it("refuses a caller who belongs to several and named none", async () => {
		resolveUserOrganization.mockResolvedValue({
			kind: "ambiguous",
			organizationIds: [MEMBER_ORG, SECOND_ORG],
		});

		const { response, body, sessionId } = await initialize({
			authorization: "Bearer personal-key",
		});

		// 400, not 403: the credentials are fine and the caller can fix this
		// themselves by naming one of their own organizations.
		expect(response.status).toBe(400);
		expect(sessionId).toBeNull();
		const message = JSON.parse(body).error.message as string;
		// The remedy is spelled out, with the organizations that satisfy it.
		expect(message).toContain("x-organization-id");
		expect(message).toContain(MEMBER_ORG);
		expect(message).toContain(SECOND_ORG);
		expect(executePlatformTool).not.toHaveBeenCalled();
	});

	it("refuses a caller with no membership, distinguishably", async () => {
		resolveUserOrganization.mockResolvedValue({ kind: "no_membership" });

		const withoutMembership = await initialize({
			authorization: "Bearer personal-key",
		});

		expect(withoutMembership.response.status).toBe(403);
		expect(withoutMembership.sessionId).toBeNull();
		const message = JSON.parse(withoutMembership.body).error
			.message as string;
		expect(message).toContain("belongs to none");
		// Nothing to name, so nothing is offered to name.
		expect(message).not.toContain("x-organization-id");
		// And nothing to retry, so no retry is invited — the caller here is a
		// model, and an instruction it can only obey by repeating the same
		// failing call is a loop, not guidance.
		expect(message).not.toMatch(/retry/i);

		resolveUserOrganization.mockResolvedValue({
			kind: "ambiguous",
			organizationIds: [MEMBER_ORG, SECOND_ORG],
		});
		const ambiguous = await initialize({
			authorization: "Bearer personal-key",
		});

		// "Nowhere to go" and "has not said where" reach the caller as
		// different answers, in both the status and the text. Collapsed into
		// one they would read as the same dead end, and only one of them is.
		expect(ambiguous.response.status).not.toBe(
			withoutMembership.response.status,
		);
		expect(JSON.parse(ambiguous.body).error.message).not.toBe(message);
	});

	it("does not consult the helper when the caller names an organization", async () => {
		const call = await callToolWithKey({ "x-organization-id": MEMBER_ORG });

		expect(call.status).toBe(200);
		expect(isOrganizationMember).toHaveBeenCalledWith("user-1", MEMBER_ORG);
		expect(resolveUserOrganization).not.toHaveBeenCalled();
		expect(lastToolSession().organizationId).toBe(MEMBER_ORG);
	});

	it("still serves an unauthenticated caller a public session", async () => {
		const { response, sessionId, body } = await initialize({});

		expect(response.status).toBe(200);
		expect(sessionId).toBeTruthy();
		const payload = readSsePayload(body) as {
			result: { instructions: string };
		};
		expect(payload.result.instructions).toContain("public");
		// No user, therefore no membership to resolve — asking the helper here
		// would mean inventing an identity to ask it for.
		expect(resolveUserOrganization).not.toHaveBeenCalled();
	});
});

/**
 * The browser-session branch, which is excluded from organization-only
 * resolution on purpose (Fizzy #1875, R6). A session carries the organization
 * the user switched into, including none at all, and while personal context
 * still exists that is a legitimate place for a browser session to sit.
 * Retargeting it belongs with the removal of personal context, not here — so
 * these two tests exist to catch that branch being "fixed" early.
 */
describe("hosted MCP server — browser sessions keep their own organization", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
		vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
		organizationApiKeyFindFirst.mockResolvedValue(null);
		userFindUnique.mockResolvedValue({
			name: "Test User",
			email: "dev@example.com",
			role: "user",
		});
		verifyUserApiKey.mockResolvedValue({ valid: false });
		isOrganizationMember.mockResolvedValue(true);
		resolveUserOrganization.mockResolvedValue({
			kind: "resolved",
			organizationId: MEMBER_ORG,
		});
		executePlatformTool.mockResolvedValue({
			content: [{ type: "text", text: "ok" }],
		});
	});

	/** A browser session sitting in `activeOrganizationId`. */
	function browserSession(activeOrganizationId: string | null): void {
		getSession.mockResolvedValue({
			user: {
				id: "user-browser",
				name: "Browser User",
				email: "dev@example.com",
				role: "user",
			},
			session: { activeOrganizationId },
		});
	}

	/** Initialize from a browser session and run one tool call on it. */
	async function callToolWithSession(): Promise<Response> {
		const { POST } = await loadRoute();
		const { sessionId } = await initialize({});
		expect(sessionId).toBeTruthy();

		return POST(
			new Request(MCP_URL, {
				method: "POST",
				headers: headers({ "mcp-session-id": sessionId as string }),
				body: toolCallBody(),
			}) as never,
		);
	}

	it("runs in the organization the session is in", async () => {
		browserSession(MEMBER_ORG);

		const call = await callToolWithSession();

		expect(call.status).toBe(200);
		expect(lastToolSession().organizationId).toBe(MEMBER_ORG);
		expect(resolveUserOrganization).not.toHaveBeenCalled();
	});

	// This asserted the opposite until personal context was removed: a session
	// naming no organization stayed in none, and the resolver was not consulted.
	// That was right while personal context was somewhere a browser could be.
	// FR4 admits no code path that resolves to no organization, and this branch
	// was the last one — so a session naming nothing now asks the same shared
	// resolver the key branch asks.
	it("resolves a session that names no organization, rather than running in none", async () => {
		browserSession(null);
		resolveUserOrganization.mockResolvedValue({
			kind: "resolved",
			organizationId: MEMBER_ORG,
		});

		const call = await callToolWithSession();

		expect(call.status).toBe(200);
		expect(lastToolSession().organizationId).toBe(MEMBER_ORG);
		expect(resolveUserOrganization).toHaveBeenCalledWith("user-browser");
	});

	it("refuses a session that names none when the caller belongs nowhere", async () => {
		browserSession(null);
		resolveUserOrganization.mockResolvedValue({ kind: "no_membership" });

		const { POST } = await loadRoute();
		const response = await POST(
			new Request(MCP_URL, {
				method: "POST",
				headers: headers({}),
				body: initializeBody(),
			}) as never,
		);

		expect(response.status).toBe(403);
		expect(JSON.parse(await response.text()).error.data.reason).toBe(
			"no_membership",
		);
	});

	// Fail-closed rather than picking one: an ambiguous caller under-specified
	// the request, and guessing would run their tools in a tenant they did not
	// name.
	it("refuses a session that names none when the choice is ambiguous", async () => {
		browserSession(null);
		resolveUserOrganization.mockResolvedValue({
			kind: "ambiguous",
			organizationIds: [MEMBER_ORG, "org-other"],
		});

		const { POST } = await loadRoute();
		const response = await POST(
			new Request(MCP_URL, {
				method: "POST",
				headers: headers({}),
				body: initializeBody(),
			}) as never,
		);

		expect(response.status).toBe(400);
		expect(JSON.parse(await response.text()).error.data.reason).toBe(
			"ambiguous_organization",
		);
	});

	it("refuses a browser session whose membership has been revoked", async () => {
		// `activeOrganizationId` is stored, so it survives the membership going
		// away. This branch takes its organization from neither the caller nor
		// a fresh derivation, which makes it the only one here that has to
		// re-read — and the gateway re-reads it too. Two entry points
		// disagreeing about whether a removed member still has access would be
		// the worst shape that divergence could take.
		browserSession(MEMBER_ORG);
		isOrganizationMember.mockResolvedValue(false);

		const { POST } = await loadRoute();
		const response = await POST(
			new Request(MCP_URL, {
				method: "POST",
				headers: headers({}),
				body: initializeBody(),
			}) as never,
		);

		expect(response.status).toBe(403);
		expect(JSON.parse(await response.text()).error.data.reason).toBe(
			"not_a_member",
		);
		expect(executePlatformTool).not.toHaveBeenCalled();
	});

	it("does not re-read membership for a session in personal context", async () => {
		// Nothing to confirm — there is no membership behind a null
		// organization, so the branch must not spend a query pretending there
		// is, and must certainly not refuse.
		browserSession(null);
		isOrganizationMember.mockResolvedValue(false);

		const call = await callToolWithSession();

		expect(call.status).toBe(200);
		expect(isOrganizationMember).not.toHaveBeenCalled();
	});
});
