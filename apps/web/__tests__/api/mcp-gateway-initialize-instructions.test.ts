/**
 * The gateway handshake tells a connected agent that projects can publish
 * coding instructions (Fizzy #2568).
 *
 * `initialize` is the one message every client receives before it has called
 * anything, and its `instructions` string is injected into that client's
 * context. It is static — the route has no session or project in hand at that
 * point — so it cannot say whether THIS project has instructions; what it can
 * do is name the field that does (`codingInstructions` on every project
 * response), the tool that installs them, and the argument that asks for only
 * what changed. Without those three names an agent has no reason to look at
 * the field at all, which is the discovery gap this closes.
 *
 * Mocking follows `mcp-gateway-organization.test.ts`: the authentication
 * branch is stubbed just far enough to reach `handleInitialize`, because what
 * is asserted here is the handshake text, not which tenant it runs in.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const verifyUserApiKey = vi.fn();
vi.mock("@repo/api/modules/users/procedures/api-keys", () => ({
	verifyUserApiKey: (rawKey: string) => verifyUserApiKey(rawKey),
}));

vi.mock("@repo/auth", () => ({
	auth: { api: { getSession: vi.fn().mockResolvedValue(null) } },
}));

vi.mock("@saas/mcp/lib/gateway", async () => {
	const store = await import(
		"../../modules/saas/mcp/lib/gateway/session-store"
	);
	return {
		createGatewaySession: store.createGatewaySession,
		getGatewaySession: store.getGatewaySession,
		deleteGatewaySession: store.deleteGatewaySession,
		updateSessionOrganization: store.updateSessionOrganization,
		executePlatformTool: vi.fn(),
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
const resolveUserOrganization = vi.fn();
vi.mock("@repo/database", () => ({
	isOrganizationLive: vi.fn().mockResolvedValue(true),
	db: { user: { findUnique: (args: unknown) => userFindUnique(args) } },
	getOrganizationApiKeyByPrefix: vi.fn(),
	updateOrganizationApiKeyUsage: vi.fn(),
	isOrganizationMember: vi.fn().mockResolvedValue(true),
	resolveUserOrganization: () => resolveUserOrganization(),
}));

const GATEWAY_URL = "http://localhost:3001/api/mcp-gateway";

async function initialize(): Promise<string> {
	const { POST } = await import("../../app/api/mcp-gateway/route");
	const response = await POST(
		new Request(GATEWAY_URL, {
			method: "POST",
			headers: {
				host: "localhost:3001",
				"content-type": "application/json",
				accept: "application/json",
				authorization: "Bearer fab_personal_key",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: { protocolVersion: "2025-03-26", capabilities: {} },
			}),
		}) as never,
	);
	expect(response.status).toBe(200);
	const payload = (await response.json()) as {
		result: { instructions: string };
	};
	return payload.result.instructions;
}

beforeEach(() => {
	vi.clearAllMocks();
	verifyUserApiKey.mockResolvedValue({ valid: true, userId: "user-1" });
	resolveUserOrganization.mockResolvedValue({
		kind: "resolved",
		organizationId: "org-example-alpha",
	});
	userFindUnique.mockResolvedValue({
		name: "Test User",
		email: "dev@example.com",
		role: "user",
	});
});

describe("initialize instructions", () => {
	it("tells the client that projects can publish coding instructions", async () => {
		const instructions = await initialize();

		expect(instructions).toContain("## Coding instructions");
		// The field on the project responses is how an agent discovers a
		// project has any without being told; naming it is the whole point.
		expect(instructions).toContain("codingInstructions");
		expect(instructions).toContain("fabric_get_project");
		expect(instructions).toContain("fabric_list_projects");
		// What to call to install them, and how to ask for only the delta.
		expect(instructions).toContain("fabric_get_project_instruction_bundle");
		expect(instructions).toContain("fabric_list_project_instructions");
		expect(instructions).toContain("sinceDigest");
	});

	// The section is inserted between two existing ones; a client reads this
	// top to bottom, so "how to get started" still precedes it and the
	// authority rules still follow it.
	it("keeps the existing sections, in order, around it", async () => {
		const instructions = await initialize();

		expect(instructions.indexOf("## Getting started")).toBeLessThan(
			instructions.indexOf("## Coding instructions"),
		);
		expect(instructions.indexOf("## Coding instructions")).toBeLessThan(
			instructions.indexOf("## Runtime authority"),
		);
		expect(instructions).toContain("## Tool naming");
	});
});
