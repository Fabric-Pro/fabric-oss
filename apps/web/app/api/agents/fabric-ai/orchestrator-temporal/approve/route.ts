/**
 * Orchestrator Approval Signal Endpoint
 *
 * Sends approval/rejection signals to running orchestrator workflows.
 *
 * @security This endpoint includes:
 * - Session-based authentication
 * - Rate limiting (10 approval signals per minute)
 * - Execution ID format validation
 * - Audit logging of approval decisions
 */

import { checkRateLimit } from "@repo/api/lib/rate-limit";
import { db } from "@repo/database";
import { getTemporalClient } from "@repo/temporal";
import { getSession } from "@saas/auth/lib/server";
import type { NextRequest } from "next/server";

// Rate limit: 10 approval signals per minute per user
const APPROVAL_RATE_LIMIT = { limit: 10, windowMs: 60_000 };

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

		// ✅ Security: Rate limiting for approval signals
		const rateLimitKey = `orchestrator:approve:${userId}`;
		const rateLimitResult = await checkRateLimit(
			rateLimitKey,
			APPROVAL_RATE_LIMIT.limit,
			APPROVAL_RATE_LIMIT.windowMs,
		);

		if (!rateLimitResult.allowed) {
			return new Response(
				JSON.stringify({
					error: "Rate limit exceeded",
					message: `Too many approval requests. Please try again in ${rateLimitResult.resetInSeconds} seconds.`,
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

		const { executionId, approved, feedback } = await request.json();

		if (!executionId) {
			return new Response(
				JSON.stringify({ error: "executionId is required" }),
				{
					status: 400,
					headers: { "Content-Type": "application/json" },
				},
			);
		}

		// ✅ Security: Validate executionId format to prevent injection
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

		if (typeof approved !== "boolean") {
			return new Response(
				JSON.stringify({ error: "approved (boolean) is required" }),
				{
					status: 400,
					headers: { "Content-Type": "application/json" },
				},
			);
		}

		// ✅ Security: Validate feedback size if provided
		if (
			feedback &&
			(typeof feedback !== "string" || feedback.length > 10_000)
		) {
			return new Response(
				JSON.stringify({
					error: "Invalid feedback",
					message: "Feedback must be a string under 10KB",
				}),
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

		// ✅ Security: Verify the caller owns this workflow and has tenant access
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
							"You are not authorized to approve this workflow",
					}),
					{
						status: 403,
						headers: { "Content-Type": "application/json" },
					},
				);
			}
			// Tenant check: verify current org membership
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
		} catch {
			// Workflow not found or already completed
			return new Response(
				JSON.stringify({
					error: "Workflow not found or already completed",
				}),
				{
					status: 404,
					headers: { "Content-Type": "application/json" },
				},
			);
		}

		await handle.signal("approval", {
			approved,
			feedback,
			decidedBy: userId,
		});

		// ✅ Security: Audit log the approval decision
		console.log(
			`[Orchestrator:Audit] Approval signal: executionId=${executionId}, approved=${approved}, decidedBy=${userId}, timestamp=${new Date().toISOString()}`,
		);

		return new Response(
			JSON.stringify({
				success: true,
				executionId,
				approved,
			}),
			{
				status: 200,
				headers: { "Content-Type": "application/json" },
			},
		);
	} catch (error) {
		console.error("[Orchestrator] Error sending approval signal:", error);
		return new Response(
			JSON.stringify({
				error:
					error instanceof Error
						? error.message
						: "Failed to send approval",
			}),
			{
				status: 500,
				headers: { "Content-Type": "application/json" },
			},
		);
	}
}

export const runtime = "nodejs";
