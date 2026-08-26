/**
 * A2A Send API Route
 * Proxies messages to external agents via A2A protocol.
 * Provides a unified interface for the frontend to communicate with any A2A-compatible agent.
 * Security:
 * - Authenticates user session
 * - Issues AI token for secure credential exchange
 * - Passes tenant context to agents
 */

import { type A2AMessage, SecureA2AClient } from "@repo/agent-core";
import {
	buildEffectiveBaseUrl,
	getAIModelWithMetadata,
	getRAGProviderConfig,
} from "@repo/ai";
import { issueAIToken } from "@repo/ai-token";
import { auth } from "@repo/auth";
import { AiUsageLimitExceededError } from "@repo/payments";
import { headers } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";

interface A2ASendRequest {
	agentUrl: string;
	message: {
		role: "user";
		content: string;
		metadata?: Record<string, unknown>;
	};
	contextId?: string | null;
	history?: Array<{ role: string; content: string }>;
	organizationId?: string;
}

export async function POST(req: NextRequest) {
	try {
		// Get user session for authentication
		const headersList = await headers();
		const session = await auth.api.getSession({
			headers: headersList,
		});

		if (!session?.user) {
			console.log("[A2A Send] Unauthorized - no session");
			return NextResponse.json(
				{ error: "Unauthorized" },
				{ status: 401 },
			);
		}

		const body: A2ASendRequest = await req.json();
		const { agentUrl, message, contextId, history, organizationId } = body;

		if (!agentUrl) {
			return NextResponse.json(
				{ error: "agentUrl is required" },
				{ status: 400 },
			);
		}

		if (!message?.content) {
			return NextResponse.json(
				{ error: "message.content is required" },
				{ status: 400 },
			);
		}

		// Issue AI token for secure credential exchange
		let aiToken: string | undefined;
		let aiModel: string | undefined;
		let aiProvider: string | undefined;
		let aiBaseUrl: string | undefined;

		try {
			// Get AI model with metadata using centralized entry point
			const { metadata, trackUsage } = await getAIModelWithMetadata(
				{ taskType: "TOOL_CALLING" },
				{ userId: session.user.id, organizationId },
			);

			// Track usage (fire-and-forget)
			trackUsage();

			// Get raw provider config for base URL
			const providerConfig = await getRAGProviderConfig({
				userId: session.user.id,
				organizationId,
			});

			aiToken = await issueAIToken({
				userId: session.user.id,
				organizationId,
				source: "a2a-proxy",
			});

			aiModel = metadata.modelString;
			aiProvider = metadata.provider;
			aiBaseUrl =
				buildEffectiveBaseUrl(
					metadata.provider,
					providerConfig.baseUrl || undefined,
				) || undefined;

			console.log("[A2A Send] Issued AI token for user:", {
				userId: session.user.id,
				organizationId,
				aiProvider,
				aiModel,
			});
		} catch (error) {
			// AI usage-limit chokepoint hit a HARD limit.
			// The default `Continue without AI
			// config` branch silently masks the block and lets the
			// agent fall through with no token; surface the structured
			// payload directly so the caller renders the shared
			// destructive toast and stops the request.
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
			console.warn("[A2A Send] Failed to issue AI token:", error);
			// Continue without AI config - agent will use its own defaults
		}

		// Create secure A2A client
		const client = new SecureA2AClient({
			timeout: 120000, // 2 minutes for agent response
			sourceAgent: "fabric-web",
		});

		// Build the A2A message with proper structure (parts array required)
		const a2aMessage: A2AMessage = {
			role: "user",
			parts: [{ type: "text", text: message.content }],
			metadata: {
				...message.metadata,
				history: history || [],
			},
		};

		console.log("[A2A Send] Sending message to agent:", {
			agentUrl,
			contentLength: message.content.length,
			hasHistory: !!history?.length,
			contextId,
			hasAiToken: !!aiToken,
			userId: session.user.id,
		});

		// Send message via secure A2A protocol with tenant context and AI config
		const task = await client.sendMessageSecure(
			agentUrl,
			a2aMessage,
			{
				userId: session.user.id,
				organizationId: organizationId || null,
			},
			{
				contextId: contextId || undefined,
				metadata: message.metadata,
				aiConfig:
					aiToken && aiModel && aiProvider
						? {
								token: aiToken,
								model: aiModel,
								provider: aiProvider,
								baseUrl: aiBaseUrl,
							}
						: undefined,
			},
		);

		console.log("[A2A Send] Received task:", {
			taskId: task.id,
			status: task.status,
			hasArtifacts: !!task.artifacts?.length,
		});

		// Extract response from task
		let responseContent = "";
		let toolCalls: Array<{ name: string; args: unknown; result: unknown }> =
			[];
		let reasoning: string | undefined;

		// Check task messages for the agent response
		if (task.messages && task.messages.length > 0) {
			const lastMessage = task.messages[task.messages.length - 1];
			if (lastMessage.role === "agent" && lastMessage.parts) {
				// Extract text from parts
				for (const part of lastMessage.parts) {
					if (part.type === "text") {
						responseContent += part.text;
					}
					// Check for reasoning in data parts
					if (part.type === "data") {
						const data = part.data as Record<string, unknown>;
						if (
							data.reasoning &&
							typeof data.reasoning === "string"
						) {
							reasoning = data.reasoning;
						}
					}
				}
			}
		}

		// Also check task metadata for reasoning
		if (
			!reasoning &&
			task.metadata?.reasoning &&
			typeof task.metadata.reasoning === "string"
		) {
			reasoning = task.metadata.reasoning;
		}

		// Check artifacts for structured output
		if (task.artifacts && task.artifacts.length > 0) {
			for (const artifact of task.artifacts) {
				if (artifact.parts) {
					for (const part of artifact.parts) {
						if (part.type === "text") {
							// If we don't have response content yet, use the artifact text
							if (!responseContent) {
								responseContent = part.text;
							}
						}
						if (part.type === "data") {
							// Extract tool calls if present in data
							const data = part.data as Record<string, unknown>;
							if (data.toolCalls) {
								toolCalls = data.toolCalls as typeof toolCalls;
							}
						}
					}
				}
			}
		}

		// Fallback: use task status message if no content
		if (!responseContent && task.status === "completed") {
			responseContent = "Task completed successfully.";
		}

		if (!responseContent && task.status === "failed") {
			// Check metadata for error info
			const errorInfo = task.metadata?.error as
				| { message?: string }
				| undefined;
			responseContent =
				errorInfo?.message || "Task failed with unknown error.";
		}

		return NextResponse.json({
			response: responseContent,
			contextId: task.contextId || contextId,
			taskId: task.id,
			status: task.status,
			toolCalls,
			artifacts: task.artifacts,
			reasoning,
		});
	} catch (error) {
		console.error("[A2A Send] Error:", error);

		const errorMessage =
			error instanceof Error
				? error.message
				: "Failed to communicate with agent";

		return NextResponse.json({ error: errorMessage }, { status: 500 });
	}
}
