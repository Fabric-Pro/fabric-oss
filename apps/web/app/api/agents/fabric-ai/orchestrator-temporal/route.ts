/**
 * Fabric AI Orchestrator - Temporal API
 * This endpoint starts and manages the durable Temporal orchestrator workflow.
 * It replaces the SSE-based orchestrator with a more robust, durable execution model.
 * Endpoints:
 * - POST: Start a new orchestrator execution
 * - GET: Query execution status/progress
 * @security This endpoint includes:
 * - Session-based authentication
 * - Rate limiting (20 requests per minute for POST, 100 for GET)
 * - Input validation
 * - Organization ownership verification
 */

import { getDefaultEnabledMcpConfigIds } from "@repo/agent-core/backend";
import { getAIModelWithMetadata } from "@repo/ai";
import { checkRateLimit } from "@repo/api/lib/rate-limit";
import { db } from "@repo/database";
import { AiUsageLimitExceededError } from "@repo/payments";
import type {
	AgentVariable,
	ExecutionMode,
	OrchestratorProgressUpdate,
	OrchestratorWorkflowInput,
	TaskPlan,
} from "@repo/temporal";
import { getTemporalClient } from "@repo/temporal";
import { getSession } from "@saas/auth/lib/server";
import type { NextRequest } from "next/server";
import { v4 as uuidv4 } from "uuid";

// Rate limit configurations
const RATE_LIMITS = {
	post: { limit: 20, windowMs: 60_000 }, // 20 workflow starts per minute
	get: { limit: 100, windowMs: 60_000 }, // 100 status queries per minute
};

