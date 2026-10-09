/**
 * `POST /api/mcp-gateway` — what a credential may reach is the credential's,
 * not the session's or a tool name's (security audit of the MCP gateway).
 *
 * Three rules, driven through the real route and the real session store:
 *
 * 1. A connected server's tools (`<server>__<tool>`) are held to the
 *    credential's scopes. A delegated credential (an `org_` key, an OAuth
 *    sign-in) is READ only when the server itself says `readOnlyHint: true`;
 *    a name that merely looks harmless is a write to it.
 * 2. A session is reused only by the credential that opened it, with the
 *    scopes it opened with. Quoting a broader session's id does not widen a
 *    narrower key.
 * 3. An organization key's digest is compared in constant time.
 */

import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const verifyUserApiKey = vi.fn();
vi.mock("@repo/api/modules/users/procedures/api-keys", () => ({
	verifyUserApiKey: (rawKey: string) => verifyUserApiKey(rawKey),
}));

vi.mock("@repo/auth", () => ({
	auth: { api: { getSession: vi.fn().mockResolvedValue(null) } },
}));

const executePlatformTool = vi.fn();
const executeConnectedServerTool = vi.fn();
const getAggregatedTools = vi.fn();
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
		executeConnectedServerTool: (...args: unknown[]) =>
			executeConnectedServerTool(...args),
		getAggregatedTools: (...args: unknown[]) => getAggregatedTools(...args),
	};
});

// The classification is the real one: which scope a connected tool needs is
// what this file pins. Only the runtime-grant lookup, which needs a database,
// is stubbed.
const enforceAuthority = vi.fn();
vi.mock("@saas/mcp/lib/gateway/authority-service", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@saas/mcp/lib/gateway/authority-service")
	>()),
	enforceAuthority: (...args: unknown[]) => enforceAuthority(...args),
	generateRequestFingerprint: vi.fn().mockResolvedValue("fingerprint"),
	resolveProviderKeyFromToolPrefix: vi.fn().mockReturnValue(undefined),
}));

const getOrganizationApiKeyByPrefix = vi.fn();
const isOrganizationMember = vi.fn();
vi.mock("@repo/database", () => ({
	isOrganizationLive: vi.fn().mockResolvedValue(true),
	db: {
		user: {
			findUnique: vi.fn().mockResolvedValue({
				name: "Test User",
				email: "dev@example.com",
				role: "user",
			}),
		},
	},
	getOrganizationApiKeyByPrefix: (prefix: string) =>
		getOrganizationApiKeyByPrefix(prefix),
	updateOrganizationApiKeyUsage: vi.fn().mockResolvedValue(undefined),
	isOrganizationMember: (userId: string, organizationId: string) =>
		isOrganizationMember(userId, organizationId),
	resolveUserOrganization: vi
		.fn()
		.mockResolvedValue({ kind: "resolved", organizationId: "org-alpha" }),
}));

const GATEWAY_URL = "http://localhost:3001/api/mcp-gateway";
const USER_ID = "user-1";
const ALPHA = "org-example-alpha";
const PERSONAL_KEY = "Bearer fab_personal_key";
const ORG_KEY = "org_abcd_secret";
const ORG_KEY_HASH = createHash("sha256").update(ORG_KEY).digest("hex");

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

function toolCallBody(name: string): unknown {
	return {
		jsonrpc: "2.0",
		id: 2,
		method: "tools/call",
		params: { name, arguments: {} },
	};
}

async function post(body: unknown, extra: Record<string, string> = {}) {
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
		text: JSON.stringify(await response.json()),
	};
}

function orgKeyRecord(keyScopes: string[], keyHash = ORG_KEY_HASH) {
	return {
		id: "key-1",
		isActive: true,
		expiresAt: null,
		keyHash,
		organizationId: ALPHA,
		createdByUserId: USER_ID,
		scopes: keyScopes,
	};
}

const ORG_AUTH = { authorization: `Bearer ${ORG_KEY}` };

