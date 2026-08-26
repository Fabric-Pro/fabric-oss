/**
 * Tests for OAuth Discovery Utilities
 *
 * Tests RFC 9728 (Protected Resource Metadata) and RFC 8414 (Authorization Server Metadata)
 * discovery, PKCE generation, and structured state parameter handling.
 */

import {
	base64UrlEncode,
	discoverOAuthEndpoints,
	fetchAuthorizationServerMetadata,
	fetchProtectedResourceMetadata,
	generateCodeChallenge,
	generateCodeVerifier,
	generateStructuredState,
	type OAuthStatePayload,
	parseStructuredState,
} from "@repo/api/modules/mcp/lib/oauth-discovery";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch as unknown as typeof fetch;

describe("OAuth Discovery", () => {
	beforeEach(() => {
		mockFetch.mockReset();
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	describe("fetchProtectedResourceMetadata (RFC 9728)", () => {
		it("should fetch protected resource metadata successfully", async () => {
			const mockMetadata = {
				resource: "https://mcp.example.com",
				authorization_servers: ["https://auth.example.com"],
				scopes_supported: ["read", "write"],
			};

			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: () => Promise.resolve(mockMetadata),
			});

			const result = await fetchProtectedResourceMetadata(
				"https://mcp.example.com",
			);

			expect(mockFetch).toHaveBeenCalledWith(
				"https://mcp.example.com/.well-known/oauth-protected-resource",
				expect.objectContaining({
					method: "GET",
					headers: { Accept: "application/json" },
					redirect: "error",
				}),
			);
			expect(result).toEqual(mockMetadata);
		});

		it("should return null when metadata is not available", async () => {
			mockFetch.mockResolvedValueOnce({
				ok: false,
				status: 404,
			});

			const result = await fetchProtectedResourceMetadata(
				"https://mcp.example.com",
			);

			expect(result).toBeNull();
		});

		it("should handle network errors gracefully", async () => {
			mockFetch.mockRejectedValueOnce(new Error("Network error"));

			const result = await fetchProtectedResourceMetadata(
				"https://mcp.example.com",
			);

			expect(result).toBeNull();
		});
	});

	describe("fetchAuthorizationServerMetadata (RFC 8414)", () => {
		it("should fetch authorization server metadata successfully", async () => {
			const mockMetadata = {
				issuer: "https://auth.example.com",
				authorization_endpoint: "https://auth.example.com/authorize",
				token_endpoint: "https://auth.example.com/token",
				registration_endpoint: "https://auth.example.com/register",
				code_challenge_methods_supported: ["S256"],
			};

			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: () => Promise.resolve(mockMetadata),
			});

			const result = await fetchAuthorizationServerMetadata(
				"https://auth.example.com",
			);

			expect(mockFetch).toHaveBeenCalledWith(
				"https://auth.example.com/.well-known/oauth-authorization-server",
				expect.objectContaining({
					method: "GET",
					headers: { Accept: "application/json" },
					redirect: "error",
				}),
			);
			expect(result).toEqual(mockMetadata);
		});

		it("should fall back to OpenID Connect discovery", async () => {
			const mockOidcMetadata = {
				issuer: "https://auth.example.com",
				authorization_endpoint: "https://auth.example.com/authorize",
				token_endpoint: "https://auth.example.com/token",
			};

			// First call fails (RFC 8414)
			mockFetch.mockResolvedValueOnce({
				ok: false,
				status: 404,
			});

			// Second call succeeds (OIDC)
			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: () => Promise.resolve(mockOidcMetadata),
			});

			const result = await fetchAuthorizationServerMetadata(
				"https://auth.example.com",
			);

			expect(mockFetch).toHaveBeenCalledTimes(2);
			expect(mockFetch).toHaveBeenLastCalledWith(
				"https://auth.example.com/.well-known/openid-configuration",
				expect.any(Object),
			);
			expect(result).toEqual(mockOidcMetadata);
		});

		it("should return null when both discovery methods fail", async () => {
			mockFetch.mockResolvedValue({
				ok: false,
				status: 404,
			});

			const result = await fetchAuthorizationServerMetadata(
				"https://auth.example.com",
			);

			expect(result).toBeNull();
		});
	});

	describe("discoverOAuthEndpoints", () => {
		it("should use protected resource metadata to find auth server", async () => {
			const protectedResourceMetadata = {
				resource: "https://mcp.example.com",
				authorization_servers: ["https://auth.example.com"],
				scopes_supported: ["mcp:read", "mcp:write"],
			};

			const authServerMetadata = {
				issuer: "https://auth.example.com",
				authorization_endpoint: "https://auth.example.com/authorize",
				token_endpoint: "https://auth.example.com/token",
				registration_endpoint: "https://auth.example.com/register",
				code_challenge_methods_supported: ["S256"],
			};

			// First call: protected resource metadata
			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: () => Promise.resolve(protectedResourceMetadata),
			});

			// Second call: auth server metadata
			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: () => Promise.resolve(authServerMetadata),
			});

			const result = await discoverOAuthEndpoints(
				"https://mcp.example.com/mcp",
			);

			expect(result.success).toBe(true);
			expect(result.hasProtectedResourceMetadata).toBe(true);
			expect(result.hasAuthServerMetadata).toBe(true);
			expect(result.metadata).toMatchObject({
				resource: "https://mcp.example.com",
				authorizationServer: "https://auth.example.com",
				authorizationEndpoint: "https://auth.example.com/authorize",
				tokenEndpoint: "https://auth.example.com/token",
				registrationEndpoint: "https://auth.example.com/register",
				scopesSupported: ["mcp:read", "mcp:write"],
				codeChallengeMethodsSupported: ["S256"],
			});
		});

		it("should fall back to direct discovery when protected resource metadata is not available", async () => {
			const authServerMetadata = {
				issuer: "https://mcp.example.com",
				authorization_endpoint: "https://mcp.example.com/authorize",
				token_endpoint: "https://mcp.example.com/token",
			};

			// First call: protected resource metadata (not found)
			mockFetch.mockResolvedValueOnce({
				ok: false,
				status: 404,
			});

			// Second call: direct auth server metadata
			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: () => Promise.resolve(authServerMetadata),
			});

			const result = await discoverOAuthEndpoints(
				"https://mcp.example.com",
			);

			expect(result.success).toBe(true);
			expect(result.hasProtectedResourceMetadata).toBe(false);
			expect(result.hasAuthServerMetadata).toBe(true);
		});

		it("should return error when no OAuth endpoints are found", async () => {
			// All discovery attempts fail
			mockFetch.mockResolvedValue({
				ok: false,
				status: 404,
			});

			const result = await discoverOAuthEndpoints(
				"https://mcp.example.com",
			);

			expect(result.success).toBe(false);
			expect(result.error).toContain(
				"Could not discover OAuth endpoints",
			);
		});
	});
});

