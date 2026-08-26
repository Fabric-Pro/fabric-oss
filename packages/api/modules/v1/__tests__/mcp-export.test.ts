import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockListMcpConfigsForTenant = vi.fn();
const mockGetValidAccessToken = vi.fn();
const mockGetMcpConfigById = vi.fn();
const mockDeleteMcpConfig = vi.fn();
const mockListCustomMcpServersForTenant = vi.fn();
const mockListSystemMcpServers = vi.fn();
const mockLogDataEvent = vi.fn().mockResolvedValue(undefined);

vi.mock("@repo/database", () => ({
	deleteMcpConfig: (...args: unknown[]) => mockDeleteMcpConfig(...args),
	getMcpConfigById: (...args: unknown[]) => mockGetMcpConfigById(...args),
	getValidAccessToken: (...args: unknown[]) =>
		mockGetValidAccessToken(...args),
	listCustomMcpServersForTenant: (...args: unknown[]) =>
		mockListCustomMcpServersForTenant(...args),
	listMcpConfigsForTenant: (...args: unknown[]) =>
		mockListMcpConfigsForTenant(...args),
	listSystemMcpServers: (...args: unknown[]) =>
		mockListSystemMcpServers(...args),
}));

vi.mock("@repo/logs", () => ({
	logDataEvent: (...args: unknown[]) => mockLogDataEvent(...args),
	logger: {
		error: vi.fn(),
	},
}));

vi.mock("@repo/utils", () => ({
	decryptApiKey: (value: string) => `decrypted:${value}`,
}));

vi.mock("../../external-api/middleware/api-key-auth", () => ({
	requireScope: () => async (_c: unknown, next: () => Promise<void>) => {
		await next();
	},
}));

import { buildMcpConfigExportResponse, registerMcpRoutes } from "../mcp";

function createConfig(overrides: Record<string, unknown> = {}) {
	return {
		id: "cfg-1",
		userId: "user-1",
		organizationId: null,
		displayName: "Linear",
		baseUrl: "https://mcp.linear.app/mcp",
		transport: "HTTP",
		authType: "API_KEY",
		apiKeyMethod: "BEARER",
		enabled: true,
		description: "Linear MCP",
		scopes: [],
		tokenExpiresAt: null,
		encryptedRefreshToken: null,
		mcpServer: {
			key: "linear",
			name: "Linear",
			description: "Linear MCP",
			defaultUrl: "https://mcp.linear.app/mcp",
			transport: "HTTP",
		},
		...overrides,
	};
}

