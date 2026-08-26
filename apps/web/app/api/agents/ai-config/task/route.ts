/**
 * Returns AI provider configuration for a specific task type, for internal
 * LangGraph agents. See `./route.ts` for the auth contract.
 */

import { verifySignedTenantRequest } from "@repo/agent-runtime";
import {
	buildEffectiveBaseUrl,
	getAIModelWithMetadata,
	getRAGProviderConfig,
	isReasoningModelName,
} from "@repo/ai";
import type { AiTaskType } from "@repo/database";
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
			aiModelResult = await getAIModelWithMetadata(
				{ taskType: taskType as AiTaskType },
				{ userId, organizationId },
			);
		} catch (error) {
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

		const providerConfig = await getRAGProviderConfig({
			userId,
			organizationId,
		});

		const gatewayUrl = buildEffectiveBaseUrl(
			metadata.provider,
			providerConfig.baseUrl || undefined,
		);

		return NextResponse.json({
			provider: metadata.provider,
			apiKey: providerConfig.apiKey,
			model: metadata.modelString,
			gatewayUrl: gatewayUrl || null,
			source: metadata.selectionSource,
			deploymentName: providerConfig.deploymentName || null,
			// Canonical-derived "emits <think>" signal (Bug #1942 review).
			isReasoningModel: isReasoningModelName(metadata.canonicalName),
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
