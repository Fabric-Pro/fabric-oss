/**
 * AI Token Exchange Client
 *
 * Client for exchanging AI tokens for API keys.
 * Used by agents and services to securely retrieve AI credentials.
 */

import {
	clearCachedKey,
	getCachedKey,
	setCachedKey,
	startCacheCleanup,
} from "./cache";
import type { ExchangeResult } from "./types";
import { getRemainingValidity, verifyAIToken } from "./verifier";

/**
 * Configuration for the exchange client
 */
export interface ExchangeClientConfig {
	/** Base URL for the Fabric API (e.g., "http://localhost:3000") */
	fabricBaseUrl: string;
	/** Enable caching of exchanged keys (default: true) */
	enableCache?: boolean;
	/** Request timeout in milliseconds (default: 60000) */
	timeoutMs?: number;
}

/**
 * Default exchange endpoint path
 */
const EXCHANGE_ENDPOINT = "/api/ai/keys/exchange";

// Start cache cleanup on module load
startCacheCleanup();

/**
 * Exchange an AI token for API credentials
 *
 * @param token - The AI token to exchange
 * @param config - Client configuration
 * @returns Exchange result with API key and provider info
 * @throws Error if exchange fails or token is invalid
 *
 * @example
 * ```typescript
 * const result = await exchangeTokenForKey(token, {
 *   fabricBaseUrl: "http://localhost:3000",
 * });
 * console.log("Provider:", result.provider);
 * console.log("Model:", result.model);
 * // Use result.apiKey to call AI provider
 * ```
 */
export async function exchangeTokenForKey(
	token: string,
	config: ExchangeClientConfig,
): Promise<ExchangeResult> {
	const { fabricBaseUrl, enableCache = true, timeoutMs = 60000 } = config;

	if (!token) {
		throw new Error("AI token is required for exchange");
	}

	if (!fabricBaseUrl) {
		throw new Error("Fabric base URL is required for token exchange");
	}

	// Check cache first
	if (enableCache) {
		const cached = await getCachedKey(token);
		if (cached) {
			return cached;
		}
	}

	// Make exchange request
	const url = `${fabricBaseUrl}${EXCHANGE_ENDPOINT}`;
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

	try {
		const response = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-AI-Token": token,
			},
			body: JSON.stringify({}),
			signal: controller.signal,
		});

		if (!response.ok) {
			const errorBody = (await response
				.json()
				.catch(() => ({ error: response.statusText }))) as {
				error?: string;
			};
			throw new Error(
				`Token exchange failed: ${errorBody.error || response.statusText}`,
			);
		}

		const result = (await response.json()) as ExchangeResult;

		// Cache the result
		if (enableCache && result.expiresIn > 0) {
			await setCachedKey(token, result);
		}

		return result;
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") {
			throw new Error(`Token exchange timed out after ${timeoutMs}ms`);
		}
		throw error;
	} finally {
		clearTimeout(timeoutId);
	}
}

/**
 * Get secure AI key for server-side usage
 *
 * This is the unified function for all AI key access.
 * It handles token exchange with caching.
 *
 * @param token - The AI token
 * @param fabricBaseUrl - The Fabric API base URL
 * @returns Exchange result with API credentials
 */
export async function getSecureAIKey(
	token: string,
	fabricBaseUrl: string,
): Promise<ExchangeResult> {
	return exchangeTokenForKey(token, { fabricBaseUrl });
}

/**
 * Validate a token locally before attempting exchange
 * Useful for fast-fail scenarios
 *
 * @param token - The AI token to validate
 * @returns True if token appears valid (signature not verified)
 */
export async function validateTokenLocally(token: string): Promise<{
	valid: boolean;
	userId?: string;
	organizationId?: string;
	remainingSeconds?: number;
	error?: string;
}> {
	const result = await verifyAIToken(token);

	if (result.valid === false) {
		return {
			valid: false,
			error: result.error,
		};
	}

	return {
		valid: true,
		userId: result.claims.sub,
		organizationId: result.claims.org,
		remainingSeconds: getRemainingValidity(result.claims),
	};
}

/**
 * Invalidate a cached key entry
 * Use when you know a key has been revoked or rotated
 *
 * @param token - The AI token to invalidate
 */
export async function invalidateCachedKey(token: string): Promise<void> {
	await clearCachedKey(token);
}
