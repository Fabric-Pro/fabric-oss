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

import { ORPCError } from "@orpc/client";
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
import {
	authorizeInputOrganization,
	Permissions,
} from "@repo/api/orpc/procedures";
import { AiUsageLimitExceededError } from "@repo/payments";
import {
	sidekickModelMetadata,
	sidekickRunPropsSchema,
} from "@saas/agents/lib/sidekick-runtime-protocol";
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
	organizationId: z.string().min(1).max(200).optional(),
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
			organizationId: requestedOrganizationId,
			formSnapshot,
			messages: clientMessages,
		} = parseResult.data;

		const sessionOrganizationId =
			session.session?.activeOrganizationId ?? undefined;

		// The tenant is the entity's own organization, not the session's
		// active one (`authorizeSidekickEntity`).
		const access = await authorizeSidekickEntity({
			userId,
			agentId,
			entityType,
			sessionOrganizationId:
				requestedOrganizationId ?? sessionOrganizationId,
		});
		if (!access.ok) {
			return new Response(JSON.stringify({ error: access.error }), {
				status: access.status,
				headers: { "Content-Type": "application/json" },
			});
		}

		// Saved builders must agree with any explicitly selected organization,
		// never silently billing or discovering connections in a different tenant.
		if (
			requestedOrganizationId !== undefined &&
			requestedOrganizationId !== access.organizationId
		) {
			return Response.json(
				{ error: "Agent not found or access denied" },
				{ status: 404 },
			);
		}

		// Instance and unsaved template builders require AGENT_TEMPLATE_MANAGE in
		// the target organization before spending model tokens or probing tools.
		if (access.entityType !== "registered") {
			if (!access.organizationId) {
				return Response.json(
					{ error: "Agent not found or access denied" },
					{ status: 404 },
				);
			}
			try {
				await authorizeInputOrganization(
					Permissions.AGENT_TEMPLATE_MANAGE,
					access.organizationId,
					{
						user: { id: userId },
						session: {
							activeOrganizationId: sessionOrganizationId ?? null,
						},
					},
					{ requireOrganization: true },
				);
			} catch (error) {
				if (
					!(error instanceof ORPCError) ||
					(error.code !== "FORBIDDEN" &&
						error.code !== "UNAUTHORIZED")
				) {
					throw error;
				}
				return Response.json({ error: "Forbidden" }, { status: 403 });
			}
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
		let step = 0;
		let stepHasText = false;
		let modelMetadata: ReturnType<typeof sidekickModelMetadata> | undefined;
		return createUIMessageStreamResponse({
			stream: toUIMessageStream({
				stream: result.stream,
				messageMetadata: ({ part }) => {
					if (part.type === "text-delta" && part.text) {
						stepHasText = true;
					}
					if (part.type !== "finish-step") {
						return;
					}
					const model = result.getAnswerModel(step++);
					if (!stepHasText) {
						return;
					}
					stepHasText = false;
					modelMetadata = sidekickModelMetadata(modelMetadata, model);
					return modelMetadata;
				},
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
