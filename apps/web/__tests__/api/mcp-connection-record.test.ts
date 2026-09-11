/**
 * `POST /api/mcp-gateway` — the runtime writes the connection record
 * (Fizzy #2457, R2/R25/R32).
 *
 * The record is the one authoritative statement that a CLI reached an
 * organization, and everything this suite pins is about the two questions the
 * plan says must not be answered by inference.
 *
 * WHAT qualifies. Only an API key. Both hosts also authenticate Better Auth
 * browser sessions and hand them `["*"]`, so a scope-based guard would record
 * in-app browsing as a CLI connection and mark the organization connected
 * forever. The guard is the credential's key identity — absent on the session
 * branch — which is why the session cases below are not decoration.
 *
 * WHEN it qualifies. After the credential matched, the owner was loaded, and
 * membership was re-read. Never at the point the secret matched: this route
 * stamps the key's usage counter immediately after that, BEFORE the owner
 * lookup and BEFORE the membership check, so the counter counts requests that
 * then return 401. The offboarded-owner case asserts exactly that gap — the
 * counter moves and the record does not.
 *
 * HOW it is written matters as much as when. The record is scheduled through
 * `runInBackground`, which registers the continuation with the runtime so the
 * serverless invocation stays alive until the write lands; a bare
 * `void promise` is simply dropped when the invocation freezes after the
 * response returns, and an organization whose only write was dropped reads as
 * disconnected forever. That is why the scheduler below is mocked and asserted
 * rather than stubbed away.
 *
 * The store below is a fake, but it is not a stub: it models the two real
 * constraints (`@@unique([organizationId, credentialKind, credentialId])` and
 * `OrganizationCliFirstReach`'s organization primary key), because the
 * "one row, one event" claims are claims about those constraints holding.
 */

import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CLI_FIRST_REACH_EVENT } from "../../modules/saas/mcp/lib/record-cli-reach";

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

vi.mock("@repo/api/lib/audit", () => ({ recordAuditFromRequest: vi.fn() }));

const userFindUnique = vi.fn();
const getOrganizationApiKeyByPrefix = vi.fn();
const updateOrganizationApiKeyUsage = vi.fn();
const isOrganizationMember = vi.fn();
const resolveUserOrganization = vi.fn();
const recordOrganizationCliReach = vi.fn();
/** Defaults to a live tenant; one case below deactivates it. */
const isOrganizationLive = vi.fn(async () => true);
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
	// The deactivated-organization gate (Fizzy #2462) runs before the gateway
	// serves anything. A spy rather than a constant, because a deleted tenant
	// must not leave a connection record either.
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

const GATEWAY_URL = "http://localhost:3001/api/mcp-gateway";
const USER_ID = "user-1";
const PERSONAL_KEY = "Bearer fab_personal_key";
const ALPHA = "org-example-alpha";
const BETA = "org-example-beta";
const OUTSIDE = "org-example-outside";

const ORG_KEY = "org_abcd_secret";
const ORG_KEY_HASH = createHash("sha256").update(ORG_KEY).digest("hex");
const ORG_KEY_ID = "orgkey-1";
const PERSONAL_KEY_ID = "userkey-1";

// ─── The fake reach store ───────────────────────────────────────────────────

interface ReachRow {
	organizationId: string;
	credentialKind: string;
	credentialId: string;
	/** Bumped on every upsert, standing in for `lastReachedAt`. */
	reachCount: number;
}

let reachRows: Map<string, ReachRow>;
let firstReachRows: Map<string, number>;

function reachKey(row: {
	organizationId: string;
	credentialKind: string;
	credentialId: string;
}): string {
	return `${row.organizationId}|${row.credentialKind}|${row.credentialId}`;
}

/**
 * The real query's contract, with the two unique constraints modelled.
 *
 * Deliberately does no awaiting before it mutates: that is what makes the
 * check-and-insert atomic, which is exactly what Postgres's unique index gives
 * the real one, and it is the property the concurrency case rests on.
 */
function installReachStore(): void {
	recordOrganizationCliReach.mockImplementation(
		async (args: {
			organizationId: string;
			credentialKind: string;
			credentialId: string;
		}) => {
			const key = reachKey(args);
			const existing = reachRows.get(key);
			reachRows.set(key, {
				...args,
				reachCount: (existing?.reachCount ?? 0) + 1,
			});

			if (firstReachRows.has(args.organizationId)) {
				return { firstReachForOrganization: false };
			}
			firstReachRows.set(args.organizationId, 1);
			return { firstReachForOrganization: true };
		},
	);
}

/** First-reach events actually emitted, read off the log line the helper writes. */
function firstReachEvents(): unknown[] {
	const spy = console.info as unknown as { mock: { calls: unknown[][] } };
	return spy.mock.calls.filter((call) =>
		String(call[0]).includes(CLI_FIRST_REACH_EVENT),
	);
}

/** Wait for the fire-and-forget write, which lands a microtask after the response. */
async function settled(times: number): Promise<void> {
	await vi.waitFor(() =>
		expect(recordOrganizationCliReach).toHaveBeenCalledTimes(times),
	);
}

