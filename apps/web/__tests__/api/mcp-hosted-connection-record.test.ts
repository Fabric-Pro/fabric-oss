/**
 * `POST|GET|DELETE /mcp` — the hosted protocol server writes the same
 * connection record the gateway does (Fizzy #2457, R2/R25/R32).
 *
 * The two hosts do NOT converge on one point, and this file exists because of
 * that: this route calls its own `authenticateRequest` from three places, one
 * per verb, and the POST handler alone reaches the server down four branches —
 * so the record has six call sites here against the gateway's one. A regression
 * that drops any of them is invisible from the gateway suite.
 *
 * WHEN the POST records is pinned here too. The handler authenticates long
 * before it decides whether the request may be served: `checkStoredSessionAuth`
 * refuses a session whose live identity no longer matches it, on two of those
 * branches. A record written ahead of that gate is written for a request
 * answered 401 — and `OrganizationCliFirstReach` is never invalidated, so one
 * such row marks an organization connected forever.
 *
 * Two things are specific to this host. It has an ANONYMOUS fall-through — no
 * credentials is a normal outcome served as a public session, not a 401 — and
 * an organization key whose owner has left falls through to that same public
 * session rather than refusing. Both are requests this server happily answers
 * and neither is a CLI, so both must write nothing.
 *
 * The record is scheduled through `runInBackground` rather than floated, so the
 * serverless invocation stays alive until the write lands — a dropped write
 * leaves the organization reading as disconnected forever. With the record
 * written from that many places on this host, the scheduler is mocked and
 * asserted here too.
 *
 * `GET` is driven through `getConformance`. The public `GET` export answers 405
 * without authenticating (issue #2254), so the conformance entry point is the
 * only way to reach `handleGetRequest` — the call site under test — at all.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { CLI_FIRST_REACH_EVENT } from "../../modules/saas/mcp/lib/record-cli-reach";

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

vi.mock("@repo/api/lib/audit", () => ({ recordAuditFromRequest: vi.fn() }));

const organizationApiKeyFindFirst = vi.fn();
const organizationApiKeyUpdate = vi.fn();
const userFindUnique = vi.fn();
const isOrganizationMember = vi.fn();
const resolveUserOrganization = vi.fn();
const recordOrganizationCliReach = vi.fn();
/** Defaults to a live tenant; one case below deactivates it. */
const isOrganizationLive = vi.fn(async () => true);
vi.mock("@repo/database", () => ({
	db: {
		organizationApiKey: {
			findFirst: (args: unknown) => organizationApiKeyFindFirst(args),
			update: (args: unknown) => organizationApiKeyUpdate(args),
		},
		user: { findUnique: (args: unknown) => userFindUnique(args) },
	},
	isOrganizationMember: (userId: string, organizationId: string) =>
		isOrganizationMember(userId, organizationId),
	resolveUserOrganization: (userId: string) =>
		resolveUserOrganization(userId),
	// The deactivated-organization gate (Fizzy #2462) runs before this route
	// hands anything to the MCP server. A spy rather than a constant, because a
	// deleted tenant must not leave a connection record either.
	isOrganizationLive: (organizationId: string) =>
		isOrganizationLive(organizationId),
	recordOrganizationCliReach: (args: unknown) =>
		recordOrganizationCliReach(args),
}));

/**
 * The scheduler the recording goes through, mocked so this suite can assert it
 * was USED. The stand-in registers the same rejection handler the real helper
 * registers, so a failing write is handled here exactly as it is in production
 * and no rejection escapes into the run.
 */
const runInBackground = vi.fn((promise: Promise<unknown>) => {
	void promise.catch(() => {});
});
vi.mock("@repo/api/modules/weave/lib/run-in-background", () => ({
	runInBackground: (promise: Promise<unknown>) => runInBackground(promise),
}));

const MCP_URL = "http://localhost:3001/mcp";
const USER_ID = "user-1";
const ALPHA = "org-example-alpha";
const BETA = "org-example-beta";
const OUTSIDE = "org-example-outside";
const ORG_KEY = "Bearer org_abcd1234_secret";
const PERSONAL_KEY = "Bearer fab_personal_key";
const ORG_KEY_ID = "orgkey-1";
const PERSONAL_KEY_ID = "userkey-1";