describe("MCP export", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockListCustomMcpServersForTenant.mockResolvedValue([]);
		mockListSystemMcpServers.mockResolvedValue([]);
		mockDeleteMcpConfig.mockResolvedValue({ success: true });
	});

	it("exports only enabled HTTPS HTTP configs as streamableHttp", async () => {
		mockListMcpConfigsForTenant.mockResolvedValue([
			createConfig(),
			createConfig({
				id: "cfg-2",
				displayName: "GitHub",
				baseUrl: "https://api.githubcopilot.com/mcp/",
				authType: "OAUTH2",
				apiKeyMethod: null,
				scopes: ["read", "write"],
				encryptedRefreshToken: "refresh-token",
				tokenExpiresAt: new Date("2026-03-29T12:00:00.000Z"),
				mcpServer: {
					key: "github",
					name: "GitHub",
					description: "GitHub MCP",
					defaultUrl: "https://api.githubcopilot.com/mcp/",
					transport: "HTTP",
				},
			}),
			createConfig({
				id: "cfg-3",
				displayName: "SSE Server",
				transport: "SSE",
				mcpServer: {
					key: "sse-server",
					name: "SSE Server",
					description: "SSE MCP",
					defaultUrl: "https://example.com/sse",
					transport: "SSE",
				},
			}),
			createConfig({
				id: "cfg-4",
				displayName: "Insecure",
				baseUrl: "http://example.com/mcp",
			}),
			createConfig({
				id: "cfg-5",
				displayName: "Disabled",
				enabled: false,
			}),
		]);

		mockGetValidAccessToken.mockImplementation(
			async ({ configId }: { configId: string }) => {
				if (configId === "cfg-1") {
					return "api-key-123";
				}
				if (configId === "cfg-2") {
					return "oauth-access-456";
				}
				return null;
			},
		);

		mockGetMcpConfigById.mockResolvedValue(
			createConfig({
				id: "cfg-2",
				authType: "OAUTH2",
				apiKeyMethod: null,
				scopes: ["read", "write"],
				encryptedRefreshToken: "refresh-token",
				tokenExpiresAt: new Date("2026-03-29T12:00:00.000Z"),
				mcpServer: {
					key: "github",
					name: "GitHub",
					description: "GitHub MCP",
					defaultUrl: "https://api.githubcopilot.com/mcp/",
					transport: "HTTP",
				},
			}),
		);

		const result = await buildMcpConfigExportResponse({
			userId: "user-1",
			organizationId: null,
		});

		expect(result.version).toBe("1.0");
		expect(result.servers).toHaveLength(2);
		expect(result.servers[0]).toMatchObject({
			name: "linear",
			type: "streamableHttp",
			url: "https://mcp.linear.app/mcp",
			headers: {
				Authorization: "Bearer api-key-123",
			},
			timeoutMs: 5000,
			disabled: false,
			provider: "linear",
		});
		expect(result.servers[1]).toMatchObject({
			name: "github",
			type: "streamableHttp",
			url: "https://api.githubcopilot.com/mcp/",
			oauth: {
				accessToken: "oauth-access-456",
				refreshToken: "decrypted:refresh-token",
				expiresAt: new Date("2026-03-29T12:00:00.000Z").getTime(),
				scope: "read write",
			},
			timeoutMs: 5000,
			disabled: false,
			provider: "github",
		});
	});

	it("skips configs with missing credentials", async () => {
		mockListMcpConfigsForTenant.mockResolvedValue([
			createConfig({
				id: "cfg-10",
				authType: "API_KEY",
			}),
			createConfig({
				id: "cfg-11",
				authType: "OAUTH2",
				apiKeyMethod: null,
			}),
		]);

		mockGetValidAccessToken.mockResolvedValue(null);

		const result = await buildMcpConfigExportResponse({
			userId: "user-1",
			organizationId: null,
		});

		expect(result.servers).toEqual([]);
	});

	it("serves the user export route", async () => {
		mockListMcpConfigsForTenant.mockResolvedValue([createConfig()]);
		mockGetValidAccessToken.mockResolvedValue("api-key-123");

		const app = new Hono<{
			Variables: {
				externalApiContext: {
					keyType: "personal";
					keyId: string;
					keyPrefix: string;
					userId: string;
					organizationId: undefined;
					scopes: string[];
				};
			};
		}>();

		app.use("*", async (c, next) => {
			c.set("externalApiContext", {
				keyType: "personal",
				keyId: "key-1",
				keyPrefix: "fab_test",
				userId: "user-1",
				organizationId: undefined,
				scopes: ["mcp:read"],
			});
			await next();
		});

		registerMcpRoutes(app as never);

		const res = await app.request("/user/mcp-config", {
			method: "GET",
			headers: {
				"x-client-version": "1.2.3",
			},
		});

		expect(res.status).toBe(200);
		expect(res.headers.get("cache-control")).toContain("no-store");

		const body = await res.json();
		expect(body.servers).toHaveLength(1);
		expect(body.servers[0]).toMatchObject({
			name: "linear",
			type: "streamableHttp",
		});
		expect(mockLogDataEvent).toHaveBeenCalledWith(
			"EXPORT",
			"mcp_config",
			"user-1",
			"user-1",
			expect.objectContaining({
				clientVersion: "1.2.3",
				serverCount: 1,
			}),
		);
	});
});
