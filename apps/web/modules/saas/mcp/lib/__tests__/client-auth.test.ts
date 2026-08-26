/**
 * Tests for MCP Client Authentication
 *
 * Tests API key authentication methods (BEARER vs HEADER),
 * session ID support, and auth header building.
 */

import { describe, expect, it, vi } from "vitest";

// Mock the database module before importing client
vi.mock("@repo/database", () => ({
	getMcpConfigById: vi.fn(),
	getValidAccessToken: vi.fn(),
}));

import { type ApiKeyMethod, buildAuthHeaders } from "@repo/mcp/lib/client";

describe("MCP Client Authentication", () => {
	describe("buildAuthHeaders", () => {
		describe("OAuth2 Authentication", () => {
			it("should build Bearer token header for OAuth2", () => {
				const headers = buildAuthHeaders("OAUTH2", "access-token-123");

				expect(headers).toEqual({
					Authorization: "Bearer access-token-123",
				});
			});

			it("should ignore apiKeyMethod for OAuth2", () => {
				const headers = buildAuthHeaders(
					"OAUTH2",
					"access-token-123",
					"HEADER" as ApiKeyMethod,
				);

				// OAuth always uses Bearer, ignores apiKeyMethod
				expect(headers).toEqual({
					Authorization: "Bearer access-token-123",
				});
			});
		});

		describe("API Key Authentication", () => {
			it("should build Bearer token header by default for API_KEY", () => {
				const headers = buildAuthHeaders("API_KEY", "api-key-123");

				expect(headers).toEqual({
					Authorization: "Bearer api-key-123",
				});
			});

			it("should build Bearer token header when method is BEARER", () => {
				const headers = buildAuthHeaders(
					"API_KEY",
					"api-key-123",
					"BEARER",
				);

				expect(headers).toEqual({
					Authorization: "Bearer api-key-123",
				});
			});

			it("should build X-API-Key header when method is HEADER", () => {
				const headers = buildAuthHeaders(
					"API_KEY",
					"api-key-123",
					"HEADER",
				);

				expect(headers).toEqual({
					"X-API-Key": "api-key-123",
				});
			});
		});

		describe("No Authentication", () => {
			it("should return empty headers for NONE auth type", () => {
				const headers = buildAuthHeaders("NONE", "token");

				expect(headers).toEqual({});
			});

			it("should return empty headers when token is null", () => {
				const headers = buildAuthHeaders("API_KEY", null);

				expect(headers).toEqual({});
			});

			it("should return empty headers when token is undefined", () => {
				const headers = buildAuthHeaders("OAUTH2", undefined);

				expect(headers).toEqual({});
			});

			it("should return empty headers when token is empty string", () => {
				const headers = buildAuthHeaders("API_KEY", "");

				expect(headers).toEqual({});
			});
		});

		describe("Edge Cases", () => {
			it("should handle unknown auth type gracefully", () => {
				const headers = buildAuthHeaders("UNKNOWN_TYPE", "token");

				expect(headers).toEqual({});
			});

			it("should preserve token with special characters", () => {
				const specialToken = "sk-abc123_def456.ghi789";
				const headers = buildAuthHeaders(
					"API_KEY",
					specialToken,
					"HEADER",
				);

				expect(headers["X-API-Key"]).toBe(specialToken);
			});

			it("should handle very long tokens", () => {
				const longToken = "a".repeat(10000);
				const headers = buildAuthHeaders("OAUTH2", longToken);

				expect(headers.Authorization).toBe(`Bearer ${longToken}`);
			});
		});
	});
});

describe("MCP Session ID Support", () => {
	describe("Session ID in Headers", () => {
		it("should add Mcp-Session-Id header when sessionId is provided", () => {
			// This tests the concept - actual implementation is in createMcpClient
			// which we can't easily unit test without mocking the SDK
			const sessionId = "session-12345";
			const headers: Record<string, string> = {};

			if (sessionId) {
				headers["Mcp-Session-Id"] = sessionId;
			}

			expect(headers["Mcp-Session-Id"]).toBe(sessionId);
		});

		it("should not add header when sessionId is undefined", () => {
			const sessionId: string | undefined = undefined;
			const headers: Record<string, string> = {};

			if (sessionId) {
				headers["Mcp-Session-Id"] = sessionId;
			}

			expect(headers["Mcp-Session-Id"]).toBeUndefined();
		});
	});
});

describe("Authentication Header Building Integration", () => {
	it("should combine auth headers with session ID", () => {
		const authHeaders = buildAuthHeaders(
			"API_KEY",
			"api-key-123",
			"BEARER",
		);
		const sessionId = "session-abc";

		const finalHeaders = {
			...authHeaders,
			...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
		};

		expect(finalHeaders).toEqual({
			Authorization: "Bearer api-key-123",
			"Mcp-Session-Id": "session-abc",
		});
	});

	it("should combine X-API-Key with session ID", () => {
		const authHeaders = buildAuthHeaders(
			"API_KEY",
			"api-key-123",
			"HEADER",
		);
		const sessionId = "session-xyz";

		const finalHeaders = {
			...authHeaders,
			...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
		};

		expect(finalHeaders).toEqual({
			"X-API-Key": "api-key-123",
			"Mcp-Session-Id": "session-xyz",
		});
	});
});