// ─── The fake reach store ───────────────────────────────────────────────────

let reachRows: Map<string, number>;
let firstReachRows: Set<string>;

function installReachStore(): void {
	recordOrganizationCliReach.mockImplementation(
		async (args: {
			organizationId: string;
			credentialKind: string;
			credentialId: string;
		}) => {
			const key = `${args.organizationId}|${args.credentialKind}|${args.credentialId}`;
			reachRows.set(key, (reachRows.get(key) ?? 0) + 1);
			if (firstReachRows.has(args.organizationId)) {
				return { firstReachForOrganization: false };
			}
			firstReachRows.add(args.organizationId);
			return { firstReachForOrganization: true };
		},
	);
}

function firstReachEvents(): unknown[] {
	const spy = console.info as unknown as { mock: { calls: unknown[][] } };
	return spy.mock.calls.filter((call) =>
		String(call[0]).includes(CLI_FIRST_REACH_EVENT),
	);
}

async function settled(times: number): Promise<void> {
	await vi.waitFor(() =>
		expect(recordOrganizationCliReach).toHaveBeenCalledTimes(times),
	);
}

async function noRecordWritten(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(recordOrganizationCliReach).not.toHaveBeenCalled();
	expect(reachRows.size).toBe(0);
}

// ─── Request helpers ────────────────────────────────────────────────────────

function headers(extra: Record<string, string> = {}): Record<string, string> {
	return {
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

async function loadRoute() {
	return import("../../app/mcp/route");
}

async function initialize(
	extra: Record<string, string> = {},
): Promise<{ response: Response; sessionId: string | null }> {
	const { POST } = await loadRoute();
	const response = await POST(
		new Request(MCP_URL, {
			method: "POST",
			headers: headers(extra),
			body: initializeBody(),
		}) as never,
	);
	// The transport streams; drain it so nothing is left half-read.
	await response.text();
	return { response, sessionId: response.headers.get("mcp-session-id") };
}

/** A live organization key whose creator is still a member. */
function organizationKeyIssuedFor(organizationId: string): void {
	organizationApiKeyFindFirst.mockResolvedValue({
		id: ORG_KEY_ID,
		organizationId,
		createdByUserId: USER_ID,
		scopes: ["*"],
	});
	isOrganizationMember.mockResolvedValue(true);
}

/** A browser cookie, which reaches these same endpoints with wildcard scopes. */
function browserSessionIn(organizationId: string): void {
	getSession.mockResolvedValue({
		user: {
			id: USER_ID,
			name: "Test User",
			email: "dev@example.com",
			role: "user",
		},
		session: { activeOrganizationId: organizationId },
	});
}

beforeEach(async () => {
	// The route resolves `@repo/database` through a dynamic import on every
	// request. Loading it once up front keeps the first case in the file from
	// paying for the whole module graph inside its own timeout.
	await loadRoute();

	vi.clearAllMocks();
	vi.spyOn(console, "info").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});

	// Force the in-memory session fallback; the route caches the store's
	// absence on first use.
	vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
	vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");

	reachRows = new Map();
	firstReachRows = new Set();
	installReachStore();

	organizationApiKeyFindFirst.mockResolvedValue(null);
	organizationApiKeyUpdate.mockResolvedValue({});
	userFindUnique.mockResolvedValue({
		name: "Test User",
		email: "dev@example.com",
		role: "user",
	});
	verifyUserApiKey.mockResolvedValue({
		valid: true,
		userId: USER_ID,
		keyId: PERSONAL_KEY_ID,
		scopes: ["*"],
	});
	getSession.mockResolvedValue(null);
	isOrganizationMember.mockResolvedValue(true);
	resolveUserOrganization.mockResolvedValue({
		kind: "resolved",
		organizationId: ALPHA,
	});
	executePlatformTool.mockResolvedValue({
		content: [{ type: "text", text: "ok" }],
	});
});

