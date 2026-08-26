/**
 * AI Token Verifier
 *
 * Verifies JWT tokens for AI API key exchange.
 * Extracts and validates claims for key lookup.
 */

import { errors, jwtVerify } from "jose";
import type {
	AITokenClaims,
	VerifyTokenError,
	VerifyTokenResult,
} from "./types";

/**
 * Get the secret key for verifying tokens
 * Uses AI_TOKEN_SECRET environment variable
 */
function getSecretKey(): Uint8Array {
	const secret = process.env.AI_TOKEN_SECRET;
	if (!secret) {
		throw new Error(
			"AI_TOKEN_SECRET environment variable is required for token verification",
		);
	}
	return new TextEncoder().encode(secret);
}

/**
 * Verify an AI token and extract its claims
 *
 * @param token - The JWT token string to verify
 * @returns Verification result with claims on success, error details on failure
 *
 * @example
 * ```typescript
 * const result = await verifyAIToken(token);
 * if (result.valid) {
 *   console.log("User:", result.claims.sub);
 *   console.log("Org:", result.claims.org);
 * } else {
 *   console.error("Token error:", result.error);
 * }
 * ```
 */
export async function verifyAIToken(
	token: string,
): Promise<VerifyTokenResult | VerifyTokenError> {
	if (!token || typeof token !== "string") {
		return {
			valid: false,
			error: "Token is required and must be a string",
			code: "MALFORMED",
		};
	}

	try {
		const secretKey = getSecretKey();

		const { payload } = await jwtVerify(token, secretKey, {
			issuer: "fabric-portal",
			algorithms: ["HS256"],
			// Covers container clock skew; extends bearer acceptance by 30s.
			// NOT replay protection — jti uniqueness is not tracked server-side.
			clockTolerance: 30,
		});

		// Validate required claims
		if (!payload.sub) {
			return {
				valid: false,
				error: "Token missing required claim: sub (userId)",
				code: "MISSING_CLAIMS",
			};
		}

		if (!payload.src) {
			return {
				valid: false,
				error: "Token missing required claim: src (source)",
				code: "MISSING_CLAIMS",
			};
		}

		if (!payload.exp || !payload.iat || !payload.jti) {
			return {
				valid: false,
				error: "Token missing required claim: exp, iat, or jti",
				code: "MISSING_CLAIMS",
			};
		}

		// Build claims object
		const claims: AITokenClaims = {
			iss: "fabric-portal",
			sub: payload.sub as string,
			exp: payload.exp as number,
			jti: payload.jti as string,
			iat: payload.iat as number,
			org: payload.org as string | undefined,
			src: payload.src as string,
		};

		return {
			valid: true,
			claims,
		};
	} catch (error) {
		if (error instanceof errors.JWTExpired) {
			return {
				valid: false,
				error: "Token has expired",
				code: "EXPIRED",
			};
		}

		if (error instanceof errors.JWTClaimValidationFailed) {
			return {
				valid: false,
				error: `Token claim validation failed: ${error.message}`,
				code: "INVALID_SIGNATURE",
			};
		}

		if (error instanceof errors.JWSSignatureVerificationFailed) {
			return {
				valid: false,
				error: "Token signature verification failed",
				code: "INVALID_SIGNATURE",
			};
		}

		if (error instanceof errors.JWSInvalid) {
			return {
				valid: false,
				error: "Token format is invalid",
				code: "MALFORMED",
			};
		}

		// Unknown error
		console.error("[AI Token] Verification error:", error);
		return {
			valid: false,
			error:
				error instanceof Error
					? error.message
					: "Unknown verification error",
			code: "MALFORMED",
		};
	}
}

/**
 * Extract claims from a token without full verification
 * Useful for logging/debugging but NOT for security decisions
 *
 * @param token - The JWT token string
 * @returns Decoded payload or null if malformed
 */
export function decodeTokenClaims(
	token: string,
): Partial<AITokenClaims> | null {
	try {
		// JWT has 3 parts: header.payload.signature
		const parts = token.split(".");
		if (parts.length !== 3) {
			return null;
		}

		// Decode the payload (middle part)
		const payload = JSON.parse(
			Buffer.from(parts[1], "base64url").toString("utf-8"),
		);

		return {
			iss: payload.iss,
			sub: payload.sub,
			exp: payload.exp,
			jti: payload.jti,
			iat: payload.iat,
			org: payload.org,
			src: payload.src,
		};
	} catch {
		return null;
	}
}

/**
 * Check if a token is expired based on its claims
 *
 * @param claims - Token claims with exp field
 * @returns True if token is expired
 */
export function isTokenExpired(claims: { exp?: number }): boolean {
	if (!claims.exp) {
		return true;
	}
	// exp is in seconds, Date.now() is in milliseconds
	return claims.exp * 1000 < Date.now();
}

/**
 * Get remaining validity of a token in seconds
 *
 * @param claims - Token claims with exp field
 * @returns Seconds until expiry, or 0 if expired
 */
export function getRemainingValidity(claims: { exp?: number }): number {
	if (!claims.exp) {
		return 0;
	}
	const remaining = claims.exp - Math.floor(Date.now() / 1000);
	return Math.max(0, remaining);
}
