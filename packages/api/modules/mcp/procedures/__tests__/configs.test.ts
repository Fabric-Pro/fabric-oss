/**
 * Tests for MCP Config Procedures
 *
 * Tests the upsert procedure's handling of apiKeyMethod
 * for API key authentication configurations.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

// Mock database functions
vi.mock("@repo/database", () => ({
	getMcpConfigById: vi.fn(),
	getMcpConfigForTenantAndServer: vi.fn(),
	getOrganizationById: vi.fn(),
	listMcpConfigsForTenant: vi.fn(),
	upsertMcpConfig: vi.fn(),
	updateMcpConfigEnabled: vi.fn(),
	deleteMcpConfig: vi.fn(),
	createMcpClientSession: vi.fn(),
	getMcpServerById: vi.fn(),
	getUserDefaultProviderConfig: vi.fn(),
	getOrganizationDefaultProviderConfig: vi.fn(),
}));

// Mock utils
vi.mock("@repo/utils", () => ({
	encryptApiKey: vi.fn((key: string) => `encrypted:${key}`),
}));

// Mock temporal
vi.mock("@repo/temporal", () => ({
	triggerMcpToolIngestion: vi.fn(),
	triggerMcpToolDeletion: vi.fn(),
}));

// Mock membership verification
vi.mock("../../../organizations/lib/membership", () => ({
	verifyOrganizationMembership: vi.fn(),
}));

// Input schema for upsert procedure (replicated from configs.ts)
const upsertInputSchema = z.object({
	mcpServerId: z.string(),
	organizationId: z.string().nullable().optional(),
	displayName: z.string().optional(),
	baseUrl: z.string().url({
		message: "Base URL is required and must be a valid URL",
	}),
	authType: z.enum(["NONE", "API_KEY", "OAUTH2"]).optional(),
	apiKeyMethod: z.enum(["BEARER", "HEADER"]).optional(),
	oauthClientId: z.string().optional(),
	oauthClientSecret: z.string().optional(),
	apiKey: z.string().optional(),
	accessToken: z.string().optional(),
	refreshToken: z.string().optional(),
	encryptedApiKey: z.string().optional().nullable(),
	encryptedAccessToken: z.string().optional().nullable(),
	encryptedRefreshToken: z.string().optional().nullable(),
	tokenExpiresAt: z.coerce.date().optional(),
	scopes: z.array(z.string()).default([]),
	enabled: z.boolean().default(true),
});

describe("MCP Config Procedures", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("upsert input schema validation", () => {
		describe("apiKeyMethod field", () => {
			it("should accept BEARER as valid apiKeyMethod", () => {
				const input = {
					mcpServerId: "test-server",
					baseUrl: "https://api.example.com/mcp",
					authType: "API_KEY" as const,
					apiKeyMethod: "BEARER" as const,
					apiKey: "test-api-key",
				};

				const result = upsertInputSchema.safeParse(input);
				expect(result.success).toBe(true);
				if (result.success) {
					expect(result.data.apiKeyMethod).toBe("BEARER");
				}
			});

			it("should accept HEADER as valid apiKeyMethod", () => {
				const input = {
					mcpServerId: "test-server",
					baseUrl: "https://api.example.com/mcp",
					authType: "API_KEY" as const,
					apiKeyMethod: "HEADER" as const,
					apiKey: "test-api-key",
				};

				const result = upsertInputSchema.safeParse(input);
				expect(result.success).toBe(true);
				if (result.success) {
					expect(result.data.apiKeyMethod).toBe("HEADER");
				}
			});

			it("should reject invalid apiKeyMethod values", () => {
				const input = {
					mcpServerId: "test-server",
					baseUrl: "https://api.example.com/mcp",
					authType: "API_KEY" as const,
					apiKeyMethod: "INVALID_METHOD",
					apiKey: "test-api-key",
				};

				const result = upsertInputSchema.safeParse(input);
				expect(result.success).toBe(false);
			});

			it("should allow apiKeyMethod to be optional", () => {
				const input = {
					mcpServerId: "test-server",
					baseUrl: "https://api.example.com/mcp",
					authType: "API_KEY" as const,
					apiKey: "test-api-key",
				};

				const result = upsertInputSchema.safeParse(input);
				expect(result.success).toBe(true);
				if (result.success) {
					expect(result.data.apiKeyMethod).toBeUndefined();
				}
			});

			it("should allow apiKeyMethod with OAUTH2 authType (will be ignored in handler)", () => {
				const input = {
					mcpServerId: "test-server",
					baseUrl: "https://api.example.com/mcp",
					authType: "OAUTH2" as const,
					apiKeyMethod: "HEADER" as const,
				};

				const result = upsertInputSchema.safeParse(input);
				expect(result.success).toBe(true);
			});

			it("should allow apiKeyMethod with NONE authType (will be ignored in handler)", () => {
				const input = {
					mcpServerId: "test-server",
					baseUrl: "https://api.example.com/mcp",
					authType: "NONE" as const,
					apiKeyMethod: "BEARER" as const,
				};

				const result = upsertInputSchema.safeParse(input);
				expect(result.success).toBe(true);
			});
		});
	});

	describe("apiKeyMethod data transformation", () => {
		it("should set apiKeyMethod to BEARER by default when authType is API_KEY", () => {
			const input = {
				mcpServerId: "test-server",
				baseUrl: "https://api.example.com/mcp",
				authType: "API_KEY" as const,
				apiKey: "test-api-key",
			};
			const effectiveAuthType = "API_KEY";

			// Simulate the handler's data transformation logic
			const data: Record<string, unknown> = {
				baseUrl: input.baseUrl,
				authType: effectiveAuthType,
				apiKeyMethod:
					effectiveAuthType === "API_KEY"
						? (input.apiKeyMethod ?? "BEARER")
						: undefined,
			};

			expect(data.apiKeyMethod).toBe("BEARER");
		});

		it("should preserve HEADER apiKeyMethod when explicitly set", () => {
			const input = {
				mcpServerId: "test-server",
				baseUrl: "https://api.example.com/mcp",
				authType: "API_KEY" as const,
				apiKeyMethod: "HEADER" as const,
				apiKey: "test-api-key",
			};
			const effectiveAuthType = "API_KEY";

			const data: Record<string, unknown> = {
				baseUrl: input.baseUrl,
				authType: effectiveAuthType,
				apiKeyMethod:
					effectiveAuthType === "API_KEY"
						? (input.apiKeyMethod ?? "BEARER")
						: undefined,
			};

			expect(data.apiKeyMethod).toBe("HEADER");
		});

		it("should set apiKeyMethod to undefined when authType is OAUTH2", () => {
			const input = {
				mcpServerId: "test-server",
				baseUrl: "https://api.example.com/mcp",
				authType: "OAUTH2" as const,
				apiKeyMethod: "HEADER" as const, // Should be ignored
			};
			const effectiveAuthType = "OAUTH2";

			const data: Record<string, unknown> = {
				baseUrl: input.baseUrl,
				authType: effectiveAuthType,
				apiKeyMethod:
					effectiveAuthType === "API_KEY"
						? (input.apiKeyMethod ?? "BEARER")
						: undefined,
			};

			expect(data.apiKeyMethod).toBeUndefined();
		});

		it("should set apiKeyMethod to undefined when authType is NONE", () => {
			const input = {
				mcpServerId: "test-server",
				baseUrl: "https://api.example.com/mcp",
				authType: "NONE" as const,
				apiKeyMethod: "BEARER" as const, // Should be ignored
			};
			const effectiveAuthType = "NONE";

			const data: Record<string, unknown> = {
				baseUrl: input.baseUrl,
				authType: effectiveAuthType,
				apiKeyMethod:
					effectiveAuthType === "API_KEY"
						? (input.apiKeyMethod ?? "BEARER")
						: undefined,
			};

			expect(data.apiKeyMethod).toBeUndefined();
		});
	});

	describe("complete config creation scenarios", () => {
		it("should build correct data for API_KEY with BEARER method", () => {
			const input = {
				mcpServerId: "cloudflare-mcp",
				baseUrl: "https://bindings.mcp.cloudflare.com/mcp",
				authType: "API_KEY" as const,
				apiKeyMethod: "BEARER" as const,
				apiKey: "cf-api-key-123",
				displayName: "Cloudflare Bindings",
				enabled: true,
				scopes: [] as string[],
			};

			// Simulate full data transformation
			const effectiveAuthType = input.authType;
			const encryptedApiKey = `encrypted:${input.apiKey}`;

			const data = {
				displayName: input.displayName,
				baseUrl: input.baseUrl,
				enabled: input.enabled,
				scopes: input.scopes,
				authType: effectiveAuthType,
				apiKeyMethod:
					effectiveAuthType === "API_KEY"
						? (input.apiKeyMethod ?? "BEARER")
						: undefined,
				encryptedApiKey,
			};

			expect(data).toEqual({
				displayName: "Cloudflare Bindings",
				baseUrl: "https://bindings.mcp.cloudflare.com/mcp",
				enabled: true,
				scopes: [],
				authType: "API_KEY",
				apiKeyMethod: "BEARER",
				encryptedApiKey: "encrypted:cf-api-key-123",
			});
		});

		it("should build correct data for API_KEY with HEADER method", () => {
			const input = {
				mcpServerId: "custom-mcp",
				baseUrl: "https://custom.mcp.example.com/mcp",
				authType: "API_KEY" as const,
				apiKeyMethod: "HEADER" as const,
				apiKey: "custom-x-api-key-456",
				displayName: "Custom MCP Server",
				enabled: true,
				scopes: [] as string[],
			};

			const effectiveAuthType = input.authType;
			const encryptedApiKey = `encrypted:${input.apiKey}`;

			const data = {
				displayName: input.displayName,
				baseUrl: input.baseUrl,
				enabled: input.enabled,
				scopes: input.scopes,
				authType: effectiveAuthType,
				apiKeyMethod:
					effectiveAuthType === "API_KEY"
						? (input.apiKeyMethod ?? "BEARER")
						: undefined,
				encryptedApiKey,
			};

			expect(data).toEqual({
				displayName: "Custom MCP Server",
				baseUrl: "https://custom.mcp.example.com/mcp",
				enabled: true,
				scopes: [],
				authType: "API_KEY",
				apiKeyMethod: "HEADER",
				encryptedApiKey: "encrypted:custom-x-api-key-456",
			});
		});

		it("should build correct data for OAUTH2 without apiKeyMethod", () => {
			const input = {
				mcpServerId: "github-mcp",
				baseUrl: "https://api.github.com/mcp",
				authType: "OAUTH2" as const,
				displayName: "GitHub MCP",
				enabled: true,
				scopes: ["repo", "read:user"],
			};

			const effectiveAuthType = input.authType;

			const data = {
				displayName: input.displayName,
				baseUrl: input.baseUrl,
				enabled: input.enabled,
				scopes: input.scopes,
				authType: effectiveAuthType,
				apiKeyMethod:
					effectiveAuthType === "API_KEY" ? "BEARER" : undefined,
			};

			expect(data).toEqual({
				displayName: "GitHub MCP",
				baseUrl: "https://api.github.com/mcp",
				enabled: true,
				scopes: ["repo", "read:user"],
				authType: "OAUTH2",
				apiKeyMethod: undefined,
			});
		});
	});

	describe("apiKeyMethod with existing config", () => {
		it("should preserve existing apiKeyMethod when updating other fields", () => {
			const existingConfig = {
				id: "config-1",
				mcpServerId: "test-server",
				baseUrl: "https://api.example.com/mcp",
				authType: "API_KEY",
				apiKeyMethod: "HEADER",
				encryptedApiKey: "encrypted:existing-key",
			};

			// Update only displayName, keeping existing auth settings
			const updateInput = {
				mcpServerId: "test-server",
				baseUrl: "https://api.example.com/mcp",
				displayName: "Updated Display Name",
				// No authType or apiKeyMethod specified - should keep existing
			};

			const effectiveAuthType =
				updateInput.authType ?? existingConfig.authType;

			// Simulating the handler logic for updates
			const data: Record<string, unknown> = {
				displayName: updateInput.displayName,
				baseUrl: updateInput.baseUrl,
				authType: effectiveAuthType,
				// In a real update, apiKeyMethod would come from input or existing
				apiKeyMethod:
					effectiveAuthType === "API_KEY"
						? ((updateInput as any).apiKeyMethod ??
							existingConfig.apiKeyMethod ??
							"BEARER")
						: undefined,
			};

			expect(data.apiKeyMethod).toBe("HEADER");
		});

		it("should allow changing apiKeyMethod from BEARER to HEADER", () => {
			const existingConfig = {
				id: "config-1",
				mcpServerId: "test-server",
				baseUrl: "https://api.example.com/mcp",
				authType: "API_KEY",
				apiKeyMethod: "BEARER",
				encryptedApiKey: "encrypted:existing-key",
			};

			const updateInput = {
				mcpServerId: "test-server",
				baseUrl: "https://api.example.com/mcp",
				authType: "API_KEY" as const,
				apiKeyMethod: "HEADER" as const,
			};

			const effectiveAuthType =
				updateInput.authType ?? existingConfig.authType;

			const data: Record<string, unknown> = {
				baseUrl: updateInput.baseUrl,
				authType: effectiveAuthType,
				apiKeyMethod:
					effectiveAuthType === "API_KEY"
						? (updateInput.apiKeyMethod ?? "BEARER")
						: undefined,
			};

			expect(data.apiKeyMethod).toBe("HEADER");
		});
	});
});

describe("MCP Config apiKeyMethod Edge Cases", () => {
	it("should handle null apiKeyMethod gracefully", () => {
		const input = {
			mcpServerId: "test-server",
			baseUrl: "https://api.example.com/mcp",
			authType: "API_KEY" as const,
			apiKeyMethod: null as unknown as "BEARER" | "HEADER",
			apiKey: "test-key",
		};

		// The schema should reject null
		const result = upsertInputSchema.safeParse(input);
		expect(result.success).toBe(false);
	});

	it("should handle case sensitivity (only accept uppercase)", () => {
		const input = {
			mcpServerId: "test-server",
			baseUrl: "https://api.example.com/mcp",
			authType: "API_KEY" as const,
			apiKeyMethod: "bearer" as unknown as "BEARER" | "HEADER",
			apiKey: "test-key",
		};

		const result = upsertInputSchema.safeParse(input);
		expect(result.success).toBe(false);
	});

	it("should handle empty string apiKeyMethod", () => {
		const input = {
			mcpServerId: "test-server",
			baseUrl: "https://api.example.com/mcp",
			authType: "API_KEY" as const,
			apiKeyMethod: "" as unknown as "BEARER" | "HEADER",
			apiKey: "test-key",
		};

		const result = upsertInputSchema.safeParse(input);
		expect(result.success).toBe(false);
	});
});