function offerTool(
	name: string,
	annotations?: { readOnlyHint?: boolean },
): void {
	getAggregatedTools.mockResolvedValue({
		tools: [
			{
				name,
				description: "",
				inputSchema: {},
				...(annotations ? { annotations } : {}),
			},
		],
		servers: [
			{
				configId: "cfg-1",
				displayName: "Example",
				toolPrefix: "example",
				tools: [],
			},
		],
	});
}

async function callConnectedWith(
	auth: Record<string, string>,
	name: string,
): Promise<string> {
	const { sessionId } = await post(initializeBody(), auth);
	const { text } = await post(toolCallBody(name), {
		...auth,
		"mcp-session-id": sessionId as string,
	});
	return text;
}

beforeEach(() => {
	vi.clearAllMocks();
	isOrganizationMember.mockResolvedValue(true);
	getOrganizationApiKeyByPrefix.mockResolvedValue(
		orgKeyRecord(["mcp:read", "mcp:write"]),
	);
	verifyUserApiKey.mockResolvedValue({
		valid: true,
		userId: USER_ID,
		scopes: ["mcp:read", "mcp:write"],
	});
	executePlatformTool.mockResolvedValue({
		content: [{ type: "text", text: "ok" }],
	});
	executeConnectedServerTool.mockResolvedValue({
		content: [{ type: "text", text: "connected ok" }],
	});
	getAggregatedTools.mockResolvedValue({ tools: [], servers: [] });
	enforceAuthority.mockResolvedValue({ authorized: true });
});

describe("MCP gateway — connected server tools honour the credential", () => {
	it("refuses a server-declared read-only tool to a key without mcp:read", async () => {
		getOrganizationApiKeyByPrefix.mockResolvedValue(
			orgKeyRecord(["projects:read"]),
		);
		offerTool("example__fetch_report", { readOnlyHint: true });

		const text = await callConnectedWith(ORG_AUTH, "example__fetch_report");

		expect(text).toContain("mcp:read");
		expect(executeConnectedServerTool).not.toHaveBeenCalled();
	});

	it("runs a server-declared read-only tool for a key holding mcp:read", async () => {
		getOrganizationApiKeyByPrefix.mockResolvedValue(
			orgKeyRecord(["mcp:read"]),
		);
		offerTool("example__fetch_report", { readOnlyHint: true });

		const text = await callConnectedWith(ORG_AUTH, "example__fetch_report");

		expect(text).toContain("connected ok");
		expect(executeConnectedServerTool).toHaveBeenCalledTimes(1);
	});

	it("does not take a tool's name as proof it only reads, for a key holding only mcp:read", async () => {
		getOrganizationApiKeyByPrefix.mockResolvedValue(
			orgKeyRecord(["mcp:read"]),
		);
		offerTool("example__get_everything");

		const text = await callConnectedWith(
			ORG_AUTH,
			"example__get_everything",
		);

		expect(text).toContain("mcp:write");
		expect(enforceAuthority).not.toHaveBeenCalled();
		expect(executeConnectedServerTool).not.toHaveBeenCalled();
	});

	it("still asks for a runtime grant when the key does hold mcp:write", async () => {
		offerTool("example__get_everything");
		enforceAuthority.mockResolvedValue({
			authorized: false,
			reason: "no grant",
			action: "request_authority",
		});

		const text = await callConnectedWith(
			ORG_AUTH,
			"example__get_everything",
		);

		expect(enforceAuthority).toHaveBeenCalledTimes(1);
		expect(text).toContain("Authority required");
		expect(executeConnectedServerTool).not.toHaveBeenCalled();
	});

	it("keeps the name heuristic for a person's own personal key, with the scope check added", async () => {
		verifyUserApiKey.mockResolvedValue({
			valid: true,
			userId: USER_ID,
			scopes: ["mcp:read"],
		});
		offerTool("example__get_everything");

		const text = await callConnectedWith(
			{ authorization: PERSONAL_KEY },
			"example__get_everything",
		);

		expect(text).toContain("connected ok");
	});

	it("refuses a personal key with no mcp scope a connected read it used to run", async () => {
		verifyUserApiKey.mockResolvedValue({
			valid: true,
			userId: USER_ID,
			scopes: ["projects:read"],
		});
		offerTool("example__get_everything");

		const text = await callConnectedWith(
			{ authorization: PERSONAL_KEY },
			"example__get_everything",
		);

		expect(text).toContain("mcp:read");
		expect(executeConnectedServerTool).not.toHaveBeenCalled();
	});
});

