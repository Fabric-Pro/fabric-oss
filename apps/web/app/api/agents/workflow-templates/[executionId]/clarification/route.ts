/**
 * Workflow Templates - Clarification API
 *
 * POST endpoint to send a clarification response to a running workflow.
 */

import { getTemporalClient } from "@repo/temporal";
import { getSession } from "@saas/auth/lib/server";
import type { NextRequest } from "next/server";

interface RouteParams {
	params: Promise<{
		executionId: string;
	}>;
}

function extractUserIdFromExecutionId(executionId: string): string | null {
	const parts = executionId.split("-");
	if (parts.length >= 3 && parts[0] === "wf") {
		return parts[1];
	}
	return null;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
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
		const body = await request.json().catch(() => ({}));
		const response =
			typeof body?.response === "string" ? body.response.trim() : "";

		if (!executionId) {
			return new Response(
				JSON.stringify({ error: "executionId is required" }),
				{
					status: 400,
					headers: { "Content-Type": "application/json" },
				},
			);
		}

		if (!response) {
			return new Response(
				JSON.stringify({ error: "response is required" }),
				{
					status: 400,
					headers: { "Content-Type": "application/json" },
				},
			);
		}

		if (extractUserIdFromExecutionId(executionId) !== userId) {
			return new Response(
				JSON.stringify({
					error: "You are not authorized to update this workflow",
				}),
				{
					status: 403,
					headers: { "Content-Type": "application/json" },
				},
			);
		}

		const temporalClient = await getTemporalClient();
		const handle = temporalClient.workflow.getHandle(executionId);
		const description = await handle.describe();

		if (description.status.name !== "RUNNING") {
			return new Response(
				JSON.stringify({
					error: `Cannot send clarification to workflow in ${description.status.name} state`,
				}),
				{
					status: 400,
					headers: { "Content-Type": "application/json" },
				},
			);
		}

		await handle.signal("clarification", response);

		return new Response(
			JSON.stringify({
				success: true,
				executionId,
				message: "Clarification sent",
			}),
			{
				status: 200,
				headers: { "Content-Type": "application/json" },
			},
		);
	} catch (error) {
		console.error("[Workflow Template Clarification] Error:", error);
		return new Response(
			JSON.stringify({
				error:
					error instanceof Error
						? error.message
						: "Failed to send clarification",
			}),
			{
				status: 500,
				headers: { "Content-Type": "application/json" },
			},
		);
	}
}

export const runtime = "nodejs";
