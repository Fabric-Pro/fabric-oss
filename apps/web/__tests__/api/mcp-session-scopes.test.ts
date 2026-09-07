/**
 * `POST /mcp` — a restored session runs with the scopes of the key presenting
 * it (Fizzy #2380 regression).
 *
 * Scope enforcement shipped, and every `tools/call` on this route began failing
 * with "This API key does not have the ... scope", for every key and every
 * scope set. `initialize` kept succeeding, which made it look like a
 * provisioning problem.
 *
 * The cause: `restoreAuthResult()` returns `scopes: []` because the durable
 * session has no scopes to carry, and the callers wrote
 * `storedAuthResult ?? authResult` — so a request quoting a session id ran with
 * an empty scope set. Every `tools/call` carries `Mcp-Session-Id`; `initialize`
 * does not and checks no scope, which is exactly the shape of the outage.
 *
 * Neither existing suite could have caught it, and the gap is instructive:
 * `mcp-organization-header.test.ts` mocks `executePlatformTool`, so the scope
 * check never runs on the route path, and `tool-scope-enforcement.test.ts`
 * builds a `GatewaySession` directly, so it never crosses the restore path. The
 * bug lived exactly between them. So this suite mocks neither: it drives the
 * real route, over two requests, with the real tool executor.
 *
 * Two requests is the whole point. A single-request test passes against the
 * broken code.
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

// `@saas/mcp/lib/gateway/platform-tools` is deliberately NOT mocked. The scope
// gate lives inside `executePlatformTool`, so a mock here is a test that cannot
// fail for the reason this file exists.

const organizationApiKeyFindFirst = vi.fn();
const userFindUnique = vi.fn();
const memberFindMany = vi.fn();
const isOrganizationMember = vi.fn();
const resolveUserOrganization = vi.fn();
vi.mock("@repo/database", () => ({
	db: {
		organizationApiKey: {
			findFirst: (args: unknown) => organizationApiKeyFindFirst(args),
			update: vi.fn().mockResolvedValue({}),
		},
		user: { findUnique: (args: unknown) => userFindUnique(args) },
		member: { findMany: (args: unknown) => memberFindMany(args) },
	},
	isOrganizationMember: (userId: string, organizationId: string) =>
		isOrganizationMember(userId, organizationId),
	resolveUserOrganization: (userId: string) =>
		resolveUserOrganization(userId),
}));

vi.mock("@repo/api/lib/audit", () => ({ recordAuditFromRequest: vi.fn() }));

const MCP_URL = "http://localhost:3001/mcp";
const ORG = "org-example-alpha";
const ORG_KEY = "Bearer org_abcd1234_secret";

function headers(extra: Record<string, string> = {}): Record<string, string> {
	return {
		host: "localhost:3001",
		"content-type": "application/json",
		accept: "application/json, text/event-stream",
		...extra,
	};
}

function readSsePayload(body: string): Record<string, unknown> {
	const line = body.split("\n").find((c) => c.startsWith("data:"));
	return JSON.parse(line?.slice("data:".length).trim() ?? "{}");
}

/** The text a tool result carries, whatever shape the result took. */
function resultText(payload: Record<string, unknown>): string {
	return JSON.stringify(payload);
}

/**
 * Authenticate, take the session id, then call a tool on that session — which
 * is what every real client does and what no existing test did.
 */
async function initializeThenCall(tool: string): Promise<string> {
	const { POST } = await import("../../app/mcp/route");

	const init = await POST(
		new Request(MCP_URL, {
			method: "POST",
			headers: headers({ authorization: ORG_KEY }),
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: "2025-06-18",
					capabilities: {},
					clientInfo: { name: "test-client", version: "1.0.0" },
				},
			}),
		}) as never,
	);
	const sessionId = init.headers.get("mcp-session-id");
	expect(sessionId).toBeTruthy();

	const call = await POST(
		new Request(MCP_URL, {
			method: "POST",
			headers: headers({
				authorization: ORG_KEY,
				"mcp-session-id": sessionId as string,
			}),
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 2,
				method: "tools/call",
				params: { name: tool, arguments: {} },
			}),
		}) as never,
	);
	return resultText(readSsePayload(await call.text()));
}

function keyWithScopes(scopes: string[]) {
	organizationApiKeyFindFirst.mockResolvedValue({
		id: "key-1",
		organizationId: ORG,
		createdByUserId: "user-1",
		scopes,
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.resetModules();
	// Force the in-memory session store; Upstash is not exercised here.
	vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
	vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");

	userFindUnique.mockResolvedValue({
		name: "Test User",
		email: "dev@example.com",
		role: "user",
	});
	memberFindMany.mockResolvedValue([
		{
			role: "member",
			organization: { id: ORG, name: "Example Org", slug: "example-org" },
		},
	]);
	isOrganizationMember.mockResolvedValue(true);
	resolveUserOrganization.mockResolvedValue({
		kind: "resolved",
		organizationId: ORG,
	});
});

describe("a tool call on a restored session uses the key's real scopes", () => {
	// The regression, stated as the thing a user reported: a key that carries
	// the scope a tool needs must be able to call that tool.
	it("does not refuse a key that holds the required scope", async () => {
		keyWithScopes(["mcp:read", "mcp:write"]);

		const body = await initializeThenCall("fabric_get_identity");

		expect(body).not.toContain("does not have the");
	});

	it("does not refuse a key holding the finer scope either", async () => {
		keyWithScopes(["orgs:read"]);

		const body = await initializeThenCall("fabric_get_identity");

		expect(body).not.toContain("does not have the");
	});

	// The other half: the fix must restore the live scopes, not stop reading
	// them. A test that only asserts "no refusal" passes against enforcement
	// deleted outright.
	it("still refuses a key that does not hold the required scope", async () => {
		keyWithScopes(["frames:read"]);

		const body = await initializeThenCall("fabric_get_identity");

		expect(body).toContain("does not have the");
		expect(body).toContain("orgs:read");
	});

	it("still refuses a key carrying no scopes at all", async () => {
		keyWithScopes([]);

		const body = await initializeThenCall("fabric_get_identity");

		expect(body).toContain("does not have the");
	});
});
