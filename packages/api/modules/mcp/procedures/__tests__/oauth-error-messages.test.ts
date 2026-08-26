/**
 * Unit tests for the hostname-aware OAuth-credential error-message helper.
 *
 * Pins the Atlassian-specific copy introduced by the 2026-05-19 MCP OAuth fix
 * (`docs/superpowers/specs/2026-05-19-atlassian-mcp-oauth-fix-design.md` §5.2)
 * and ensures the registry uses strict hostname matching — no suffix-match
 * attacks via lookalike domains.
 */

import { describe, expect, it, vi } from "vitest";

// Mock the heavy external surfaces that `oauth.ts` imports at module load.
// The helper itself touches none of them — these mocks just stop the module
// graph from blowing up when we import the file.
vi.mock("@repo/database", () => ({
	clearRefreshFailures: vi.fn(),
	createOauthState: vi.fn(),
	db: {},
	deleteOauthState: vi.fn(),
	getCachedOAuthMetadata: vi.fn(),
	getGoogleAccountEmail: vi.fn(),
	getMcpConfigByIdInternal: vi.fn(),
	getOauthState: vi.fn(),
	getOrganizationById: vi.fn(),
	updateMcpConfigTokens: vi.fn(),
	updateOAuthMetadataCache: vi.fn(),
}));

vi.mock("@repo/temporal", () => ({
	triggerMcpToolIngestion: vi.fn(),
}));

vi.mock("@repo/utils", () => ({
	decryptApiKey: vi.fn((s: string) => s),
	encryptApiKey: vi.fn((s: string) => s),
	hashApiKey: vi.fn((s: string) => s),
}));
vi.mock("@repo/utils/url-security", () => ({
	assertSafeOutboundUrl: vi.fn(),
	safeFetchOutbound: vi.fn(),
}));

vi.mock("../../../organizations/lib/membership", () => ({
	verifyOrganizationMembership: vi.fn(),
}));

// Short-circuit the procedure-builder chain so we don't transitively load
// payments → database when importing `oauth.ts`.
vi.mock("../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => ({ _handler: fn }),
	});
	return {
		publicProcedure: chainable,
		tenantProtectedProcedure: chainable,
		requirePermission: () => () => ({}),
		Permissions: {
			MCP_CONNECT: "mcp:connect",
			MCP_UPDATE: "mcp:update",
		} as const,
	};
});

import { getOAuthCredentialErrorMessage } from "../oauth";

describe("getOAuthCredentialErrorMessage", () => {
	it("returns the Atlassian-specific message for the Atlassian MCP hostname", () => {
		const message = getOAuthCredentialErrorMessage(
			"https://mcp.atlassian.com/v1/mcp",
			"atlassian",
		);
		expect(message).toMatch(/atlassian/i);
		expect(message).toMatch(/fabric administrator/i);
	});

	it("falls back to serverKey when baseUrl is null", () => {
		const message = getOAuthCredentialErrorMessage(null, "atlassian");
		expect(message).toMatch(/atlassian/i);
	});

	it("returns null for unknown servers (preserves the generic message)", () => {
		expect(
			getOAuthCredentialErrorMessage(
				"https://mcp.slack.com/v1/mcp",
				"slack",
			),
		).toBeNull();
	});

	it("uses strict hostname matching — rejects suffix-attack lookalikes", () => {
		expect(
			getOAuthCredentialErrorMessage(
				"https://mcp.atlassian.com.attacker.example/mcp",
				"unknown",
			),
		).toBeNull();
	});
});
