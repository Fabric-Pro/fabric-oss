/**
 * Orchestrator Clarification Signal Endpoint
 *
 * Sends the user's answer to a pending clarifying question to a running
 * orchestrator workflow (HITL sibling of the approval endpoint).
 *
 * @security Session auth, rate limiting, executionId format validation,
 * ownership + tenant checks, and audit logging — mirrors the approve endpoint.
 */

import { checkRateLimit } from "@repo/api/lib/rate-limit";
import { db } from "@repo/database";
import { getTemporalClient } from "@repo/temporal";
import { getSession } from "@saas/auth/lib/server";
import type { NextRequest } from "next/server";

// Rate limit: 20 clarification answers per minute per user.
const CLARIFY_RATE_LIMIT = { limit: 20, windowMs: 60_000 };

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

		const rateLimitResult = await checkRateLimit(
			`orchestrator:clarify:${userId}`,
			CLARIFY_RATE_LIMIT.limit,
			CLARIFY_RATE_LIMIT.windowMs,
		);
		if (!rateLimitResult.allowed) {
			return new Response(
				JSON.stringify({
					error: "Rate limit exceeded",
					message: `Too many requests. Please try again in ${rateLimitResult.resetInSeconds} seconds.`,
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

		const { executionId, answer, dismissed } = await request.json();

		if (!executionId) {
			return new Response(
				JSON.stringify({ error: "executionId is required" }),
				{
					status: 400,
					headers: { "Content-Type": "application/json" },
				},
			);
		}

		// Validate executionId format to prevent injection.
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

		// Either a non-empty answer or an explicit dismissal is required.
		const isDismissed = dismissed === true;
		if (
			!isDismissed &&
			(typeof answer !== "string" || answer.trim().length === 0)
		) {
			return new Response(
				JSON.stringify({
					error: "answer (non-empty string) or dismissed:true is required",
				}),
				{
					status: 400,
					headers: { "Content-Type": "application/json" },
				},
			);
		}
		if (typeof answer === "string" && answer.length > 10_000) {
			return new Response(
				JSON.stringify({
					error: "Invalid answer",
					message: "Answer must be a string under 10KB",
				}),
				{
					status: 400,
					headers: { "Content-Type": "application/json" },
				},
			);
		}

		const temporalClient = await getTemporalClient();
		const handle = temporalClient.workflow.getHandle(executionId);

		// Verify the caller owns this workflow and has tenant access.
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
							"You are not authorized to answer this workflow",
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
		} catch {
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

		await handle.signal("clarification", {
			answer: isDismissed ? "" : (answer as string),
			dismissed: isDismissed,
		});

		console.log(
			`[Orchestrator:Audit] Clarification signal: executionId=${executionId}, dismissed=${isDismissed}, answeredBy=${userId}, timestamp=${new Date().toISOString()}`,
		);

		return new Response(JSON.stringify({ success: true, executionId }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	} catch (error) {
		console.error(
			"[Orchestrator] Error sending clarification signal:",
			error,
		);
		return new Response(
			JSON.stringify({
				error:
					error instanceof Error
						? error.message
						: "Failed to send clarification",
			}),
			{ status: 500, headers: { "Content-Type": "application/json" } },
		);
	}
}

export const runtime = "nodejs";
