/**
 * Tests for the needsReauth circuit-breaker enforcement in
 * createMcpClientForConfig.
 *
 * The refresh circuit breaker (recordRefreshFailure) flips needsReauth after
 * persistent refresh failures. createMcpClientForConfig must fail fast with
 * an OAUTH_AUTH_REQUIRED error instead of attempting to refresh (and
 * re-hammer) the dead refresh token.
 *
 * Enforcement is scoped to OAUTH2. The flag describes an OAuth GRANT and only
 * an OAuth reconnect clears it, but a config's authType can be edited after
 * the fact, and rows carrying the flag from an earlier OAuth life already
 * exist. Refusing those would block a working API key behind a reconnect flow
 * the config no longer has.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetMcpConfigById = vi.fn();
const mockGetValidAccessToken = vi.fn();

vi.mock("@repo/database", () => ({
	getMcpConfigById: function getMcpConfigById(...args: unknown[]) {
		return mockGetMcpConfigById(...args);
	},
	getValidAccessToken: function getValidAccessToken(...args: unknown[]) {
		return mockGetValidAccessToken(...args);
	},
}));

const mockRefreshOAuthToken = vi.fn();
vi.mock("@repo/utils/oauth-refresh", () => ({
	refreshOAuthToken: function refreshOAuthToken(...args: unknown[]) {
		return mockRefreshOAuthToken(...args);
	},
}));

vi.mock("@repo/utils/url-security", () => ({
	getUnsafeUrlReason: function getUnsafeUrlReason() {
		return null;
	},
}));

import { createMcpClientForConfig, McpClientError } from "../client";

const baseConfig = {
	id: "config_x",
	enabled: true,
	needsReauth: false,
	displayName: "Example Server",
	baseUrl: "https://example.com/mcp",
	transport: "HTTP",
	authType: "OAUTH2",
	apiKeyMethod: "BEARER",
	mcpServer: {
		name: "Example Server",
		defaultUrl: "https://example.com/mcp",
		transport: "HTTP",
	},
};

function resetMocks() {
	mockGetMcpConfigById.mockReset();
	mockGetValidAccessToken.mockReset();
	mockRefreshOAuthToken.mockReset();
	mockGetMcpConfigById.mockResolvedValue({ ...baseConfig });
}

describe("createMcpClientForConfig - needsReauth enforcement", () => {
	beforeEach(resetMocks);

	it("rejects an OAUTH2 config with OAUTH_AUTH_REQUIRED when needsReauth is true, without attempting a refresh", async () => {
		mockGetMcpConfigById.mockResolvedValue({
			...baseConfig,
			// Stated explicitly rather than inherited: the guard is auth-type
			// scoped, so this is the axis under test.
			authType: "OAUTH2",
			needsReauth: true,
		});
		const fetchSpy = vi.spyOn(global, "fetch");

		let caughtError: unknown;
		try {
			await createMcpClientForConfig({
				configId: "config_x",
				userId: "user_a",
				organizationId: "org_a",
			});
		} catch (error) {
			caughtError = error;
		}

		expect(caughtError).toBeInstanceOf(McpClientError);
		expect((caughtError as InstanceType<typeof McpClientError>).code).toBe(
			"OAUTH_AUTH_REQUIRED",
		);
		expect(mockRefreshOAuthToken).not.toHaveBeenCalled();
		expect(fetchSpy).not.toHaveBeenCalled();

		fetchSpy.mockRestore();
	});

	it("does NOT refuse an API_KEY config carrying a stale flag from its OAuth life", async () => {
		// The reported defect: an OAuth config trips the breaker, the user
		// edits it to API_KEY and supplies a working key, and the row keeps
		// `needsReauth: true` — a flag only an OAuth reconnect clears, for an
		// auth type that has no OAuth reconnect. Reaching the API-key lookup
		// at all is the assertion; the stubbed lookup then reports the key as
		// missing, which is a different (and clearable) failure entirely.
		mockGetMcpConfigById.mockResolvedValue({
			...baseConfig,
			authType: "API_KEY",
			needsReauth: true,
		});
		mockGetValidAccessToken.mockResolvedValue(null);
		const fetchSpy = vi.spyOn(global, "fetch");

		await expect(
			createMcpClientForConfig({
				configId: "config_x",
				userId: "user_a",
				organizationId: "org_a",
			}),
		).rejects.toMatchObject({ code: "API_KEY_MISSING" });

		expect(mockGetValidAccessToken).toHaveBeenCalledWith({
			configId: "config_x",
			userId: "user_a",
			organizationId: "org_a",
		});
		expect(fetchSpy).not.toHaveBeenCalled();
		fetchSpy.mockRestore();
	});

	it("does NOT refuse a NONE-auth config carrying a stale flag", async () => {
		// Same rescue for the auth type that has no credential at all. The
		// unparseable URL makes client creation fail at the first step, which
		// keeps the test off the network while still proving the breaker gate
		// let this config through to it.
		mockGetMcpConfigById.mockResolvedValue({
			...baseConfig,
			authType: "NONE",
			needsReauth: true,
			baseUrl: "not-a-url",
			mcpServer: { ...baseConfig.mcpServer, defaultUrl: "not-a-url" },
		});

		await expect(
			createMcpClientForConfig({
				configId: "config_x",
				userId: "user_a",
				organizationId: "org_a",
			}),
		).rejects.toMatchObject({ code: "INVALID_URL" });
	});

	it("does not throw OAUTH_AUTH_REQUIRED for CONFIG_DISABLED when both are true (disabled check runs first)", async () => {
		mockGetMcpConfigById.mockResolvedValue({
			...baseConfig,
			enabled: false,
			needsReauth: true,
		});

		await expect(
			createMcpClientForConfig({
				configId: "config_x",
				userId: "user_a",
				organizationId: "org_a",
			}),
		).rejects.toMatchObject({
			code: "CONFIG_DISABLED",
		});
	});
});
