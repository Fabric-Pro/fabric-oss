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
import {
	abandonConversationTurnStart,
	type ConversationTurn,
	db,
	hasOrganizationTie,
} from "@repo/database";
import { AiUsageLimitExceededError } from "@repo/payments";
import type {
	AgentVariable,
	OrchestratorProgressUpdate,
	OrchestratorWorkflowInput,
	TaskPlan,
} from "@repo/temporal";
import { getTemporalClient } from "@repo/temporal";
import { getSession } from "@saas/auth/lib/server";
import type { NextRequest } from "next/server";
import { v4 as uuidv4 } from "uuid";
import {
	EXECUTION_MODE_NAMES,
	parseExecutionMode,
} from "../orchestrator-execution-mode";
import {
	isOrchestratorOrganizationMember,
	refuseUnlessRunOwner,
} from "./run-access";
import {
	admitChatTurn,
	cancelledBeforeStartResponse,
	executionModeUsesTurns,
	isCancelledBeforeStart,
	resolveClientRequestKey,
	startLegacyChatWorkflow,
	startTurnWorkflow,
	TurnStartAmbiguousError,
	TurnStoppedBeforeStartError,
	turnPendingResponse,
} from "./turn-admission";

// Rate limit configurations
const RATE_LIMITS = {
	post: { limit: 20, windowMs: 60_000 }, // 20 workflow starts per minute
	get: { limit: 100, windowMs: 60_000 }, // 100 status queries per minute
};

/**
 * POST - Start a new orchestrator execution
 */
