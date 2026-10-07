/**
 * Returns AI provider configuration (including decrypted API keys) for the
 * authenticated tenant, for internal LangGraph agents.
 * Callers MUST authenticate via HMAC-signed tenant headers produced by
 * `createSecurityHeaders` in `@repo/agent-runtime`. Plaintext
 * `X-Tenant-User-ID` / `X-Tenant-Organization-ID` are NOT trusted.
 */

import { verifySignedTenantRequest } from "@repo/agent-runtime";
import {
	buildEffectiveBaseUrl,
	getAIModelWithMetadata,
	getRAGProviderConfig,
	isReasoningModelName,
	requiresBaseUrl,
} from "@repo/ai";
import {
	chatGptPlanExhaustedRefusal,
	chatGptPlanReconnectRefusal,
	getChatGptPlanAgentConfig,
} from "@repo/ai/lib/chatgpt-plan/agent-config";
import { AiUsageLimitExceededError } from "@repo/payments";
import { type NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
	const auth = verifySignedTenantRequest(req.headers);
	if (!auth.ok) {
		return NextResponse.json(
			{ error: auth.error },
			{ status: auth.status },
		);
	}

	try {
		const { userId, organizationId } = auth;

		let modelResult: Awaited<ReturnType<typeof getAIModelWithMetadata>>;
		try {
			modelResult = await getAIModelWithMetadata(
				{ taskType: "TOOL_CALLING" },
				{ userId, organizationId },
			);
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
			// AI usage-limit chokepoint hit a HARD limit.
			// Internal agents call this endpoint to
			// resolve their model; preserving the structured envelope
			// lets the calling agent propagate the same toast contract
			// when it surfaces the error to its own client.
			if (error instanceof AiUsageLimitExceededError) {
				return NextResponse.json(
					{
						error: error.message,
						code: "AI_USAGE_LIMIT_EXCEEDED",
						data: {
							limitId: error.limitId,
							dimension: error.dimension,
							window: error.window,
							used: error.used.toString(),
							max: error.max.toString(),
							manageLimitsUrl: error.manageLimitsUrl,
						},
					},
					{ status: 429 },
				);
			}
			return NextResponse.json(
				{
					error: "No AI provider configured. Please configure an AI provider in Settings.",
					code: "AI_PROVIDER_NOT_CONFIGURED",
				},
				{ status: 400 },
			);
		}

		const { metadata, trackUsage } = modelResult;
		trackUsage();

		// Only a member who chose "background jobs and agents" for this
		// organization resolves to their plan here: these signed headers carry
		// no sign that a person is present (Fizzy #2939).
		if (metadata.provider === "OPENAI_CHATGPT_PLAN") {
			const plan = await getChatGptPlanAgentConfig({
				userId,
				model: metadata.modelString,
				source: metadata.planSource,
			});
			return plan.ok
				? NextResponse.json(plan.config)
				: NextResponse.json(
						{
							error: plan.error,
							code: plan.code,
							resetAt: plan.resetAt ?? null,
						},
						{ status: plan.status },
					);
		}

		const providerConfig = await getRAGProviderConfig({
			userId,
			organizationId,
		});

		// Resolve the effective gateway/base URL. Providers that require a
		// tenant-supplied base URL (Databricks, Azure AI Foundry, AWS Bedrock,
		// Cloudflare AI, ...) must NOT fall back to OpenRouter's host: doing so
		// sends the tenant's provider key (e.g. a Databricks PAT) to
		// openrouter.ai — a wrong-host failure instead of a clear error. For
		// those, return null so the agent surfaces its own "requires a base URL"
		// error (mirrors ai-config/task/route.ts). Only gateway/direct providers
		// — or an unresolved provider — fall back to the OpenRouter default.
		const resolvedProvider = metadata.provider || "OPENROUTER";
		const gatewayUrl =
			buildEffectiveBaseUrl(
				resolvedProvider,
				providerConfig.baseUrl || undefined,
			) ??
			(requiresBaseUrl(resolvedProvider)
				? null
				: "https://openrouter.ai/api/v1");

		return NextResponse.json({
			provider: metadata.provider,
			apiKey: providerConfig.apiKey,
			model: metadata.modelString,
			gatewayUrl,
			deploymentName: providerConfig.deploymentName || null,
			// Canonical-derived "emits <think>" signal (Bug #1942 review): resolved
			// from the canonical identity, not the (possibly opaque) serving alias.
			isReasoningModel: isReasoningModelName(metadata.canonicalName),
		});
	} catch (error) {
		console.error("[AI Config API] Error:", error);
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
