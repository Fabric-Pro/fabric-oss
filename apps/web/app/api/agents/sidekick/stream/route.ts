/**
 * Sidekick Streaming Chat API
 * Streams AI responses for the Sidekick assistant embedded in the Agent Builder.
 * Sidekick helps users configure their agents by making structured suggestions
 * (tools, instructions, skills, etc.) that appear as accept/reject cards.
 * Uses AI SDK streamText with tool calling and returns a UI message stream.
 * Nothing is saved: the client sends the whole conversation with every turn.
 * The turn itself (`sidekick-turn.ts`) is shared with the agent runtime's
 * `agent-builder-sidekick` engine.
 */

import {
	createUIMessageStreamResponse,
	toUIMessageStream,
	type UIMessage,
} from "@repo/ai";
import {
	chatGptPlanExhaustedChatResponse,
	chatGptPlanReconnectRefusal,
} from "@repo/ai/lib/chatgpt-plan/agent-config";
import { enterAiInteractiveContext } from "@repo/ai/lib/chatgpt-plan/interactive-context";
import { AiUsageLimitExceededError } from "@repo/payments";
import { sidekickRunPropsSchema } from "@saas/agents/lib/sidekick-runtime-protocol";
import { getSession } from "@saas/auth/lib/server";
import type { NextRequest } from "next/server";
import { z } from "zod";
import {
	authorizeSidekickEntity,
	checkSidekickRateLimit,
	streamSidekickTurn,
} from "./sidekick-turn";
import { sidekickStreamErrorText } from "./stream-error-text";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const sidekickStreamSchema = sidekickRunPropsSchema.extend({
	conversationId: z.string().max(200).optional(),
	messages: z.array(z.any()),
});

export async function POST(request: NextRequest) {
	try {
		// Authenticate using the same pattern as fabric-ai stream
		const session = await getSession();
		if (!session) {
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

		const userId = session.user.id;

		// Rate limit: use AI preset (20 requests per minute per user)
		const rateLimitResult = await checkSidekickRateLimit(userId);
		if (!rateLimitResult.allowed) {
			return new Response(
				JSON.stringify({
					error: "Too many requests",
					message: `Rate limit exceeded. Please try again in ${rateLimitResult.resetInSeconds} seconds.`,
					retryAfter: rateLimitResult.resetInSeconds,
				}),
				{
					status: 429,
					headers: {
						"Content-Type": "application/json",
						"Retry-After":
							rateLimitResult.resetInSeconds.toString(),
					},
				},
			);
		}

		// Validate request body
		const rawBody = await request.json();
		const parseResult = sidekickStreamSchema.safeParse(rawBody);
		if (!parseResult.success) {
			return new Response(
				JSON.stringify({
					error: "Invalid request body",
					details: parseResult.error.issues.map((i) => ({
						path: i.path.join("."),
						message: i.message,
					})),
				}),
				{
					status: 400,
					headers: { "Content-Type": "application/json" },
				},
			);
		}

		const {
			agentId,
			entityType,
			formSnapshot,
			messages: clientMessages,
		} = parseResult.data;

		// The tenant is the entity's own organization, not the session's
		// active one (`authorizeSidekickEntity`).
		const access = await authorizeSidekickEntity({
			userId,
			agentId,
			entityType,
			sessionOrganizationId:
				session.session?.activeOrganizationId ?? undefined,
		});
		if (!access.ok) {
			return new Response(JSON.stringify({ error: access.error }), {
				status: access.status,
				headers: { "Content-Type": "application/json" },
			});
		}

		// The full message history from the client (includes tool calls and
		// results with proper structure).
		const result = await streamSidekickTurn({
			userId,
			agentId,
			entityType: access.entityType,
			organizationId: access.organizationId,
			messages: clientMessages as UIMessage[],
			formSnapshot,
		});

		// Return UI message stream response.
		//
		// AI SDK 7 deprecates the `streamText` result helpers in favour of the
		// stateless `toUIMessageStream` / `createUIMessageStreamResponse` pair;
		// `result.toUIMessageStreamResponse()` is exactly this composition
		// (ai/src/generate-text/stream-text.ts). Both helpers take an options
		// object — the migration guide's positional
		// `createUIMessageStreamResponse(uiStream)` does not match the shipped
		// declaration, which destructures `{ stream }`.
		//
		// The model checks the usage limits before each step, so a later step
		// can be refused after the response has started; `onError` sends that
		// refusal as the limit payload the client toasts, and masks the rest.
		return createUIMessageStreamResponse({
			stream: toUIMessageStream({
				stream: result.stream,
				onError: sidekickStreamErrorText,
			}),
		});
	} catch (error) {
		// AI usage-limit chokepoint hit a HARD limit.
		// The chokepoint runs inside
		// `getAIModelWithMetadata` near the top of this handler, but
		// can also bubble through `createSidekickTools` if a tool calls
		// the chokepoint indirectly. Catch at the outer boundary so the
		// Sidekick consumer surfaces the shared destructive toast.
		// The member's plan is on here but needs reconnecting: refuse rather
		// than bill the organization (Fizzy #2939).
		const reconnect = chatGptPlanReconnectRefusal(error);
		if (reconnect) {
			return new Response(JSON.stringify(reconnect.body), {
				status: reconnect.status,
				headers: { "Content-Type": "application/json" },
			});
		}
		const exhausted = chatGptPlanExhaustedChatResponse(error);
		if (exhausted) {
			return exhausted;
		}
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
		console.error("[Sidekick Stream] Error:", error);
		return new Response(
			JSON.stringify({
				error: error instanceof Error ? error.message : "Stream failed",
			}),
			{
				status: 500,
				headers: { "Content-Type": "application/json" },
			},
		);
	}
}
