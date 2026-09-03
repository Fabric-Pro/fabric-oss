/**
 * Orchestrator Follow-Up Signal Endpoint
 *
 * Sends follow-up messages to running orchestrator workflows for mid-execution
 * plan modifications or clarifications.
 *
 * @security This endpoint includes:
 * - Session-based authentication
 * - Rate limiting (20 follow-ups per minute)
 * - Execution ID format validation
 * - Message size validation
 */

import { checkRateLimit } from "@repo/api/lib/rate-limit";
import { db } from "@repo/database";
import { getTemporalClient } from "@repo/temporal";
import { getSession } from "@saas/auth/lib/server";
import type { NextRequest } from "next/server";

// Rate limit: 20 follow-up signals per minute per user
const FOLLOW_UP_RATE_LIMIT = { limit: 20, windowMs: 60_000 };

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

		// Rate limiting for follow-up signals
		const rateLimitKey = `orchestrator:follow-up:${userId}`;
		const rateLimitResult = await checkRateLimit(
			rateLimitKey,
			FOLLOW_UP_RATE_LIMIT.limit,
			FOLLOW_UP_RATE_LIMIT.windowMs,
		);

		if (!rateLimitResult.allowed) {
			return new Response(
				JSON.stringify({
					error: "Rate limit exceeded",
					message: `Too many follow-up requests. Please try again in ${rateLimitResult.resetInSeconds} seconds.`,
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

		const {
			executionId,
			message,
			isModification = false,
		} = await request.json();

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

		if (!message || typeof message !== "string") {
			return new Response(
				JSON.stringify({ error: "message (string) is required" }),
				{
					status: 400,
					headers: { "Content-Type": "application/json" },
				},
			);
		}

		// Validate message size (max 50KB)
		if (message.length > 50_000) {
			return new Response(
				JSON.stringify({
					error: "Invalid message",
					message: "Message must be under 50KB",
				}),
				{
					status: 400,
					headers: { "Content-Type": "application/json" },
				},
			);
		}

		// Get Temporal client
		const temporalClient = await getTemporalClient();

		// Get workflow handle and send signal
		const handle = temporalClient.workflow.getHandle(executionId);

		// ✅ Security: Verify ownership and check workflow status
		const description = await handle.describe();
		const memo = description.memo as Record<string, unknown> | undefined;
		const workflowUserId = memo?.userId;
		const workflowOrgId = memo?.organizationId;
		if (workflowUserId && workflowUserId !== userId) {
			return new Response(
				JSON.stringify({
					error: "Forbidden",
					message: "You are not authorized to access this workflow",
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
						message: "You are not a member of this organization",
					}),
					{
						status: 403,
						headers: { "Content-Type": "application/json" },
					},
				);
			}
		}
		if (description.status.name !== "RUNNING") {
			return new Response(
				JSON.stringify({
					error: "Workflow not running",
					message: `Workflow is in ${description.status.name} state and cannot receive follow-ups`,
				}),
				{
					status: 400,
					headers: { "Content-Type": "application/json" },
				},
			);
		}

		await handle.signal("followUp", {
			message,
			isModification,
		});

		console.log("[Orchestrator:FollowUp] Signal sent", {
			executionId,
			isModification,
			userId,
			timestamp: new Date().toISOString(),
		});

		return new Response(
			JSON.stringify({
				success: true,
				executionId,
				isModification,
			}),
			{
				status: 200,
				headers: { "Content-Type": "application/json" },
			},
		);
	} catch (error) {
		console.error("[Orchestrator] Error sending follow-up signal:", error);
		return new Response(
			JSON.stringify({
				error:
					error instanceof Error
						? error.message
						: "Failed to send follow-up",
			}),
			{
				status: 500,
				headers: { "Content-Type": "application/json" },
			},
		);
	}
}

export const runtime = "nodejs";
