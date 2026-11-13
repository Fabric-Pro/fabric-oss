/**
 * A connection to a retired system server whose package was never published
 * (Fizzy #3531).
 *
 * The Fetch, Time and SQLite reference servers are Python packages, so the
 * `npx @modelcontextprotocol/server-…` command the catalog once offered for
 * them asks npm for a package that does not exist. A connection made before
 * they were retired went on doing that on every call, and every call failed
 * the same way. It is now refused before the wrapper runs anything, with what
 * the person can do about it; a tenant's own server of the same key is not.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetMcpConfigById = vi.fn();

vi.mock("@repo/database", () => ({
	isGitLabPersonalMcpServerKey: () => false,
	getMcpConfigById: function getMcpConfigById(...args: unknown[]) {
		return mockGetMcpConfigById(...args);
	},
	getValidAccessToken: vi.fn(),
	canConnectOrganizationMcpConfigs: async () => true,
	canReadOrganizationMcpConfigs: async () => true,
	isOrganizationMember: async () => true,
}));

vi.mock("@repo/utils/oauth-refresh", () => ({
	refreshOAuthToken: vi.fn(),
}));

vi.mock("@repo/utils/url-security", () => ({
	getUnsafeUrlReason: () => null,
	getBlockedOutboundReason: () => null,
	createOutboundHostAllowlist: (options: { envVar: string }) => ({
		envVar: options.envVar,
		hosts: () => [],
		isAllowedHost: () => false,
		getUnsafeReason: () => null,
		assert: () => undefined,
		assertResolved: async () => undefined,
		fetch: (input: string | URL, init?: RequestInit) => fetch(input, init),
	}),
}));

import { createMcpClientForConfig, McpClientError } from "../client";

function stdioConfig(server: Record<string, unknown>) {
	return {
		id: "config_fetch",
		enabled: true,
		needsReauth: false,
		displayName: "Fetch",
		baseUrl: null,
		transport: "STDIO",
		authType: "NONE",
		apiKeyMethod: "BEARER",
		commandArgs: [],
		mcpServer: {
			name: "Fetch",
			transport: "STDIO",
			command: "npx -y @modelcontextprotocol/server-fetch",
			...server,
		},
	};
}

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	return undefined;
}

describe("createMcpClientForConfig — servers that can never start", () => {
	beforeEach(() => {
		mockGetMcpConfigById.mockReset();
	});

	it.each(["fetch", "time", "sqlite", "raycast", "browserbase"])(
		"refuses the retired system %s server without calling the wrapper",
		async (key) => {
			mockGetMcpConfigById.mockResolvedValue(
				stdioConfig({ key, isSystemProvided: true }),
			);
			const fetchSpy = vi.spyOn(global, "fetch");

			const error = await errorOf(
				createMcpClientForConfig({
					configId: "config_fetch",
					userId: "user_a",
					organizationId: "org_a",
				}),
			);

			expect(error).toBeInstanceOf(McpClientError);
			expect(error).toMatchObject({
				code: "SERVER_UNAVAILABLE",
				serverName: "Fetch",
			});
			expect((error as Error).message).toContain(
				"Remove this connection in MCP Settings",
			);
			expect(fetchSpy).not.toHaveBeenCalled();
			fetchSpy.mockRestore();
		},
	);

	it("leaves a tenant's own server with the same key alone", async () => {
		mockGetMcpConfigById.mockResolvedValue(
			stdioConfig({ key: "fetch", isSystemProvided: false }),
		);

		const error = await errorOf(
			createMcpClientForConfig({
				configId: "config_fetch",
				userId: "user_a",
				organizationId: "org_a",
			}),
		);

		// It goes on to the wrapper as before; whatever that does next, it is
		// not refused as unavailable.
		expect((error as { code?: string } | undefined)?.code).not.toBe(
			"SERVER_UNAVAILABLE",
		);
	});

	it("leaves a retired server that still starts alone", async () => {
		mockGetMcpConfigById.mockResolvedValue(
			stdioConfig({ key: "puppeteer", isSystemProvided: true }),
		);

		const error = await errorOf(
			createMcpClientForConfig({
				configId: "config_fetch",
				userId: "user_a",
				organizationId: "org_a",
			}),
		);

		expect((error as { code?: string } | undefined)?.code).not.toBe(
			"SERVER_UNAVAILABLE",
		);
	});
});
