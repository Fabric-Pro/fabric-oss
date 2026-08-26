/**
 * Sidekick Streaming Chat API
 * Streams AI responses for the Sidekick assistant embedded in the Agent Builder.
 * Sidekick helps users configure their agents by making structured suggestions
 * (tools, instructions, skills, etc.) that appear as accept/reject cards.
 * Uses AI SDK streamText with tool calling and returns a UI message stream.
 * Conversation history is persisted to AgentConversation for multi-turn context.
 */

import {
	convertToModelMessages,
	getAIModelWithMetadata,
	stepCountIs,
	streamText,
	type UIMessage,
} from "@repo/ai";
import { createSidekickTools } from "@repo/ai/sidekick";
import { NEW_AGENT_ID } from "@repo/ai/sidekick/constants";
import { buildSidekickSystemPrompt } from "@repo/ai/sidekick/prompt";
import { checkRateLimit, RATE_LIMIT_PRESETS } from "@repo/api/lib/rate-limit";
import {
	db,
	getOrganizationMembership,
	getRegisteredAgentById,
} from "@repo/database";
import { AiUsageLimitExceededError } from "@repo/payments";
import { getSession } from "@saas/auth/lib/server";
import type { NextRequest } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const sidekickStreamSchema = z.object({
	agentId: z.string().min(1).max(200),
	// Discriminates server-side authz: "registered" looks up RegisteredAgent;
	// "instance" looks up AgentTemplateInstance; "new" skips lookup entirely.
	// Defaults to "registered" for backward compat with the builder page.
	entityType: z.enum(["registered", "instance", "new"]).default("registered"),
	conversationId: z.string().max(200).optional(),
	formSnapshot: z.record(z.string(), z.unknown()),
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

		const userId = session.user.id;

		// Rate limit: use AI preset (20 requests per minute per user)
		const rateLimitResult = await checkRateLimit(
			`sidekick-stream:${userId}`,
			RATE_LIMIT_PRESETS.ai.limit,
			RATE_LIMIT_PRESETS.ai.windowMs,
		);
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

		// Resolve tenant from the *entity being edited*, not from the
		// session's active organization. A user can open a personal instance
		// or an instance from a different org than their active one; we must
		// run model/tool resolution against that tenant, not the session's.
		const sessionOrganizationId =
			session.session?.activeOrganizationId ?? undefined;
		let effectiveOrganizationId: string | undefined = sessionOrganizationId;

		// Verify the user has access to the target entity before streaming.
		// Branches by entityType so Sidekick can assist both RegisteredAgent
		// config editing and AgentTemplateInstance form editing.
		const isNewAgent = entityType === "new" || agentId === NEW_AGENT_ID;
		if (!isNewAgent) {
			if (entityType === "registered") {
				const agent = await getRegisteredAgentById(agentId);
				if (!agent) {
					return new Response(
						JSON.stringify({ error: "Agent not found" }),
						{
							status: 404,
							headers: { "Content-Type": "application/json" },
						},
					);
				}
				if (agent.scope === "SYSTEM") {
					return new Response(
						JSON.stringify({
							error: "System agents cannot be modified via Sidekick",
						}),
						{
							status: 403,
							headers: { "Content-Type": "application/json" },
						},
					);
				}
				if (agent.scope === "USER" && agent.userId !== userId) {
					return new Response(
						JSON.stringify({ error: "Forbidden" }),
						{
							status: 403,
							headers: { "Content-Type": "application/json" },
						},
					);
				}
				if (agent.scope === "ORGANIZATION") {
					if (!agent.organizationId) {
						return new Response(
							JSON.stringify({ error: "Forbidden" }),
							{
								status: 403,
								headers: { "Content-Type": "application/json" },
							},
						);
					}
					const membership = await getOrganizationMembership(
						agent.organizationId,
						userId,
					);
					if (!membership) {
						return new Response(
							JSON.stringify({ error: "Forbidden" }),
							{
								status: 403,
								headers: { "Content-Type": "application/json" },
							},
						);
					}
				}
				// The registered agent's tenant wins over the session's active org.
				effectiveOrganizationId = agent.organizationId ?? undefined;
			} else {
				// entityType === "instance" — AgentTemplateInstance authz mirrors instances.get
				const instance = await db.agentTemplateInstance.findUnique({
					where: { id: agentId },
					select: { userId: true, organizationId: true },
				});
				if (!instance) {
					return new Response(
						JSON.stringify({ error: "Agent not found" }),
						{
							status: 404,
							headers: { "Content-Type": "application/json" },
						},
					);
				}
				const isOwner = instance.userId === userId;
				let hasAccess = isOwner;
				if (!hasAccess && instance.organizationId) {
					const membership = await getOrganizationMembership(
						instance.organizationId,
						userId,
					);
					hasAccess = !!membership;
				}
				if (!hasAccess) {
					return new Response(
						JSON.stringify({ error: "Forbidden" }),
						{
							status: 403,
							headers: { "Content-Type": "application/json" },
						},
					);
				}
				// Personal instances are null-tenant; org instances bind to
				// the owning org regardless of which org the session is in.
				effectiveOrganizationId = instance.organizationId ?? undefined;
			}
		}

		// Convert client UIMessages to model messages (preserves tool call structure)
		const uiMessages = clientMessages as UIMessage[];
		const modelMessages = await convertToModelMessages(uiMessages);

		// Strip prior <agent_context> blocks from all user messages to prevent
		// quadratic token growth (each turn previously accumulated all prior snapshots).
		const agentContextRegex =
			/<agent_context>\n[\s\S]*?\n<\/agent_context>\n\n/g;
		for (const msg of modelMessages) {
			if (msg.role !== "user") {
				continue;
			}
			if (typeof msg.content === "string") {
				msg.content = msg.content.replace(agentContextRegex, "");
			} else if (Array.isArray(msg.content)) {
				for (const part of msg.content) {
					if (part.type === "text" && "text" in part) {
						part.text = part.text.replace(agentContextRegex, "");
					}
				}
			}
		}

		// Inject fresh <agent_context> into the last user message so the LLM
		// sees the current form state alongside the user's request.
		const contextBlock = `<agent_context>\n${JSON.stringify(formSnapshot)}\n</agent_context>\n\n`;
		for (let i = modelMessages.length - 1; i >= 0; i--) {
			const msg = modelMessages[i];
			if (msg.role === "user") {
				if (typeof msg.content === "string") {
					msg.content = contextBlock + msg.content;
				} else if (Array.isArray(msg.content)) {
					const textPart = msg.content.find((p) => p.type === "text");
					if (textPart && "text" in textPart) {
						textPart.text = contextBlock + textPart.text;
					}
				}
				break;
			}
		}

		// Get AI model via centralized entry point — use the entity's tenant
		// so model catalog + billing resolve against the right org.
		const { model: aiModel, trackUsage } = await getAIModelWithMetadata(
			{ taskType: "CHAT" },
			{
				userId,
				organizationId: effectiveOrganizationId,
				featureKey: "chat-agent",
			},
		);

		// Track usage (fire-and-forget)
		trackUsage();

		// Create Sidekick tools. Persistence-capable tools only engage for
		// "registered" agents; "new" and "instance" fall through to the
		// auto-apply path so the frontend writes changes straight into the
		// form state.
		const tools = createSidekickTools({
			agentId,
			entityType: isNewAgent ? "new" : entityType,
			userId,
			organizationId: effectiveOrganizationId,
		});

		// Stream the response using the full message history from the client
		// (includes tool calls and results with proper structure)
		const result = streamText({
			model: aiModel,
			system: buildSidekickSystemPrompt(),
			messages: modelMessages,
			tools,
			stopWhen: stepCountIs(5),
		});

		// Return UI message stream response
		return result.toUIMessageStreamResponse();
	} catch (error) {
		// AI usage-limit chokepoint hit a HARD limit.
		// The chokepoint runs inside
		// `getAIModelWithMetadata` near the top of this handler, but
		// can also bubble through `createSidekickTools` if a tool calls
		// the chokepoint indirectly. Catch at the outer boundary so the
		// Sidekick consumer surfaces the shared destructive toast.
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
