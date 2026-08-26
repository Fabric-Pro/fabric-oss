/**
 * ChatMessageWorkflow
 *
 * Durable workflow for processing AI chat messages with automatic retries.
 * This workflow orchestrates the complete message lifecycle:
 * 1. Generate AI response
 * 2. Save messages to database
 * 3. Generate title for first message (if needed)
 * 4. Update workflow status
 *
 * Features:
 * - Automatic retry on transient failures (network, API rate limits, database)
 * - Exponential backoff for retries
 * - Idempotent operations (safe to retry)
 * - Complete execution history for debugging
 * - Graceful error handling with fallbacks
 */

import {
	ApplicationFailure,
	log,
	proxyActivities,
	workflowInfo,
} from "@temporalio/workflow";
import type * as activities from "../activities";
import type { ChatMessageInput, ChatMessageOutput } from "../types";

// Configure activity retry policies
const {
	streamAndSaveMessage,
	updateChatMetadata,
	generateTitle,
	updateChatTitle,
	updateWorkflowStatus,
} = proxyActivities<typeof activities>({
	startToCloseTimeout: "2m", // Max time for activity to complete (longer for AI calls)
	heartbeatTimeout: "30 seconds",
	retry: {
		initialInterval: "2s", // First retry after 2 seconds
		maximumInterval: "60s", // Max wait between retries (1 minute)
		backoffCoefficient: 2, // Double wait time each retry
		maximumAttempts: 5, // Max 5 attempts
	},
});

/**
 * ChatMessageWorkflow
 *
 * Processes a chat message with durability and automatic retries.
 * Handles the complete lifecycle from AI generation to database persistence.
 *
 * @param input - Workflow input containing chat details and messages
 * @returns Workflow output with success status and generated content
 */
export async function chatMessageWorkflow(
	input: ChatMessageInput,
): Promise<ChatMessageOutput> {
	const { chatId, userId, userMessage, model, allMessages, organizationId } =
		input;
	const { workflowId, runId } = workflowInfo();

	log.info("Starting chat message workflow", {
		chatId,
		userId,
		model,
		messageCount: allMessages.length,
		workflowId,
		runId,
	});

	let assistantMessage: string | undefined;
	let title: string | undefined;
	let error: string | undefined;

	try {
		// Update workflow status to RUNNING
		log.info("Updating workflow status to RUNNING");
		await updateWorkflowStatus(chatId, workflowId, runId, "RUNNING");

		// Step 1: Generate AI response and save to database
		log.info("Generating AI response and saving to database");
		try {
			assistantMessage = await streamAndSaveMessage(
				chatId,
				allMessages,
				model,
			);
			log.info("AI response generated and saved", {
				responseLength: assistantMessage.length,
			});
		} catch (messageError) {
			log.error("Failed to generate or save AI response", {
				error:
					messageError instanceof Error
						? messageError.message
						: "Unknown error",
			});
			throw messageError; // Re-throw to trigger workflow failure
		}

		// Step 2: Generate title if this is the first message exchange
		const isFirstMessage =
			allMessages.length === 1 && allMessages[0].role === "user";

		if (isFirstMessage) {
			log.info("First message detected, generating title");
			try {
				// Try to generate title with AI
				title = await generateTitle(userMessage, {
					userId,
					organizationId,
				});
				log.info("Title generated successfully", { title });

				// Save title to database
				await updateChatTitle(chatId, title);
				log.info("Title saved to database");
			} catch (titleError) {
				// If title generation fails, use fallback (truncated message)
				log.warn("Title generation failed, using fallback", {
					error:
						titleError instanceof Error
							? titleError.message
							: "Unknown error",
				});

				title = userMessage.substring(0, 50);
				if (title.length === 50) {
					title += "...";
				}

				// Try to save fallback title
				try {
					await updateChatTitle(chatId, title);
					log.info("Fallback title saved to database");
				} catch (fallbackError) {
					// If even fallback fails, log but don't fail the workflow
					log.warn("Failed to save fallback title", {
						error:
							fallbackError instanceof Error
								? fallbackError.message
								: "Unknown error",
					});
				}
			}
		}

		// Step 3: Update chat metadata (timestamps, etc.)
		log.info("Updating chat metadata");
		try {
			await updateChatMetadata(chatId);
			log.info("Chat metadata updated successfully");
		} catch (metadataError) {
			// Non-critical operation, log but don't fail
			log.warn("Failed to update chat metadata", {
				error:
					metadataError instanceof Error
						? metadataError.message
						: "Unknown error",
			});
		}

		// Step 4: Update workflow status to COMPLETED
		log.info("Updating workflow status to COMPLETED");
		await updateWorkflowStatus(chatId, workflowId, runId, "COMPLETED");

		log.info("Chat message workflow completed successfully", {
			chatId,
			hasTitle: !!title,
		});

		return {
			success: true,
			assistantMessage,
			title,
		};
	} catch (workflowError) {
		// Workflow failed after all retries
		error =
			workflowError instanceof Error
				? workflowError.message
				: "Unknown error";

		log.error("Chat message workflow failed", { error, chatId });

		// Try to update workflow status to FAILED (best effort)
		try {
			await updateWorkflowStatus(chatId, workflowId, runId, "FAILED");
		} catch (statusError) {
			// Ignore errors when updating status
			log.warn("Failed to update workflow status to FAILED", {
				error:
					statusError instanceof Error
						? statusError.message
						: "Unknown error",
			});
		}

		throw ApplicationFailure.nonRetryable(error, "CHAT_MESSAGE_FAILED");
	}
}
