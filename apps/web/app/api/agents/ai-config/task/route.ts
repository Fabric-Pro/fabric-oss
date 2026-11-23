/**
 * Returns AI provider configuration for a specific task type, for internal
 * LangGraph agents. See `./route.ts` for the auth contract.
 */

import { verifySignedTenantRequest } from "@repo/agent-runtime";
import {
	buildEffectiveBaseUrl,
	getAIModelWithMetadata,
	getRAGProviderConfigForModel,
	isReasoningModelName,
	requiresBaseUrl,
} from "@repo/ai";
import {
	chatGptPlanExhaustedRefusal,
	chatGptPlanReconnectRefusal,
	getChatGptPlanAgentConfig,
} from "@repo/ai/lib/chatgpt-plan/agent-config";
import { runWithAiInteractiveContext } from "@repo/ai/lib/chatgpt-plan/interactive-context";
import type { AiTaskType } from "@repo/database";
import { AnthropicFederationUnavailableError } from "@repo/database/prisma/queries/anthropic-federation";
import { AiUsageLimitExceededError } from "@repo/payments";
import { type NextRequest, NextResponse } from "next/server";

function federationUnavailable(error: AnthropicFederationUnavailableError) {
	return NextResponse.json(
		{ error: error.message, code: "ANTHROPIC_FEDERATION_UNAVAILABLE" },
		{ status: 409 },
	);
}

export async function GET(req: NextRequest) {
	const auth = verifySignedTenantRequest(req.headers);
	if (!auth.ok) {
		return NextResponse.json(
			{ error: auth.error },
			{ status: auth.status },
		);
	}

	try {
		const { userId, organizationId, impersonated } = auth;

		const { searchParams } = new URL(req.url);
		const taskType = searchParams.get("taskType");

		if (!taskType) {
			return NextResponse.json(
				{ error: "taskType query parameter is required" },
				{ status: 400 },
			);
		}

		let aiModelResult: Awaited<ReturnType<typeof getAIModelWithMetadata>>;
		try {
			const resolve = () =>
				getAIModelWithMetadata(
					{ taskType: taskType as AiTaskType },
					{ userId, organizationId },
				);
			// Signed while an admin acted as the member: never their plan
			// (see `../route.ts`).
			aiModelResult = impersonated
				? await runWithAiInteractiveContext(
						{ userId, impersonated: true },
						resolve,
					)
				: await resolve();
		} catch (error) {
			if (error instanceof AnthropicFederationUnavailableError) {
				return federationUnavailable(error);
			}
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
			// Internal agents call this endpoint;
			// preserve the structured envelope so the calling agent can
			// propagate the same toast contract to its own client.
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
					error:
						error instanceof Error
							? error.message
							: `No model available for task type ${taskType}`,
				},
				{ status: 400 },
			);
		}

		const { metadata, trackUsage } = aiModelResult;
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

		const providerConfig = await getRAGProviderConfigForModel(
			{ userId, organizationId },
			metadata,
		);
		const bearer = Boolean(providerConfig.anthropicBearerSource);
		if (bearer && req.headers.get("X-AI-Credential-Kind") !== "bearer") {
			return NextResponse.json(
				{
					error: "Use the AI token exchange to obtain an Anthropic Bearer credential.",
					code: "ANTHROPIC_BEARER_REQUIRED",
				},
				{ status: 409 },
			);
		}

		const gatewayUrl = providerConfig.baseUrl
			? buildEffectiveBaseUrl(metadata.provider, providerConfig.baseUrl)
			: requiresBaseUrl(metadata.provider)
				? undefined
				: buildEffectiveBaseUrl(metadata.provider, undefined);

		return NextResponse.json({
			provider: metadata.provider,
			...(bearer
				? { credentialKind: "bearer" }
				: { apiKey: providerConfig.apiKey }),
			model: metadata.modelString,
			gatewayUrl: gatewayUrl || null,
			source: metadata.selectionSource,
			deploymentName: providerConfig.deploymentName || null,
			// Canonical-derived "emits <think>" signal (Bug #1942 review).
			isReasoningModel: isReasoningModelName(metadata.canonicalName),
			canonicalModelName: metadata.canonicalName,
			// Catalog output cap, so the agent can size its budget against the
			// model it actually got instead of a hard-coded literal. Without
			// this the LangChain path fell back to 4,000 output tokens for
			// every model — including ones the catalog rates at 128,000 — while
			// the Vercel AI SDK path had used explicit budgets since #2198.
			// `null` means "catalog doesn't know"; the agent then keeps its own
			// default rather than inventing a ceiling.
			maxOutputTokens: metadata.maxOutputTokens ?? null,
			// Also the window, so the agent can keep a default reservation from
			// crowding out the prompt on a small-context model.
			contextWindow: metadata.contextWindow ?? null,
		});
	} catch (error) {
		if (error instanceof AnthropicFederationUnavailableError) {
			return federationUnavailable(error);
		}
		console.error("[AI Config Task API] Error:", error);
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
