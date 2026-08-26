/**
 * AI Token Exchange Endpoint
 *
 * Exchanges an AI token (short-lived JWT) for actual API credentials.
 * This is the single point of access for AI API keys in the system.
 *
 * Flow:
 * 1. Extract and verify JWT token from X-AI-Token header
 * 2. Extract userId and organizationId from token claims
 * 3. Look up the user/org's default AI provider configuration
 * 4. Look up Jina API key for web search/scraping (if configured)
 * 5. Return the API key, provider, model, base URL, and Jina key
 *
 * Security:
 * - Token must be valid and not expired
 * - Only the exchange endpoint can access decrypted API keys
 * - All exchanges are logged for auditing
 */

import { DEFAULT_BASE_URLS, getAIModelWithMetadata } from "@repo/ai";
import {
	AI_TOKEN_HEADER,
	getRemainingValidity,
	verifyAIToken,
} from "@repo/ai-token";
import { getSearchProviderConfig } from "@repo/database";
import { decryptApiKey } from "@repo/utils";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

interface ExchangeResponse {
	apiKey: string;
	provider: string;
	model: string;
	baseUrl?: string;
	expiresIn: number;
	billingMode?: string;
	billingCustomerId?: string;
	/** Jina AI API key for web search/scraping (if user has configured) */
	jinaApiKey?: string;
	/** For Azure AI Foundry - the user-defined deployment name */
	deploymentName?: string;
}

interface ErrorResponse {
	error: string;
	code?: string;
}

/**
 * POST /api/ai/keys/exchange
 *
 * Exchange an AI token for API credentials.
 *
 * Headers:
 *   X-AI-Token: <jwt-token>
 *
 * Response:
 *   200: { apiKey, provider, model, baseUrl?, expiresIn }
 *   401: { error, code } - Token invalid/expired
 *   404: { error } - No AI provider configured
 *   500: { error } - Server error
 */
export async function POST(
	request: Request,
): Promise<NextResponse<ExchangeResponse | ErrorResponse>> {
	try {
		// Extract token from header
		const token = request.headers.get(AI_TOKEN_HEADER);

		if (!token) {
			return NextResponse.json(
				{
					error: `Missing ${AI_TOKEN_HEADER} header`,
					code: "MISSING_TOKEN",
				},
				{ status: 401 },
			);
		}

		// Verify the token
		const verifyResult = await verifyAIToken(token);

		if (!verifyResult.valid) {
			console.warn(
				"[AI Exchange] Token verification failed:",
				verifyResult.error,
			);
			return NextResponse.json(
				{
					error: verifyResult.error,
					code: verifyResult.code,
				},
				{ status: 401 },
			);
		}

		const { claims } = verifyResult;
		const userId = claims.sub;
		const organizationId = claims.org;
		const source = claims.src;

		// Log the exchange request for auditing
		console.log("[AI Exchange] Token exchange request", {
			userId,
			organizationId: organizationId || "none",
			source,
			remainingValidity: getRemainingValidity(claims),
		});

		// Get AI model with metadata using centralized entry point
		// This handles provider resolution, model selection, and usage tracking
		let modelResult: Awaited<ReturnType<typeof getAIModelWithMetadata>>;
		try {
			modelResult = await getAIModelWithMetadata(
				{ taskType: "COMPLEX" },
				{ userId, organizationId },
			);
		} catch (error) {
			console.warn("[AI Exchange] No AI provider configured", {
				userId,
				organizationId,
				error: error instanceof Error ? error.message : error,
			});
			return NextResponse.json(
				{
					error: "No AI provider configured. Please configure an AI provider in Settings.",
				},
				{ status: 404 },
			);
		}

		const { metadata, trackUsage } = modelResult;

		// Track usage (fire-and-forget)
		trackUsage();

		// Get the raw API key for external services
		// We need to get this separately since getAIModelWithMetadata uses it internally
		const { getRAGProviderConfig } = await import("@repo/ai");
		const providerConfig = await getRAGProviderConfig({
			userId,
			organizationId,
		});

		// providerConfig.apiKey is already decrypted by getRAGProviderConfig()
		const decryptedApiKey = providerConfig.apiKey;

		const model = metadata.modelString;
		const providerToUse = metadata.provider;

		// Calculate remaining token validity
		const expiresIn = getRemainingValidity(claims);

		// Look up Jina API key for web search/scraping (optional)
		let jinaApiKey: string | undefined;
		try {
			const jinaConfig = await getSearchProviderConfig({
				userId,
				organizationId,
				providerName: "jina",
			});
			if (jinaConfig?.encryptedApiKey) {
				jinaApiKey = decryptApiKey(jinaConfig.encryptedApiKey);
				console.log("[AI Exchange] Jina API key found for user");
			}
		} catch (error) {
			// Non-critical - Jina key is optional
			console.warn("[AI Exchange] Failed to get Jina API key:", error);
		}

		// Return the exchange result with full provider configuration
		// Use the resolved provider which may differ from the user's default
		// (e.g., if user has Cerebras but the model requires OpenAI)
		const response: ExchangeResponse = {
			apiKey: decryptedApiKey, // Decrypted API key - ready to use
			provider: providerToUse || "unknown",
			model: model, // Full model string compatible with the provider
			expiresIn,
			billingMode: metadata.billingMode,
			billingCustomerId: metadata.billingCustomerId || undefined,
		};

		// Include base URL based on the resolved provider
		// Use DEFAULT_BASE_URLS from @repo/ai - SINGLE SOURCE OF TRUTH
		// SDK-based providers (OPENAI_DIRECT, ANTHROPIC_DIRECT, GROQ, MISTRAL_AI, COHERE) don't have entries
		if (providerConfig.baseUrl) {
			response.baseUrl = providerConfig.baseUrl;
		} else if (
			providerToUse &&
			DEFAULT_BASE_URLS[providerToUse as keyof typeof DEFAULT_BASE_URLS]
		) {
			response.baseUrl =
				DEFAULT_BASE_URLS[
					providerToUse as keyof typeof DEFAULT_BASE_URLS
				];
		}

		// Include Jina API key if configured
		if (jinaApiKey) {
			response.jinaApiKey = jinaApiKey;
		}

		// Include deployment name for Azure AI Foundry
		if (providerConfig.deploymentName) {
			response.deploymentName = providerConfig.deploymentName;
		}

		console.log("[AI Exchange] Token exchange successful", {
			provider: response.provider,
			model: response.model,
			hasBaseUrl: !!response.baseUrl,
			hasJinaKey: !!jinaApiKey,
			hasDeploymentName: !!response.deploymentName,
			expiresIn,
		});

		return NextResponse.json(response);
	} catch (error) {
		console.error("[AI Exchange] Error:", error);
		return NextResponse.json(
			{
				error:
					error instanceof Error
						? error.message
						: "Internal server error",
			},
			{ status: 500 },
		);
	}
}

/**
 * OPTIONS - Handle CORS preflight requests
 */
export async function OPTIONS(): Promise<NextResponse> {
	return new NextResponse(null, {
		status: 204,
		headers: {
			"Access-Control-Allow-Methods": "POST, OPTIONS",
			"Access-Control-Allow-Headers": `Content-Type, ${AI_TOKEN_HEADER}`,
			"Access-Control-Max-Age": "86400",
		},
	});
}
