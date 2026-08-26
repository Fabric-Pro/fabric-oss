/**
 * AI Token Verifier Tests
 *
 * Tests for token verification functionality including security edge cases.
 */

import { SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { issueAIToken } from "./issuer";
import {
	decodeTokenClaims,
	getRemainingValidity,
	isTokenExpired,
	verifyAIToken,
} from "./verifier";

describe("AI Token Verifier", () => {
	const TEST_SECRET = "test-secret-key-for-ai-tokens-32-chars";
	const WRONG_SECRET = "wrong-secret-key-do-not-use-this";
	let originalSecret: string | undefined;

	beforeEach(() => {
		originalSecret = process.env.AI_TOKEN_SECRET;
		process.env.AI_TOKEN_SECRET = TEST_SECRET;
	});

	afterEach(() => {
		if (originalSecret !== undefined) {
			process.env.AI_TOKEN_SECRET = originalSecret;
		} else {
			delete process.env.AI_TOKEN_SECRET;
		}
	});

	describe("verifyAIToken", () => {
		it("should verify a valid token", async () => {
			const token = await issueAIToken({
				userId: "user_123",
				organizationId: "org_456",
				source: "test-service",
			});

			const result = await verifyAIToken(token);

			expect(result.valid).toBe(true);
			if (result.valid) {
				expect(result.claims.sub).toBe("user_123");
				expect(result.claims.org).toBe("org_456");
				expect(result.claims.src).toBe("test-service");
				expect(result.claims.iss).toBe("fabric-portal");
				expect(result.claims.jti).toBeDefined();
				expect(result.claims.iat).toBeDefined();
				expect(result.claims.exp).toBeDefined();
			}
		});

		it("should reject empty token", async () => {
			const result = await verifyAIToken("");

			expect(result.valid).toBe(false);
			if (!result.valid) {
				expect(result.code).toBe("MALFORMED");
				expect(result.error).toContain("required");
			}
		});

		it("should reject null/undefined token", async () => {
			// @ts-expect-error Testing invalid input
			const result = await verifyAIToken(null);

			expect(result.valid).toBe(false);
			if (!result.valid) {
				expect(result.code).toBe("MALFORMED");
			}
		});

		it("should reject malformed token", async () => {
			const result = await verifyAIToken("not-a-valid-jwt");

			expect(result.valid).toBe(false);
			if (!result.valid) {
				expect(result.code).toBe("MALFORMED");
			}
		});

		it("should reject token with wrong signature", async () => {
			// Create a token with a different secret
			const secretKey = new TextEncoder().encode(WRONG_SECRET);
			const token = await new SignJWT({
				org: "org_456",
				src: "test-service",
			})
				.setProtectedHeader({ alg: "HS256" })
				.setIssuer("fabric-portal")
				.setSubject("user_123")
				.setIssuedAt()
				.setExpirationTime("5m")
				.setJti("test-jti")
				.sign(secretKey);

			const result = await verifyAIToken(token);

			expect(result.valid).toBe(false);
			if (!result.valid) {
				expect(result.code).toBe("INVALID_SIGNATURE");
				expect(result.error).toContain("signature");
			}
		});

		it("should reject expired token", async () => {
			// Create an already-expired token, well past the 30s clock-tolerance
			// window (see "clock-tolerance window" tests below for the boundary).
			const secretKey = new TextEncoder().encode(TEST_SECRET);
			const token = await new SignJWT({
				org: "org_456",
				src: "test-service",
			})
				.setProtectedHeader({ alg: "HS256" })
				.setIssuer("fabric-portal")
				.setSubject("user_123")
				.setIssuedAt()
				.setExpirationTime("-1h") // Already expired
				.setJti("test-jti")
				.sign(secretKey);

			const result = await verifyAIToken(token);

			expect(result.valid).toBe(false);
			if (!result.valid) {
				expect(result.code).toBe("EXPIRED");
				expect(result.error).toContain("expired");
			}
		});

		it("should reject token with wrong issuer", async () => {
			const secretKey = new TextEncoder().encode(TEST_SECRET);
			const token = await new SignJWT({
				org: "org_456",
				src: "test-service",
			})
				.setProtectedHeader({ alg: "HS256" })
				.setIssuer("wrong-issuer") // Wrong issuer
				.setSubject("user_123")
				.setIssuedAt()
				.setExpirationTime("5m")
				.setJti("test-jti")
				.sign(secretKey);

			const result = await verifyAIToken(token);

			expect(result.valid).toBe(false);
			if (!result.valid) {
				expect(result.code).toBe("INVALID_SIGNATURE");
			}
		});

		it("should reject token missing sub claim", async () => {
			const secretKey = new TextEncoder().encode(TEST_SECRET);
			const token = await new SignJWT({
				org: "org_456",
				src: "test-service",
			})
				.setProtectedHeader({ alg: "HS256" })
				.setIssuer("fabric-portal")
				// No .setSubject()
				.setIssuedAt()
				.setExpirationTime("5m")
				.setJti("test-jti")
				.sign(secretKey);

			const result = await verifyAIToken(token);

			expect(result.valid).toBe(false);
			if (!result.valid) {
				expect(result.code).toBe("MISSING_CLAIMS");
				expect(result.error).toContain("sub");
			}
		});

		it("should accept a token that expired within the clock-tolerance window", async () => {
			const secretKey = new TextEncoder().encode(TEST_SECRET);
			const nowSeconds = Math.floor(Date.now() / 1000);
			const token = await new SignJWT({
				org: "org_456",
				src: "test-service",
			})
				.setProtectedHeader({ alg: "HS256" })
				.setIssuer("fabric-portal")
				.setSubject("user_123")
				.setIssuedAt(nowSeconds - 20)
				.setExpirationTime(nowSeconds - 20) // expired 20s ago
				.setJti("test-jti")
				.sign(secretKey);

			const result = await verifyAIToken(token);

			expect(result.valid).toBe(true);
		});

		it("should reject a token that expired past the clock-tolerance window", async () => {
			const secretKey = new TextEncoder().encode(TEST_SECRET);
			const nowSeconds = Math.floor(Date.now() / 1000);
			const token = await new SignJWT({
				org: "org_456",
				src: "test-service",
			})
				.setProtectedHeader({ alg: "HS256" })
				.setIssuer("fabric-portal")
				.setSubject("user_123")
				.setIssuedAt(nowSeconds - 60)
				.setExpirationTime(nowSeconds - 60) // expired 60s ago
				.setJti("test-jti")
				.sign(secretKey);

			const result = await verifyAIToken(token);

			expect(result.valid).toBe(false);
			if (!result.valid) {
				expect(result.code).toBe("EXPIRED");
			}
		});

		it("should reject a token missing exp, iat, and jti", async () => {
			const secretKey = new TextEncoder().encode(TEST_SECRET);
			// Hand-built without .setExpirationTime()/.setIssuedAt()/.setJti() —
			// the issuer always sets all three, so this only exercises the guard.
			const token = await new SignJWT({
				org: "org_456",
				src: "test-service",
			})
				.setProtectedHeader({ alg: "HS256" })
				.setIssuer("fabric-portal")
				.setSubject("user_123")
				.sign(secretKey);

			const result = await verifyAIToken(token);

			expect(result.valid).toBe(false);
			if (!result.valid) {
				expect(result.code).toBe("MISSING_CLAIMS");
			}
		});

		it("should reject token missing src claim", async () => {
			const secretKey = new TextEncoder().encode(TEST_SECRET);
			const token = await new SignJWT({
				org: "org_456",
				// No src claim
			})
				.setProtectedHeader({ alg: "HS256" })
				.setIssuer("fabric-portal")
				.setSubject("user_123")
				.setIssuedAt()
				.setExpirationTime("5m")
				.setJti("test-jti")
				.sign(secretKey);

			const result = await verifyAIToken(token);

			expect(result.valid).toBe(false);
			if (!result.valid) {
				expect(result.code).toBe("MISSING_CLAIMS");
				expect(result.error).toContain("src");
			}
		});

		it("should return error when AI_TOKEN_SECRET is not set", async () => {
			delete process.env.AI_TOKEN_SECRET;

			// verifyAIToken catches missing secret and returns error result
			const result = await verifyAIToken("some-token");
			expect(result.valid).toBe(false);
			if (!result.valid) {
				expect(result.error).toContain("AI_TOKEN_SECRET");
				expect(result.code).toBe("MALFORMED");
			}
		});
	});

	describe("decodeTokenClaims", () => {
		it("should decode valid token claims without verification", async () => {
			const token = await issueAIToken({
				userId: "user_123",
				organizationId: "org_456",
				source: "test-service",
			});

			const claims = decodeTokenClaims(token);

			expect(claims).not.toBeNull();
			expect(claims?.sub).toBe("user_123");
			expect(claims?.org).toBe("org_456");
			expect(claims?.src).toBe("test-service");
		});

		it("should return null for malformed token", () => {
			const claims = decodeTokenClaims("not-a-jwt");
			expect(claims).toBeNull();
		});

		it("should return null for invalid base64", () => {
			const claims = decodeTokenClaims("header.!!invalid!!.signature");
			expect(claims).toBeNull();
		});
	});

	describe("isTokenExpired", () => {
		it("should return false for non-expired token", () => {
			const futureExp = Math.floor(Date.now() / 1000) + 300; // 5 minutes in future
			expect(isTokenExpired({ exp: futureExp })).toBe(false);
		});

		it("should return true for expired token", () => {
			const pastExp = Math.floor(Date.now() / 1000) - 300; // 5 minutes in past
			expect(isTokenExpired({ exp: pastExp })).toBe(true);
		});

		it("should return true when exp is undefined", () => {
			expect(isTokenExpired({})).toBe(true);
		});
	});

	describe("getRemainingValidity", () => {
		it("should return positive seconds for valid token", () => {
			const futureExp = Math.floor(Date.now() / 1000) + 300;
			const remaining = getRemainingValidity({ exp: futureExp });

			expect(remaining).toBeGreaterThan(290);
			expect(remaining).toBeLessThanOrEqual(300);
		});

		it("should return 0 for expired token", () => {
			const pastExp = Math.floor(Date.now() / 1000) - 300;
			expect(getRemainingValidity({ exp: pastExp })).toBe(0);
		});

		it("should return 0 when exp is undefined", () => {
			expect(getRemainingValidity({})).toBe(0);
		});
	});

	describe("Security edge cases", () => {
		it("should reject token with algorithm confusion attack (none)", async () => {
			// This tests protection against the "none" algorithm attack
			const result = await verifyAIToken(
				// Decodes to header {"alg":"none"} / payload {"sub":"user_123","src":"test"}
				// with an empty signature — the attack input this test asserts we reject.
				// Unsigned, so there is no secret here to leak.
				// nosemgrep: generic.secrets.security.detected-jwt-token.detected-jwt-token
				"eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJzdWIiOiJ1c2VyXzEyMyIsInNyYyI6InRlc3QifQ.",
			);

			expect(result.valid).toBe(false);
		});

		it("should reject token with extra segments", async () => {
			const result = await verifyAIToken(
				"header.payload.signature.extra",
			);
			expect(result.valid).toBe(false);
		});

		it("should handle very long tokens gracefully", async () => {
			const longToken = "a".repeat(10000);
			const result = await verifyAIToken(longToken);
			expect(result.valid).toBe(false);
		});

		it("should issue a unique jti per token", async () => {
			// NOTE: this only asserts jti uniqueness at issuance. jti is not
			// tracked server-side (no seen-token store), so a captured token is
			// still valid to replay until it expires — this test does not cover
			// replay prevention.
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

			expect(decoded1?.jti).not.toBe(decoded2?.jti);
		});
	});
});
