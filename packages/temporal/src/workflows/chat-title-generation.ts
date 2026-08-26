/**
 * ChatTitleGenerationWorkflow
 *
 * Durable workflow for generating and saving chat titles with automatic retries.
 * This workflow demonstrates Temporal's durability and retry capabilities.
 *
 * Features:
 * - Automatic retry on transient failures
 * - Exponential backoff
 * - Fallback to truncated message on persistent failures
 * - Complete execution history for debugging
 */

import { ApplicationFailure, log, proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities";
import type {
	ChatTitleGenerationInput,
	ChatTitleGenerationOutput,
} from "../types";

// Configure activity retry policies
const { generateTitle, updateChatTitle, updateWorkflowStatus } =
	proxyActivities<typeof activities>({
		startToCloseTimeout: "30s", // Max time for activity to complete
		heartbeatTimeout: "30 seconds",
		retry: {
			initialInterval: "1s", // First retry after 1 second
			maximumInterval: "30s", // Max wait between retries
			backoffCoefficient: 2, // Double wait time each retry
			maximumAttempts: 5, // Max 5 attempts
		},
	});

/**
 * ChatTitleGenerationWorkflow
 *
 * Generates a title for a chat using AI and saves it to the database.
 * Handles failures gracefully with automatic retries and fallback logic.
 *
 * @param input - Workflow input containing chatId, firstMessage, and userId
 * @returns Workflow output with success status and generated title
 */
export async function chatTitleGenerationWorkflow(
	input: ChatTitleGenerationInput,
): Promise<ChatTitleGenerationOutput> {
	const { chatId, firstMessage, userId, organizationId } = input;

	log.info("Starting chat title generation workflow", {
		chatId,
		userId,
		organizationId,
		messagePreview: firstMessage.substring(0, 50),
	});

	let title: string | undefined;
	let error: string | undefined;

	try {
		// Step 1: Generate title using AI (with automatic retries)
		log.info("Generating title with AI");
		try {
			title = await generateTitle(firstMessage, {
				userId,
				organizationId,
			});
			log.info("Title generated successfully", { title });
		} catch (titleError) {
			// If title generation fails after all retries, use fallback
			log.warn("Title generation failed, using fallback", {
				error:
					titleError instanceof Error
						? titleError.message
						: "Unknown error",
			});
			title = firstMessage.substring(0, 50);
			if (title.length === 50) {
				title += "...";
			}
		}

		// Step 2: Update chat with generated title (with automatic retries)
		log.info("Updating chat title in database");
		await updateChatTitle(chatId, title);
		log.info("Chat title updated successfully");

		// Step 3: Update workflow status to COMPLETED
		log.info("Updating workflow status to COMPLETED");
		await updateWorkflowStatus(
			chatId,
			"workflow-id-placeholder", // Will be replaced by actual workflow ID
			"run-id-placeholder", // Will be replaced by actual run ID
			"COMPLETED",
		);

		return {
			success: true,
			title,
		};
	} catch (workflowError) {
		// Workflow failed after all retries
		error =
			workflowError instanceof Error
				? workflowError.message
				: "Unknown error";

		log.error("Workflow failed", { error });

		// Try to update workflow status to FAILED (best effort)
		try {
			await updateWorkflowStatus(
				chatId,
				"workflow-id-placeholder",
				"run-id-placeholder",
				"FAILED",
			);
		} catch {
			// Ignore errors when updating status
		}

		throw ApplicationFailure.nonRetryable(
			error,
			"CHAT_TITLE_GENERATION_FAILED",
		);
	}
}
