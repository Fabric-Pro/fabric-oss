/**
 * Integration tests for MCP Configuration CRUD operations
 * Tests the complete flow: create -> update -> delete
 *
 * NOTE: These tests are currently skipped because they use an incorrect pattern
 * for testing oRPC procedures. oRPC procedures don't expose a `.handler` property
 * that can be called directly. These tests need to be rewritten to either:
 * 1. Use oRPC's test utilities
 * 2. Test through HTTP using a test server
 * 3. Extract and test the underlying service functions directly
 */

import type { MCPConfig, MCPServer } from "@repo/database";
import { beforeAll, describe, expect, it, vi } from "vitest";

// Mock database queries
const mockDb = {
	getMcpConfigById: vi.fn(),
	getMcpServerById: vi.fn(),
	upsertMcpConfig: vi.fn(),
	deleteMcpConfig: vi.fn(),
	getMcpConfigForTenantAndServer: vi.fn(),
	listMcpConfigsForTenant: vi.fn(),
	getOrganizationById: vi.fn(),
};

vi.mock("@repo/database", () => mockDb);

// Mock encryption utilities
vi.mock("@repo/utils", () => ({
	encryptApiKey: (value: string) => `encrypted_${value}`,
	decryptApiKey: (value: string) => value.replace("encrypted_", ""),
}));

// Mock auth session
vi.mock("@repo/auth", () => ({
	auth: {
		api: {
			getSession: () => ({
				user: {
					id: "user-123",
					email: "test@example.com",
				},
				session: {
					id: "session-123",
				},
			}),
		},
	},
}));

const MCP_CONFIGS_MODULE_PATH =
	"../../../../packages/api/modules/mcp/procedures/configs";
const MEMBERSHIP_MODULE_PATH =
	"../../../../packages/api/modules/organizations/lib/membership";

const loadConfigProcedures = async () =>
	(await import(MCP_CONFIGS_MODULE_PATH)).configProcedures;
const loadVerifyMembership = async () =>
	(await import(MEMBERSHIP_MODULE_PATH)).verifyOrganizationMembership;

