/**
 * Activities for chat title generation
 * Activities are non-deterministic operations that can fail and be retried
 */

import { generateChatTitle } from "@repo/ai/lib/title-generator";
import { updateAiChat } from "@repo/database/prisma/queries/ai-chats";

/**
 * Context for title generation in Temporal activities
 */
export interface TitleGenerationActivityContext {
	userId: string;
	organizationId?: string;
	projectId?: string;
}

/**
 * Generate a chat title using AI
 *
 * @param firstMessage - The first user message in the chat
 * @param context - Context for dynamic model selection (required for AI model resolution)
 * @returns Generated title
 * @throws Error if title generation fails
 */
export async function generateTitle(
	firstMessage: string,
	context: TitleGenerationActivityContext,
): Promise<string> {
	console.log(
		"[Activity] Generating title for message:",
		firstMessage.substring(0, 50),
	);

	try {
		const title = await generateChatTitle(firstMessage, context);
		console.log("[Activity] Generated title:", title);
		return title;
	} catch (error) {
		console.error("[Activity] Failed to generate title:", error);
		throw new Error(
			`Failed to generate title: ${error instanceof Error ? error.message : "Unknown error"}`,
		);
	}
}

/**
 * Update chat title in database
 * This operation is idempotent - can be safely retried
 *
 * @param chatId - Chat ID to update
 * @param title - New title
 * @throws Error if database update fails
 */
export async function updateChatTitle(
	chatId: string,
	title: string,
): Promise<void> {
	console.log("[Activity] Updating chat title:", chatId, title);

	try {
		await updateAiChat({
			id: chatId,
			title,
		});
		console.log("[Activity] Chat title updated successfully");
	} catch (error) {
		console.error("[Activity] Failed to update chat title:", error);
		throw new Error(
			`Failed to update chat title: ${error instanceof Error ? error.message : "Unknown error"}`,
		);
	}
}

/**
 * Update workflow status in database
 *
 * @param chatId - Chat ID to update
 * @param workflowId - Workflow ID
 * @param workflowRunId - Workflow run ID
 * @param status - Workflow status
 * @param error - Optional error message
 */
export async function updateWorkflowStatus(
	chatId: string,
	workflowId: string,
	workflowRunId: string,
	status: "RUNNING" | "COMPLETED" | "FAILED" | "RETRYING" | "CANCELLED",
	error?: string,
): Promise<void> {
	console.log("[Activity] Updating workflow status:", chatId, status);

	try {
		await updateAiChat({
			id: chatId,
			workflowId,
			workflowRunId,
			workflowStatus: status,
			lastError: error,
			lastRetryAt: status === "RETRYING" ? new Date() : undefined,
		});
		console.log("[Activity] Workflow status updated successfully");
	} catch (error) {
		console.error("[Activity] Failed to update workflow status:", error);
		// Don't throw - this is a non-critical operation
	}
}
