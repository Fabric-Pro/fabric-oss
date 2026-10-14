/**
 * AI Text Generation API
 * Generates text using AI models via centralized AI model access
 */

import { getAIModelWithMetadata } from "@repo/ai";
import { enterAiInteractiveContext } from "@repo/ai/lib/chatgpt-plan/interactive-context";
import { findAiUsageLimitError } from "@repo/ai/lib/find-usage-limit-error";
import { auth } from "@repo/auth";
import { streamText } from "ai";
import { headers } from "next/headers";
import type { NextRequest } from "next/server";
import { z } from "zod";

const GenerateRequestSchema = z.object({
	prompt: z.string().min(1, "Prompt is required"),
	model: z.string().optional(),
	systemPrompt: z.string().optional(),
	// Note: userId and organizationId from request body are IGNORED for security
	// We use session values instead to prevent user impersonation attacks
});

export async function POST(req: NextRequest) {
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
		// This person's own request — or an admin acting as them, which no
		// ChatGPT plan may serve (Fizzy #2939).
		enterAiInteractiveContext({
			userId: session.user.id,
			impersonated: Boolean(session.session.impersonatedBy),
		});

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

		// The resolved model records its own AiUsageLog row for each provider
		// call, so this route writes none of its own.
		const { model, trackUsage } = await getAIModelWithMetadata(
			{
				taskType: "SIMPLE",
				modelOverride: requestedModel || undefined,
			},
			{
				userId,
				organizationId,
				// A person is driving this request, so it may run on their own
				// ChatGPT plan where they turned it on (Fizzy #2939).
				planEligible: true,
			},
		);

		// Track provider last-used timestamp (fire-and-forget)
		trackUsage();

		// Generate text using AI SDK. A failed request ends the stream with
		// an error part rather than a throw; keep the first one so a usage-limit
		// refusal (the model checks the limits before each request) can be
		// answered as such below.
		let streamError: unknown;
		const result = streamText({
			model,
			prompt,
			instructions: systemPrompt,
			onError: ({ error }) => {
				streamError ??= error;
				console.error("[AI Generate] Stream error:", error);
			},
		});

		// Collect the full text response
		let fullText = "";
		for await (const textPart of result.textStream) {
			fullText += textPart;
		}

		// Nothing has been sent yet (the reply is one JSON body), so a limit
		// refusal can still be the same 429 a refusal at resolution gets.
		const streamLimitError = findAiUsageLimitError(streamError);
		if (streamLimitError) {
			throw streamLimitError;
		}

		// Get usage data
		const usage = await result.usage;

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
		const errorMessage =
			error instanceof Error ? error.message : "Internal server error";

		// AI usage-limit chokepoint hit a HARD limit, at model resolution or
		// during the stream. Surface the rich payload so the client renders
		// the shared destructive toast instead of falling into the generic
		// 500 path.
		const limitError = findAiUsageLimitError(error);
		if (limitError) {
			return new Response(
				JSON.stringify({
					error: limitError.message,
					code: "AI_USAGE_LIMIT_EXCEEDED",
					data: {
						limitId: limitError.limitId,
						dimension: limitError.dimension,
						window: limitError.window,
						used: limitError.used.toString(),
						max: limitError.max.toString(),
						manageLimitsUrl: limitError.manageLimitsUrl,
					},
				}),
				{
					status: 429,
					headers: { "Content-Type": "application/json" },
				},
			);
		}

		console.error("[AI Generate] Error:", error);

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