describe("POST records a key and nothing else", () => {
	it("records the organization key that presented the request", async () => {
		organizationKeyIssuedFor(ALPHA);

		const { response } = await initialize({ authorization: ORG_KEY });
		expect(response.status).toBe(200);
		await settled(1);

		expect(recordOrganizationCliReach).toHaveBeenCalledWith({
			organizationId: ALPHA,
			credentialKind: "ORGANIZATION_API_KEY",
			credentialId: ORG_KEY_ID,
		});
		expect(firstReachEvents()).toHaveLength(1);
	});

	it("records the organization a personal key NAMED, not its holder's default", async () => {
		// AE23. `resolveUserOrganization` would answer ALPHA; the request said
		// BETA and this server honoured it after checking membership, so BETA
		// is the organization that was reached.
		isOrganizationMember.mockResolvedValue(true);

		const { response } = await initialize({
			authorization: PERSONAL_KEY,
			"x-organization-id": BETA,
		});
		expect(response.status).toBe(200);
		await settled(1);

		expect(recordOrganizationCliReach).toHaveBeenCalledWith({
			organizationId: BETA,
			credentialKind: "USER_API_KEY",
			credentialId: PERSONAL_KEY_ID,
		});
	});

	it("keeps recording across a reused session", async () => {
		// The durable session stores neither the credential nor the key that
		// opened it, so a restored session would write nothing unless the live
		// identity is threaded back in. Two requests, one row, one event.
		organizationKeyIssuedFor(ALPHA);
		const { POST } = await loadRoute();

		const { sessionId } = await initialize({ authorization: ORG_KEY });
		expect(sessionId).toBeTruthy();
		await settled(1);

		const call = await POST(
			new Request(MCP_URL, {
				method: "POST",
				headers: headers({
					authorization: ORG_KEY,
					"mcp-session-id": sessionId as string,
				}),
				body: toolCallBody(),
			}) as never,
		);
		await call.text();
		expect(call.status).toBe(200);
		await settled(2);

		expect(reachRows.size).toBe(1);
		expect([...reachRows.values()][0]).toBe(2);
		expect(firstReachEvents()).toHaveLength(1);
	});

	it("writes nothing for a browser session", async () => {
		// AE26. Same endpoint, wildcard scopes, not a CLI.
		browserSessionIn(ALPHA);

		const { response } = await initialize();
		expect(response.status).toBe(200);
		await noRecordWritten();
	});

	it("writes nothing for the anonymous public session", async () => {
		getSession.mockResolvedValue(null);

		const { response } = await initialize();
		expect(response.status).toBe(200);
		await noRecordWritten();
	});
});

describe("the write waits for the membership check, never the usage counter", () => {
	it("writes nothing for a key whose owner has left the organization", async () => {
		// AE24. This host stamps `lastUsedAt` and `usageCount` the moment the
		// hash matches — before the owner lookup and before this check — and
		// then serves the caller a public session. The counter moved; the
		// record must not.
		organizationKeyIssuedFor(ALPHA);
		isOrganizationMember.mockResolvedValue(false);

		const { response } = await initialize({ authorization: ORG_KEY });

		expect(response.status).toBe(200);
		expect(organizationApiKeyUpdate).toHaveBeenCalledWith(
			expect.objectContaining({ where: { id: ORG_KEY_ID } }),
		);
		await noRecordWritten();
	});

	it("writes nothing for a guest refused for lack of membership", async () => {
		// AE8.
		isOrganizationMember.mockResolvedValue(false);

		const { response } = await initialize({
			authorization: PERSONAL_KEY,
			"x-organization-id": OUTSIDE,
		});

		expect(response.status).toBe(403);
		await noRecordWritten();
	});
});