export async function POST(request: NextRequest) {
	// The turn this request admitted; ended FAILED in `finally` when the
	// request returns or throws before starting it (an abandoned
	// START_PENDING turn would hold its conversation until a reconcile).
	let turnToStart: ConversationTurn | null = null;
	let turnSettled = false;
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
			organizationId: requestedOrganizationId,
			executionMode: requestedExecutionMode = "balanced", // All modes now use iterative execution with mode-specific limits
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
			// `stream/route.ts` (which serves the live UI), this non-stream
			// variant is used by fire-and-forget callers that today rarely
			// pass an `AgentConversation`. Optional; when given it must be
			// the caller's own conversation in this organization (403
			// otherwise — admission checks it).
			conversationId: requestedConversationId,
			// Per-message idempotency key (see ./turn-admission.ts).
			clientRequestKey: rawClientRequestKey,
		} = body;
		const conversationId: string | null =
			typeof requestedConversationId === "string" &&
			requestedConversationId
				? requestedConversationId
				: null;

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

		const executionMode = parseExecutionMode(requestedExecutionMode);
		if (!executionMode) {
			return new Response(
				JSON.stringify({
					error: "Invalid request body",
					message: `executionMode must be one of: ${EXECUTION_MODE_NAMES.join(", ")}`,
				}),
				{
					status: 400,
					headers: { "Content-Type": "application/json" },
				},
			);
		}

		// ✅ Security: resolve and verify the organization this run acts in.
		// The organization is the only tenant context (ADR-018): a run
		// started with none would thread `undefined` into the AI, Temporal
		// and memory calls below and keep the organization-less arm live. The
		// caller may name one; otherwise the session's active organization is
		// used; either way the caller must have a tie to it, and with neither
		// the request fails closed.
		const candidateOrganizationId =
			(typeof requestedOrganizationId === "string" &&
			requestedOrganizationId.length > 0
				? requestedOrganizationId
				: undefined) ??
			session.session?.activeOrganizationId ??
			undefined;

		if (!candidateOrganizationId) {
			return new Response(
				JSON.stringify({
					error: "Forbidden",
					message: "No organization is active for this session",
				}),
				{
					status: 403,
					headers: { "Content-Type": "application/json" },
				},
			);
		}

		// Membership — the rule every paired orchestrator route applies
		// (./run-access.ts).
		if (
			!(await isOrchestratorOrganizationMember(
				userId,
				candidateOrganizationId,
			))
		) {
			console.warn("[Orchestrator] User not a member of organization", {
				userId,
				organizationId: candidateOrganizationId,
			});
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
		const organizationId: string = candidateOrganizationId;

		const clientRequestKey = resolveClientRequestKey(rawClientRequestKey);
		if (!clientRequestKey.ok) {
			return clientRequestKey.response;
		}

		// ✅ Security: a named conversation must be the caller's own in this
		// organization — checked here, before either starter is chosen, so a
		// run with no turn (a planner mode skips admission, which re-checks
		// it) cannot carry another user's or organization's conversation into
		// completion and memory.
		if (conversationId) {
			const owned = await db.agentConversation.findFirst({
				where: { id: conversationId, userId, organizationId },
				select: { id: true },
			});
			if (!owned) {
				return new Response(
					JSON.stringify({
						error: "Forbidden",
						message: "This conversation is not accessible",
					}),
					{
						status: 403,
						headers: { "Content-Type": "application/json" },
					},
				);
			}
		}

		// Get Temporal client
		const temporalClient = await getTemporalClient();

		// Admit the turn through the durable record before anything billed:
		// the same creation path as the stream route (./turn-admission.ts).
		// A planner mode (`save_reuse`, `weave`) gets no turn and the legacy
		// start (see `executionModeUsesTurns`).
		const usesTurn = executionModeUsesTurns(executionMode);
		const admission = usesTurn
			? await admitChatTurn({
					userId,
					organizationId,
					conversationId,
					clientRequestKey: clientRequestKey.key,
					executionMode,
					temporalClient,
				})
			: null;
		if (admission?.kind === "refused") {
			return admission.response;
		}
		if (admission && isCancelledBeforeStart(admission.turn)) {
			return cancelledBeforeStartResponse();
		}
		if (admission?.kind === "existing") {
			// An idempotent retry of the key: never a second workflow, and
			// never this request's to start or clean up — only the request
			// that created the turn (it holds the start token) starts it.
			return new Response(
				JSON.stringify({
					executionId: admission.turn.executionId,
					workflowId: admission.turn.executionId,
					turnId: admission.turn.id,
					status: "existing",
				}),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			);
		}
		const turn = admission?.turn ?? null;
		turnToStart = turn;

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

		// Track usage (fire-and-forget) — once per turn, not per retry.
		if (!admission || admission.kind === "created") {
			trackUsage();
		}

		// The turn's execution id (also the Temporal workflow id); a fresh
		// one for a run with no turn.
		const executionId = turn
			? (turn.executionId as string)
			: `orch-${uuidv4()}`;

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
				organizationId,
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
			executionMode,
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
			conversationId: conversationId ?? undefined,
		};

		if (!turn) {
			await startLegacyChatWorkflow({
				temporalClient,
				executionId,
				workflowInput,
				memo: { userId, organizationId },
			});
			console.log(
				`[Orchestrator] Started workflow (no turn): ${executionId}`,
			);
			return new Response(
				JSON.stringify({
					executionId,
					workflowId: executionId,
					status: "started",
				}),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			);
		}

		// Start the workflow (attaches when a lost start already created it)
		let started: Awaited<ReturnType<typeof startTurnWorkflow>>;
		try {
			started = await startTurnWorkflow({
				temporalClient,
				turn,
				workflowInput,
				memo: { userId, organizationId },
			});
		} catch (startError) {
			// startTurnWorkflow already settled the turn (or deliberately
			// left an ambiguous start for the retry to resolve).
			turnSettled = true;
			if (startError instanceof TurnStoppedBeforeStartError) {
				return cancelledBeforeStartResponse();
			}
			// The start may have applied: the same answer as a turn whose
			// start is still in progress — retry the same key shortly.
			if (startError instanceof TurnStartAmbiguousError) {
				return turnPendingResponse(startError.executionId);
			}
			throw startError;
		}
		turnSettled = true;

		console.log(
			`[Orchestrator] ${started.attached ? "Attached to" : "Started"} workflow: ${executionId}`,
		);

		return new Response(
			JSON.stringify({
				executionId,
				workflowId: executionId,
				turnId: turn.id,
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
	} finally {
		// Owner-only (the start token), START_PENDING-only.
		const abandoned = turnToStart as ConversationTurn | null;
		if (abandoned?.executionId && abandoned.startToken && !turnSettled) {
			await abandonConversationTurnStart({
				turnId: abandoned.id,
				executionId: abandoned.executionId,
				startToken: abandoned.startToken,
				cancelled: false,
				reason: "refused before start",
			}).catch((markError: unknown) => {
				console.error(
					"[Orchestrator] Failed to end an abandoned turn",
					markError,
				);
			});
		}
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
			const workflowOrgId = memo?.organizationId;
			const refusal = await refuseUnlessRunOwner({
				executionId,
				userId,
				memo,
				notOwnerMessage:
					"You are not authorized to access this workflow",
			});
			if (refusal) {
				return refusal;
			}
			// Tenant check: if the workflow belongs to an organization, the
			// caller must still have a tie to it — the same rule POST applied
			// when the run started (membership or an accepted project-guest
			// invitation, ADR-018). A membership-only check here refused a
			// project guest their own run.
			if (workflowOrgId) {
				const tied = await hasOrganizationTie(
					userId,
					workflowOrgId as string,
				);
				if (!tied) {
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
