/**
 * Workflow Templates - Status Polling API
 *
 * GET endpoint to poll the status of a workflow template execution.
 * Use this as a fallback when SSE streaming is not available.
 */

import type {
	DeepResearcherOutput,
	DeepResearcherProgress,
	SubAgentResult,
} from "@repo/temporal";
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

export async function GET(_request: NextRequest, { params }: RouteParams) {
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
					error: "You are not authorized to view this workflow",
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

			// Base response
			const response: {
				executionId: string;
				workflowStatus: string;
				status?: string;
				progress?: DeepResearcherProgress;
				subAgentResults?: SubAgentResult[];
				result?: DeepResearcherOutput;
				error?: string;
			} = {
				executionId,
				workflowStatus: description.status.name,
			};

			if (description.status.name === "COMPLETED") {
				// Get final result
				const result: DeepResearcherOutput = await handle.result();
				response.status = result.status;
				response.result = result;
			} else if (description.status.name === "FAILED") {
				response.status = "failed";
				try {
					const result: DeepResearcherOutput = await handle.result();
					response.error = result?.error || "Workflow failed";
				} catch (e) {
					response.error =
						e instanceof Error ? e.message : "Workflow failed";
				}
			} else if (description.status.name === "CANCELLED") {
				response.status = "cancelled";
				response.error = "Workflow was cancelled";
			} else if (description.status.name === "RUNNING") {
				response.status = "running";

				// Try to get progress
				try {
					const progress: DeepResearcherProgress =
						await handle.query("progress");
					response.progress = progress;
				} catch {
					// Progress query might not be available
				}

				// Try to get sub-agent results
				try {
					const subResults: SubAgentResult[] =
						await handle.query("subAgentResults");
					response.subAgentResults = subResults;
				} catch {
					// Sub-agent results might not be available
				}
			}

			return new Response(JSON.stringify(response), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
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
		console.error("[Workflow Template Status] Error:", error);
		return new Response(
			JSON.stringify({
				error:
					error instanceof Error
						? error.message
						: "Failed to get status",
			}),
			{
				status: 500,
				headers: { "Content-Type": "application/json" },
			},
		);
	}
}

export const runtime = "nodejs";