describe("POST records only once the session gate has passed", () => {
	/**
	 * A durable session opened for ALPHA with a personal key, with the
	 * initialize's own record forgotten so each case below counts only what its
	 * second request wrote.
	 */
	async function sessionOpenedInAlpha(): Promise<string> {
		const { sessionId } = await initialize({ authorization: PERSONAL_KEY });
		expect(sessionId).toBeTruthy();
		await settled(1);

		recordOrganizationCliReach.mockClear();
		runInBackground.mockClear();
		reachRows.clear();
		(console.info as unknown as { mockClear: () => void }).mockClear();
		return sessionId as string;
	}

	it("writes nothing for a POST refused for a re-pointed organization", async () => {
		// The CLI keeps the session it opened for ALPHA and is re-pointed at
		// BETA — by the header here, by ALPHA membership ending in production.
		// `checkStoredSessionAuth` answers 401 to every such POST, so the CLI
		// never works against BETA at all; recording before that gate still
		// gave BETA a reach row and a first-reach row, and the first-reach row
		// is never invalidated. BETA would read connected forever, and the
		// funnel event would fire, for a request that never succeeded.
		const sessionId = await sessionOpenedInAlpha();
		const { POST } = await loadRoute();

		const response = await POST(
			new Request(MCP_URL, {
				method: "POST",
				headers: headers({
					authorization: PERSONAL_KEY,
					"x-organization-id": BETA,
					"mcp-session-id": sessionId,
				}),
				body: toolCallBody(),
			}) as never,
		);
		await response.text();

		expect(response.status).toBe(401);
		await noRecordWritten();
		expect(runInBackground).not.toHaveBeenCalled();
		expect(firstReachEvents()).toHaveLength(0);
	});

	it("writes nothing for an organization that has been deleted", async () => {
		// Deleting an organization deactivates it for a retention window
		// (Fizzy #2462), and this route refuses at tenant resolution rather
		// than filtering every table hanging off it. That gate landed after
		// this suite was written and sits BEFORE every point that records, so
		// a deleted tenant must not collect reach rows from agents that have
		// not noticed yet — a first-reach row is never invalidated, so one
		// written here would outlive the organization's own recovery window.
		isOrganizationLive.mockResolvedValueOnce(false);
		const { POST } = await loadRoute();

		const response = await POST(
			new Request(MCP_URL, {
				method: "POST",
				headers: headers({ authorization: ORG_KEY }),
				body: initializeBody(),
			}) as never,
		);
		await response.text();

		expect(response.status).toBe(403);
		await noRecordWritten();
		expect(runInBackground).not.toHaveBeenCalled();
		expect(firstReachEvents()).toHaveLength(0);
	});

	it("writes nothing when the refused POST also has a malformed body", async () => {
		// The same refusal down the other branch: a body that is not JSON at
		// all skips the main path entirely and reaches its own
		// `checkStoredSessionAuth` call. Both had to move, so both are pinned.
		const sessionId = await sessionOpenedInAlpha();
		const { POST } = await loadRoute();

		const response = await POST(
			new Request(MCP_URL, {
				method: "POST",
				headers: headers({
					authorization: PERSONAL_KEY,
					"x-organization-id": BETA,
					"mcp-session-id": sessionId,
				}),
				body: "{ not json",
			}) as never,
		);
		await response.text();

		expect(response.status).toBe(401);
		await noRecordWritten();
		expect(runInBackground).not.toHaveBeenCalled();
	});

	it("writes exactly one record for a POST that is served", async () => {
		// The other half of the move: a request that passes the gate must
		// still record, and exactly once — four call sites now stand where one
		// did, and a second write would double-count the reach.
		const sessionId = await sessionOpenedInAlpha();
		const { POST } = await loadRoute();

		const response = await POST(
			new Request(MCP_URL, {
				method: "POST",
				headers: headers({
					authorization: PERSONAL_KEY,
					"mcp-session-id": sessionId,
				}),
				body: toolCallBody(),
			}) as never,
		);
		await response.text();

		expect(response.status).toBe(200);
		await settled(1);

		// Let anything a second call site would have scheduled settle before
		// claiming there was only one.
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(recordOrganizationCliReach).toHaveBeenCalledTimes(1);
		expect(runInBackground).toHaveBeenCalledTimes(1);
		expect(recordOrganizationCliReach).toHaveBeenCalledWith({
			organizationId: ALPHA,
			credentialKind: "USER_API_KEY",
			credentialId: PERSONAL_KEY_ID,
		});
		expect([...reachRows.values()]).toEqual([1]);
	});
});

