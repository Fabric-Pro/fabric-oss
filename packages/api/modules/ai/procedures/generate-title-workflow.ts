/**
 * Generate Title Workflow Procedure
 *
 * Starts a Temporal workflow to generate a chat title with automatic retries.
 * This is a non-blocking operation - the workflow runs in the background.
 */

import { ORPCError } from "@orpc/client";
import { getAiChatByIdForOwner, updateAiChat } from "@repo/database";
import {
	type ChatTitleGenerationInput,
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

export const generateTitleWorkflow = tenantProtectedProcedure
	.use(requirePermission(Permissions.AI_CHAT))
	.route({
		method: "POST",
		path: "/ai/chats/{chatId}/title/workflow",
		tags: ["AI"],
		summary: "Generate chat title using Temporal workflow",
		description:
			"Starts a durable workflow to generate a chat title with automatic retries",
	})
	.input(
		z.object({
			chatId: z.string(),
			firstMessage: z.string(),
		}),
	)
	.output(
		z.object({
			workflowId: z.string(),
			runId: z.string(),
			success: z.boolean(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { chatId, firstMessage } = input;
		const user = context.user;

		// Check if Temporal is available
		const temporalAvailable = await isTemporalAvailable();
		if (!temporalAvailable) {
			throw new ORPCError("SERVICE_UNAVAILABLE", {
				message: "Temporal workflow service is not available",
			});
		}

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

		try {
			// Get Temporal client
			const client = await getTemporalClient();

			// Create workflow ID (idempotent - same ID for same chat)
			const workflowId = `title-${chatId}`;

			// Prepare workflow input
			// TENANT ISOLATION: Pass organizationId for proper AI model resolution
			const workflowInput: ChatTitleGenerationInput = {
				chatId,
				firstMessage,
				userId: user.id,
				organizationId: chat.organizationId || undefined,
			};

			// Start workflow
			// Use string workflow name to avoid minification issues in production builds
			const handle = await client.workflow.start(
				"chatTitleGenerationWorkflow",
				withCorrelationMemo({
					taskQueue: "ai-chat",
					workflowId,
					args: [workflowInput],
					// Workflow execution timeout (max time for entire workflow)
					workflowExecutionTimeout: "5m",
				}),
			);

			// Update chat with workflow info
			await updateAiChat({
				id: chatId,
				workflowId: handle.workflowId,
				workflowRunId: handle.firstExecutionRunId,
				workflowStatus: "RUNNING",
				retryCount: 0,
				lastError: null,
			});

			console.log(
				`[Workflow] Started title generation workflow: ${handle.workflowId}`,
			);

			return {
				workflowId: handle.workflowId,
				runId: handle.firstExecutionRunId,
				success: true,
			};
		} catch (error) {
			console.error("[Workflow] Failed to start workflow:", error);
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: `Failed to start workflow: ${error instanceof Error ? error.message : "Unknown error"}`,
			});
		}
	});
