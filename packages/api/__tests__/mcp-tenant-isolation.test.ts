/**
 * Multi-Tenant Isolation Tests for MCP API Procedures
 *
 * These tests verify that the API layer correctly enforces tenant isolation
 * for MCP servers and configurations.
 */

import { ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// All mock objects are declared via vi.hoisted so they're initialized
// before the vi.mock factories below (which vitest hoists to the very top
// of the file). Without hoisting, static top-level imports of the
// modules-under-test would run the mock factories before these const
// initializers and throw "Cannot access X before initialization".
const {
	mockDb,
	mockCache,
	mockAuth,
	mockVerifyMembership,
	mockTemporal,
	mockEncrypt,
} = vi.hoisted(() => ({
	mockDb: {
		listMcpConfigsForTenant: vi.fn(),
		getMcpConfigById: vi.fn(),
		getMcpConfigForTenantAndServer: vi.fn(),
		upsertMcpConfig: vi.fn(),
		deleteMcpConfig: vi.fn(),
		getMcpServerById: vi.fn(),
		getOrganizationById: vi.fn(),
		listMcpServersAccessibleToTenant: vi.fn(),
		listCustomMcpServersForTenant: vi.fn(),
		createCustomMcpServer: vi.fn(),
		updateCustomMcpServer: vi.fn(),
		deleteCustomMcpServer: vi.fn(),
	},
	mockCache: {
		getCachedSystemServers: vi.fn(),
		setCachedSystemServers: vi.fn(),
	},
	mockAuth: {
		api: {
			getSession: vi.fn(),
		},
	},
	mockVerifyMembership: vi.fn(),
	mockTemporal: {
		triggerMcpToolIngestion: vi.fn(),
		triggerMcpToolDeletion: vi.fn(),
	},
	mockEncrypt: {
		encryptApiKey: vi.fn((s: string) => `encrypted_${s}`),
		decryptApiKey: vi.fn((s: string) => s.replace("encrypted_", "")),
	},
}));

// Replaces every export configs.ts and registry.ts pull from @repo/database.
// We deliberately avoid `vi.importActual("@repo/database")` because that
// loads the real prisma singleton (PrismaPg pool) at module load, which
// holds open handles past test completion and prevents vitest's main
// process from exiting (vitest #3909 — the post-test hang we hit in CI).
vi.mock("@repo/database", () => ({
	listMcpConfigsForTenant: mockDb.listMcpConfigsForTenant,
	getMcpConfigById: mockDb.getMcpConfigById,
	getMcpConfigForTenantAndServer: mockDb.getMcpConfigForTenantAndServer,
	upsertMcpConfig: mockDb.upsertMcpConfig,
	deleteMcpConfig: mockDb.deleteMcpConfig,
	getMcpServerById: mockDb.getMcpServerById,
	getOrganizationById: mockDb.getOrganizationById,
	listMcpServersAccessibleToTenant: mockDb.listMcpServersAccessibleToTenant,
	listCustomMcpServersForTenant: mockDb.listCustomMcpServersForTenant,
	createCustomMcpServer: mockDb.createCustomMcpServer,
	updateCustomMcpServer: mockDb.updateCustomMcpServer,
	deleteCustomMcpServer: mockDb.deleteCustomMcpServer,
	// Additional exports configs.ts/registry.ts touch but tests don't drive.
	createMcpClientSession: vi.fn(),
	createMcpConfig: vi.fn(),
	updateMcpConfigEnabled: vi.fn(),
	// Delete handler clears the config from report bindings (best-effort).
	clearMcpConfigFromReportInstances: vi.fn().mockResolvedValue(0),
	db: {},
	Prisma: {},
}));

vi.mock("../lib/mcp-registry-cache", () => ({
	getCachedSystemServers: mockCache.getCachedSystemServers,
	setCachedSystemServers: mockCache.setCachedSystemServers,
}));

vi.mock("@repo/auth", () => ({
	auth: mockAuth,
}));

vi.mock("../modules/organizations/lib/membership", () => ({
	verifyOrganizationMembership: mockVerifyMembership,
}));

vi.mock("@repo/temporal", () => ({
	triggerMcpToolIngestion: mockTemporal.triggerMcpToolIngestion,
	triggerMcpToolDeletion: mockTemporal.triggerMcpToolDeletion,
}));

vi.mock("@repo/utils", () => ({
	encryptApiKey: mockEncrypt.encryptApiKey,
	decryptApiKey: mockEncrypt.decryptApiKey,
}));

// Static top-level imports below — vi.mock above is hoisted, so the mocks
// are applied before these load. Keeping them at the top moves the heavy
// cold-cache transform cost to file-load time (paid once) instead of
// inside the first test's testTimeout window.
import { listMcpServersAccessibleToTenant } from "@repo/database";
import { configProcedures } from "../modules/mcp/procedures/configs";
import { registryProcedures } from "../modules/mcp/procedures/registry";

describe("MCP Config Procedures - Tenant Isolation", () => {
	const mockUser = {
		id: "user-123",
		email: "test@example.com",
		name: "Test User",
	};

	const mockSession = {
		user: mockUser,
		session: { id: "session-123" },
	};

	const mockOrg = {
		id: "org-456",
		name: "Test Org",
	};

	beforeEach(() => {
		vi.clearAllMocks();
		mockAuth.api.getSession.mockResolvedValue(mockSession);
	});

	describe("list procedure", () => {
		it("should only return user's personal configs when no org specified", async () => {
			const personalConfigs = [
				{
					id: "config-1",
					userId: "user-123",
					organizationId: null,
					mcpServerId: "server-1",
				},
				{
					id: "config-2",
					userId: "user-123",
					organizationId: null,
					mcpServerId: "server-2",
				},
			];

			mockDb.listMcpConfigsForTenant.mockResolvedValue(personalConfigs);

			const handler = (configProcedures.list as any)["~orpc"].handler;
			const result = await handler({
				input: {},
				context: mockSession,
			});

			// Should call with userId and no organizationId
			expect(mockDb.listMcpConfigsForTenant).toHaveBeenCalledWith({
				userId: "user-123",
				organizationId: undefined,
			});

			// Should return only personal configs
			expect(result).toHaveLength(2);
			expect(result.every((c: any) => c.organizationId === null)).toBe(
				true,
			);
		});

		it("should only return user's configs for specified org", async () => {
			const orgConfigs = [
				{
					id: "config-3",
					userId: "user-123",
					organizationId: "org-456",
					mcpServerId: "server-1",
				},
			];

			mockDb.listMcpConfigsForTenant.mockResolvedValue(orgConfigs);
			mockVerifyMembership.mockResolvedValue({ role: "member" });

			const handler = (configProcedures.list as any)["~orpc"].handler;
			const result = await handler({
				input: { organizationId: "org-456" },
				context: mockSession,
			});

			// Should call with both userId and organizationId
			expect(mockDb.listMcpConfigsForTenant).toHaveBeenCalledWith({
				userId: "user-123",
				organizationId: "org-456",
			});

			// Should return org configs
			expect(result).toHaveLength(1);
			expect(result[0].organizationId).toBe("org-456");
		});

		it("should reject listing configs for non-member org", async () => {
			mockVerifyMembership.mockResolvedValue(null); // Not a member

			const handler = (configProcedures.list as any)["~orpc"].handler;

			await expect(
				handler({
					input: { organizationId: "unrelated-org" },
					context: mockSession,
				}),
			).rejects.toThrow(ORPCError);

			await expect(
				handler({
					input: { organizationId: "unrelated-org" },
					context: mockSession,
				}),
			).rejects.toMatchObject({
				code: "FORBIDDEN",
			});
		});

		it("should NOT return other users' configs even in same org", async () => {
			// Only return current user's configs
			const userConfigs = [
				{
					id: "config-user",
					userId: "user-123",
					organizationId: "org-456",
				},
			];

			mockDb.listMcpConfigsForTenant.mockResolvedValue(userConfigs);
			mockVerifyMembership.mockResolvedValue({ role: "member" });

			const handler = (configProcedures.list as any)["~orpc"].handler;
			const result = await handler({
				input: { organizationId: "org-456" },
				context: mockSession,
			});

			// Verify the query is filtered by current user's ID
			expect(mockDb.listMcpConfigsForTenant).toHaveBeenCalledWith({
				userId: "user-123",
				organizationId: "org-456",
			});

			// Result should only contain current user's configs
			expect(result.every((c: any) => c.userId === "user-123")).toBe(
				true,
			);
		});

		it("should NOT return personal configs when querying org context", async () => {
			// Only org configs
			const orgConfigs = [
				{
					id: "config-org",
					userId: "user-123",
					organizationId: "org-456",
				},
			];

			mockDb.listMcpConfigsForTenant.mockResolvedValue(orgConfigs);
			mockVerifyMembership.mockResolvedValue({ role: "member" });

			const handler = (configProcedures.list as any)["~orpc"].handler;
			const result = await handler({
				input: { organizationId: "org-456" },
				context: mockSession,
			});

			// Personal configs have organizationId: null, org configs have orgId set
			// The query should filter by organizationId, so personal configs won't match
			expect(
				result.every((c: any) => c.organizationId === "org-456"),
			).toBe(true);
		});
	});

	describe("upsert procedure", () => {
		it("should create personal config when no org specified", async () => {
			mockDb.getMcpConfigForTenantAndServer.mockResolvedValue(null);
			mockDb.upsertMcpConfig.mockResolvedValue({
				id: "new-config",
				userId: "user-123",
				organizationId: null,
			});

			const handler = (configProcedures.upsert as any)["~orpc"].handler;
			const result = await handler({
				input: {
					mcpServerId: "server-1",
					baseUrl: "https://example.com",
					authType: "API_KEY",
					apiKey: "test-key",
				},
				context: mockSession,
			});

			// Should create with userId and null organizationId
			expect(mockDb.upsertMcpConfig).toHaveBeenCalledWith({
				mcpServerId: "server-1",
				userId: "user-123",
				organizationId: undefined, // undefined treated as null in query
				data: expect.any(Object),
			});

			expect(result.organizationId).toBeNull();
		});

		it("should create per-user org config when org specified", async () => {
			mockDb.getOrganizationById.mockResolvedValue(mockOrg);
			mockVerifyMembership.mockResolvedValue({ role: "member" });
			mockDb.getMcpConfigForTenantAndServer.mockResolvedValue(null);
			mockDb.upsertMcpConfig.mockResolvedValue({
				id: "new-org-config",
				userId: "user-123",
				organizationId: "org-456",
			});

			const handler = (configProcedures.upsert as any)["~orpc"].handler;
			const result = await handler({
				input: {
					mcpServerId: "server-1",
					organizationId: "org-456",
					baseUrl: "https://example.com",
					authType: "API_KEY",
					apiKey: "test-key",
				},
				context: mockSession,
			});

			// Should create with both userId and organizationId
			expect(mockDb.upsertMcpConfig).toHaveBeenCalledWith({
				mcpServerId: "server-1",
				userId: "user-123",
				organizationId: "org-456",
				data: expect.any(Object),
			});

			expect(result.organizationId).toBe("org-456");
		});

		it("should reject org config creation for non-members", async () => {
			mockDb.getOrganizationById.mockResolvedValue(mockOrg);
			mockVerifyMembership.mockResolvedValue(null);

			const handler = (configProcedures.upsert as any)["~orpc"].handler;

			await expect(
				handler({
					input: {
						mcpServerId: "server-1",
						organizationId: "unrelated-org",
						baseUrl: "https://example.com",
						authType: "NONE",
					},
					context: mockSession,
				}),
			).rejects.toThrow(ORPCError);

			expect(mockDb.upsertMcpConfig).not.toHaveBeenCalled();
		});

		it("should allow org config creation for any org member", async () => {
			mockDb.getOrganizationById.mockResolvedValue(mockOrg);
			mockVerifyMembership.mockResolvedValue({ role: "member" }); // Regular member
			mockDb.getMcpConfigForTenantAndServer.mockResolvedValue(null);
			mockDb.upsertMcpConfig.mockResolvedValue({
				id: "new-org-config",
				userId: "user-123",
				organizationId: "org-456",
			});

			const handler = (configProcedures.upsert as any)["~orpc"].handler;
			const result = await handler({
				input: {
					mcpServerId: "server-1",
					organizationId: "org-456",
					baseUrl: "https://example.com",
					authType: "NONE",
				},
				context: mockSession,
			});

			// Any member can create their own config
			expect(mockDb.upsertMcpConfig).toHaveBeenCalledWith({
				mcpServerId: "server-1",
				userId: "user-123",
				organizationId: "org-456",
				data: expect.any(Object),
			});
			expect(result.organizationId).toBe("org-456");
		});
	});

	describe("delete procedure", () => {
		it("should only delete user's own config", async () => {
			// Config belongs to current user
			const userConfig = {
				id: "config-123",
				userId: "user-123",
				organizationId: null,
			};

			mockDb.getMcpConfigById.mockResolvedValue(userConfig);
			mockDb.deleteMcpConfig.mockResolvedValue({ success: true });

			const handler = (configProcedures.delete as any)["~orpc"].handler;
			const result = await handler({
				input: { id: "config-123" },
				context: mockSession,
			});

			// Query should be filtered by current user
			expect(mockDb.getMcpConfigById).toHaveBeenCalledWith("config-123", {
				userId: "user-123",
				organizationId: undefined,
			});

			expect(result.success).toBe(true);
		});

		it("should not delete another user's personal config", async () => {
			// `getMcpConfigById` is tenant-filtered — when the caller's userId
			// doesn't match the config owner, the query returns null. Simulate
			// that here.
			mockDb.getMcpConfigById.mockResolvedValue(null);

			const handler = (configProcedures.delete as any)["~orpc"].handler;
			const result = await handler({
				input: { id: "config-other" },
				context: mockSession,
			});

			expect(mockDb.getMcpConfigById).toHaveBeenCalledWith(
				"config-other",
				{
					userId: "user-123",
					organizationId: undefined,
				},
			);

			// No config found for the caller — handler is a no-op success.
			expect(mockDb.deleteMcpConfig).not.toHaveBeenCalled();
			expect(result).toEqual({ success: true });
		});

		it("should not delete another user's org config", async () => {
			// Same as above — filtered query returns null when the config
			// belongs to a different userId in the same org.
			mockDb.getMcpConfigById.mockResolvedValue(null);
			mockVerifyMembership.mockResolvedValue({ role: "admin" });

			const handler = (configProcedures.delete as any)["~orpc"].handler;
			const result = await handler({
				input: { id: "config-other-user", organizationId: "org-456" },
				context: mockSession,
			});

			expect(mockDb.getMcpConfigById).toHaveBeenCalledWith(
				"config-other-user",
				{
					userId: "user-123",
					organizationId: "org-456",
				},
			);

			expect(mockDb.deleteMcpConfig).not.toHaveBeenCalled();
			expect(result).toEqual({ success: true });
		});

		it("should allow any member to delete their own org config", async () => {
			const orgConfig = {
				id: "config-org",
				userId: "user-123",
				organizationId: "org-456",
				mcpServer: { name: "Test Server" },
			};

			mockDb.getMcpConfigById.mockResolvedValue(orgConfig);
			mockDb.deleteMcpConfig.mockResolvedValue({ success: true });
			mockVerifyMembership.mockResolvedValue({ role: "member" }); // Regular member

			const handler = (configProcedures.delete as any)["~orpc"].handler;
			const result = await handler({
				input: { id: "config-org", organizationId: "org-456" },
				context: mockSession,
			});

			// Any member can delete their own config
			expect(mockDb.deleteMcpConfig).toHaveBeenCalledWith("config-org");
			expect(result.success).toBe(true);
		});
	});
});

describe("MCP Server Registry - Tenant Isolation", () => {
	const _mockUser = {
		id: "user-123",
		email: "test@example.com",
	};

	beforeEach(() => {
		vi.clearAllMocks();
	});

	// Tests for listSystemMcpServers / listMcpServersAccessibleToTenant
	// (raw prisma query shape) live in the @repo/database integration suite —
	// they require a real Postgres to assert RLS behavior. The blocks that
	// previously tried to mock `db.mCPServer.findMany` here would never
	// have run end-to-end since `@repo/database` mock falls through to the
	// real implementation.

	describe("includeNonImplemented option", () => {
		it("should pass through when absent (default behavior)", async () => {
			mockDb.listMcpServersAccessibleToTenant.mockResolvedValue([]);

			await listMcpServersAccessibleToTenant({ userId: "user-123" });

			expect(
				mockDb.listMcpServersAccessibleToTenant,
			).toHaveBeenCalledWith({ userId: "user-123" });
		});

		it("should pass through when false (default behavior)", async () => {
			mockDb.listMcpServersAccessibleToTenant.mockResolvedValue([]);

			await listMcpServersAccessibleToTenant({
				userId: "user-123",
				includeNonImplemented: false,
			});

			expect(
				mockDb.listMcpServersAccessibleToTenant,
			).toHaveBeenCalledWith({
				userId: "user-123",
				includeNonImplemented: false,
			});
		});

		it("should pass through when true (expanded search path)", async () => {
			mockDb.listMcpServersAccessibleToTenant.mockResolvedValue([]);

			await listMcpServersAccessibleToTenant({
				userId: "user-123",
				includeNonImplemented: true,
			});

			expect(
				mockDb.listMcpServersAccessibleToTenant,
			).toHaveBeenCalledWith({
				userId: "user-123",
				includeNonImplemented: true,
			});
		});

		it("should preserve personal XOR condition alongside includeNonImplemented: true", async () => {
			mockDb.listMcpServersAccessibleToTenant.mockResolvedValue([]);

			await listMcpServersAccessibleToTenant({
				userId: "user-123",
				includeNonImplemented: true,
			});

			expect(
				mockDb.listMcpServersAccessibleToTenant,
			).toHaveBeenCalledWith(
				expect.objectContaining({ userId: "user-123" }),
			);
		});

		it("should preserve org XOR condition alongside includeNonImplemented: true", async () => {
			mockDb.listMcpServersAccessibleToTenant.mockResolvedValue([]);

			await listMcpServersAccessibleToTenant({
				userId: "user-123",
				organizationId: "org-456",
				includeNonImplemented: true,
			});

			expect(
				mockDb.listMcpServersAccessibleToTenant,
			).toHaveBeenCalledWith(
				expect.objectContaining({
					userId: "user-123",
					organizationId: "org-456",
				}),
			);
		});
	});

	// `getMcpServerById` raw prisma query shape is covered by the
	// @repo/database integration suite (real Postgres). The mocks here
	// reach into prisma internals (`db.mCPServer.findFirst`) that aren't
	// stubbed, so the assertions can never observe what they intend.
});

describe("registryProcedures.list — cache bypass behavior", () => {
	const mockUser = {
		id: "user-123",
		email: "test@example.com",
		name: "Test User",
	};

	const mockSession = {
		user: mockUser,
		session: { id: "session-123" },
	};

	const mockServers = [
		{
			id: "system-1",
			name: "System Server",
			isSystemProvided: true,
			key: "system-server",
			defaultUrl: "https://example.com/mcp",
			isImplemented: true,
		},
	];

	beforeEach(() => {
		vi.clearAllMocks();
		mockCache.setCachedSystemServers.mockResolvedValue(undefined);
		mockDb.listCustomMcpServersForTenant.mockResolvedValue([]);
		mockDb.listMcpServersAccessibleToTenant.mockResolvedValue(mockServers);
	});

	it("should call getCachedSystemServers when includeAll is absent", async () => {
		mockCache.getCachedSystemServers.mockResolvedValue(mockServers);

		const handler = (registryProcedures.list as any)["~orpc"].handler;
		await handler({ input: {}, context: mockSession });

		expect(mockCache.getCachedSystemServers).toHaveBeenCalled();
	});

	it("should call getCachedSystemServers when includeAll is false", async () => {
		mockCache.getCachedSystemServers.mockResolvedValue(mockServers);

		const handler = (registryProcedures.list as any)["~orpc"].handler;
		await handler({
			input: { includeAll: false },
			context: mockSession,
		});

		expect(mockCache.getCachedSystemServers).toHaveBeenCalled();
	});

	it("should return cached servers without calling DB on cache hit (no includeAll)", async () => {
		mockCache.getCachedSystemServers.mockResolvedValue(mockServers);

		const handler = (registryProcedures.list as any)["~orpc"].handler;
		await handler({ input: {}, context: mockSession });

		expect(mockDb.listMcpServersAccessibleToTenant).not.toHaveBeenCalled();
	});

	it("should NOT call getCachedSystemServers when includeAll is true", async () => {
		const handler = (registryProcedures.list as any)["~orpc"].handler;
		await handler({
			input: { includeAll: true },
			context: mockSession,
		});

		expect(mockCache.getCachedSystemServers).not.toHaveBeenCalled();
	});

	it("should call listMcpServersAccessibleToTenant with includeNonImplemented: true when includeAll is true", async () => {
		const handler = (registryProcedures.list as any)["~orpc"].handler;
		await handler({
			input: { includeAll: true },
			context: mockSession,
		});

		expect(mockDb.listMcpServersAccessibleToTenant).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "user-123",
				includeNonImplemented: true,
			}),
		);
	});

	it("should NOT call setCachedSystemServers when includeAll is true", async () => {
		const handler = (registryProcedures.list as any)["~orpc"].handler;
		await handler({
			input: { includeAll: true },
			context: mockSession,
		});

		expect(mockCache.setCachedSystemServers).not.toHaveBeenCalled();
	});

	it("should populate cache with system servers on cache miss (no includeAll)", async () => {
		mockCache.getCachedSystemServers.mockResolvedValue(null);

		const handler = (registryProcedures.list as any)["~orpc"].handler;
		await handler({ input: {}, context: mockSession });

		expect(mockCache.setCachedSystemServers).toHaveBeenCalledWith(
			expect.arrayContaining([
				expect.objectContaining({ isSystemProvided: true }),
			]),
		);
	});
});
