/**
 * AI Text Generation API
 * Generates text using AI models via centralized AI model access
 * Uses Next.js after for non-blocking usage logging.
 * See: server-after-nonblocking rule from Vercel React Best Practices
 */

import { getAIModelWithMetadata } from "@repo/ai";
import { auth } from "@repo/auth";
import { logAiUsage } from "@repo/database";
import { AiUsageLimitExceededError } from "@repo/payments";
import { streamText } from "ai";
import { headers } from "next/headers";
import type { NextRequest } from "next/server";
import { after } from "next/server";
import { z } from "zod";

const GenerateRequestSchema = z.object({
	prompt: z.string().min(1, "Prompt is required"),
	model: z.string().optional(),
	systemPrompt: z.string().optional(),
	// Note: userId and organizationId from request body are IGNORED for security
	// We use session values instead to prevent user impersonation attacks
});

export async function POST(req: NextRequest) {
	const startTime = Date.now();

	try {
		// Get user session
		const headersList = await headers();
		const session = await auth.api.getSession({
			headers: headersList,
		});

		if (!session?.user) {
			return new Response(JSON.stringify({ error: "Unauthorized" }), {
				status: 401,
				headers: { "Content-Type": "application/json" },
			});
		}

		// Parse request body
		const body = await req.json();
		const validation = GenerateRequestSchema.safeParse(body);

		if (!validation.success) {
			return new Response(
				JSON.stringify({
					error: "Invalid request",
					details: validation.error.issues,
				}),
				{
					status: 400,
					headers: { "Content-Type": "application/json" },
				},
			);
		}

		const { prompt, model: requestedModel, systemPrompt } = validation.data;

		// SECURITY: Always use session values for user/org context
		// Never trust userId/organizationId from request body to prevent impersonation
		const userId = session.user.id;
		const organizationId =
			session.session.activeOrganizationId ?? undefined;

		// Get AI model using centralized entry point
		const { model, metadata, trackUsage } = await getAIModelWithMetadata(
			{
				taskType: "SIMPLE",
				modelOverride: requestedModel || undefined,
			},
			{ userId, organizationId },
		);

		// Track provider last-used timestamp (fire-and-forget)
		trackUsage();

		// Generate text using AI SDK
		const result = await streamText({
			model,
			prompt,
			system: systemPrompt,
		});

		// Collect the full text response
		let fullText = "";
		for await (const textPart of result.textStream) {
			fullText += textPart;
		}

		// Get usage data
		const usage = await result.usage;
		const latencyMs = Date.now() - startTime;

		// Log AI usage after response is sent (non-blocking)
		// See: server-after-nonblocking rule from Vercel React Best Practices
		after(() => {
			logAiUsage({
				userId,
				organizationId: organizationId ?? undefined,
				provider: metadata.provider,
				providerModelId: metadata.modelString,
				modelCanonicalName: metadata.canonicalName,
				billingCategory:
					metadata.billingMode === "included_credit"
						? "INCLUDED_CREDIT"
						: metadata.billingMode === "metered_stripe"
							? "STRIPE_METERED"
							: metadata.billingMode === "platform_unbilled"
								? "PLATFORM_UNBILLED"
								: "EXTERNAL_BYOK",
				billingCustomerId: metadata.billingCustomerId,
				taskType: "SIMPLE",
				inputTokens: usage.inputTokens ?? 0,
				outputTokens: usage.outputTokens ?? 0,
				totalTokens: usage.totalTokens ?? 0,
				latencyMs,
				success: true,
			}).catch((error) => {
				console.error("[AI Generate] Failed to log usage:", error);
			});
		});

		return new Response(
			JSON.stringify({
				text: fullText,
				usage,
			}),
			{
				status: 200,
				headers: { "Content-Type": "application/json" },
			},
		);
	} catch (error: unknown) {
		const latencyMs = Date.now() - startTime;
		const errorMessage =
			error instanceof Error ? error.message : "Internal server error";

		// AI usage-limit chokepoint hit a HARD limit.
		// Surface the rich payload so the client
		// renders the shared destructive toast instead of falling into
		// the generic 500 path.
		if (error instanceof AiUsageLimitExceededError) {
			return new Response(
				JSON.stringify({
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
				}),
				{
					status: 429,
					headers: { "Content-Type": "application/json" },
				},
			);
		}

		console.error("[AI Generate] Error:", error);

		// Log failed request (non-blocking)
		after(() => {
			// Note: We may not have metadata if error occurred before model resolution
			logAiUsage({
				provider: "UNKNOWN" as any,
				providerModelId: "unknown",
				taskType: "SIMPLE",
				inputTokens: 0,
				outputTokens: 0,
				totalTokens: 0,
				latencyMs,
				success: false,
				errorMessage,
			}).catch(() => {
				// Silent failure for error logging
			});
		});

		return new Response(
			JSON.stringify({
				error: errorMessage,
			}),
			{
				status: 500,
				headers: { "Content-Type": "application/json" },
			},
		);
	}
}

export const runtime = "nodejs";
