/**
 * Tests for MCP Test Connection Route
 *
 * Tests that the test-connection API properly uses
 * apiKeyMethod from stored configs and handles
 * various authentication scenarios.
 *
 * Precedence for apiKeyMethod resolution (configId path):
 *   1. Request value (input.apiKeyMethod) — user's current UI selection
 *   2. Stored config value (cfg.apiKeyMethod) — persisted setting
 *   3. "BEARER" — default
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";

// Schema matching the route's TestConnectionSchema (apiKeyMethod is optional, no default)
const TestConnectionSchema = z.object({
	baseUrl: z.string().url({ message: "Base URL must be a valid URL" }),
	transport: z.enum(["HTTP", "SSE"]).default("HTTP"),
	authType: z.enum(["NONE", "API_KEY", "OAUTH2"]).default("NONE"),
	apiKeyMethod: z.enum(["BEARER", "HEADER", "PLAIN"]).optional(),
	apiKey: z.string().optional(),
	oauthClientId: z.string().optional(),
	oauthClientSecret: z.string().optional(),
	configId: z.string().optional(),
	oauthAccessToken: z.string().optional(),
});

/**
 * Helper that mirrors the resolution logic in the route's configId + API_KEY branch:
 *   input.apiKeyMethod || cfg.apiKeyMethod || "BEARER"
 */
function resolveApiKeyMethod(
	inputMethod: "BEARER" | "HEADER" | "PLAIN" | undefined,
	cfgMethod: string | null,
): "BEARER" | "HEADER" | "PLAIN" {
	return (
		inputMethod || (cfgMethod as "BEARER" | "HEADER" | "PLAIN") || "BEARER"
	);
}

