import { ORPCError } from "@orpc/client";
import { getAiChatByIdForOwner } from "@repo/database";
import {
	type ChatMessageInput,
	getTemporalClient,
	isTemporalAvailable,
} from "@repo/temporal";
import { z } from "zod";
import { withCorrelationMemo } from "../../../lib/temporal-correlation";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../organizations/lib/membership";

export const retryFailedMessage = tenantProtectedProcedure
	.use(requirePermission(Permissions.AI_CHAT))
	.route({
		method: "POST",
		path: "/ai/chats/{chatId}/workflows/retry",
		tags: ["AI"],
		summary: "Retry failed message workflow",
		description:
			"Manually retry a failed chat message workflow. This will restart the workflow from the beginning.",
	})
	.input(
		z.object({
			chatId: z.string(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { chatId } = input;
		const user = context.user;

		// Per-user ownership — helper rejects any chat the caller does
		// not own, even across org members.
		const chat = await getAiChatByIdForOwner(chatId, user.id);

		if (!chat) {
			throw new ORPCError("NOT_FOUND", { message: "Chat not found" });
		}

		if (chat.organizationId) {
			const membership = await verifyOrganizationMembership(
				chat.organizationId,
				user.id,
			);

			if (!membership) {
				throw new ORPCError("FORBIDDEN", {
					message: "Not a member of this organization",
				});
			}
		}

		// Check if workflow is in a failed state
		if (chat.workflowStatus !== "FAILED") {
			throw new ORPCError("BAD_REQUEST", {
				message: `Cannot retry workflow in ${chat.workflowStatus} state. Only FAILED workflows can be retried.`,
			});
		}

		// Check if Temporal is available
		const temporalAvailable = await isTemporalAvailable();
		if (!temporalAvailable) {
			throw new ORPCError("SERVICE_UNAVAILABLE", {
				message: "Temporal workflow service is not available",
			});
		}

		try {
			const client = await getTemporalClient();

			// Extract the last user message and all messages from the chat
			const messages = chat.messages as Array<{
				role: "user" | "assistant";
				parts: Array<{ type: string; text: string }>;
			}>;

			if (messages.length === 0) {
				throw new ORPCError("BAD_REQUEST", {
					message: "No messages found in chat",
				});
			}

			// Find the last user message
			const lastUserMessage = messages
				.filter((m) => m.role === "user")
				.pop();

			if (!lastUserMessage) {
				throw new ORPCError("BAD_REQUEST", {
					message: "No user messages found in chat",
				});
			}

			const userMessageText = lastUserMessage.parts
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join(" ");

			// Create new workflow ID with retry suffix
			const retryCount = (chat.retryCount || 0) + 1;
			const workflowId = `message-${chatId}-retry-${retryCount}`;

			// Send only the tail of the conversation (Fizzy #1997). The whole
			// history travels to the worker inside ONE gRPC message, hard
			// capped at 4 MiB, and an oversized workflow input is rejected at
			// scheduling — before any activity code runs, so nothing
			// downstream can catch it. A long-lived chat accumulates a
			// permanent RAG-context system message per retrieval turn, so the
			// history grows without bound even when each message is small.
			// The model only needs recent turns to continue a conversation.
			const RETRY_HISTORY_MESSAGE_LIMIT = 60;
			const recentMessages =
				messages.length > RETRY_HISTORY_MESSAGE_LIMIT
					? messages.slice(-RETRY_HISTORY_MESSAGE_LIMIT)
					: messages;

			const workflowInput: ChatMessageInput = {
				chatId,
				userId: user.id,
				userMessage: userMessageText,
				model: undefined, // Use default model
				organizationId: chat.organizationId || undefined,
				allMessages: recentMessages,
			};

			// Start the workflow
			// Use string workflow name to avoid minification issues in production builds
			const handle = await client.workflow.start(
				"chatMessageWorkflow",
				withCorrelationMemo({
					taskQueue: "ai-chat",
					workflowId,
					args: [workflowInput],
					workflowExecutionTimeout: "10m",
				}),
			);

			console.log(
				`[Workflow] Started retry workflow: ${workflowId} (attempt ${retryCount})`,
			);

			return {
				success: true,
				workflowId: handle.workflowId,
				runId: handle.firstExecutionRunId,
				retryCount,
			};
		} catch (error) {
			console.error("[Workflow] Failed to start retry workflow:", error);
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: `Failed to start retry workflow: ${error instanceof Error ? error.message : "Unknown error"}`,
			});
		}
	});
