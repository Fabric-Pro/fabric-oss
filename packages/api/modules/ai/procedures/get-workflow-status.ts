/**
 * Get Workflow Status Procedure
 *
 * Queries the status of a Temporal workflow execution.
 * Useful for tracking progress and debugging.
 */

import { ORPCError } from "@orpc/client";
import { db } from "@repo/database";
import { getTemporalClient, isTemporalAvailable } from "@repo/temporal";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

export const getWorkflowStatus = tenantProtectedProcedure
	.use(requirePermission(Permissions.AI_CHAT))
	.route({
		method: "GET",
		path: "/ai/workflows/{workflowId}/status",
		tags: ["AI"],
		summary: "Get workflow execution status",
		description:
			"Query the status and details of a Temporal workflow execution",
	})
	.input(
		z.object({
			workflowId: z.string(),
		}),
	)
	.output(
		z.object({
			workflowId: z.string(),
			runId: z.string().optional(),
			status: z.string(),
			startTime: z.string().optional(),
			closeTime: z.string().optional(),
			historyLength: z.number().optional(),
			error: z.string().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { workflowId } = input;

		// Ownership guard (SOC 2 CC6.1): bind the queried workflow to a
		// chat the caller owns before describing it. Without this, any
		// authenticated user could read the status of an arbitrary
		// workflowId belonging to another tenant.
		const ownedChat = await db.aiChat.findFirst({
			where: { workflowId, userId: context.user.id },
			select: { id: true },
		});
		if (!ownedChat) {
			throw new ORPCError("NOT_FOUND", {
				message: "Workflow not found",
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
			// Get Temporal client
			const client = await getTemporalClient();

			// Get workflow handle
			const handle = client.workflow.getHandle(workflowId);

			// Describe workflow execution
			const description = await handle.describe();

			return {
				workflowId: description.workflowId,
				runId: description.runId,
				status: description.status.name,
				startTime: description.startTime?.toISOString(),
				closeTime: description.closeTime?.toISOString(),
				historyLength: description.historyLength,
			};
		} catch (error) {
			console.error("[Workflow] Failed to get workflow status:", error);

			// Check if workflow not found
			if (
				error instanceof Error &&
				error.message.includes("workflow execution not found")
			) {
				throw new ORPCError("NOT_FOUND", {
					message: "Workflow not found",
				});
			}

			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: `Failed to get workflow status: ${error instanceof Error ? error.message : "Unknown error"}`,
			});
		}
	});
