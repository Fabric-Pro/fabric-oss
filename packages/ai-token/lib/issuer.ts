/**
 * AI Token Issuer
 *
 * Issues short-lived JWT tokens for AI API key exchange.
 * Tokens identify a user/org and are used to securely retrieve API keys.
 */

import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import {
	type AITokenClaims,
	DEFAULT_TOKEN_EXPIRY_SECONDS,
	type IssueTokenOptions,
} from "./types";

/**
 * Get the secret key for signing tokens
 * Uses AI_TOKEN_SECRET environment variable
 */
function getSecretKey(): Uint8Array {
	const secret = process.env.AI_TOKEN_SECRET;
	if (!secret) {
		throw new Error(
			"AI_TOKEN_SECRET environment variable is required for token issuance",
		);
	}
	return new TextEncoder().encode(secret);
}

/**
 * Get token expiry in seconds from environment or use default
 */
function getExpirySeconds(customExpiry?: number): number {
	if (customExpiry !== undefined) {
		return customExpiry;
	}
	const envExpiry = process.env.AI_TOKEN_EXPIRY_SECONDS;
	if (envExpiry) {
		const parsed = Number.parseInt(envExpiry, 10);
		if (!Number.isNaN(parsed) && parsed > 0) {
			return parsed;
		}
	}
	return DEFAULT_TOKEN_EXPIRY_SECONDS;
}

/**
 * Issue a new AI token for API key exchange
 *
 * @param options - Token options including userId, organizationId, and source
 * @returns The signed JWT token string
 *
 * @example
 * ```typescript
 * const token = await issueAIToken({
 *   userId: "user_123",
 *   organizationId: "org_456",
 *   source: "document-generator",
 * });
 * ```
 */
export async function issueAIToken(
	options: IssueTokenOptions,
): Promise<string> {
	const { userId, organizationId, source, expirySeconds } = options;

	if (!userId) {
		throw new Error("userId is required for token issuance");
	}
	if (!source) {
		throw new Error("source is required for token issuance");
	}

	const secretKey = getSecretKey();
	const expiry = getExpirySeconds(expirySeconds);

	// Create the JWT with custom claims
	const jwt = new SignJWT({
		org: organizationId || undefined,
		src: source,
	} as Partial<AITokenClaims>)
		.setProtectedHeader({ alg: "HS256" })
		.setIssuer("fabric-portal")
		.setSubject(userId)
		.setIssuedAt()
		.setExpirationTime(`${expiry}s`)
		.setJti(randomUUID());

	return jwt.sign(secretKey);
}

/**
 * Issue a token and return it with metadata
 *
 * @param options - Token options
 * @returns Object containing the token and expiry info
 */
export async function issueAITokenWithMetadata(
	options: IssueTokenOptions,
): Promise<{
	token: string;
	expiresIn: number;
}> {
	const expiry = getExpirySeconds(options.expirySeconds);
	const token = await issueAIToken(options);

	return {
		token,
		expiresIn: expiry,
	};
}