/**
 * POST - Start a new orchestrator execution
 */
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

		// ✅ Security: Rate limiting
		const rateLimitKey = `orchestrator:start:${userId}`;
		const rateLimitResult = await checkRateLimit(
			rateLimitKey,
			RATE_LIMITS.post.limit,
			RATE_LIMITS.post.windowMs,
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
						"X-RateLimit-Limit": RATE_LIMITS.post.limit.toString(),
						"X-RateLimit-Remaining":
							rateLimitResult.remaining.toString(),
						"X-RateLimit-Reset":
							rateLimitResult.resetInSeconds.toString(),
					},
				},
			);
		}

		const body = await request.json();

		const {
			message,
			history = [],
			organizationId,
			executionMode = "balanced", // All modes now use iterative execution with mode-specific limits
			enabledMcpConfigIds = null,
			enabledAgentIds = null,
			enabledFabricToolIds = null,
			prioritizedToolIds,
			prioritizedAgentIds,
			prioritizedMcpConfigIds,
			policyContext,
			replayTrajectoryId,
			// Optional AgentConversation ID for persistent
			// operation-result system messages. Unlike the SSE sibling at
			// `stream/route.ts:117` (which serves the live UI), this
			// non-stream variant is used by fire-and-forget callers that
			// today rarely pass an `AgentConversation`. Accept it as
			// optional so present-day callers stay unaffected and future
			// callers can opt in by simply adding it to the body.
			conversationId,
		} = body;

		if (!message) {
			return new Response(
				JSON.stringify({ error: "message is required" }),
				{
					status: 400,
					headers: { "Content-Type": "application/json" },
				},
			);
		}

		// ✅ Security: Validate message size (max 100KB)
		if (typeof message !== "string" || message.length > 100_000) {
			return new Response(
				JSON.stringify({
					error: "Invalid message",
					message: "Message must be a string under 100KB",
				}),
				{
					status: 400,
					headers: { "Content-Type": "application/json" },
				},
			);
		}

		// ✅ Security: Verify organization ownership if organizationId is provided
		if (organizationId) {
			const member = await db.member.findFirst({
				where: {
					userId,
					organizationId,
				},
			});

			if (!member) {
				console.warn(
					`[Orchestrator] User ${userId} not a member of organization ${organizationId}`,
				);
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

		// Get AI model and provider config using centralized entry point
		let aiModelResult: Awaited<ReturnType<typeof getAIModelWithMetadata>>;
		try {
			// See the note in fabric-ai/stream: the returned model is discarded
			// (only trackUsage is used), so a featureKey here would tag a call
			// that never happens. The Temporal activity carries the tag.
			aiModelResult = await getAIModelWithMetadata(
				{ taskType: "TOOL_CALLING" },
				{ userId, organizationId },
			);
		} catch (error) {
			// AI usage-limit chokepoint hit a HARD limit.
			// Surface the rich payload so the
			// orchestrator launcher renders the shared destructive
			// toast instead of a generic AI_GATEWAY_MISSING error card.
			if (error instanceof AiUsageLimitExceededError) {
				return new Response(
					JSON.stringify({
						error: error.message,
						code: "AI_USAGE_LIMIT_EXCEEDED",
						data: {
							limitId: error.limitId,
							dimension: error.dimension,
							window: error.window,
							used: error.used.toString(),
							max: error.max.toString(),
							manageLimitsUrl: error.manageLimitsUrl,
						},
					}),
					{
						status: 429,
						headers: { "Content-Type": "application/json" },
					},
				);
			}
			console.error("[Orchestrator] Failed to get AI model:", error);
			return new Response(
				JSON.stringify({
					error:
						error instanceof Error
							? error.message
							: "No AI provider configured. Please configure an AI provider in Settings → AI Providers.",
					code: "AI_GATEWAY_MISSING",
				}),
				{
					status: 400,
					headers: { "Content-Type": "application/json" },
				},
			);
		}

		const { trackUsage } = aiModelResult;

		// Track usage (fire-and-forget)
		trackUsage();

		// Generate unique execution ID
		const executionId = `orch-${uuidv4()}`;

		// Get Temporal client
		const temporalClient = await getTemporalClient();

		// Union default-enabled MCP config ids into the caller-restricted set
		// so managed-default servers (e.g. Excalidraw, when `defaultEnabled`)
		// are eligible for eager-routing inside the orchestrator workflow.
		// On helper failure, log and proceed with the original array — the
		// workflow's defense-in-depth at `applyDefaultMcpEagerRouting`
		// still resolves via `findDefaultMcpConfigActivity`.
		let effectiveEnabledMcpConfigIds: string[] | null = enabledMcpConfigIds;
		try {
			const defaultIds = await getDefaultEnabledMcpConfigIds(
				userId,
				organizationId ?? null,
			);
			if (defaultIds.length > 0) {
				const existing = Array.isArray(enabledMcpConfigIds)
					? enabledMcpConfigIds
					: [];
				effectiveEnabledMcpConfigIds = Array.from(
					new Set([...existing, ...defaultIds]),
				);
			}
		} catch (defaultIdsError) {
			console.warn(
				"[Orchestrator] Failed to union default-enabled MCP config ids — proceeding with caller-supplied array",
				defaultIdsError,
			);
		}

		// Prioritizing implies enabling (issue #2182): the UI can star a
		// server without adding it to the conversation tool selection, which
		// leaves the planner biased toward tools the ToolIndex then excludes
		// as "config not enabled". Union the prioritized ids into the
		// effective set — but only when the caller restricted it: `null`
		// means "all configs enabled" and must stay null.
		if (
			Array.isArray(effectiveEnabledMcpConfigIds) &&
			Array.isArray(prioritizedMcpConfigIds) &&
			prioritizedMcpConfigIds.length > 0
		) {
			effectiveEnabledMcpConfigIds = Array.from(
				new Set([
					...effectiveEnabledMcpConfigIds,
					...prioritizedMcpConfigIds,
				]),
			);
		}

		// Build workflow input
		// SECURITY: Credentials are NOT passed in workflow inputs
		// Activities fetch credentials internally to avoid storing them in Temporal history
		const workflowInput: OrchestratorWorkflowInput = {
			executionId,
			message,
			history,
			userId,
			organizationId,
			executionMode: executionMode as ExecutionMode,
			enabledMcpConfigIds: effectiveEnabledMcpConfigIds,
			enabledAgentIds,
			enabledFabricToolIds,
			prioritizedToolIds,
			prioritizedAgentIds,
			prioritizedMcpConfigIds,
			policyContext,
			replayTrajectoryId,
			// See body destructure note above. Forwarding
			// is unconditional; the completion-phase activity guards on
			// `conversationId === undefined` to no-op.
			conversationId,
		};

		// Start the workflow
		const handle = await temporalClient.workflow.start(
			"orchestratorExecutionWorkflow",
			{
				taskQueue: "fabric-orchestrator",
				// Absolute ceiling, matching the streaming starter. Without it a
				// wedged run stays RUNNING with nothing to reclaim it.
				workflowExecutionTimeout: "1 hour",
				workflowId: executionId,
				args: [workflowInput],
				memo: { userId, organizationId: organizationId ?? null },
			},
		);

		console.log(`[Orchestrator] Started workflow: ${executionId}`);

		return new Response(
			JSON.stringify({
				executionId,
				workflowId: handle.workflowId,
				status: "started",
			}),
			{
				status: 200,
				headers: { "Content-Type": "application/json" },
			},
		);
	} catch (error) {
		console.error("[Orchestrator] Error starting workflow:", error);
		return new Response(
			JSON.stringify({
				error:
					error instanceof Error
						? error.message
						: "Failed to start orchestrator",
			}),
			{
				status: 500,
				headers: { "Content-Type": "application/json" },
			},
		);
	}
}

