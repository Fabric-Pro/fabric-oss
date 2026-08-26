/**
 * Direct Chat Cancel Endpoint
 *
 * Cancels a running `directChatWorkflow` (the Temporal workflow started by
 * `apps/web/app/api/agents/fabric-ai/stream/route.ts`).
 *
 * Used when the user clicks Stop on a direct-chat surface (Fabric Agent
 * launcher, Loom Direct chat, Nexus per-agent stream). Mirrors the
 * orchestrator-temporal cancel route line-for-line — same auth, ownership,
 * already-terminated handling, and 401/403/429/500 paths.
 *
 * Workflow id format
 * ------------------
 * The stream route at `apps/web/app/api/agents/fabric-ai/stream/route.ts`
 * builds the executionId as `direct-chat-${uuidv4()}` (line 561 of that
 * file). uuidv4 produces 36 lowercase characters of `[a-f0-9-]`, so the
 * pattern below validates the full id end-to-end.
 *
 * @security This endpoint includes:
 * - Session-based authentication
 * - Rate limiting (10 cancel requests per minute per user)
 * - Execution ID format validation
 * - Ownership verification via Temporal workflow memo (userId, organizationId)
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
		const rateLimitKey = `direct-chat:cancel:${userId}`;
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
		// Format: `direct-chat-<uuidv4>` (see header comment for derivation)
		const executionIdPattern = /^direct-chat-[a-f0-9-]{36}$/;
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
			// Fail-closed if memo is missing entirely. The producer route
			// (apps/web/app/api/agents/fabric-ai/stream/route.ts) attaches
			// memo on every workflow start; an absent memo means the
			// workflow predates this code or was started outside the
			// expected path — refuse to cancel rather than skip the check.
			if (!memo || !workflowUserId) {
				return new Response(
					JSON.stringify({
						error: "Forbidden",
						message:
							"This workflow is missing tenant context and cannot be cancelled by this route",
					}),
					{
						status: 403,
						headers: { "Content-Type": "application/json" },
					},
				);
			}
			if (workflowUserId !== userId) {
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
		console.log(
			`[DirectChat:Audit] Workflow cancelled: executionId=${executionId}, cancelledBy=${userId}, reason=${reason || "user_clicked_stop"}, timestamp=${new Date().toISOString()}`,
		);

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
		console.error("[DirectChat] Error cancelling workflow:", error);
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