describe("PKCE (RFC 7636)", () => {
	describe("generateCodeVerifier", () => {
		it("should generate a 128-character code verifier", () => {
			const verifier = generateCodeVerifier();

			// 96 bytes base64url encoded = 128 characters
			expect(verifier.length).toBe(128);
		});

		it("should only contain base64url-safe characters", () => {
			const verifier = generateCodeVerifier();

			// Base64url uses A-Z, a-z, 0-9, -, _
			expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
		});

		it("should generate unique verifiers", () => {
			const verifier1 = generateCodeVerifier();
			const verifier2 = generateCodeVerifier();

			expect(verifier1).not.toBe(verifier2);
		});

		it("should not contain padding characters", () => {
			const verifier = generateCodeVerifier();

			expect(verifier).not.toContain("=");
		});
	});

	describe("generateCodeChallenge", () => {
		it("should generate a valid S256 code challenge", () => {
			const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
			const challenge = generateCodeChallenge(verifier);

			// The challenge should be base64url-encoded SHA-256 hash
			expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
			expect(challenge.length).toBe(43); // SHA-256 = 32 bytes = 43 base64url chars
		});

		it("should produce consistent challenges for same verifier", () => {
			const verifier = generateCodeVerifier();
			const challenge1 = generateCodeChallenge(verifier);
			const challenge2 = generateCodeChallenge(verifier);

			expect(challenge1).toBe(challenge2);
		});

		it("should produce different challenges for different verifiers", () => {
			const verifier1 = generateCodeVerifier();
			const verifier2 = generateCodeVerifier();
			const challenge1 = generateCodeChallenge(verifier1);
			const challenge2 = generateCodeChallenge(verifier2);

			expect(challenge1).not.toBe(challenge2);
		});
	});

	describe("base64UrlEncode", () => {
		it("should encode buffer without padding", () => {
			const buffer = Buffer.from("hello");
			const encoded = base64UrlEncode(buffer);

			expect(encoded).not.toContain("=");
		});

		it("should replace + with - and / with _", () => {
			// Create a buffer that would produce + and / in standard base64
			const buffer = Buffer.from([251, 255, 254]); // Would produce ++/+
			const encoded = base64UrlEncode(buffer);

			expect(encoded).not.toContain("+");
			expect(encoded).not.toContain("/");
		});
	});
});