/**
 * GET - Query execution status/progress
 */
export async function GET(request: NextRequest) {
	try {
		const session = await getSession();
		if (!session) {
			return new Response(JSON.stringify({ error: "Unauthorized" }), {
				status: 401,
				headers: { "Content-Type": "application/json" },
			});
		}

		const userId = session.user.id;

		// ✅ Security: Rate limiting for status queries
		const rateLimitKey = `orchestrator:status:${userId}`;
		const rateLimitResult = await checkRateLimit(
			rateLimitKey,
			RATE_LIMITS.get.limit,
			RATE_LIMITS.get.windowMs,
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

		const { searchParams } = new URL(request.url);
		const executionId = searchParams.get("executionId");

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

		// Get Temporal client
		const temporalClient = await getTemporalClient();

		// Get workflow handle
		const handle = temporalClient.workflow.getHandle(executionId);

		// ✅ Security: Verify the caller owns this workflow
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
							"You are not authorized to access this workflow",
					}),
					{
						status: 403,
						headers: { "Content-Type": "application/json" },
					},
				);
			}
			// Tenant check: if workflow belongs to an org, verify current membership
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
				JSON.stringify({ error: "Workflow not found" }),
				{
					status: 404,
					headers: { "Content-Type": "application/json" },
				},
			);
		}

		// Query current status
		let status:
			| "running"
			| "awaiting_approval"
			| "completed"
			| "failed"
			| "cancelled" = "running";
		let progress: OrchestratorProgressUpdate | null = null;
		let plan: TaskPlan | null = null;
		let variables: Record<string, AgentVariable> = {};
		let pendingApproval: {
			approvalId: string;
			stepId: string;
			reason: string;
		} | null = null;
		let result: any = null;

		try {
			// Try to get workflow status
			const description = await handle.describe();

			if (description.status.name === "COMPLETED") {
				// Get the result
				result = await handle.result();
				status = result.status;
				// Use the plan from the completed result (has final step statuses)
				plan = result.taskPlan || null;
				variables = result.variables || {};
			} else if (description.status.name === "FAILED") {
				status = "failed";
			} else if (description.status.name === "CANCELLED") {
				status = "cancelled";
			} else {
				// Workflow is still running - query for current state
				try {
					status = await handle.query("status");
					progress = await handle.query("progress");
					plan = await handle.query("plan");
					variables = await handle.query("variables");
					pendingApproval = await handle.query("pendingApproval");
				} catch (queryError) {
					// Queries might fail if workflow just started
					console.warn("[Orchestrator] Query failed:", queryError);
				}
			}
		} catch (error) {
			// Workflow might not exist
			console.error("[Orchestrator] Error querying workflow:", error);
			return new Response(
				JSON.stringify({ error: "Execution not found" }),
				{
					status: 404,
					headers: { "Content-Type": "application/json" },
				},
			);
		}

		return new Response(
			JSON.stringify({
				executionId,
				status,
				progress,
				plan,
				variables,
				pendingApproval,
				result,
			}),
			{
				status: 200,
				headers: { "Content-Type": "application/json" },
			},
		);
	} catch (error) {
		console.error("[Orchestrator] Error querying workflow:", error);
		return new Response(
			JSON.stringify({
				error:
					error instanceof Error
						? error.message
						: "Failed to query orchestrator",
			}),
			{
				status: 500,
				headers: { "Content-Type": "application/json" },
			},
		);
	}
}

export const runtime = "nodejs";
