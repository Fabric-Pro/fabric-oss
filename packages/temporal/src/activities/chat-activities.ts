/**
 * Activities for chat message processing
 * Activities are non-deterministic operations that can fail and be retried
 */

import {
	convertToModelMessages,
	getAIModelWithMetadata,
	logModelUsageAsync,
	streamText,
} from "@repo/ai";
import { getAiChatById } from "@repo/database";
import { createAgentReplyReadyNotifications } from "@repo/database/prisma/queries/agent-reply-notifications";
import { updateAiChat } from "@repo/database/prisma/queries/ai-chats";
import { Context } from "@temporalio/activity";
import {
	classifyPayloadSize,
	measureSerializedBytes,
	PAYLOAD_WARN_BYTES,
} from "../lib/payload-size-guard";

/**
 * Message type for activities (simplified from UIMessage)
 */
interface ActivityMessage {
	id?: string;
	role: "user" | "assistant" | "system";
	parts: Array<{ type: string; text: string }>;
}

/**
 * Generate AI response and save to database
 * This is the core activity that calls the AI API and persists the result
 *
 * @param chatId - Chat ID to update
 * @param messages - All messages in the conversation
 * @param modelOverride - AI model to use (optional, will use dynamic selection if not provided)
 * @returns The AI assistant's response text
 * @throws Error if AI generation or database save fails
 */
export async function streamAndSaveMessage(
	chatId: string,
	messages: ActivityMessage[],
	modelOverride?: string,
): Promise<string> {
	console.log("[Activity] Generating AI response for chat:", chatId);

	// The conversation history is this activity's argument and crosses the
	// gRPC frame at SCHEDULING time — by the time the body runs it already
	// fit. An oversized history therefore fails before any code here could
	// throw, so all this can do is make the approach visible (#1997): warn
	// well before the frame so a growing chat is acted on, not discovered.
	const bytes = measureSerializedBytes(messages);
	if (bytes > PAYLOAD_WARN_BYTES) {
		console.warn(
			`[Activity] Chat ${chatId} history nears the Temporal frame: ${bytes} bytes (${classifyPayloadSize(bytes)}); ` +
				"history should move to pass-by-reference before it stops scheduling",
		);
	}

	try {
		// Internal activity — trusts its workflow caller. The calling
		// procedure (addMessageToChat / retryFailedMessage / …) has
		// already enforced per-user ownership via getAiChatByIdForOwner
		// before signalling us.
		const chat = await getAiChatById(chatId);
		if (!chat) {
			throw new Error(`Chat not found: ${chatId}`);
		}
		if (!chat.userId) {
			throw new Error(
				`Chat ${chatId} has no userId - cannot resolve AI provider`,
			);
		}

		const userId = chat.userId;
		const organizationId = chat.organizationId ?? undefined;

		// Get model using centralized single entry point (with optional override)
		// This is where the chat answer is actually generated. The API routes
		// that start this workflow also resolve a model, but only to hit the
		// usage-limit chokepoint — they never generate — so tagging them would
		// record a feature key against a call that never happens.
		const { model, metadata, trackUsage } = await getAIModelWithMetadata(
			{ taskType: "CHAT", modelOverride },
			{ userId, organizationId, featureKey: "chat-agent" },
		);

		console.log(
			"[Activity] Using model:",
			metadata.modelString,
			"provider:",
			metadata.provider,
		);

		// Convert messages to UIMessage format (add IDs if missing)
		const uiMessages = messages.map((msg, index) => ({
			...msg,
			id: msg.id ?? `msg-${index}`,
			parts: msg.parts.map((part) => ({
				...part,
				type: part.type as "text", // Cast to specific type
			})),
		}));

		// Call AI API to generate response
		const generationStart = Date.now();
		const response = streamText({
			model,
			messages: await convertToModelMessages(uiMessages as any), // Type cast for compatibility
		});

		// Wait for the full response
		const result = await response;
		const text = await result.text;
		const usage = await result.usage;

		console.log("[Activity] AI response generated, length:", text.length);

		// Track successful usage
		trackUsage();
		logModelUsageAsync({
			context: { userId, organizationId },
			metadata,
			taskType: "CHAT",
			usage,
			latencyMs: Date.now() - generationStart,
			conversationId: chatId,
			projectId: chat.projectId ?? undefined,
		});

		// Save the updated messages to database
		const updatedMessages = [
			...messages,
			{
				role: "assistant" as const,
				parts: [{ type: "text", text }],
			},
		];

		await updateAiChat({
			id: chatId,
			messages: updatedMessages,
		});

		console.log("[Activity] Messages saved to database");

		// Fire-and-forget notification fan-out for the chat initiator. Lives in
		// `@repo/database` (not `@repo/api`) because `@repo/api` depends on
		// `@repo/temporal`, so the API-side `fanOut.agentReplyReady` can't be
		// imported here without a workspace cycle. Keep this in lock-step with
		// `fanOut.agentReplyReady` in notification-service.ts.
		//
		// TODO(presence): no in-process presence signal is available from a
		// Temporal worker — duplicate visibility is better than missed
		// visibility, so we always fire here. Wire a presence channel (e.g.
		// Redis-backed) into createAgentReplyReadyNotifications if/when needed.
		// Only emit when the chat is project-attached: the notification's link
		// and payload presume a project context. Detached chats (no projectId)
		// don't surface in the project chat panel, so a bell ping has nowhere
		// useful to land.
		if (chat.projectId) {
			try {
				// activity.info().workflowExecution.workflowId is the durable
				// id of the workflow run for this assistant turn — exactly one
				// notification per run via the `agentReply:${runId}` dedupe
				// key.
				const workflowId =
					Context.current().info.workflowExecution.workflowId;
				void createAgentReplyReadyNotifications({
					runId: workflowId,
					recipientUserId: userId,
					organizationId: chat.organizationId ?? null,
					agentName: chat.title?.trim() || "Assistant",
					finalMessage: text,
					link: `app/chats/${chatId}?project=${chat.projectId}`,
					projectId: chat.projectId,
				}).catch((error) => {
					console.warn(
						"[Activity] agentReplyReady notification dispatch failed:",
						error,
					);
				});
			} catch (error) {
				console.warn(
					"[Activity] agentReplyReady notification dispatch failed:",
					error,
				);
			}
		}

		return text;
	} catch (error) {
		console.error("[Activity] Failed to generate or save message:", error);
		throw new Error(
			`Failed to generate AI response: ${error instanceof Error ? error.message : "Unknown error"}`,
		);
	}
}

/**
 * Update chat metadata (timestamps, etc.)
 * This operation is idempotent - can be safely retried
 *
 * @param chatId - Chat ID to update
 * @throws Error if database update fails
 */
export async function updateChatMetadata(chatId: string): Promise<void> {
	console.log("[Activity] Updating chat metadata:", chatId);

	try {
		// The updatedAt timestamp is automatically updated by Prisma
		// This is a placeholder for any additional metadata updates
		await updateAiChat({
			id: chatId,
			// Could add additional metadata here in the future
		});
		console.log("[Activity] Chat metadata updated successfully");
	} catch (error) {
		console.error("[Activity] Failed to update chat metadata:", error);
		throw new Error(
			`Failed to update chat metadata: ${error instanceof Error ? error.message : "Unknown error"}`,
		);
	}
}
