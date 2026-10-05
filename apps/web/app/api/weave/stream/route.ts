/**
 * Weave Execution Stream API (SSE)
 *
 * Server-Sent Events endpoint for real-time weave execution monitoring.
 * Streams progress updates from the orchestrator workflow.
 *
 * Query params:
 * - executionId: WeaveExecution record ID
 */

import { ORPCError } from "@orpc/client";
import { assertRowInAuthorizedOrganization } from "@repo/api/modules/weave/lib/plan-organization";
import { createWeaveExecutionStream } from "@repo/api/modules/weave/procedures/stream-execution";
import {
	assertProjectPermission,
	Permissions,
} from "@repo/api/orpc/procedures";
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

	const notFound = () =>
		new Response(JSON.stringify({ error: "Execution not found" }), {
			status: 404,
			headers: { "Content-Type": "application/json" },
		});

	// The caller's own execution, loaded by id and creator only — the same
	// lookup as `getExecution`. `startExecution` stamps an execution with its
	// AUTHORIZED project's organization (Fizzy #2904), which is not the
	// session's for a project guest or for a member whose active organization
	// is another; filtering on the session's would hide the caller's own run.
	const execution = await db.weaveExecution.findFirst({
		where: { id: executionId, userId },
		select: {
			id: true,
			workflowId: true,
			status: true,
			projectId: true,
			organizationId: true,
		},
	});

	if (!execution) {
		return notFound();
	}

	// Then the project, as `getExecution` authorizes it: the caller must still
	// be allowed to read its agents, and the row must be in the project's
	// organization (`lib/plan-organization.ts`). A caller-named organization
	// other than the project's is refused, as the resolvers refuse it.
	try {
		const authorized = await assertProjectPermission(
			execution.projectId,
			userId,
			Permissions.AGENT_READ,
		);
		assertRowInAuthorizedOrganization(
			request.nextUrl.searchParams.get("organizationId"),
			execution,
			authorized,
		);
	} catch (error) {
		if (error instanceof ORPCError) {
			return error.code === "BAD_REQUEST"
				? new Response(JSON.stringify({ error: error.message }), {
						status: 400,
						headers: { "Content-Type": "application/json" },
					})
				: notFound();
		}
		throw error;
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
