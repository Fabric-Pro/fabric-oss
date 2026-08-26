/**
 * AI Token Package
 *
 * Secure token-based AI API key exchange system.
 *
 * This package provides:
 * - Token issuance for Fabric-side (issueAIToken)
 * - Token verification for exchange endpoint (verifyAIToken)
 * - Token exchange client for agents (exchangeTokenForKey, getSecureAIKey)
 * - In-memory caching with TTL
 *
 * @example
 * ```typescript
 * // Fabric-side: Issue a token
 * import { issueAIToken } from "@repo/ai-token";
 *
 * const token = await issueAIToken({
 *   userId: "user_123",
 *   organizationId: "org_456",
 *   source: "document-generator",
 * });
 *
 * // Agent-side: Exchange token for key
 * import { getSecureAIKey } from "@repo/ai-token";
 *
 * const { apiKey, provider, model } = await getSecureAIKey(
 *   token,
 *   "http://localhost:3000"
 * );
 * ```
 */

// Cache utilities
export {
	cleanupExpiredEntries,
	clearAllCachedKeys,
	clearCachedKey,
	getCachedKey,
	getCacheStats,
	setCachedKey,
	startCacheCleanup,
	stopCacheCleanup,
} from "./lib/cache";
// Token Exchange Client (Agent-side)
export type { ExchangeClientConfig } from "./lib/client";
export {
	exchangeTokenForKey,
	getSecureAIKey,
	invalidateCachedKey,
	validateTokenLocally,
} from "./lib/client";
// Token Issuance (Fabric-side)
export { issueAIToken, issueAITokenWithMetadata } from "./lib/issuer";
// Types
export type {
	AITokenClaims,
	CachedKeyEntry,
	ExchangeResult,
	IssueTokenOptions,
	VerifyTokenError,
	VerifyTokenResult,
} from "./lib/types";
export {
	AI_TOKEN_HEADER,
	DEFAULT_TOKEN_EXPIRY_SECONDS,
} from "./lib/types";
// Token Verification (Exchange endpoint)
export {
	decodeTokenClaims,
	getRemainingValidity,
	isTokenExpired,
	verifyAIToken,
} from "./lib/verifier";