describe("Structured State Parameter", () => {
	describe("generateStructuredState", () => {
		it("should generate a valid base64url-encoded state", () => {
			const state = generateStructuredState({
				serverId: "server-123",
				configId: "config-456",
				userId: "user-789",
			});

			expect(state).toMatch(/^[A-Za-z0-9_-]+$/);
		});

		it("should include all required fields in the payload", () => {
			const state = generateStructuredState({
				serverId: "server-123",
				configId: "config-456",
				userId: "user-789",
				organizationId: "org-abc",
			});

			const parsed = parseStructuredState(state);

			expect(parsed).not.toBeNull();
			expect(parsed?.serverId).toBe("server-123");
			expect(parsed?.configId).toBe("config-456");
			expect(parsed?.userId).toBe("user-789");
			expect(parsed?.organizationId).toBe("org-abc");
			expect(parsed?.nonce).toBeDefined();
			expect(parsed?.timestamp).toBeDefined();
		});

		it("should generate unique nonces", () => {
			const state1 = generateStructuredState({
				serverId: "server-123",
				configId: "config-456",
				userId: "user-789",
			});

			const state2 = generateStructuredState({
				serverId: "server-123",
				configId: "config-456",
				userId: "user-789",
			});

			const parsed1 = parseStructuredState(state1);
			const parsed2 = parseStructuredState(state2);

			expect(parsed1?.nonce).not.toBe(parsed2?.nonce);
		});
	});

	describe("parseStructuredState", () => {
		it("should parse a valid state string", () => {
			const state = generateStructuredState({
				serverId: "server-123",
				configId: "config-456",
				userId: "user-789",
			});

			const parsed = parseStructuredState(state);

			expect(parsed).not.toBeNull();
			expect(parsed?.serverId).toBe("server-123");
			expect(parsed?.configId).toBe("config-456");
			expect(parsed?.userId).toBe("user-789");
		});

		it("should return null for invalid base64", () => {
			const parsed = parseStructuredState("not-valid-base64!!!");

			expect(parsed).toBeNull();
		});

		it("should return null for expired state", () => {
			// Create a state with a very old timestamp
			const oldPayload: OAuthStatePayload = {
				serverId: "server-123",
				configId: "config-456",
				userId: "user-789",
				nonce: "test-nonce",
				timestamp: Date.now() - 15 * 60 * 1000, // 15 minutes ago
			};

			const jsonString = JSON.stringify(oldPayload);
			const state = Buffer.from(jsonString, "utf-8")
				.toString("base64")
				.replace(/\+/g, "-")
				.replace(/\//g, "_")
				.replace(/=+$/g, "");

			// Default max age is 10 minutes
			const parsed = parseStructuredState(state);

			expect(parsed).toBeNull();
		});

		it("should accept state within custom max age", () => {
			const payload: OAuthStatePayload = {
				serverId: "server-123",
				configId: "config-456",
				userId: "user-789",
				nonce: "test-nonce",
				timestamp: Date.now() - 5 * 60 * 1000, // 5 minutes ago
			};

			const jsonString = JSON.stringify(payload);
			const state = Buffer.from(jsonString, "utf-8")
				.toString("base64")
				.replace(/\+/g, "-")
				.replace(/\//g, "_")
				.replace(/=+$/g, "");

			// Allow 10 minute max age (default)
			const parsed = parseStructuredState(state);

			expect(parsed).not.toBeNull();
			expect(parsed?.serverId).toBe("server-123");
		});

		it("should return null for missing required fields", () => {
			const incompletePayload = {
				serverId: "server-123",
				// Missing configId, userId, nonce, timestamp
			};

			const jsonString = JSON.stringify(incompletePayload);
			const state = Buffer.from(jsonString, "utf-8")
				.toString("base64")
				.replace(/\+/g, "-")
				.replace(/\//g, "_")
				.replace(/=+$/g, "");

			const parsed = parseStructuredState(state);

			expect(parsed).toBeNull();
		});
	});
});
