/**
 * Unit tests for `checkServerConnection`, covering the `hasValidCredentials`
 * gate it wraps (not exported, so covered through this entry point).
 *
 * `needsReauth` describes an OAuth GRANT and is cleared only by an OAuth
 * reconnect. Before this fix, `hasValidCredentials` short-circuited on
 * `config.needsReauth` before branching on `authType`, so a config edited
 * away from OAuth (e.g. to API_KEY) could still carry a stale `needsReauth`
 * from its earlier OAuth life and be reported as having no valid
 * credentials even though its current API key works. The short-circuit must
 * only apply to configs that are actually on OAuth2.
 *
 * The Prisma client is mocked at the module boundary so the test runs
 * without a live DB, following the convention in
 * `find-default-mcp-config.test.ts`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockMcpServerFindUnique = vi.fn();
const mockMcpConfigFindFirst = vi.fn();

vi.mock("@repo/database", () => ({
	db: {
		mCPServer: {
			findUnique: (...args: unknown[]) =>
				mockMcpServerFindUnique(...args),
		},
		mCPConfig: {
			findFirst: (...args: unknown[]) => mockMcpConfigFindFirst(...args),
		},
	},
}));

import { checkServerConnection } from "../detect-required-connections";

beforeEach(() => {
	vi.clearAllMocks();
});

describe("checkServerConnection — needsReauth scoped to OAuth2 configs", () => {
	it("treats an API_KEY config with a stale needsReauth flag as having valid credentials", async () => {
		mockMcpServerFindUnique.mockResolvedValueOnce({
			id: "srv-1",
			key: "example-server",
			name: "Example Server",
			description: null,
			authMethods: ["OAUTH2", "API_KEY"],
			isSystemProvided: true,
			iconUrl: null,
			category: null,
		});
		mockMcpConfigFindFirst.mockResolvedValueOnce({
			id: "cfg-1",
			authType: "API_KEY",
			encryptedApiKey: "encrypted-live-key",
			encryptedAccessToken: null,
			tokenExpiresAt: null,
			// Left over from an earlier OAuth life on this same config; the
			// current API_KEY credential is unaffected by it.
			needsReauth: true,
		});

		const result = await checkServerConnection(
			"srv-1",
			"user-1",
			undefined,
		);

		expect(result).toEqual({ isConnected: true });
	});
});