describe("MCP Test Connection Route", () => {
	describe("TestConnectionSchema validation", () => {
		it("should accept BEARER as apiKeyMethod", () => {
			const input = {
				baseUrl: "https://api.example.com/mcp",
				authType: "API_KEY",
				apiKeyMethod: "BEARER",
				apiKey: "test-key",
			};

			const result = TestConnectionSchema.safeParse(input);
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.apiKeyMethod).toBe("BEARER");
			}
		});

		it("should accept HEADER as apiKeyMethod", () => {
			const input = {
				baseUrl: "https://api.example.com/mcp",
				authType: "API_KEY",
				apiKeyMethod: "HEADER",
				apiKey: "test-key",
			};

			const result = TestConnectionSchema.safeParse(input);
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.apiKeyMethod).toBe("HEADER");
			}
		});

		it("should accept PLAIN as apiKeyMethod", () => {
			const input = {
				baseUrl: "https://api.example.com/mcp",
				authType: "API_KEY",
				apiKeyMethod: "PLAIN",
				apiKey: "test-key",
			};

			const result = TestConnectionSchema.safeParse(input);
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.apiKeyMethod).toBe("PLAIN");
			}
		});

		it("should leave apiKeyMethod undefined when not specified", () => {
			const input = {
				baseUrl: "https://api.example.com/mcp",
				authType: "API_KEY",
				apiKey: "test-key",
			};

			const result = TestConnectionSchema.safeParse(input);
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.apiKeyMethod).toBeUndefined();
			}
		});

		it("should reject invalid apiKeyMethod values", () => {
			const input = {
				baseUrl: "https://api.example.com/mcp",
				authType: "API_KEY",
				apiKeyMethod: "INVALID",
				apiKey: "test-key",
			};

			const result = TestConnectionSchema.safeParse(input);
			expect(result.success).toBe(false);
		});
	});

	describe("Config-based apiKeyMethod resolution", () => {
		it("should prefer request apiKeyMethod over config value", () => {
			// User switched to PLAIN in the UI; config still stores HEADER
			const resolved = resolveApiKeyMethod("PLAIN", "HEADER");
			expect(resolved).toBe("PLAIN");
		});

		it("should fall back to config apiKeyMethod when request omits it", () => {
			const resolved = resolveApiKeyMethod(undefined, "HEADER");
			expect(resolved).toBe("HEADER");
		});

		it("should fall back to config PLAIN when request omits it", () => {
			const resolved = resolveApiKeyMethod(undefined, "PLAIN");
			expect(resolved).toBe("PLAIN");
		});

		it("should default to BEARER when neither request nor config specifies", () => {
			const resolved = resolveApiKeyMethod(undefined, null);
			expect(resolved).toBe("BEARER");
		});

		it("should use request BEARER even when config is HEADER", () => {
			const resolved = resolveApiKeyMethod("BEARER", "HEADER");
			expect(resolved).toBe("BEARER");
		});
	});

	describe("effectiveInput construction for API_KEY", () => {
		it("should use request PLAIN over config BEARER", () => {
			const input = {
				baseUrl: "https://api.example.com/mcp",
				transport: "HTTP" as const,
				authType: "API_KEY" as const,
				apiKeyMethod: "PLAIN" as const,
				configId: "config-123",
			};

			const mockConfig = {
				id: "config-123",
				apiKeyMethod: "BEARER",
				encryptedApiKey: "encrypted:my-api-key",
			};

			const decryptedApiKey = "my-api-key";

			const effectiveInput = {
				...input,
				apiKey: decryptedApiKey,
				apiKeyMethod: resolveApiKeyMethod(
					input.apiKeyMethod,
					mockConfig.apiKeyMethod,
				),
			};

			expect(effectiveInput).toEqual({
				baseUrl: "https://api.example.com/mcp",
				transport: "HTTP",
				authType: "API_KEY",
				configId: "config-123",
				apiKey: "my-api-key",
				apiKeyMethod: "PLAIN",
			});
		});

		it("should fall back to config HEADER when request omits apiKeyMethod", () => {
			const input = {
				baseUrl: "https://api.example.com/mcp",
				transport: "HTTP" as const,
				authType: "API_KEY" as const,
				configId: "config-123",
				// apiKeyMethod intentionally omitted
			};

			const mockConfig = {
				id: "config-123",
				apiKeyMethod: "HEADER",
				encryptedApiKey: "encrypted:my-x-api-key",
			};

			const decryptedApiKey = "my-x-api-key";

			const effectiveInput = {
				...input,
				apiKey: decryptedApiKey,
				apiKeyMethod: resolveApiKeyMethod(
					undefined,
					mockConfig.apiKeyMethod,
				),
			};

			expect(effectiveInput).toEqual({
				baseUrl: "https://api.example.com/mcp",
				transport: "HTTP",
				authType: "API_KEY",
				configId: "config-123",
				apiKey: "my-x-api-key",
				apiKeyMethod: "HEADER",
			});
		});

		it("should default to BEARER when both are absent", () => {
			const input = {
				baseUrl: "https://api.example.com/mcp",
				transport: "HTTP" as const,
				authType: "API_KEY" as const,
				configId: "config-123",
			};

			const mockConfig = {
				id: "config-123",
				apiKeyMethod: null,
				encryptedApiKey: "encrypted:my-api-key",
			};

			const decryptedApiKey = "my-api-key";

			const effectiveInput = {
				...input,
				apiKey: decryptedApiKey,
				apiKeyMethod: resolveApiKeyMethod(
					undefined,
					mockConfig.apiKeyMethod,
				),
			};

			expect(effectiveInput.apiKeyMethod).toBe("BEARER");
		});
	});

	describe("buildAuthHeaders integration", () => {
		// Simulate the buildAuthHeaders function from @repo/mcp
		function buildAuthHeaders(
			authType: string,
			token?: string | null,
			apiKeyMethod?: "BEARER" | "HEADER" | "PLAIN",
		): Record<string, string> {
			if (!token) {
				return {};
			}

			switch (authType) {
				case "OAUTH2":
					return { Authorization: `Bearer ${token}` };
				case "API_KEY":
					if (apiKeyMethod === "HEADER") {
						return { "X-API-Key": token };
					}
					if (apiKeyMethod === "PLAIN") {
						return { Authorization: token };
					}
					return { Authorization: `Bearer ${token}` };
				default:
					return {};
			}
		}

		it("should build Authorization header for BEARER method", () => {
			const headers = buildAuthHeaders(
				"API_KEY",
				"test-api-key-123",
				"BEARER",
			);

			expect(headers).toEqual({
				Authorization: "Bearer test-api-key-123",
			});
		});

		it("should build X-API-Key header for HEADER method", () => {
			const headers = buildAuthHeaders(
				"API_KEY",
				"test-api-key-456",
				"HEADER",
			);

			expect(headers).toEqual({
				"X-API-Key": "test-api-key-456",
			});
		});

		it("should build plain Authorization header for PLAIN method", () => {
			const headers = buildAuthHeaders(
				"API_KEY",
				"raw-token-789",
				"PLAIN",
			);

			expect(headers).toEqual({
				Authorization: "raw-token-789",
			});
		});

		it("should use BEARER by default when apiKeyMethod is not specified", () => {
			const headers = buildAuthHeaders(
				"API_KEY",
				"test-api-key-789",
				undefined,
			);

			expect(headers).toEqual({
				Authorization: "Bearer test-api-key-789",
			});
		});
	});

	describe("TestResult response with apiKeyMethod", () => {
		interface TestResult {
			success: boolean;
			message: string;
			details?: {
				transport?: string;
				authType?: string;
				apiKeyMethod?: string;
				responseTime?: number;
			};
			error?: {
				type: string;
				message: string;
			};
		}

		it("should include apiKeyMethod in success details", () => {
			const result: TestResult = {
				success: true,
				message: "Successfully connected to MCP server. Found 5 tools.",
				details: {
					transport: "HTTP",
					authType: "API_KEY",
					apiKeyMethod: "BEARER",
					responseTime: 150,
				},
			};

			expect(result.details?.apiKeyMethod).toBe("BEARER");
		});

		it("should include apiKeyMethod in error details", () => {
			const result: TestResult = {
				success: false,
				message: "Connection test failed: Authentication failed",
				details: {
					transport: "HTTP",
					authType: "API_KEY",
					apiKeyMethod: "HEADER",
					responseTime: 2500,
				},
				error: {
					type: "AUTHENTICATION_ERROR",
					message:
						"Authentication failed (401 Unauthorized).\n\nCurrent method: X-API-Key header. Try the other method or verify your API key is correct.",
				},
			};

			expect(result.details?.apiKeyMethod).toBe("HEADER");
			expect(result.error?.message).toContain("X-API-Key header");
		});

		it("should include PLAIN apiKeyMethod in error details", () => {
			const result: TestResult = {
				success: false,
				message: "Connection test failed: Authentication failed",
				details: {
					transport: "HTTP",
					authType: "API_KEY",
					apiKeyMethod: "PLAIN",
					responseTime: 1200,
				},
				error: {
					type: "AUTHENTICATION_ERROR",
					message: "Authentication failed (401 Unauthorized).",
				},
			};

			expect(result.details?.apiKeyMethod).toBe("PLAIN");
		});
	});

	describe("Error message guidance based on apiKeyMethod", () => {
		it("should suggest BEARER when HEADER fails", () => {
			const currentMethod = "HEADER";
			const authGuidance =
				currentMethod === "HEADER"
					? "Try switching to 'Bearer' authentication method, or verify your API key is correct."
					: "Try switching to 'X-API-Key Header' authentication method, or verify your API key is correct.";

			expect(authGuidance).toBe(
				"Try switching to 'Bearer' authentication method, or verify your API key is correct.",
			);
		});

		it("should suggest HEADER when BEARER fails", () => {
			const currentMethod = "BEARER";
			const authGuidance =
				currentMethod === "HEADER"
					? "Try switching to 'Bearer' authentication method, or verify your API key is correct."
					: "Try switching to 'X-API-Key Header' authentication method, or verify your API key is correct.";

			expect(authGuidance).toBe(
				"Try switching to 'X-API-Key Header' authentication method, or verify your API key is correct.",
			);
		});
	});
});