/** No write is a negative: give the dispatch a turn before asserting absence. */
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

async function post(
	body: unknown,
	extra: Record<string, string> = {},
): Promise<Response> {
	const { POST } = await import("../../app/api/mcp-gateway/route");
	return POST(
		new Request(GATEWAY_URL, {
			method: "POST",
			headers: headers(extra),
			body: typeof body === "string" ? body : JSON.stringify(body),
		}) as never,
	);
}

interface DescribedUser {
	memberships: string[];
	lastActive?: string | null;
}

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

function signedInAs(user: DescribedUser): void {
	verifyUserApiKey.mockResolvedValue({
		valid: true,
		userId: USER_ID,
		keyId: PERSONAL_KEY_ID,
		scopes: ["mcp:read"],
	});
	resolveUserOrganization.mockImplementation(async () => resolutionFor(user));
	isOrganizationMember.mockImplementation(
		async (_userId: string, organizationId: string) =>
			user.memberships.includes(organizationId),
	);
}

/** Point the organization-key branch at a live key whose owner is a member. */
function organizationKeyIssuedFor(organizationId: string): void {
	getOrganizationApiKeyByPrefix.mockResolvedValue({
		id: ORG_KEY_ID,
		organizationId,
		createdByUserId: USER_ID,
		keyHash: ORG_KEY_HASH,
		isActive: true,
		expiresAt: null,
		scopes: ["mcp:read"],
	});
	isOrganizationMember.mockResolvedValue(true);
}

beforeEach(async () => {
	// The route resolves `@repo/database` through a dynamic import on every
	// request. Loading it once up front keeps the first case in the file from
	// paying for the whole module graph inside its own timeout.
	await import("../../app/api/mcp-gateway/route");

	vi.clearAllMocks();
	vi.spyOn(console, "info").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});

	reachRows = new Map();
	firstReachRows = new Map();
	installReachStore();

	userFindUnique.mockResolvedValue({
		name: "Test User",
		email: "dev@example.com",
		role: "user",
	});
	getOrganizationApiKeyByPrefix.mockResolvedValue(null);
	updateOrganizationApiKeyUsage.mockResolvedValue(undefined);
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

describe("a key request records the organization it reached", () => {
	it("writes one record naming the organization key that presented it", async () => {
		organizationKeyIssuedFor(ALPHA);

		const response = await post(initializeBody(), {
			authorization: `Bearer ${ORG_KEY}`,
		});
		expect(response.status).toBe(200);
		await settled(1);

		expect(recordOrganizationCliReach).toHaveBeenCalledWith({
			organizationId: ALPHA,
			// The KIND alone would collapse every organization key into one
			// record and take revocation with it; the id is what keeps them
			// apart.
			credentialKind: "ORGANIZATION_API_KEY",
			credentialId: ORG_KEY_ID,
		});
		expect(firstReachEvents()).toHaveLength(1);
	});

	it("refreshes the existing record on a second request, without a second event", async () => {
		organizationKeyIssuedFor(ALPHA);

		await post(initializeBody(), { authorization: `Bearer ${ORG_KEY}` });
		await settled(1);
		await post(initializeBody(), { authorization: `Bearer ${ORG_KEY}` });
		await settled(2);

		// One row, reached twice — the upsert's conflict target doing its job.
		expect(reachRows.size).toBe(1);
		expect([...reachRows.values()][0].reachCount).toBe(2);
		// R32/R25: the first-reach row is written once and is not touched
		// again, so the funnel event fires once per organization ever.
		expect(firstReachRows.size).toBe(1);
		expect(firstReachEvents()).toHaveLength(1);
	});

	it("names a personal key's own row, not the kind of key", async () => {
		signedInAs({ memberships: [ALPHA] });

		await post(initializeBody(), { authorization: PERSONAL_KEY });
		await settled(1);

		expect(recordOrganizationCliReach).toHaveBeenCalledWith({
			organizationId: ALPHA,
			credentialKind: "USER_API_KEY",
			credentialId: PERSONAL_KEY_ID,
		});
	});

	it("records the organization the request NAMED, not the holder's default", async () => {
		// AE23. The holder belongs to both and their last-active names ALPHA,
		// so the default resolver would answer ALPHA. Mirroring that resolver
		// is precisely the inference the plan rejected: the request said BETA
		// and the runtime honoured it, so BETA is what was reached.
		signedInAs({ memberships: [ALPHA, BETA], lastActive: ALPHA });

		await post(initializeBody(), {
			authorization: PERSONAL_KEY,
			"x-organization-id": BETA,
		});
		await settled(1);

		expect(recordOrganizationCliReach).toHaveBeenCalledWith({
			organizationId: BETA,
			credentialKind: "USER_API_KEY",
			credentialId: PERSONAL_KEY_ID,
		});
	});
});

