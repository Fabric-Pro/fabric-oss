import { ORPCError } from "@orpc/client";
import { getAiChatByIdForOwner, updateAiChat } from "@repo/database";
import { getTemporalClient, isTemporalAvailable } from "@repo/temporal";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../organizations/lib/membership";

export const cancelMessageWorkflow = tenantProtectedProcedure
	.use(requirePermission(Permissions.AI_CHAT))
	.route({
		method: "POST",
		path: "/ai/chats/{chatId}/workflows/cancel",
		tags: ["AI"],
		summary: "Cancel running message workflow",
		description:
			"Cancel a running chat message workflow. This will stop the workflow execution.",
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

		// Check if there's a workflow to cancel
		if (!chat.workflowId || !chat.workflowRunId) {
			throw new ORPCError("BAD_REQUEST", {
				message: "No workflow found for this chat",
			});
		}

		// Check if workflow is in a cancellable state
		if (
			chat.workflowStatus !== "RUNNING" &&
			chat.workflowStatus !== "RETRYING"
		) {
			throw new ORPCError("BAD_REQUEST", {
				message: `Cannot cancel workflow in ${chat.workflowStatus} state. Only RUNNING or RETRYING workflows can be cancelled.`,
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

			// Get workflow handle
			const handle = client.workflow.getHandle(
				chat.workflowId,
				chat.workflowRunId,
			);

			// Cancel the workflow
			await handle.cancel();

			console.log(`[Workflow] Cancelled workflow: ${chat.workflowId}`);

			// Update chat status
			await updateAiChat({
				id: chatId,
				workflowStatus: "CANCELLED",
			});

			return {
				success: true,
				workflowId: chat.workflowId,
				runId: chat.workflowRunId,
			};
		} catch (error) {
			console.error("[Workflow] Failed to cancel workflow:", error);
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: `Failed to cancel workflow: ${error instanceof Error ? error.message : "Unknown error"}`,
			});
		}
	});
