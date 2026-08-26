/**
 * Token Exchange Client for Agents
 *
 * This module handles exchanging AI tokens for actual API credentials.
 * Agents receive tokens via headers and use this to get API keys.
 *
 * Flow:
 * 1. Agent receives X-AI-Token header from Fabric
 * 2. Agent calls exchangeTokenForCredentials() with the token
 * 3. Token is exchanged via /api/ai/keys/exchange endpoint
 * 4. Cached credentials are returned for subsequent calls
 */

import { AI_TOKEN_HEADER, exchangeTokenForKey } from "@repo/ai-token";

/**
 * AI credentials resolved from token exchange
 */
export interface AICredentials {
	/** The decrypted API key */
	apiKey: string;
	/** The AI provider type */
	provider: string;
	/** The configured model string */
	model: string;
	/** Base URL for the provider */
	baseUrl?: string;
	/** Token expiry remaining seconds */
	expiresIn: number;
	/** For Azure AI Foundry - the user-defined deployment name */
	deploymentName?: string;
	/** Billing mode determined by Fabric at token exchange time */
	billingMode?: string;
	/** Stripe customer id when metering is active */
	billingCustomerId?: string;
}

/**
 * Options for token extraction
 */
export interface TokenExtractionOptions {
	/** Fabric API base URL for token exchange */
	fabricBaseUrl?: string;
}

/**
 * Default Fabric API base URL
 * Can be overridden via FABRIC_API_URL or RUNTIME_API_URL environment variable
 *
 * Priority:
 * 1. FABRIC_API_URL - Explicit config for agents
 * 2. RUNTIME_API_URL - Set by docker-compose for agents (e.g., http://web:3001)
 * 3. NEXT_PUBLIC_APP_URL - Next.js app URL
 * 4. Default to localhost:3000 for local development
 */
function getDefaultFabricBaseUrl(): string {
	return (
		process.env.FABRIC_API_URL ||
		process.env.RUNTIME_API_URL ||
		process.env.NEXT_PUBLIC_APP_URL ||
		"http://localhost:3000"
	);
}

/**
 * Extract AI token from request headers
 *
 * @param headers - Request headers (Map, Headers object, or Record)
 * @returns The AI token or null if not present
 */
export function extractAIToken(
	headers:
		| Map<string, string>
		| Headers
		| Record<string, string | string[] | undefined>,
): string | null {
	// Handle Map
	if (headers instanceof Map) {
		return (
			headers.get(AI_TOKEN_HEADER) ||
			headers.get(AI_TOKEN_HEADER.toLowerCase()) ||
			null
		);
	}

	// Handle Headers object
	if (headers instanceof Headers) {
		return headers.get(AI_TOKEN_HEADER) || null;
	}

	// Handle Record object
	const token =
		headers[AI_TOKEN_HEADER] || headers[AI_TOKEN_HEADER.toLowerCase()];
	if (Array.isArray(token)) {
		return token[0] || null;
	}
	return token || null;
}

/**
 * Exchange an AI token for API credentials
 *
 * This function handles the token exchange with caching.
 * Use this when you have a token and need the actual API key.
 *
 * @param token - The AI token from X-AI-Token header
 * @param options - Options including Fabric base URL
 * @returns AI credentials with API key
 * @throws Error if token is invalid or exchange fails
 *
 * @example
 * ```typescript
 * const token = extractAIToken(request.headers);
 * if (token) {
 *   const creds = await exchangeTokenForCredentials(token);
 *   console.log("Provider:", creds.provider);
 *   console.log("Model:", creds.model);
 *   // Use creds.apiKey to call AI provider
 * }
 * ```
 */
async function exchangeTokenForCredentials(
	token: string,
	options?: TokenExtractionOptions,
): Promise<AICredentials> {
	if (!token) {
		throw new Error("AI token is required for exchange");
	}

	const fabricBaseUrl = options?.fabricBaseUrl || getDefaultFabricBaseUrl();

	// Use the ai-token package's exchange function (handles caching)
	const result = await exchangeTokenForKey(token, {
		fabricBaseUrl,
		enableCache: true,
	});

	return {
		apiKey: result.apiKey,
		provider: result.provider,
		model: result.model,
		baseUrl: result.baseUrl,
		expiresIn: result.expiresIn,
		deploymentName: result.deploymentName,
		billingMode: result.billingMode,
		billingCustomerId: result.billingCustomerId,
	};
}

/**
 * Extract AI token from headers and exchange for credentials
 *
 * Convenience function that combines token extraction and exchange.
 *
 * @param headers - Request headers
 * @param options - Options including Fabric base URL
 * @returns AI credentials or null if no token present
 * @throws Error if token is present but invalid/exchange fails
 */
export async function getAICredentialsFromHeaders(
	headers:
		| Map<string, string>
		| Headers
		| Record<string, string | string[] | undefined>,
	options?: TokenExtractionOptions,
): Promise<AICredentials | null> {
	const token = extractAIToken(headers);

	if (!token) {
		return null;
	}

	return exchangeTokenForCredentials(token, options);
}

// Re-export the token header constant
export { AI_TOKEN_HEADER };