describe("nothing but a key is a CLI", () => {
	it("writes nothing for a browser session", async () => {
		// AE26. The session reaches the same endpoint and carries `["*"]` —
		// wider than any key — which is why the guard cannot be scopes.
		getSession.mockResolvedValue({
			user: {
				id: USER_ID,
				name: "Test User",
				email: "dev@example.com",
				role: "user",
			},
			session: { activeOrganizationId: ALPHA },
		});

		const response = await post(initializeBody());
		expect(response.status).toBe(200);
		await noRecordWritten();
	});

	it("writes nothing when no credentials were presented at all", async () => {
		verifyUserApiKey.mockResolvedValue({ valid: false });
		getSession.mockResolvedValue(null);

		const response = await post(initializeBody(), {
			authorization: PERSONAL_KEY,
		});
		expect(response.status).toBe(401);
		await noRecordWritten();
	});
});

describe("the write waits for the membership check, never the usage counter", () => {
	it("writes nothing for a key whose owner has left the organization", async () => {
		// AE24. The request stamps the counter and then returns 401, which is
		// the whole reason nothing here may be keyed off `lastUsedAt`.
		organizationKeyIssuedFor(ALPHA);
		isOrganizationMember.mockResolvedValue(false);

		const response = await post(initializeBody(), {
			authorization: `Bearer ${ORG_KEY}`,
		});

		expect(response.status).toBe(401);
		expect(updateOrganizationApiKeyUsage).toHaveBeenCalledWith(ORG_KEY_ID);
		await noRecordWritten();
	});

	it("writes nothing for a guest refused for lack of membership", async () => {
		// AE8. A personal key presented for an organization its holder does
		// not belong to.
		signedInAs({ memberships: [ALPHA] });

		const response = await post(initializeBody(), {
			authorization: PERSONAL_KEY,
			"x-organization-id": OUTSIDE,
		});

		expect(response.status).toBe(403);
		await noRecordWritten();
	});
});

describe("an unusable call is not a connection", () => {
	beforeEach(() => {
		organizationKeyIssuedFor(ALPHA);
	});

	it("writes nothing for a malformed body", async () => {
		const response = await post("{not json", {
			authorization: `Bearer ${ORG_KEY}`,
		});

		expect((await response.json()).error.code).toBe(-32700);
		await noRecordWritten();
	});

	it("writes nothing for an invalid JSON-RPC envelope", async () => {
		const response = await post(
			{ jsonrpc: "1.0", id: 1, method: "initialize" },
			{ authorization: `Bearer ${ORG_KEY}` },
		);

		expect((await response.json()).error.code).toBe(-32600);
		await noRecordWritten();
	});

	it("writes nothing for a method this server does not serve", async () => {
		const response = await post(
			{ jsonrpc: "2.0", id: 1, method: "resources/subscribe" },
			{ authorization: `Bearer ${ORG_KEY}` },
		);

		expect((await response.json()).error.code).toBe(-32601);
		await noRecordWritten();
	});
});

describe("recording never changes the answer the caller gets", () => {
	it("serves the request when the write fails", async () => {
		organizationKeyIssuedFor(ALPHA);
		recordOrganizationCliReach.mockRejectedValue(
			new Error("connection terminated"),
		);

		const response = await post(initializeBody(), {
			authorization: `Bearer ${ORG_KEY}`,
		});

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

		await post(initializeBody(), { authorization: `Bearer ${ORG_KEY}` });
		await settled(1);

		expect(runInBackground).toHaveBeenCalledTimes(1);
		// Handed the write's own promise, not a thunk: what is scheduled has
		// to be the thing whose settling extends the invocation.
		expect(runInBackground.mock.calls[0]?.[0]).toBeInstanceOf(Promise);
	});

	it("schedules nothing for a request that records nothing", async () => {
		getSession.mockResolvedValue({
			user: {
				id: USER_ID,
				name: "Test User",
				email: "dev@example.com",
				role: "user",
			},
			session: { activeOrganizationId: ALPHA },
		});

		await post(initializeBody());
		await noRecordWritten();

		expect(runInBackground).not.toHaveBeenCalled();
	});
});

describe("the funnel event is per organization, not per credential", () => {
	it("records both credentials but announces the organization once", async () => {
		// R25/R32. Two different keys reach the same organization. Each gets
		// its own reach row — that is what keeps revocation meaningful — while
		// the first-reach row, and so the event, belongs to the organization
		// and is written once.
		//
		// Two genuinely simultaneous first requests are the same claim, and it
		// is asserted where the constraint that answers it lives:
		// `packages/database/prisma/queries/cli-reach.test.ts` drives the
		// unique violation on the second insert. It cannot be asserted here —
		// two concurrent dynamic imports of a mocked module race vitest's
		// mocker and one of them is handed the real `@repo/database`, so a
		// route-level version of this test would be measuring the harness.
		organizationKeyIssuedFor(ALPHA);
		await post(initializeBody(), { authorization: `Bearer ${ORG_KEY}` });
		await settled(1);

		signedInAs({ memberships: [ALPHA] });
		getOrganizationApiKeyByPrefix.mockResolvedValue(null);
		await post(initializeBody(), { authorization: PERSONAL_KEY });
		await settled(2);

		expect(reachRows.size).toBe(2);
		expect(firstReachRows.size).toBe(1);
		expect(firstReachEvents()).toHaveLength(1);
	});
});