describe.skip("MCP Configuration CRUD Integration Tests", () => {
	const _mockServer: Partial<MCPServer> = {
		id: "server-1",
		key: "test-mcp",
		name: "Test MCP Server",
		defaultUrl: "https://mcp.example.com",
		transport: "HTTP",
		authMethods: ["API_KEY", "OAUTH2"],
	};

	beforeAll(() => {
		global.fetch = vi.fn();
	});

	describe("Create Configuration", () => {
		it("should create API Key configuration", async () => {
			const configData = {
				mcpServerId: "server-1",
				baseUrl: "https://mcp.example.com",
				authType: "API_KEY" as const,
				apiKey: "test-api-key-123",
				displayName: "My Test Config",
				enabled: true,
			};

			const expectedConfig: Partial<MCPConfig> = {
				id: "config-1",
				...configData,
				encryptedApiKey: "encrypted_test-api-key-123",
				userId: "user-123",
				status: "HEALTHY",
			};

			mockDb.getMcpConfigForTenantAndServer.mockResolvedValue(null);
			mockDb.upsertMcpConfig.mockResolvedValue(expectedConfig);

			const configProcedures = await loadConfigProcedures();
			const upsertHandler = (configProcedures.upsert as any).handler;

			const result = await upsertHandler({
				input: configData,
				context: {
					user: { id: "user-123", email: "test@example.com" },
				} as any,
			});

			expect(result).toBeDefined();
			expect(mockDb.upsertMcpConfig).toHaveBeenCalledWith({
				mcpServerId: "server-1",
				userId: "user-123",
				organizationId: undefined,
				data: expect.objectContaining({
					baseUrl: "https://mcp.example.com",
					authType: "API_KEY",
					encryptedApiKey: "encrypted_test-api-key-123",
				}),
			});
		});

		it("should create OAuth2 configuration without credentials", async () => {
			const configData = {
				mcpServerId: "server-1",
				baseUrl: "https://oauth-mcp.example.com",
				authType: "OAUTH2" as const,
				scopes: ["read", "write"],
				displayName: "OAuth Config",
				enabled: true,
			};

			mockDb.getMcpConfigForTenantAndServer.mockResolvedValue(null);
			mockDb.upsertMcpConfig.mockResolvedValue({
				id: "config-2",
				...configData,
				userId: "user-123",
			});

			const configProcedures = await loadConfigProcedures();

			const result = await (configProcedures.upsert as any).handler({
				input: configData,
				context: {
					user: { id: "user-123", email: "test@example.com" },
				} as any,
			});

			expect(result).toBeDefined();
			expect(mockDb.upsertMcpConfig).toHaveBeenCalled();
		});

		it("should reject API_KEY config without key", async () => {
			const configData = {
				mcpServerId: "server-1",
				baseUrl: "https://mcp.example.com",
				authType: "API_KEY" as const,
				// Missing apiKey
			};

			mockDb.getMcpConfigForTenantAndServer.mockResolvedValue(null);

			const configProcedures = await loadConfigProcedures();

			await expect(
				(configProcedures.upsert as any).handler({
					input: configData as any,
					context: {
						user: { id: "user-123", email: "test@example.com" },
					} as any,
				}),
			).rejects.toThrow("API key is required");
		});

		it("should allow any org member to create their own config", async () => {
			const configData = {
				mcpServerId: "server-1",
				organizationId: "org-123",
				baseUrl: "https://mcp.example.com",
				authType: "NONE" as const,
			};

			mockDb.getOrganizationById.mockResolvedValue({
				id: "org-123",
				name: "Test Org",
			});

			// Mock regular member
			const verifyOrganizationMembership = await loadVerifyMembership();
			vi.mocked(verifyOrganizationMembership).mockResolvedValue({
				role: "member",
			} as any);

			mockDb.getMcpConfigForTenantAndServer.mockResolvedValue(null);
			mockDb.upsertMcpConfig.mockResolvedValue({
				id: "new-config",
				userId: "user-123",
				organizationId: "org-123",
			});

			const configProcedures = await loadConfigProcedures();
			const result = await (configProcedures.upsert as any).handler({
				input: configData,
				context: {
					user: { id: "user-123", email: "test@example.com" },
				} as any,
			});

			// Any member can create their own config
			expect(result.organizationId).toBe("org-123");
		});
	});

	describe("Update Configuration", () => {
		it("should update existing configuration", async () => {
			const existingConfig: Partial<MCPConfig> = {
				id: "config-1",
				mcpServerId: "server-1",
				userId: "user-123",
				baseUrl: "https://old-url.example.com",
				authType: "API_KEY",
				encryptedApiKey: "encrypted_old-key",
			};

			const updateData = {
				mcpServerId: "server-1",
				baseUrl: "https://new-url.example.com",
				authType: "API_KEY" as const,
				apiKey: "new-api-key-456",
			};

			mockDb.getMcpConfigForTenantAndServer.mockResolvedValue(
				existingConfig,
			);
			mockDb.upsertMcpConfig.mockResolvedValue({
				...existingConfig,
				...updateData,
				encryptedApiKey: "encrypted_new-api-key-456",
			});

			const configProcedures = await loadConfigProcedures();

			const result = await (configProcedures.upsert as any).handler({
				input: updateData,
				context: {
					user: { id: "user-123", email: "test@example.com" },
				} as any,
			});

			expect(result.baseUrl).toBe("https://new-url.example.com");
			expect(mockDb.upsertMcpConfig).toHaveBeenCalledWith(
				expect.objectContaining({
					data: expect.objectContaining({
						baseUrl: "https://new-url.example.com",
						encryptedApiKey: "encrypted_new-api-key-456",
					}),
				}),
			);
		});
	});

	describe("Delete Configuration", () => {
		it("should delete user-owned configuration", async () => {
			const config: Partial<MCPConfig> = {
				id: "config-1",
				userId: "user-123",
				mcpServerId: "server-1",
			};

			mockDb.getMcpConfigById.mockResolvedValue(config);
			mockDb.deleteMcpConfig.mockResolvedValue(config);

			const configProcedures = await loadConfigProcedures();

			const result = await (configProcedures.delete as any).handler({
				input: { id: "config-1" },
				context: {
					user: { id: "user-123", email: "test@example.com" },
				} as any,
			});

			expect(result.success).toBe(true);
			expect(mockDb.deleteMcpConfig).toHaveBeenCalledWith("config-1");
		});

		it("should reject deletion of other user's config", async () => {
			const config: Partial<MCPConfig> = {
				id: "config-1",
				userId: "other-user",
				mcpServerId: "server-1",
			};

			mockDb.getMcpConfigById.mockResolvedValue(config);

			const configProcedures = await loadConfigProcedures();

			await expect(
				(configProcedures.delete as any).handler({
					input: { id: "config-1" },
					context: {
						user: { id: "user-123", email: "test@example.com" },
					} as any,
				}),
			).rejects.toThrow("FORBIDDEN");
		});

		it("should allow any org member to delete their own config", async () => {
			const config: Partial<MCPConfig> = {
				id: "config-1",
				userId: "user-123",
				organizationId: "org-123",
				mcpServerId: "server-1",
				mcpServer: { name: "Test Server" },
			};

			mockDb.getMcpConfigById.mockResolvedValue(config);
			mockDb.deleteMcpConfig.mockResolvedValue({ success: true });
			mockDb.getOrganizationById.mockResolvedValue({
				id: "org-123",
				name: "Test Org",
			});

			// Mock regular member
			const verifyOrganizationMembership = await loadVerifyMembership();
			vi.mocked(verifyOrganizationMembership).mockResolvedValue({
				role: "member",
			} as any);

			const configProcedures = await loadConfigProcedures();
			const result = await (configProcedures.delete as any).handler({
				input: { id: "config-1", organizationId: "org-123" },
				context: {
					user: { id: "user-123", email: "test@example.com" },
				} as any,
			});

			// Any member can delete their own config
			expect(mockDb.deleteMcpConfig).toHaveBeenCalledWith("config-1");
			expect(result.success).toBe(true);
		});
	});

	describe("List Configurations", () => {
		it("should list user configurations", async () => {
			const userConfigs = [
				{
					id: "config-1",
					userId: "user-123",
					mcpServerId: "server-1",
					authType: "API_KEY",
				},
				{
					id: "config-2",
					userId: "user-123",
					mcpServerId: "server-2",
					authType: "OAUTH2",
				},
			];

			mockDb.listMcpConfigsForTenant.mockResolvedValue(userConfigs);

			const configProcedures = await loadConfigProcedures();

			const result = await (configProcedures.list as any).handler({
				input: {},
				context: {
					user: { id: "user-123", email: "test@example.com" },
				} as any,
			});

			expect(result).toHaveLength(2);
			expect(mockDb.listMcpConfigsForTenant).toHaveBeenCalledWith({
				userId: "user-123",
				organizationId: undefined,
			});
		});

		it("should list organization configurations", async () => {
			const orgConfigs = [
				{
					id: "config-1",
					organizationId: "org-123",
					mcpServerId: "server-1",
				},
			];

			mockDb.listMcpConfigsForTenant.mockResolvedValue(orgConfigs);

			// Mock org membership
			const verifyOrganizationMembership = await loadVerifyMembership();
			vi.mocked(verifyOrganizationMembership).mockResolvedValue({
				role: "member",
			} as any);

			const configProcedures = await loadConfigProcedures();

			const result = await (configProcedures.list as any).handler({
				input: { organizationId: "org-123" },
				context: {
					user: { id: "user-123", email: "test@example.com" },
				} as any,
			});

			expect(result).toHaveLength(1);
			expect(mockDb.listMcpConfigsForTenant).toHaveBeenCalledWith({
				userId: "user-123",
				organizationId: "org-123",
			});
		});
	});
});
