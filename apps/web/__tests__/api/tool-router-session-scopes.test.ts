/**
 * `POST /api/fabric/tool-router/session` and `/mcp` — a session never reaches
 * further than the key that minted it (Fizzy #2380, QA round 2).
 *
 * Two holes, both on routes that never participated in the scope model at all,
 * which is why scope testing elsewhere could not have found them.
 *
 * SCOPES. `verifyUserApiKey`'s scope argument is optional and its check is
 * guarded by it, so calling the function bare skips the check entirely. The
 * mint route called it bare, and nothing downstream of `validateSession`
 * looked at scopes either — so any valid personal key, whatever it was issued
 * to do, minted a session that could send Slack messages and write to Drive.
 *
 * TENANT. `organizationId` was taken verbatim from the request body, stamped
 * into the session, and handed to `fetchCredentialsByProvider`, which matches
 * an organization's stored integration credentials on `organizationId` alone
 * with no membership predicate of its own. Naming someone else's organization
 * was the whole attack.
 *
 * The tenant tests drive the real session store across both routes rather than
 * stubbing it: the mint route is only half the claim, and the half that
 * matters is what the id it hands back can then do.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const verifyUserApiKey = vi.fn();
vi.mock("@repo/api/modules/users/procedures/api-keys", () => ({
	verifyUserApiKey: (rawKey: string, requiredScope?: string) =>
		verifyUserApiKey(rawKey, requiredScope),
}));

const getSession = vi.fn();
vi.mock("@repo/auth", () => ({
	auth: { api: { getSession: (args: unknown) => getSession(args) } },
}));

const isOrganizationMember = vi.fn();
const fetchCredentialsByProvider = vi.fn();
vi.mock("@repo/database", () => ({
	isOrganizationMember: (userId: string, organizationId: string) =>
		isOrganizationMember(userId, organizationId),
	fetchCredentialsByProvider: (...args: unknown[]) =>
		fetchCredentialsByProvider(...args),
}));

const { POST: mintSession } = await import(
	"../../app/api/fabric/tool-router/session/route"
);
const { POST: mcp } = await import(
	"../../app/api/fabric/tool-router/mcp/route"
);

/** A key that really holds `scopes`, checked the way the real verifier does. */
function keyHolding(scopes: string[]) {
	return (_rawKey: string, requiredScope?: string) => {
		if (
			requiredScope &&
			!scopes.includes(requiredScope) &&
			!scopes.includes("*")
		) {
			return {
				valid: false,
				error: `Missing required scope: ${requiredScope}`,
			};
		}
		return { valid: true, userId: "user-1", scopes, keyId: "key-1" };
	};
}

function mintRequest(body: Record<string, unknown>, apiKey = "fab_x_y") {
	return new Request("http://localhost/api/fabric/tool-router/session", {
		method: "POST",
		headers: { "x-api-key": apiKey, "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

async function mintedSessionId(scopes: string[], organizationId?: string) {
	verifyUserApiKey.mockImplementation(keyHolding(scopes));
	isOrganizationMember.mockResolvedValue(true);
	const res = await mintSession(
		mintRequest(organizationId ? { organizationId } : {}),
	);
	expect(res.status).toBe(200);
	return (await res.json()).sessionId as string;
}

function callTool(sessionId: string) {
	return mcp(
		new Request("http://localhost/api/fabric/tool-router/mcp", {
			method: "POST",
			headers: {
				"x-fabric-session": sessionId,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				// A real integration tool, not a `connect_*` one: those
				// short-circuit to an OAuth URL and never reach the
				// credential lookup that the tenant claim is about.
				params: { name: "github_list_repos", arguments: {} },
			}),
		}),
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	fetchCredentialsByProvider.mockResolvedValue(null);
});

describe("minting a tool-router session", () => {
	it("refuses a key that does not hold the mint scope", async () => {
		verifyUserApiKey.mockImplementation(keyHolding(["projects:read"]));

		const res = await mintSession(mintRequest({}));

		expect(res.status).toBe(401);
		// The scope was actually demanded of the verifier, rather than the key
		// being rejected for some other reason.
		expect(verifyUserApiKey).toHaveBeenCalledWith("fab_x_y", "mcp:read");
	});

	it("accepts a key that holds it", async () => {
		verifyUserApiKey.mockImplementation(keyHolding(["mcp:read"]));

		const res = await mintSession(mintRequest({}));

		expect(res.status).toBe(200);
		expect(isOrganizationMember).not.toHaveBeenCalled();
	});

	it("accepts a legacy wildcard key", async () => {
		// Keys minted before the Fabric Code key was narrowed hold `["*"]` and
		// nothing else. The mint must not lock them out.
		verifyUserApiKey.mockImplementation(keyHolding(["*"]));

		const res = await mintSession(mintRequest({}));

		expect(res.status).toBe(200);
	});

	it("refuses an organization the caller is not a member of", async () => {
		verifyUserApiKey.mockImplementation(keyHolding(["mcp:read"]));
		isOrganizationMember.mockResolvedValue(false);

		const res = await mintSession(mintRequest({ organizationId: "org-2" }));

		expect(res.status).toBe(403);
		expect(isOrganizationMember).toHaveBeenCalledWith("user-1", "org-2");
	});

	it("accepts an organization the caller belongs to", async () => {
		verifyUserApiKey.mockImplementation(keyHolding(["mcp:read"]));
		isOrganizationMember.mockResolvedValue(true);

		const res = await mintSession(mintRequest({ organizationId: "org-1" }));

		expect(res.status).toBe(200);
	});

	it("checks membership for a browser session's active organization too", async () => {
		// `activeOrganizationId` is a stored field that outlives the membership
		// it points at, so it is not self-evidently safe just because the
		// server put it there.
		getSession.mockResolvedValue({
			user: { id: "user-1" },
			session: { activeOrganizationId: "org-stale" },
		});
		isOrganizationMember.mockResolvedValue(false);

		const res = await mintSession(
			new Request("http://localhost/api/fabric/tool-router/session", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({}),
			}),
		);

		expect(res.status).toBe(403);
		expect(isOrganizationMember).toHaveBeenCalledWith(
			"user-1",
			"org-stale",
		);
	});
});

describe("what a minted session may then do", () => {
	it("refuses tools/call when the minting key was read-only", async () => {
		const sessionId = await mintedSessionId(["mcp:read"]);

		const res = await callTool(sessionId);
		const payload = await res.json();

		expect(payload.error.message).toContain("mcp:write");
		expect(fetchCredentialsByProvider).not.toHaveBeenCalled();
	});

	it("allows tools/call when the minting key could write", async () => {
		const sessionId = await mintedSessionId(["mcp:read", "mcp:write"]);

		const res = await callTool(sessionId);
		const payload = await res.json();

		expect(payload.error?.message ?? "").not.toContain("mcp:write");
	});

	it("carries the checked organization, not one the caller re-supplies", async () => {
		// The session is the credential from here on: the MCP route reads the
		// tenant off the stored session and the request body cannot move it.
		const sessionId = await mintedSessionId(
			["mcp:read", "mcp:write"],
			"org-1",
		);

		await callTool(sessionId);

		const orgArg = fetchCredentialsByProvider.mock.calls[0]?.[2];
		expect(orgArg).toBe("org-1");
	});
});
