/**
 * Orchestrator Cancel Endpoint
 *
 * Cancels running orchestrator workflows.
 * Used when UI detects a stalled workflow (e.g., worker not running).
 *
 * @security This endpoint includes:
 * - Session-based authentication
 * - Rate limiting (10 cancel requests per minute)
 * - Execution ID format validation
 * - Audit logging of cancellation
 */

import { checkRateLimit } from "@repo/api/lib/rate-limit";
import { db } from "@repo/database";
import { getTemporalClient } from "@repo/temporal";
import { getSession } from "@saas/auth/lib/server";
import type { NextRequest } from "next/server";

// Rate limit: 10 cancel requests per minute per user
const CANCEL_RATE_LIMIT = { limit: 10, windowMs: 60_000 };

export async function POST(request: NextRequest) {
	try {
		const session = await getSession();
		if (!session) {
			return new Response(JSON.stringify({ error: "Unauthorized" }), {
				status: 401,
				headers: { "Content-Type": "application/json" },
			});
		}

		const userId = session.user.id;

		// Rate limiting for cancel requests
		const rateLimitKey = `orchestrator:cancel:${userId}`;
		const rateLimitResult = await checkRateLimit(
			rateLimitKey,
			CANCEL_RATE_LIMIT.limit,
			CANCEL_RATE_LIMIT.windowMs,
		);

		if (!rateLimitResult.allowed) {
			return new Response(
				JSON.stringify({
					error: "Rate limit exceeded",
					message: `Too many cancel requests. Please try again in ${rateLimitResult.resetInSeconds} seconds.`,
					retryAfter: rateLimitResult.resetInSeconds,
				}),
				{
					status: 429,
					headers: {
						"Content-Type": "application/json",
						"Retry-After":
							rateLimitResult.resetInSeconds.toString(),
					},
				},
			);
		}

		const { executionId, reason } = await request.json();

		if (!executionId) {
			return new Response(
				JSON.stringify({ error: "executionId is required" }),
				{
					status: 400,
					headers: { "Content-Type": "application/json" },
				},
			);
		}

		// Validate executionId format to prevent injection
		const executionIdPattern = /^orch-[a-f0-9-]{36}$/;
		if (!executionIdPattern.test(executionId)) {
			return new Response(
				JSON.stringify({ error: "Invalid executionId format" }),
				{
					status: 400,
					headers: { "Content-Type": "application/json" },
				},
			);
		}

		// Get Temporal client
		const temporalClient = await getTemporalClient();

		// Get workflow handle
		const handle = temporalClient.workflow.getHandle(executionId);

		// ✅ Security: Verify ownership and check if workflow is still running
		try {
			const description = await handle.describe();
			const memo = description.memo as
				| Record<string, unknown>
				| undefined;
			const workflowUserId = memo?.userId;
			const workflowOrgId = memo?.organizationId;
			if (workflowUserId && workflowUserId !== userId) {
				return new Response(
					JSON.stringify({
						error: "Forbidden",
						message:
							"You are not authorized to cancel this workflow",
					}),
					{
						status: 403,
						headers: { "Content-Type": "application/json" },
					},
				);
			}
			if (workflowOrgId) {
				const member = await db.member.findFirst({
					where: { userId, organizationId: workflowOrgId as string },
				});
				if (!member) {
					return new Response(
						JSON.stringify({
							error: "Forbidden",
							message:
								"You are not a member of this organization",
						}),
						{
							status: 403,
							headers: { "Content-Type": "application/json" },
						},
					);
				}
			}
			if (description.status.name !== "RUNNING") {
				// Workflow already completed/failed/cancelled
				return new Response(
					JSON.stringify({
						success: true,
						executionId,
						message: `Workflow already ${description.status.name.toLowerCase()}`,
						alreadyTerminated: true,
					}),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				);
			}
		} catch {
			// Workflow not found - treat as already cancelled
			return new Response(
				JSON.stringify({
					success: true,
					executionId,
					message: "Workflow not found or already terminated",
					alreadyTerminated: true,
				}),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			);
		}

		// Cancel the workflow
		await handle.cancel();

		// Audit log the cancellation
		console.log("[Orchestrator:Audit] Workflow cancelled", {
			executionId,
			cancelledBy: userId,
			reason: reason || "timeout",
			timestamp: new Date().toISOString(),
		});

		return new Response(
			JSON.stringify({
				success: true,
				executionId,
				message: "Workflow cancelled",
			}),
			{
				status: 200,
				headers: { "Content-Type": "application/json" },
			},
		);
	} catch (error) {
		console.error("[Orchestrator] Error cancelling workflow:", error);
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