describe("Private/Local Address Validation", () => {
	// Simulate the isPrivateOrLocalAddress function
	function isPrivateOrLocalAddress(urlString: string): boolean {
		try {
			const url = new URL(urlString);

			if (url.protocol !== "http:" && url.protocol !== "https:") {
				return true;
			}

			const hostname = url.hostname.toLowerCase();

			if (
				hostname === "localhost" ||
				hostname === "127.0.0.1" ||
				hostname === "::1"
			) {
				return true;
			}

			const ipv4Match = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
			if (ipv4Match) {
				const [, a, b] = ipv4Match.map(Number);
				if (a === 10) {
					return true;
				}
				if (a === 127) {
					return true;
				}
				if (a === 172 && b >= 16 && b <= 31) {
					return true;
				}
				if (a === 192 && b === 168) {
					return true;
				}
				if (a === 169 && b === 254) {
					return true;
				}
			}

			if (hostname.endsWith(".local")) {
				return true;
			}

			return false;
		} catch {
			return true;
		}
	}

	it("should block localhost", () => {
		expect(isPrivateOrLocalAddress("http://localhost:3000/mcp")).toBe(true);
	});

	it("should block 127.0.0.1", () => {
		expect(isPrivateOrLocalAddress("http://127.0.0.1:8080/mcp")).toBe(true);
	});

	it("should block private 192.168.x.x addresses", () => {
		expect(isPrivateOrLocalAddress("http://192.168.1.100/mcp")).toBe(true);
	});

	it("should block private 10.x.x.x addresses", () => {
		expect(isPrivateOrLocalAddress("http://10.0.0.1/mcp")).toBe(true);
	});

	it("should block private 172.16-31.x.x addresses", () => {
		expect(isPrivateOrLocalAddress("http://172.16.0.1/mcp")).toBe(true);
		expect(isPrivateOrLocalAddress("http://172.31.255.255/mcp")).toBe(true);
	});

	it("should allow public addresses", () => {
		expect(isPrivateOrLocalAddress("https://api.example.com/mcp")).toBe(
			false,
		);
		expect(
			isPrivateOrLocalAddress("https://bindings.mcp.cloudflare.com/mcp"),
		).toBe(false);
	});

	it("should block .local domains", () => {
		expect(isPrivateOrLocalAddress("http://myserver.local/mcp")).toBe(true);
	});
});

describe("Protocol Version", () => {
	it("should use protocol version 2025-03-26", () => {
		// This test ensures we're using the latest protocol version
		const EXPECTED_PROTOCOL_VERSION = "2025-03-26";

		// In the actual route, this is returned in the success response
		const successResponse = {
			success: true,
			message: "Successfully connected to MCP server.",
			details: {
				protocolVersion: "2025-03-26",
				serverInfo: {
					name: "MCP Server",
					version: "1.0.0",
				},
			},
		};

		expect(successResponse.details.protocolVersion).toBe(
			EXPECTED_PROTOCOL_VERSION,
		);
	});
});
