/**
 * Unit tests for the enterprise-MCP seed registry.
 *
 * These tests pin the Atlassian entry to the corrected discovery URL and
 * `/v1/mcp` HTTP endpoint so the 2026-05-19 OAuth fix can't silently
 * regress. See `docs/superpowers/specs/2026-05-19-atlassian-mcp-oauth-fix-design.md`.
 */

import { describe, expect, it, vi } from "vitest";

// Mock the prisma client to avoid pulling the Prisma-generated client into
// the test runtime. The seed file self-executes on import, so its seeding
// loop does run — against these mocks, asynchronously, with no real DB
// touched. The tests themselves only read the static `enterpriseServers`
// array.
vi.mock("../prisma/client", () => ({
	db: {
		mCPServer: {
			findFirst: vi.fn(),
			update: vi.fn(),
			create: vi.fn(),
			delete: vi.fn(),
		},
		$disconnect: vi.fn(),
	},
}));

import { CURATED_SYSTEM_MCP_SERVER_KEY_SET } from "../prisma/curated-mcp-server-keys";
import { DEFAULT_PROJECT_MANAGEMENT_KEYS } from "../prisma/default-pm-tool-keys";
import { enterpriseServers } from "../prisma/seed-enterprise-mcp";

describe("seed-enterprise-mcp Atlassian entry", () => {
	const atlassian = enterpriseServers.find((s) => s.key === "atlassian");

	it("points OAuth discovery at the Atlassian MCP authorization server", () => {
		expect(atlassian?.oauthDiscoveryUrl).toBe(
			"https://mcp.atlassian.com/.well-known/oauth-authorization-server",
		);
	});

	it("uses the current /v1/mcp HTTP endpoint (not deprecated /v1/sse)", () => {
		expect(atlassian?.defaultUrl).toBe("https://mcp.atlassian.com/v1/mcp");
		expect(atlassian?.transport).toBe("HTTP");
	});

	it("names the tile after Jira and Confluence (no Bitbucket in title)", () => {
		expect(atlassian?.name).toBe("Atlassian (Jira & Confluence)");
		expect(atlassian?.name).not.toMatch(/bitbucket/i);
	});

	it("description omits Bitbucket", () => {
		expect(atlassian?.description).not.toMatch(/bitbucket/i);
	});

	it("tags the entry with jira and confluence", () => {
		expect(atlassian?.tags).toEqual(
			expect.arrayContaining(["jira", "confluence"]),
		);
	});
});

// seed-mcp-registry's cleanupNonOfficialServers() deletes any
// isSystemProvided MCPServer row with no MCPConfigs whose key is missing
// from CURATED_SYSTEM_MCP_SERVER_KEYS. A seeded system server left off the
// allowlist therefore survives only until the registry seed next runs —
// gitlab-official was deleted from prod this way (issue #2824), degrading
// the availablePmTools picker to key-sentinel ids.
describe("curated-allowlist parity", () => {
	it("every system-provided enterprise server key is in the curated allowlist", () => {
		const missing = enterpriseServers
			.filter((s) => s.isSystemProvided)
			.map((s) => s.key)
			.filter((key) => !CURATED_SYSTEM_MCP_SERVER_KEY_SET.has(key));
		expect(missing).toEqual([]);
	});

	// The wizard's default PM tools require their catalog rows even when no
	// tenant has an MCPConfig for them (REST-fallback tenants never do), so
	// none of these keys may be eligible for registry cleanup.
	it("every wizard-default PM key is in the curated allowlist", () => {
		const missing = DEFAULT_PROJECT_MANAGEMENT_KEYS.filter(
			(key) => !CURATED_SYSTEM_MCP_SERVER_KEY_SET.has(key),
		);
		expect(missing).toEqual([]);
	});
});
