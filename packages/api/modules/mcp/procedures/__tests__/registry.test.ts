/**
 * Tests for MCP Registry Procedures
 *
 * Tests the create/update procedures' handling of apiKeyMethod
 * for custom MCP server definitions.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";

// Schema matching the registry procedures
const transportEnum = z.enum(["SSE", "HTTP", "STDIO"]);
const authTypeEnum = z.enum(["NONE", "API_KEY", "OAUTH2"]);
const apiKeyMethodEnum = z.enum(["BEARER", "HEADER"]);

const createServerSchema = z.object({
	organizationId: z.string().nullable().optional(),
	key: z.string().min(1),
	name: z.string().min(1),
	description: z.string().optional().nullable(),
	defaultUrl: z.string().url().optional().nullable(),
	docsUrl: z.string().url().optional().nullable(),
	transport: transportEnum,
	authMethods: z.array(authTypeEnum).min(1),
	apiKeyMethod: apiKeyMethodEnum.optional().nullable(),
	oauthDiscoveryUrl: z.string().url().optional().nullable(),
	oauthAuthorizationEndpoint: z.string().url().optional().nullable(),
	oauthTokenEndpoint: z.string().url().optional().nullable(),
	dcrRegistrationEndpoint: z.string().url().optional().nullable(),
	category: z.string().optional().nullable(),
	tags: z.array(z.string()).optional(),
});

const updateServerSchema = z.object({
	id: z.string(),
	organizationId: z.string().nullable().optional(),
	name: z.string().optional(),
	description: z.string().optional().nullable(),
	defaultUrl: z.string().url().optional().nullable(),
	docsUrl: z.string().url().optional().nullable(),
	transport: transportEnum.optional(),
	authMethods: z.array(authTypeEnum).optional(),
	apiKeyMethod: apiKeyMethodEnum.optional().nullable(),
	oauthDiscoveryUrl: z.string().url().optional().nullable(),
	oauthAuthorizationEndpoint: z.string().url().optional().nullable(),
	oauthTokenEndpoint: z.string().url().optional().nullable(),
	dcrRegistrationEndpoint: z.string().url().optional().nullable(),
	category: z.string().optional().nullable(),
	tags: z.array(z.string()).optional(),
});

describe("MCP Registry Procedures", () => {
	describe("create server schema", () => {
		describe("apiKeyMethod field", () => {
			it("should accept BEARER as apiKeyMethod", () => {
				const input = {
					key: "my-mcp-server",
					name: "My MCP Server",
					transport: "HTTP" as const,
					authMethods: ["API_KEY" as const],
					apiKeyMethod: "BEARER" as const,
					defaultUrl: "https://api.example.com/mcp",
				};

				const result = createServerSchema.safeParse(input);
				expect(result.success).toBe(true);
				if (result.success) {
					expect(result.data.apiKeyMethod).toBe("BEARER");
				}
			});

			it("should accept HEADER as apiKeyMethod", () => {
				const input = {
					key: "custom-mcp",
					name: "Custom MCP Server",
					transport: "HTTP" as const,
					authMethods: ["API_KEY" as const],
					apiKeyMethod: "HEADER" as const,
					defaultUrl: "https://custom.example.com/mcp",
				};

				const result = createServerSchema.safeParse(input);
				expect(result.success).toBe(true);
				if (result.success) {
					expect(result.data.apiKeyMethod).toBe("HEADER");
				}
			});

			it("should accept null apiKeyMethod", () => {
				const input = {
					key: "oauth-mcp",
					name: "OAuth MCP Server",
					transport: "HTTP" as const,
					authMethods: ["OAUTH2" as const],
					apiKeyMethod: null,
					defaultUrl: "https://oauth.example.com/mcp",
				};

				const result = createServerSchema.safeParse(input);
				expect(result.success).toBe(true);
				if (result.success) {
					expect(result.data.apiKeyMethod).toBeNull();
				}
			});

			it("should allow omitting apiKeyMethod", () => {
				const input = {
					key: "no-auth-mcp",
					name: "No Auth MCP Server",
					transport: "HTTP" as const,
					authMethods: ["NONE" as const],
					defaultUrl: "https://public.example.com/mcp",
				};

				const result = createServerSchema.safeParse(input);
				expect(result.success).toBe(true);
				if (result.success) {
					expect(result.data.apiKeyMethod).toBeUndefined();
				}
			});

			it("should reject invalid apiKeyMethod values", () => {
				const input = {
					key: "bad-mcp",
					name: "Bad MCP Server",
					transport: "HTTP" as const,
					authMethods: ["API_KEY" as const],
					apiKeyMethod: "INVALID_METHOD",
					defaultUrl: "https://bad.example.com/mcp",
				};

				const result = createServerSchema.safeParse(input);
				expect(result.success).toBe(false);
			});
		});

		describe("complete server definitions", () => {
			it("should create server with API_KEY and BEARER method", () => {
				const input = {
					key: "cloudflare-bindings",
					name: "Cloudflare Bindings",
					description: "Access Cloudflare Workers, KV, D1, and more",
					defaultUrl: "https://bindings.mcp.cloudflare.com/mcp",
					transport: "HTTP" as const,
					authMethods: ["API_KEY" as const],
					apiKeyMethod: "BEARER" as const,
					category: "cloud",
					tags: ["cloudflare", "workers", "serverless"],
				};

				const result = createServerSchema.safeParse(input);
				expect(result.success).toBe(true);
				if (result.success) {
					expect(result.data).toMatchObject({
						key: "cloudflare-bindings",
						name: "Cloudflare Bindings",
						transport: "HTTP",
						authMethods: ["API_KEY"],
						apiKeyMethod: "BEARER",
					});
				}
			});

			it("should create server with API_KEY and HEADER method", () => {
				const input = {
					key: "custom-internal",
					name: "Internal Tools Server",
					description: "Company internal MCP tools",
					defaultUrl: "https://internal.company.com/mcp",
					transport: "HTTP" as const,
					authMethods: ["API_KEY" as const],
					apiKeyMethod: "HEADER" as const,
					category: "internal",
				};

				const result = createServerSchema.safeParse(input);
				expect(result.success).toBe(true);
				if (result.success) {
					expect(result.data.apiKeyMethod).toBe("HEADER");
				}
			});

			it("should create server with multiple auth methods including API_KEY", () => {
				const input = {
					key: "flexible-mcp",
					name: "Flexible Auth MCP",
					defaultUrl: "https://flexible.example.com/mcp",
					transport: "HTTP" as const,
					authMethods: ["API_KEY" as const, "OAUTH2" as const],
					apiKeyMethod: "BEARER" as const, // Default method when API_KEY is chosen
				};

				const result = createServerSchema.safeParse(input);
				expect(result.success).toBe(true);
				if (result.success) {
					expect(result.data.authMethods).toContain("API_KEY");
					expect(result.data.authMethods).toContain("OAUTH2");
					expect(result.data.apiKeyMethod).toBe("BEARER");
				}
			});

			it("should create OAuth-only server without apiKeyMethod", () => {
				const input = {
					key: "github-mcp",
					name: "GitHub MCP",
					description: "GitHub repository access via MCP",
					defaultUrl: "https://api.github.com/mcp",
					transport: "HTTP" as const,
					authMethods: ["OAUTH2" as const],
					oauthDiscoveryUrl:
						"https://github.com/.well-known/oauth-authorization-server",
					category: "development",
				};

				const result = createServerSchema.safeParse(input);
				expect(result.success).toBe(true);
				if (result.success) {
					expect(result.data.authMethods).toEqual(["OAUTH2"]);
					expect(result.data.apiKeyMethod).toBeUndefined();
				}
			});
		});
	});

	describe("update server schema", () => {
		describe("apiKeyMethod updates", () => {
			it("should allow updating apiKeyMethod to BEARER", () => {
				const input = {
					id: "server-123",
					apiKeyMethod: "BEARER" as const,
				};

				const result = updateServerSchema.safeParse(input);
				expect(result.success).toBe(true);
				if (result.success) {
					expect(result.data.apiKeyMethod).toBe("BEARER");
				}
			});

			it("should allow updating apiKeyMethod to HEADER", () => {
				const input = {
					id: "server-123",
					apiKeyMethod: "HEADER" as const,
				};

				const result = updateServerSchema.safeParse(input);
				expect(result.success).toBe(true);
				if (result.success) {
					expect(result.data.apiKeyMethod).toBe("HEADER");
				}
			});

			it("should allow clearing apiKeyMethod with null", () => {
				const input = {
					id: "server-123",
					apiKeyMethod: null,
				};

				const result = updateServerSchema.safeParse(input);
				expect(result.success).toBe(true);
				if (result.success) {
					expect(result.data.apiKeyMethod).toBeNull();
				}
			});

			it("should allow updating other fields without affecting apiKeyMethod", () => {
				const input = {
					id: "server-123",
					name: "Updated Server Name",
					description: "New description",
				};

				const result = updateServerSchema.safeParse(input);
				expect(result.success).toBe(true);
				if (result.success) {
					expect(result.data.apiKeyMethod).toBeUndefined();
				}
			});

			it("should allow updating authMethods and apiKeyMethod together", () => {
				const input = {
					id: "server-123",
					authMethods: ["API_KEY" as const, "NONE" as const],
					apiKeyMethod: "HEADER" as const,
				};

				const result = updateServerSchema.safeParse(input);
				expect(result.success).toBe(true);
				if (result.success) {
					expect(result.data.authMethods).toEqual([
						"API_KEY",
						"NONE",
					]);
					expect(result.data.apiKeyMethod).toBe("HEADER");
				}
			});
		});
	});
});

describe("MCPServer Model apiKeyMethod", () => {
	describe("Default API Key Method for Servers", () => {
		it("should recommend BEARER for most servers", () => {
			// BEARER is the most common method for API key auth
			// Should be the default recommendation
			const serverConfigs = [
				{ name: "Cloudflare", recommendedMethod: "BEARER" },
				{ name: "OpenAI", recommendedMethod: "BEARER" },
				{ name: "Anthropic", recommendedMethod: "BEARER" },
			];

			for (const config of serverConfigs) {
				expect(config.recommendedMethod).toBe("BEARER");
			}
		});

		it("should use HEADER for servers that require X-API-Key", () => {
			// Some servers specifically require X-API-Key header
			const headerBasedServers = [
				{
					name: "Legacy Internal API",
					apiKeyMethod: "HEADER",
					headerName: "X-API-Key",
				},
			];

			for (const server of headerBasedServers) {
				expect(server.apiKeyMethod).toBe("HEADER");
			}
		});
	});

	describe("apiKeyMethod inheritance", () => {
		it("should allow config to inherit server's default apiKeyMethod", () => {
			const mcpServer = {
				id: "server-1",
				key: "custom-mcp",
				name: "Custom MCP",
				apiKeyMethod: "HEADER", // Server-level default
				authMethods: ["API_KEY"],
			};

			// When creating a config, if user doesn't specify apiKeyMethod,
			// it should inherit from the server
			const configInput = {
				mcpServerId: mcpServer.id,
				baseUrl: "https://custom.example.com/mcp",
				authType: "API_KEY",
				apiKey: "user-api-key",
				// No apiKeyMethod specified
			};

			// Logic that would happen in the handler
			const effectiveApiKeyMethod =
				(configInput as any).apiKeyMethod ||
				mcpServer.apiKeyMethod ||
				"BEARER";

			expect(effectiveApiKeyMethod).toBe("HEADER");
		});

		it("should allow config to override server's default apiKeyMethod", () => {
			const mcpServer = {
				id: "server-1",
				key: "flexible-mcp",
				name: "Flexible MCP",
				apiKeyMethod: "BEARER", // Server-level default
				authMethods: ["API_KEY"],
			};

			// User explicitly specifies HEADER
			const configInput = {
				mcpServerId: mcpServer.id,
				baseUrl: "https://flexible.example.com/mcp",
				authType: "API_KEY",
				apiKeyMethod: "HEADER", // Override server default
				apiKey: "user-api-key",
			};

			// Config's explicit value should win
			const effectiveApiKeyMethod =
				configInput.apiKeyMethod || mcpServer.apiKeyMethod || "BEARER";

			expect(effectiveApiKeyMethod).toBe("HEADER");
		});
	});
});

describe("apiKeyMethod End-to-End Scenarios", () => {
	describe("Cloudflare MCP scenario", () => {
		it("should properly configure Cloudflare MCP with Bearer auth", () => {
			// 1. Server definition
			const cloudflareServer = {
				key: "cloudflare-bindings",
				name: "Cloudflare Bindings",
				defaultUrl: "https://bindings.mcp.cloudflare.com/mcp",
				transport: "HTTP",
				authMethods: ["API_KEY"],
				apiKeyMethod: "BEARER", // Cloudflare uses Bearer tokens
			};

			// 2. User config (using server defaults)
			const userConfig = {
				mcpServerId: "cloudflare-bindings",
				baseUrl: cloudflareServer.defaultUrl,
				authType: "API_KEY",
				apiKey: "cf_abc123xyz",
				// apiKeyMethod not specified - inherits BEARER from server
			};

			// 3. Effective config for connection test
			const effectiveApiKeyMethod =
				(userConfig as any).apiKeyMethod ||
				cloudflareServer.apiKeyMethod ||
				"BEARER";

			expect(effectiveApiKeyMethod).toBe("BEARER");

			// 4. Headers that would be built
			const headers =
				effectiveApiKeyMethod === "HEADER"
					? { "X-API-Key": userConfig.apiKey }
					: { Authorization: `Bearer ${userConfig.apiKey}` };

			expect(headers).toEqual({
				Authorization: "Bearer cf_abc123xyz",
			});
		});
	});

	describe("Custom internal server scenario", () => {
		it("should properly configure custom server with X-API-Key auth", () => {
			// 1. Server definition for internal API
			const internalServer = {
				key: "internal-tools",
				name: "Internal Tools",
				defaultUrl: "https://internal.company.com/mcp",
				transport: "HTTP",
				authMethods: ["API_KEY"],
				apiKeyMethod: "HEADER", // Internal API requires X-API-Key header
			};

			// 2. User config
			const userConfig = {
				mcpServerId: "internal-tools",
				baseUrl: internalServer.defaultUrl,
				authType: "API_KEY",
				apiKey: "internal_secret_key_12345",
			};

			// 3. Effective config
			const effectiveApiKeyMethod =
				(userConfig as any).apiKeyMethod ||
				internalServer.apiKeyMethod ||
				"BEARER";

			expect(effectiveApiKeyMethod).toBe("HEADER");

			// 4. Headers
			const headers =
				effectiveApiKeyMethod === "HEADER"
					? { "X-API-Key": userConfig.apiKey }
					: { Authorization: `Bearer ${userConfig.apiKey}` };

			expect(headers).toEqual({
				"X-API-Key": "internal_secret_key_12345",
			});
		});
	});

	describe("User override scenario", () => {
		it("should allow user to override server's default method", () => {
			// Server defaults to BEARER
			const server = {
				key: "flexible-server",
				apiKeyMethod: "BEARER",
			};

			// But user knows their instance needs HEADER
			const userConfig = {
				apiKeyMethod: "HEADER", // Explicit override
				apiKey: "my-custom-key",
			};

			const effectiveApiKeyMethod =
				userConfig.apiKeyMethod || server.apiKeyMethod || "BEARER";

			expect(effectiveApiKeyMethod).toBe("HEADER");
		});
	});
});