describe("GET and DELETE record on their own", () => {
	/** Open a session with the given credentials and forget the POST's record. */
	async function openSession(extra: Record<string, string>): Promise<string> {
		const { sessionId } = await initialize(extra);
		expect(sessionId).toBeTruthy();
		if (extra.authorization) {
			await settled(1);
		}
		recordOrganizationCliReach.mockClear();
		reachRows.clear();
		(console.info as unknown as { mockClear: () => void }).mockClear();
		return sessionId as string;
	}

	it("GET records a key request", async () => {
		organizationKeyIssuedFor(ALPHA);
		const sessionId = await openSession({ authorization: ORG_KEY });

		const { getConformance } = await loadRoute();
		await getConformance(
			new Request(MCP_URL, {
				method: "GET",
				headers: headers({
					authorization: ORG_KEY,
					"mcp-session-id": sessionId,
				}),
			}) as never,
		);
		await settled(1);

		expect(recordOrganizationCliReach).toHaveBeenCalledWith({
			organizationId: ALPHA,
			credentialKind: "ORGANIZATION_API_KEY",
			credentialId: ORG_KEY_ID,
		});
	});

	it("GET records nothing for a browser session", async () => {
		browserSessionIn(ALPHA);
		const sessionId = await openSession({});

		const { getConformance } = await loadRoute();
		await getConformance(
			new Request(MCP_URL, {
				method: "GET",
				headers: headers({ "mcp-session-id": sessionId }),
			}) as never,
		);

		await noRecordWritten();
	});

	it("DELETE records a key request", async () => {
		organizationKeyIssuedFor(ALPHA);
		const sessionId = await openSession({ authorization: ORG_KEY });

		const { DELETE } = await loadRoute();
		const response = await DELETE(
			new Request(MCP_URL, {
				method: "DELETE",
				headers: headers({
					authorization: ORG_KEY,
					"mcp-session-id": sessionId,
				}),
			}) as never,
		);
		await response.text();
		await settled(1);

		expect(recordOrganizationCliReach).toHaveBeenCalledWith({
			organizationId: ALPHA,
			credentialKind: "ORGANIZATION_API_KEY",
			credentialId: ORG_KEY_ID,
		});
	});

	it("DELETE records nothing for a browser session", async () => {
		browserSessionIn(ALPHA);
		const sessionId = await openSession({});

		const { DELETE } = await loadRoute();
		const response = await DELETE(
			new Request(MCP_URL, {
				method: "DELETE",
				headers: headers({ "mcp-session-id": sessionId }),
			}) as never,
		);
		await response.text();

		await noRecordWritten();
	});
});

describe("recording never changes the answer the caller gets", () => {
	it("serves the request when the write fails", async () => {
		organizationKeyIssuedFor(ALPHA);
		recordOrganizationCliReach.mockRejectedValue(
			new Error("connection terminated"),
		);

		const { response } = await initialize({ authorization: ORG_KEY });

		expect(response.status).toBe(200);
		await settled(1);

		// Swallowed, not surfaced. The rejection belongs to the scheduled
		// continuation, and `runInBackground` is where it is caught and
		// logged — by the time it settles the caller has already been
		// answered, so there is no request left to fail.
		const scheduled = runInBackground.mock.calls[0]?.[0];
		await expect(scheduled).rejects.toThrow("connection terminated");
	});
});

describe("the write is scheduled, not floated", () => {
	it("hands the record to runInBackground instead of voiding the promise", async () => {
		// The negative control for the whole suite. Every case above would
		// still pass against `void import(...)` — the promise runs eagerly
		// under vitest either way — while in production the invocation can be
		// frozen the moment the response returns and the write never happens.
		organizationKeyIssuedFor(ALPHA);

		const { response } = await initialize({ authorization: ORG_KEY });
		expect(response.status).toBe(200);
		await settled(1);

		expect(runInBackground).toHaveBeenCalledTimes(1);
		// Handed the write's own promise, not a thunk: what is scheduled has
		// to be the thing whose settling extends the invocation.
		expect(runInBackground.mock.calls[0]?.[0]).toBeInstanceOf(Promise);
	});

	it("schedules nothing for a request that records nothing", async () => {
		browserSessionIn(ALPHA);

		const { response } = await initialize();
		expect(response.status).toBe(200);
		await noRecordWritten();

		expect(runInBackground).not.toHaveBeenCalled();
	});
});
