import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	verifyOAuthAccessToken: vi.fn(),
	findActiveAuthoritySessions: vi.fn(),
	completeAuthoritySession: vi.fn(),
}));

vi.mock("@repo/auth", () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock("@repo/api/modules/users/procedures/api-keys", () => ({
	verifyUserApiKey: vi.fn(),
}));
vi.mock("@repo/utils", () => ({ getBaseUrl: () => "https://fabric.example" }));
vi.mock("@saas/mcp/lib/record-cli-reach", () => ({
	recordCliReach: vi.fn(),
	toOAuthClientIdentity: (id: string) => ({ kind: "OAUTH_CLIENT", id }),
	toOrganizationKeyIdentity: (id: string) => ({
		kind: "ORGANIZATION_API_KEY",
		id,
	}),
	toUserKeyIdentity: (id: string) => ({ kind: "USER_API_KEY", id }),
}));
vi.mock("@saas/mcp/lib/record-organization-refusal", () => ({
	recordOrganizationRefusal: vi.fn(),
}));
vi.mock("@saas/mcp/lib/gateway/authority-service", () => ({
	enforceAuthority: vi.fn(),
	generateRequestFingerprint: vi.fn(),
	resolveProviderKeyFromToolPrefix: vi.fn(),
}));
vi.mock("@saas/mcp/lib/gateway", async () => {
	const store = await import("../session-store");
	return {
		...store,
		executePlatformTool: vi.fn(),
		executeConnectedServerTool: vi.fn(),
		getAggregatedTools: vi.fn(),
	};
});
vi.mock("@repo/database", () => ({
	verifyOAuthAccessToken: m.verifyOAuthAccessToken,
	isOrganizationLive: async () => true,
	completeAuthoritySession: m.completeAuthoritySession,
	db: {
		authoritySession: { findMany: m.findActiveAuthoritySessions },
	},
}));

import {
	handleGatewayDelete,
	handleGatewayGet,
	handleGatewayPost,
} from "../../gateway-endpoint";
import { createGatewaySession, getGatewaySession } from "../session-store";

const ORG = "org-1";

function token(userId: string) {
	return {
		valid: true,
		tokenId: `token-${userId}`,
		clientRowId: `client-${userId}`,
		userId,
		userName: "Example Agent",
		email: "agent@example.com",
		role: "user",
		organizationId: ORG,
		projectId: null,
		audience: "mcp",
		scopes: ["mcp:read"],
	};
}

function gatewayRequest(
	method: "GET" | "DELETE" | "POST",
	headers: Record<string, string>,
) {
	return new NextRequest("https://fabric.example/api/mcp-gateway", {
		method,
		headers,
	});
}

async function sessionFor(userId: string) {
	return createGatewaySession({
		userId,
		organizationId: ORG,
		projectId: null,
		userName: "Example Agent",
		email: "agent@example.com",
		role: "user",
		credential: "oauth",
		scopes: ["mcp:read"],
	});
}

beforeEach(() => {
	m.verifyOAuthAccessToken.mockReset();
	m.findActiveAuthoritySessions.mockReset().mockResolvedValue([]);
	m.completeAuthoritySession.mockReset().mockResolvedValue(undefined);
	m.verifyOAuthAccessToken.mockImplementation(async (value: string) =>
		value === "owner-token"
			? token("user-1")
			: value === "other-token"
				? token("user-2")
				: { valid: false },
	);
});

describe("gateway DELETE", () => {
	it("refuses a caller who presents no credential and leaves the session alone", async () => {
		const session = await sessionFor("user-1");

		const response = await handleGatewayDelete(
			gatewayRequest("DELETE", { "mcp-session-id": session.sessionId }),
			null,
		);

		expect(response.status).toBe(401);
		expect(getGatewaySession(session.sessionId)).not.toBeNull();
		expect(m.completeAuthoritySession).not.toHaveBeenCalled();
	});

	it("does not end another user's session", async () => {
		const session = await sessionFor("user-1");

		const response = await handleGatewayDelete(
			gatewayRequest("DELETE", {
				authorization: "Bearer other-token",
				"mcp-session-id": session.sessionId,
			}),
			null,
		);

		expect(response.status).toBe(204);
		expect(getGatewaySession(session.sessionId)).not.toBeNull();
		expect(m.completeAuthoritySession).not.toHaveBeenCalled();
	});

	it("ends only the owner's own session and its own authority grants", async () => {
		const session = await sessionFor("user-1");
		const sibling = await sessionFor("user-1");
		m.findActiveAuthoritySessions.mockResolvedValue([{ id: "grant-1" }]);

		const response = await handleGatewayDelete(
			gatewayRequest("DELETE", {
				authorization: "Bearer owner-token",
				"mcp-session-id": session.sessionId,
			}),
			null,
		);

		expect(response.status).toBe(204);
		expect(getGatewaySession(session.sessionId)).toBeNull();
		expect(getGatewaySession(sibling.sessionId)).not.toBeNull();
		expect(m.findActiveAuthoritySessions).toHaveBeenCalledWith({
			where: {
				runType: "MCP_GATEWAY",
				runId: session.sessionId,
				status: "ACTIVE",
			},
			select: { id: true },
		});
		expect(m.completeAuthoritySession).toHaveBeenCalledExactlyOnceWith(
			"grant-1",
		);
	});
});

describe("gateway GET", () => {
	// The info page is public: an unauthenticated GET gets the same body with
	// its 401 challenge. A GET that carries credentials is answered as before,
	// unverified, because OAuth clients probe the URL with whatever token they
	// hold (see mcp-gateway-get-405.test.ts).
	it("serves the info page to a GET with a credential, without verifying it", async () => {
		const response = await handleGatewayGet(
			gatewayRequest("GET", { authorization: "Bearer anything" }),
			null,
		);

		expect(response.status).toBe(200);
		expect(m.verifyOAuthAccessToken).not.toHaveBeenCalled();
	});

	it("answers 200 for a verified credential", async () => {
		const response = await handleGatewayGet(
			gatewayRequest("GET", { authorization: "Bearer owner-token" }),
			null,
		);

		expect(response.status).toBe(200);
	});

	it("still answers 405 to an event-stream GET without authenticating", async () => {
		const response = await handleGatewayGet(
			gatewayRequest("GET", { accept: "text/event-stream" }),
			null,
		);

		expect(response.status).toBe(405);
		expect(m.verifyOAuthAccessToken).not.toHaveBeenCalled();
	});
});

describe("gateway POST", () => {
	it("still authenticates before parsing the body", async () => {
		const response = await handleGatewayPost(
			new NextRequest("https://fabric.example/api/mcp-gateway", {
				method: "POST",
				headers: {
					accept: "application/json",
					authorization: "Bearer anything",
				},
				body: "{",
			}),
			null,
		);

		expect(response.status).toBe(401);
	});
});
