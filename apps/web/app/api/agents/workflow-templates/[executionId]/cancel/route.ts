/**
 * Workflow Templates - Cancel API
 *
 * POST endpoint to cancel a running workflow template execution.
 */

import { getTemporalClient } from "@repo/temporal";
import { getSession } from "@saas/auth/lib/server";
import type { NextRequest } from "next/server";

interface RouteParams {
	params: Promise<{
		executionId: string;
	}>;
}

/**
 * Extract userId from executionId.
 * Format: wf-{userId}-{templateSlug}-{uuid}
 */
function extractUserIdFromExecutionId(executionId: string): string | null {
	const parts = executionId.split("-");
	// Format: wf-{userId}-{templateSlug}-{uuid parts...}
	if (parts.length >= 3 && parts[0] === "wf") {
		return parts[1];
	}
	return null;
}

export async function POST(_request: NextRequest, { params }: RouteParams) {
	try {
		const session = await getSession();
		if (!session) {
			return new Response(JSON.stringify({ error: "Unauthorized" }), {
				status: 401,
				headers: { "Content-Type": "application/json" },
			});
		}

		const userId = session.user.id;
		const { executionId } = await params;

		if (!executionId) {
			return new Response(
				JSON.stringify({ error: "executionId is required" }),
				{
					status: 400,
					headers: { "Content-Type": "application/json" },
				},
			);
		}

		// Verify the workflow belongs to the current user
		const workflowUserId = extractUserIdFromExecutionId(executionId);
		if (workflowUserId !== userId) {
			return new Response(
				JSON.stringify({
					error: "You are not authorized to cancel this workflow",
				}),
				{
					status: 403,
					headers: { "Content-Type": "application/json" },
				},
			);
		}

		// Get Temporal client
		const temporalClient = await getTemporalClient();

		try {
			// Get workflow handle
			const handle = temporalClient.workflow.getHandle(executionId);
			const description = await handle.describe();

			// Only cancel if running
			if (description.status.name !== "RUNNING") {
				return new Response(
					JSON.stringify({
						error: `Cannot cancel workflow in ${description.status.name} state`,
						status: description.status.name,
					}),
					{
						status: 400,
						headers: { "Content-Type": "application/json" },
					},
				);
			}

			// Try to send cancel signal first (graceful cancellation)
			try {
				await handle.signal("cancel");
				console.log(
					`[Workflow Template Cancel] Sent cancel signal to: ${executionId}`,
				);
			} catch {
				// Signal might fail if workflow doesn't support it, fall back to cancellation
			}

			// Cancel the workflow
			await handle.cancel();
			console.log(
				`[Workflow Template Cancel] Cancelled workflow: ${executionId}`,
			);

			return new Response(
				JSON.stringify({
					success: true,
					executionId,
					message: "Workflow cancellation requested",
				}),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			);
		} catch (error) {
			// Workflow not found
			if (error instanceof Error && error.message.includes("not found")) {
				return new Response(
					JSON.stringify({
						error: "Workflow not found",
						executionId,
					}),
					{
						status: 404,
						headers: { "Content-Type": "application/json" },
					},
				);
			}
			throw error;
		}
	} catch (error) {
		console.error("[Workflow Template Cancel] Error:", error);
		return new Response(
			JSON.stringify({
				error:
					error instanceof Error
						? error.message
						: "Failed to cancel workflow",
			}),
			{
				status: 500,
				headers: { "Content-Type": "application/json" },
			},
		);
	}
}

export const runtime = "nodejs";
