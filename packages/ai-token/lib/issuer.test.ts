/**
 * AI Token Issuer Tests
 *
 * Tests for token issuance functionality.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { issueAIToken, issueAITokenWithMetadata } from "./issuer";
import { decodeTokenClaims, verifyAIToken } from "./verifier";

describe("AI Token Issuer", () => {
	const TEST_SECRET = "test-secret-key-for-ai-tokens-32-chars";
	let originalSecret: string | undefined;

	beforeEach(() => {
		// Save original and set test secret
		originalSecret = process.env.AI_TOKEN_SECRET;
		process.env.AI_TOKEN_SECRET = TEST_SECRET;
	});

	afterEach(() => {
		// Restore original secret
		if (originalSecret !== undefined) {
			process.env.AI_TOKEN_SECRET = originalSecret;
		} else {
			delete process.env.AI_TOKEN_SECRET;
		}
	});

	describe("issueAIToken", () => {
		it("should issue a valid token with required claims", async () => {
			const token = await issueAIToken({
				userId: "user_123",
				source: "test-service",
			});

			expect(token).toBeDefined();
			expect(typeof token).toBe("string");
			expect(token.split(".")).toHaveLength(3); // JWT format

			// Verify the token
			const result = await verifyAIToken(token);
			expect(result.valid).toBe(true);
			if (result.valid) {
				expect(result.claims.sub).toBe("user_123");
				expect(result.claims.src).toBe("test-service");
				expect(result.claims.iss).toBe("fabric-portal");
			}
		});

		it("should include organizationId when provided", async () => {
			const token = await issueAIToken({
				userId: "user_123",
				organizationId: "org_456",
				source: "test-service",
			});

			const result = await verifyAIToken(token);
			expect(result.valid).toBe(true);
			if (result.valid) {
				expect(result.claims.org).toBe("org_456");
			}
		});

		it("should not include org claim when organizationId is undefined", async () => {
			const token = await issueAIToken({
				userId: "user_123",
				source: "test-service",
			});

			const decoded = decodeTokenClaims(token);
			expect(decoded?.org).toBeUndefined();
		});

		it("should throw error when userId is missing", async () => {
			await expect(
				issueAIToken({
					userId: "",
					source: "test-service",
				}),
			).rejects.toThrow("userId is required");
		});

		it("should throw error when source is missing", async () => {
			await expect(
				issueAIToken({
					userId: "user_123",
					source: "",
				}),
			).rejects.toThrow("source is required");
		});

		it("should throw error when AI_TOKEN_SECRET is not set", async () => {
			delete process.env.AI_TOKEN_SECRET;

			await expect(
				issueAIToken({
					userId: "user_123",
					source: "test-service",
				}),
			).rejects.toThrow(
				"AI_TOKEN_SECRET environment variable is required",
			);
		});

		it("should respect the AI_TOKEN_EXPIRY_SECONDS env override", async () => {
			// The fixture above only isolates AI_TOKEN_SECRET — save/restore this
			// one manually so it doesn't leak into other tests.
			const originalExpiry = process.env.AI_TOKEN_EXPIRY_SECONDS;
			try {
				process.env.AI_TOKEN_EXPIRY_SECONDS = "900";

				const { token, expiresIn } = await issueAITokenWithMetadata({
					userId: "user_123",
					source: "test-service",
				});
				expect(expiresIn).toBe(900);

				const decoded = decodeTokenClaims(token);
				expect(decoded?.exp).toBeDefined();

				const now = Math.floor(Date.now() / 1000);
				const expectedExpiry = now + 900;
				expect(decoded?.exp).toBeGreaterThan(expectedExpiry - 5);
				expect(decoded?.exp).toBeLessThan(expectedExpiry + 5);
			} finally {
				if (originalExpiry !== undefined) {
					process.env.AI_TOKEN_EXPIRY_SECONDS = originalExpiry;
				} else {
					delete process.env.AI_TOKEN_EXPIRY_SECONDS;
				}
			}
		});

		it("should respect custom expiry", async () => {
			const token = await issueAIToken({
				userId: "user_123",
				source: "test-service",
				expirySeconds: 60, // 1 minute
			});

			const decoded = decodeTokenClaims(token);
			expect(decoded?.exp).toBeDefined();

			// Check expiry is approximately 60 seconds from now
			const now = Math.floor(Date.now() / 1000);
			const expectedExpiry = now + 60;
			expect(decoded?.exp).toBeGreaterThan(expectedExpiry - 5);
			expect(decoded?.exp).toBeLessThan(expectedExpiry + 5);
		});

		it("should generate unique jti for each token", async () => {
			const token1 = await issueAIToken({
				userId: "user_123",
				source: "test-service",
			});

			const token2 = await issueAIToken({
				userId: "user_123",
				source: "test-service",
			});

			const decoded1 = decodeTokenClaims(token1);
			const decoded2 = decodeTokenClaims(token2);

			expect(decoded1?.jti).toBeDefined();
			expect(decoded2?.jti).toBeDefined();
			expect(decoded1?.jti).not.toBe(decoded2?.jti);
		});
	});

	describe("issueAITokenWithMetadata", () => {
		it("should return token with expiry info", async () => {
			const result = await issueAITokenWithMetadata({
				userId: "user_123",
				source: "test-service",
			});

			expect(result.token).toBeDefined();
			expect(result.expiresIn).toBe(300); // Default 5 minutes
		});

		it("should return custom expiry info", async () => {
			const result = await issueAITokenWithMetadata({
				userId: "user_123",
				source: "test-service",
				expirySeconds: 120,
			});

			expect(result.expiresIn).toBe(120);
		});
	});
});
