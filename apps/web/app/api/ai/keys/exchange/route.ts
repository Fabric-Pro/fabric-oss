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

import {
	type AIModelMetadata,
	DEFAULT_BASE_URLS,
	getAIModelWithMetadata,
} from "@repo/ai";
import {
	chatGptPlanExhaustedRefusal,
	chatGptPlanReconnectRefusal,
	getChatGptPlanAgentConfig,
} from "@repo/ai/lib/chatgpt-plan/agent-config";
import { runWithAiInteractiveContext } from "@repo/ai/lib/chatgpt-plan/interactive-context";
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
	/**
	 * The ChatGPT plan behind `apiKey`, by its opaque key, when one serves the
	 * agent (Fizzy #2770). Sent back in `excludeSources` after that plan
	 * refuses a call as spent, to get another plan's token.
	 */
	planSource?: string;
}

// An opaque plan key from the agent: `user:<id>` or `org:<id>`. Only an
// exclusion; one naming no plan of this token's member or organization
// matches nothing in the resolver.
const PLAN_SOURCE_KEY = /^(user|org):[\w-]{1,128}$/;

/** The plans the agent asks to skip, read from an optional JSON body. */
async function readExcludedSources(request: Request): Promise<string[]> {
	try {
		const body = (await request.json()) as { excludeSources?: unknown };
		return Array.isArray(body?.excludeSources)
			? body.excludeSources
					.filter(
						(key): key is string =>
							typeof key === "string" &&
							PLAN_SOURCE_KEY.test(key),
					)
					.slice(0, 20)
			: [];
	} catch {
		return [];
	}
}

interface ErrorResponse {
	error: string;
	code?: string;
	/** A spent ChatGPT plan window's reset time, when known. */
	resetAt?: string | null;
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

		const excludePlanSources = await readExcludedSources(request);

		// Get AI model with metadata using centralized entry point
		// This handles provider resolution, model selection, and usage tracking
		let modelResult: Awaited<ReturnType<typeof getAIModelWithMetadata>>;
		try {
			const resolve = () =>
				getAIModelWithMetadata(
					{ taskType: "COMPLEX" },
					// Only a token minted for the member's own interactive work
					// may resolve their ChatGPT plan (Fizzy #2939).
					{
						userId,
						organizationId,
						planEligible: claims.pe === true,
						...(excludePlanSources.length > 0 && {
							excludePlanSources,
						}),
					},
				);
			// Minted while an admin acted as the member: resolved as that same
			// impersonated request, which the plan gate refuses outright — even
			// for work the member let run on their plan in the background.
			modelResult = claims.imp
				? await runWithAiInteractiveContext(
						{ userId, impersonated: true },
						resolve,
					)
				: await resolve();
		} catch (error) {
			const reconnect = chatGptPlanReconnectRefusal(error);
			if (reconnect) {
				return NextResponse.json(reconnect.body, {
					status: reconnect.status,
				});
			}
			const exhausted = chatGptPlanExhaustedRefusal(error);
			if (exhausted) {
				return NextResponse.json(exhausted.body, {
					status: exhausted.status,
				});
			}
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

		if (metadata.provider === "OPENAI_CHATGPT_PLAN") {
			return exchangeChatGptPlan({
				userId,
				source: metadata.planSource,
				model: metadata.modelString,
				tokenValiditySeconds: getRemainingValidity(claims),
				billingMode: metadata.billingMode,
				jinaApiKey: await lookupJinaApiKey(userId, organizationId),
			});
		}

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

		const jinaApiKey = await lookupJinaApiKey(userId, organizationId);

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

/** Jina AI API key for web search/scraping, when the user configured one. */
async function lookupJinaApiKey(
	userId: string,
	organizationId: string | undefined,
): Promise<string | undefined> {
	try {
		const jinaConfig = await getSearchProviderConfig({
			userId,
			organizationId,
			providerName: "jina",
		});
		if (jinaConfig?.encryptedApiKey) {
			console.log("[AI Exchange] Jina API key found for user");
			return decryptApiKey(jinaConfig.encryptedApiKey);
		}
	} catch (error) {
		// Non-critical - Jina key is optional
		console.warn("[AI Exchange] Failed to get Jina API key:", error);
	}
	return undefined;
}

// Handed-over plan tokens stop being served this long before they expire, so
// an agent never starts a call with one about to lapse.
const PLAN_TOKEN_EXPIRY_MARGIN_SECONDS = 60;

/**
 * A ChatGPT plan — the member's own or an organization's shared account: the
 * server-refreshed access token stands in for the provider key. It is never paired with the organization's key or base
 * URL, and the agent's cache of it ends before the token does.
 */
async function exchangeChatGptPlan(params: {
	userId: string;
	source: AIModelMetadata["planSource"];
	model: string;
	tokenValiditySeconds: number;
	billingMode: string;
	jinaApiKey: string | undefined;
}): Promise<NextResponse<ExchangeResponse | ErrorResponse>> {
	const plan = await getChatGptPlanAgentConfig({
		userId: params.userId,
		model: params.model,
		source: params.source,
	});
	if (!plan.ok) {
		return NextResponse.json(
			{
				error: plan.error,
				code: plan.code,
				resetAt: plan.resetAt ?? null,
			},
			{ status: plan.status },
		);
	}
	const tokenSeconds = Math.floor(
		(plan.expiresAt.getTime() - Date.now()) / 1000 -
			PLAN_TOKEN_EXPIRY_MARGIN_SECONDS,
	);
	console.log("[AI Exchange] Token exchange successful", {
		provider: plan.config.provider,
		model: plan.config.model,
	});
	return NextResponse.json({
		apiKey: plan.config.apiKey,
		provider: plan.config.provider,
		model: plan.config.model,
		expiresIn: Math.max(
			0,
			Math.min(params.tokenValiditySeconds, tokenSeconds),
		),
		billingMode: params.billingMode,
		planSource: plan.planSource,
		...(params.jinaApiKey && { jinaApiKey: params.jinaApiKey }),
	});
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
