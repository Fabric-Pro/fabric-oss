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
import {
	ChatRunAccessError,
	getAuthorizedChatRun,
} from "@saas/agents/lib/server/chat-run-control";
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
		const { handle, description } = await getAuthorizedChatRun({
			executionId,
			userId,
			engine: "orchestrator",
			action: "approve",
		});
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
		return Response.json(
			{
				error:
					error instanceof ChatRunAccessError
						? "Forbidden"
						: "The request could not be confirmed",
			},
			{ status: error instanceof ChatRunAccessError ? 403 : 503 },
		);
	}
}

export const runtime = "nodejs";
