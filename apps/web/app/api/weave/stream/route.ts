/**
 * Weave Execution Stream API (SSE)
 *
 * Server-Sent Events endpoint for real-time weave execution monitoring.
 * Streams progress updates from the orchestrator workflow.
 *
 * Query params:
 * - executionId: WeaveExecution record ID
 */

import { createWeaveExecutionStream } from "@repo/api/modules/weave/procedures/stream-execution";
import { db } from "@repo/database";
import { getSession } from "@saas/auth/lib/server";
import type { NextRequest } from "next/server";

export async function GET(request: NextRequest) {
	const session = await getSession();
	if (!session?.user?.id) {
		return new Response(JSON.stringify({ error: "Unauthorized" }), {
			status: 401,
			headers: { "Content-Type": "application/json" },
		});
	}

	const executionId = request.nextUrl.searchParams.get("executionId");
	if (!executionId) {
		return new Response(
			JSON.stringify({ error: "executionId is required" }),
			{ status: 400, headers: { "Content-Type": "application/json" } },
		);
	}

	const userId = session.user.id;

	// Accept organizationId from query param, but validate against session.
	// This prevents stale session.activeOrganizationId when user has multiple
	// tabs open in different org contexts.
	const queryOrgId = request.nextUrl.searchParams.get("organizationId");
	const sessionOrgId = session.session?.activeOrganizationId ?? null;
	const organizationId =
		queryOrgId && queryOrgId === sessionOrgId ? queryOrgId : sessionOrgId;

	// Verify access to this execution with XOR tenant isolation
	const execution = await db.weaveExecution.findFirst({
		where: {
			id: executionId,
			userId,
			...(organizationId ? { organizationId } : { organizationId: null }),
		},
		select: {
			id: true,
			workflowId: true,
			status: true,
		},
	});

	if (!execution) {
		return new Response(JSON.stringify({ error: "Execution not found" }), {
			status: 404,
			headers: { "Content-Type": "application/json" },
		});
	}

	// If already in a terminal state, return a single-shot event
	if (["COMPLETED", "FAILED", "CANCELLED"].includes(execution.status)) {
		const full = await db.weaveExecution.findUnique({
			where: { id: executionId },
			select: {
				status: true,
				error: true,
				artifacts: true,
				checkboxes: true,
				currentStep: true,
			},
		});

		const event =
			execution.status === "COMPLETED"
				? "weave.completed"
				: execution.status === "FAILED"
					? "weave.failed"
					: "weave.cancelled";

		const body = `event: ${event}\ndata: ${JSON.stringify({
			status: full?.status,
			error: full?.error,
			artifacts: full?.artifacts,
			checkboxes: full?.checkboxes,
			currentStep: full?.currentStep,
		})}\n\n`;

		return new Response(body, {
			headers: {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
			},
		});
	}

	// Support reconnect: Last-Event-ID tells us the client's last seen event
	const lastEventId = request.headers.get("Last-Event-ID") ?? undefined;

	// Create live SSE stream
	const stream = createWeaveExecutionStream(
		execution.id,
		execution.workflowId,
		lastEventId,
	);

	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		},
	});
}