describe("MCP gateway — a session is not lent to a different credential", () => {
	it("does not let a narrower key inherit the scopes of the session it quotes", async () => {
		const { sessionId: broad } = await post(initializeBody(), ORG_AUTH);
		getOrganizationApiKeyByPrefix.mockResolvedValue(
			orgKeyRecord(["projects:read"]),
		);

		const { sessionId: served } = await post(
			toolCallBody("fabric_get_identity"),
			{ ...ORG_AUTH, "mcp-session-id": broad as string },
		);

		expect(served).not.toBe(broad);
		const session = executePlatformTool.mock.calls.at(-1)?.[2];
		expect(session.scopes).toEqual(["projects:read"]);
	});

	it("does not let a different kind of credential reuse a session either", async () => {
		const { sessionId } = await post(initializeBody(), {
			authorization: PERSONAL_KEY,
		});
		verifyUserApiKey.mockResolvedValue({
			valid: true,
			userId: USER_ID,
			scopes: ["mcp:read"],
		});

		const { sessionId: served } = await post(
			toolCallBody("fabric_get_identity"),
			{
				authorization: PERSONAL_KEY,
				"mcp-session-id": sessionId as string,
			},
		);

		expect(served).not.toBe(sessionId);
	});

	it("still reuses a session for the same key presenting the same scopes", async () => {
		const { sessionId } = await post(initializeBody(), ORG_AUTH);

		const { sessionId: served } = await post(
			toolCallBody("fabric_get_identity"),
			{ ...ORG_AUTH, "mcp-session-id": sessionId as string },
		);

		expect(served).toBe(sessionId);
	});
});

describe("MCP gateway — organization key comparison", () => {
	// Constant-time comparison is not observable from a response, so these pin
	// what the byte comparison changes: digests are compared as decoded bytes
	// (the same digest in upper-case hex is the same digest), and a stored
	// digest of the wrong length is a refusal, never a thrown error —
	// `timingSafeEqual` throws on unequal lengths.
	function init() {
		return new Request(GATEWAY_URL, {
			method: "POST",
			headers: headers(ORG_AUTH),
			body: JSON.stringify(initializeBody()),
		}) as never;
	}

	it("accepts the key's own digest however the hex is cased", async () => {
		const { POST } = await import("../../app/api/mcp-gateway/route");
		getOrganizationApiKeyByPrefix.mockResolvedValue(
			orgKeyRecord(["mcp:read"], ORG_KEY_HASH.toUpperCase()),
		);

		const response = await POST(init());

		expect(response.status).toBe(200);
	});

	it("refuses a different digest of the same length", async () => {
		const { POST } = await import("../../app/api/mcp-gateway/route");
		getOrganizationApiKeyByPrefix.mockResolvedValue(
			orgKeyRecord(
				["mcp:read"],
				createHash("sha256").update("another key").digest("hex"),
			),
		);

		const response = await POST(init());

		expect(response.status).toBe(401);
	});

	it("refuses a stored digest of the wrong length without throwing", async () => {
		const { POST } = await import("../../app/api/mcp-gateway/route");
		getOrganizationApiKeyByPrefix.mockResolvedValue(
			orgKeyRecord(["mcp:read"], "abcd"),
		);

		const response = await POST(init());

		expect(response.status).toBe(401);
	});
});
