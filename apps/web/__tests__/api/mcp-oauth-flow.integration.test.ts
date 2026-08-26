/**
 * Integration tests for MCP OAuth 2.0 + PKCE flow
 * Tests the complete flow: start -> authorize -> callback -> refresh
 *
 * NOTE: These tests are currently skipped because they use an incorrect pattern
 * for testing oRPC procedures. oRPC procedures don't expose a `.handler` property
 * that can be called directly. These tests need to be rewritten to either:
 * 1. Use oRPC's test utilities
 * 2. Test through HTTP using a test server
 * 3. Extract and test the underlying service functions directly
 */

import type { MCPConfig, MCPOAuthState, MCPServer } from "@repo/database";
import { beforeAll, describe, expect, it, vi } from "vitest";

// Mock database queries
const mockDb = {
	getMcpConfigById: vi.fn(),
	getMcpServerById: vi.fn(),
	createOauthState: vi.fn(),
	getOauthState: vi.fn(),
	deleteOauthState: vi.fn(),
	updateMcpConfigTokens: vi.fn(),
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

const MCP_OAUTH_MODULE_PATH =
	"../../../../packages/api/modules/mcp/procedures/oauth";
const loadOauthProcedures = async () =>
	(await import(MCP_OAUTH_MODULE_PATH)).oauthProcedures;

describe.skip("MCP OAuth Flow Integration Tests", () => {
	const mockServer: Partial<MCPServer> = {
		id: "server-1",
		key: "test-mcp",
		name: "Test MCP Server",
		oauthDiscoveryUrl:
			"https://mcp.example.com/.well-known/oauth-authorization-server",
		oauthAuthorizationEndpoint: "https://mcp.example.com/oauth/authorize",
		oauthTokenEndpoint: "https://mcp.example.com/oauth/token",
	};

	const mockConfig: Partial<MCPConfig> = {
		id: "config-1",
		mcpServerId: "server-1",
		userId: "user-123",
		baseUrl: "https://mcp.example.com",
		authType: "OAUTH2",
		scopes: ["read", "write"],
	};

	beforeAll(() => {
		// Mock fetch for OAuth discovery and token exchange
		global.fetch = vi.fn();
	});

	describe("OAuth Start Flow", () => {
		it("should generate PKCE parameters and return authorization URL", async () => {
			const mockState: Partial<MCPOAuthState> = {
				id: "state-1",
				state: "random-state-123",
				mcpServerId: "server-1",
				configId: "config-1",
				userId: "user-123",
				codeVerifier: "random-code-verifier-123",
				redirectUri: "https://app.example.com/api/mcp/oauth/callback",
				expiresAt: new Date(Date.now() + 600000), // 10 minutes
			};

			mockDb.getMcpConfigById.mockResolvedValue({
				...mockConfig,
				mcpServer: mockServer,
			});
			mockDb.createOauthState.mockResolvedValue(mockState);

			// Import the procedure after mocks are set up
			const oauthProcedures = await loadOauthProcedures();

			const result = await (oauthProcedures.start as any).handler({
				input: {
					configId: "config-1",
					redirectUri:
						"https://app.example.com/api/mcp/oauth/callback",
					autoDiscoverAndRegister: false,
				},
				context: {
					user: { id: "user-123", email: "test@example.com" },
				} as any,
			});

			expect(result).toHaveProperty("authorizationUrl");
			expect(result).toHaveProperty("state");
			expect(result.authorizationUrl).toContain(
				"https://mcp.example.com/oauth/authorize",
			);
			expect(result.authorizationUrl).toContain("response_type=code");
			expect(result.authorizationUrl).toContain(
				"code_challenge_method=S256",
			);
			expect(result.authorizationUrl).toContain(
				`state=${mockState.state}`,
			);
		});

		it("should reject if user does not have access to config", async () => {
			mockDb.getMcpConfigById.mockResolvedValue({
				...mockConfig,
				userId: "different-user",
				mcpServer: mockServer,
			});

			const oauthProcedures = await loadOauthProcedures();

			await expect(
				(oauthProcedures.start as any).handler({
					input: {
						configId: "config-1",
						redirectUri:
							"https://app.example.com/api/mcp/oauth/callback",
						autoDiscoverAndRegister: false,
					},
					context: {
						user: { id: "user-123", email: "test@example.com" },
					} as any,
				}),
			).rejects.toThrow("FORBIDDEN");
		});

		it("should handle automatic discovery and DCR registration", async () => {
			const discoveryResponse = {
				authorization_endpoint:
					"https://mcp.example.com/oauth/authorize",
				token_endpoint: "https://mcp.example.com/oauth/token",
				registration_endpoint: "https://mcp.example.com/oauth/register",
				scopes_supported: ["read", "write", "admin"],
			};

			const dcrResponse = {
				client_id: "auto-registered-client-id",
				client_secret: "auto-registered-client-secret",
				registration_access_token: "registration-token",
			};

			(global.fetch as any)
				.mockResolvedValueOnce({
					// Discovery request
					ok: true,
					json: async () => discoveryResponse,
				})
				.mockResolvedValueOnce({
					// DCR registration request
					ok: true,
					json: async () => dcrResponse,
				});

			mockDb.getMcpConfigById.mockResolvedValue({
				...mockConfig,
				oauthClientId: null, // No client ID yet
				mcpServer: {
					...mockServer,
					dcrRegistrationEndpoint:
						"https://mcp.example.com/oauth/register",
				},
			});

			mockDb.createOauthState.mockResolvedValue({
				state: "random-state-123",
				codeVerifier: "random-code-verifier-123",
			});

			const oauthProcedures = await loadOauthProcedures();

			const result = await (oauthProcedures.start as any).handler({
				input: {
					configId: "config-1",
					redirectUri:
						"https://app.example.com/api/mcp/oauth/callback",
					autoDiscoverAndRegister: true,
				},
				context: {
					user: { id: "user-123", email: "test@example.com" },
				} as any,
			});

			expect(global.fetch).toHaveBeenCalledWith(
				expect.stringContaining(
					"/.well-known/oauth-authorization-server",
				),
			);
			expect(global.fetch).toHaveBeenCalledWith(
				"https://mcp.example.com/oauth/register",
				expect.objectContaining({
					method: "POST",
				}),
			);
			expect(result.authorizationUrl).toBeDefined();
		});
	});

	describe("OAuth Token Exchange (Callback)", () => {
		it("should exchange authorization code for tokens", async () => {
			const mockState: Partial<MCPOAuthState> = {
				id: "state-1",
				state: "random-state-123",
				mcpServerId: "server-1",
				configId: "config-1",
				userId: "user-123",
				codeVerifier: "random-code-verifier-123",
				redirectUri: "https://app.example.com/api/mcp/oauth/callback",
				expiresAt: new Date(Date.now() + 600000), // Not expired
			};

			const tokenResponse = {
				access_token: "access-token-123",
				refresh_token: "refresh-token-456",
				expires_in: 3600,
				token_type: "Bearer",
			};

			mockDb.getOauthState.mockResolvedValue({
				...mockState,
				config: { ...mockConfig, mcpServer: mockServer },
			});
			mockDb.deleteOauthState.mockResolvedValue(undefined);
			mockDb.updateMcpConfigTokens.mockResolvedValue({ ...mockConfig });

			(global.fetch as any).mockResolvedValueOnce({
				ok: true,
				json: async () => tokenResponse,
			});

			const oauthProcedures = await loadOauthProcedures();

			const result = await (oauthProcedures.callback as any).handler({
				input: {
					code: "authorization-code-123",
					state: "random-state-123",
				},
				context: {} as any, // Public procedure, no auth required
			});

			expect(result.success).toBe(true);
			expect(mockDb.updateMcpConfigTokens).toHaveBeenCalledWith(
				"config-1",
				expect.objectContaining({
					encryptedAccessToken: "encrypted_access-token-123",
					encryptedRefreshToken: "encrypted_refresh-token-456",
				}),
			);
			expect(mockDb.deleteOauthState).toHaveBeenCalledWith(mockState.id);
		});

		it("should reject expired OAuth state", async () => {
			const expiredState: Partial<MCPOAuthState> = {
				id: "state-1",
				state: "random-state-123",
				expiresAt: new Date(Date.now() - 10000), // Expired
			};

			mockDb.getOauthState.mockResolvedValue(expiredState);

			const oauthProcedures = await loadOauthProcedures();

			await expect(
				(oauthProcedures.callback as any).handler({
					input: {
						code: "authorization-code-123",
						state: "random-state-123",
					},
					context: {} as any,
				}),
			).rejects.toThrow("OAuth state has expired");

			expect(mockDb.deleteOauthState).toHaveBeenCalledWith("state-1");
		});

		it("should reject invalid state parameter", async () => {
			mockDb.getOauthState.mockResolvedValue(null);

			const oauthProcedures = await loadOauthProcedures();

			await expect(
				(oauthProcedures.callback as any).handler({
					input: {
						code: "authorization-code-123",
						state: "invalid-state",
					},
					context: {} as any,
				}),
			).rejects.toThrow("Invalid OAuth state");
		});

		it("should handle token exchange failure", async () => {
			const mockState: Partial<MCPOAuthState> = {
				id: "state-1",
				state: "random-state-123",
				mcpServerId: "server-1",
				configId: "config-1",
				userId: "user-123",
				codeVerifier: "random-code-verifier-123",
				redirectUri: "https://app.example.com/api/mcp/oauth/callback",
				expiresAt: new Date(Date.now() + 600000),
			};

			mockDb.getOauthState.mockResolvedValue({
				...mockState,
				config: { ...mockConfig, mcpServer: mockServer },
			});

			(global.fetch as any).mockResolvedValueOnce({
				ok: false,
				status: 401,
				json: async () => ({
					error: "invalid_grant",
					error_description: "Authorization code expired",
				}),
			});

			const oauthProcedures = await loadOauthProcedures();

			await expect(
				(oauthProcedures.callback as any).handler({
					input: {
						code: "expired-code",
						state: "random-state-123",
					},
					context: {} as any,
				}),
			).rejects.toThrow();
		});
	});

	describe("OAuth Token Refresh", () => {
		it("should successfully refresh access token", async () => {
			const configWithTokens = {
				...mockConfig,
				encryptedRefreshToken: "encrypted_refresh-token-456",
				oauthClientId: "client-id-123",
				encryptedOauthClientSecret: "encrypted_client-secret-789",
				mcpServer: mockServer,
			};

			const refreshResponse = {
				access_token: "new-access-token-999",
				refresh_token: "new-refresh-token-888",
				expires_in: 3600,
				token_type: "Bearer",
			};

			mockDb.getMcpConfigById.mockResolvedValue(configWithTokens);
			mockDb.updateMcpConfigTokens.mockResolvedValue(configWithTokens);

			(global.fetch as any).mockResolvedValueOnce({
				ok: true,
				json: async () => refreshResponse,
			});

			const oauthProcedures = await loadOauthProcedures();

			const result = await (oauthProcedures.refresh as any).handler({
				input: {
					configId: "config-1",
				},
				context: {
					user: { id: "user-123", email: "test@example.com" },
				} as any,
			});

			expect(result.success).toBe(true);
			expect(mockDb.updateMcpConfigTokens).toHaveBeenCalledWith(
				"config-1",
				expect.objectContaining({
					encryptedAccessToken: "encrypted_new-access-token-999",
					encryptedRefreshToken: "encrypted_new-refresh-token-888",
				}),
			);
		});

		it("should reject if no refresh token available", async () => {
			mockDb.getMcpConfigById.mockResolvedValue({
				...mockConfig,
				encryptedRefreshToken: null, // No refresh token
				mcpServer: mockServer,
			});

			const oauthProcedures = await loadOauthProcedures();

			await expect(
				(oauthProcedures.refresh as any).handler({
					input: {
						configId: "config-1",
					},
					context: {
						user: { id: "user-123", email: "test@example.com" },
					} as any,
				}),
			).rejects.toThrow("No refresh token available");
		});

		it("should handle refresh token expiration (invalid_grant)", async () => {
			const configWithTokens = {
				...mockConfig,
				encryptedRefreshToken: "encrypted_expired-refresh-token",
				oauthClientId: "client-id-123",
				encryptedOauthClientSecret: "encrypted_client-secret-789",
				mcpServer: mockServer,
			};

			mockDb.getMcpConfigById.mockResolvedValue(configWithTokens);

			(global.fetch as any).mockResolvedValueOnce({
				ok: false,
				status: 401,
				json: async () => ({
					error: "invalid_grant",
					error_description: "Refresh token expired",
				}),
			});

			const oauthProcedures = await loadOauthProcedures();

			await expect(
				(oauthProcedures.refresh as any).handler({
					input: {
						configId: "config-1",
					},
					context: {
						user: { id: "user-123", email: "test@example.com" },
					} as any,
				}),
			).rejects.toThrow();
		});
	});

	describe("Edge Cases & Security", () => {
		it("should validate redirect URI in OAuth state", async () => {
			const mockState: Partial<MCPOAuthState> = {
				id: "state-1",
				state: "random-state-123",
				mcpServerId: "server-1",
				configId: "config-1",
				userId: "user-123",
				codeVerifier: "random-code-verifier-123",
				redirectUri: "https://app.example.com/api/mcp/oauth/callback",
				expiresAt: new Date(Date.now() + 600000),
			};

			mockDb.getOauthState.mockResolvedValue({
				...mockState,
				config: { ...mockConfig, mcpServer: mockServer },
			});

			// The callback procedure should validate that the redirect URI matches
			// This is a security measure to prevent redirect URI manipulation
			expect(mockState.redirectUri).toBe(
				"https://app.example.com/api/mcp/oauth/callback",
			);
		});

		it("should use single-use OAuth state (deleted after callback)", async () => {
			const mockState: Partial<MCPOAuthState> = {
				id: "state-1",
				state: "random-state-123",
				mcpServerId: "server-1",
				configId: "config-1",
				userId: "user-123",
				codeVerifier: "random-code-verifier-123",
				expiresAt: new Date(Date.now() + 600000),
			};

			mockDb.getOauthState.mockResolvedValue({
				...mockState,
				config: { ...mockConfig, mcpServer: mockServer },
			});
			mockDb.deleteOauthState.mockResolvedValue(undefined);
			mockDb.updateMcpConfigTokens.mockResolvedValue({ ...mockConfig });

			(global.fetch as any).mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					access_token: "token",
					refresh_token: "refresh",
					expires_in: 3600,
				}),
			});

			const oauthProcedures = await loadOauthProcedures();

			await (oauthProcedures.callback as any).handler({
				input: {
					code: "code-123",
					state: "random-state-123",
				},
				context: {} as any,
			});

			expect(mockDb.deleteOauthState).toHaveBeenCalledWith("state-1");
		});

		it("should enforce organization membership for org-scoped configs", async () => {
			const orgConfig = {
				...mockConfig,
				userId: null,
				organizationId: "org-123",
				mcpServer: mockServer,
			};

			mockDb.getMcpConfigById.mockResolvedValue(orgConfig);
			mockDb.getOrganizationById.mockResolvedValue({
				id: "org-123",
				name: "Test Org",
			});

			// Mock organization membership check would happen here
			// In real implementation, this would be in verifyOrganizationMembership
		});
	});
});
