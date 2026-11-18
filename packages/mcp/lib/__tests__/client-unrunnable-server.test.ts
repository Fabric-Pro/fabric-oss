// Retired system STDIO servers are refused before a wrapper client is returned.
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

import { RETIRED_SYSTEM_MCP_SERVER_KEYS } from "@repo/database/prisma/curated-mcp-server-keys";
import { createMcpClientForConfig, McpClientError } from "../client";

function stdioConfig(
	server: Record<string, unknown>,
	config: Record<string, unknown> = {},
) {
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
		...config,
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

describe("createMcpClientForConfig — retired STDIO servers", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		mockGetMcpConfigById.mockReset();
	});

	it.each(RETIRED_SYSTEM_MCP_SERVER_KEYS)(
		"refuses the retired system %s server without calling the wrapper",
		async (key) => {
			mockGetMcpConfigById.mockResolvedValue(
				stdioConfig({ key, isSystemProvided: true }),
			);
			const fetchSpy = vi
				.spyOn(global, "fetch")
				.mockImplementation(async () => {
					throw new Error("Unexpected outbound request");
				});

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

	it("refuses invalid stored arguments before returning a STDIO client", async () => {
		vi.stubEnv("MCP_STDIO_WRAPPER_URL", "http://localhost:3100");
		try {
			mockGetMcpConfigById.mockResolvedValue(
				stdioConfig(
					{ key: "azure-devops", isSystemProvided: true },
					{ commandArgs: ["-example"] },
				),
			);
			await expect(
				createMcpClientForConfig({
					configId: "config_fetch",
					userId: "user_a",
					organizationId: "org_a",
				}),
			).rejects.toMatchObject({
				code: "SERVER_UNAVAILABLE",
				message: expect.stringContaining(
					"Azure DevOps organization name",
				),
			});
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it.each(["filesystem", "postgres", "obsidian", "upstash", "google-maps"])(
		"refuses retired system %s even when stored arguments are present",
		async (key) => {
			mockGetMcpConfigById.mockResolvedValue(
				stdioConfig(
					{
						key,
						isSystemProvided: true,
						command: "npx -y example-mcp-server@1.0.0",
					},
					{ commandArgs: ["example-argument"] },
				),
			);

			const error = await errorOf(
				createMcpClientForConfig({
					configId: "config_fetch",
					userId: "user_a",
					organizationId: "org_a",
				}),
			);

			expect(error).toMatchObject({
				code: "SERVER_UNAVAILABLE",
				message: expect.stringContaining(
					"Remove this connection in MCP Settings",
				),
			});
		},
	);
});
