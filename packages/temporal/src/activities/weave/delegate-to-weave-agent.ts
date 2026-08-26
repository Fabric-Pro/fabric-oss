/**
 * Weave Agent Delegation Activities
 *
 * Temporal activities for delegating to weave agents via A2A protocol.
 * Wraps delegation with:
 * - Typed input/output for Temporal serialization
 * - Error classification (retryable vs non-retryable) for Temporal retry policy
 * - Heartbeats for long-running delegations (Shuttle coding runs)
 * - Structured result format following Temporal best practices
 *
 * All delegation uses SecureA2AClient with HMAC-signed tenant context.
 */

import { issueAIToken } from "@repo/ai-token";
import { requireServiceUrl } from "@repo/utils";
import { ApplicationFailure, Context } from "@temporalio/activity";
import {
	enrichWeaveDelegationMessage,
	isWeaveAgent,
} from "./enrich-delegation";

// =============================================================================
// Types — Temporal best practice: explicit input/output for all activities
// =============================================================================

export interface WeaveAgentDelegationInput {
	agentId: string;
	message: string;
	userId: string;
	organizationId?: string;
	projectId?: string;
	sandboxSessionId?: string;
	workDir?: string;
	/** Override timeout for long-running agents like Shuttle */
	timeoutMs?: number;
	/** Extra context forwarded to the agent */
	delegationContext?: Record<string, unknown>;
}

export interface WeaveAgentDelegationResult {
	agentId: string;
	status: "completed" | "failed" | "degraded";
	response: string;
	artifacts: Array<{
		id: string;
		name: string;
		mimeType: string;
		content: unknown;
	}>;
	durationMs: number;
	/** Whether the agent operated without sandbox (quality may be reduced) */
	degraded: boolean;
	degradationReason?: string;
}

// =============================================================================
// Error Classification — Temporal retries only retryable failures
// =============================================================================

function isRetryableError(error: unknown): boolean {
	const msg =
		error instanceof Error
			? error.message.toLowerCase()
			: String(error).toLowerCase();
	return (
		msg.includes("econnrefused") ||
		msg.includes("econnreset") ||
		msg.includes("fetch failed") ||
		msg.includes("timeout") ||
		msg.includes("503") ||
		msg.includes("502") ||
		msg.includes("429") ||
		msg.includes("rate limit") ||
		msg.includes("overloaded")
	);
}

// =============================================================================
// Activity: delegateToWeaveAgent
// =============================================================================

/**
 * Delegate a task to a weave agent via A2A protocol.
 *
 * This is the primary activity for all weave agent communication.
 * It handles enrichment (RAG, skills, project context), A2A protocol,
 * heartbeats, and error classification.
 *
 * Temporal retry policy should be configured by the caller:
 *   - Reader agents (Thread/Spindle/Weft/Warp): 2-3 retries, 2min timeout
 *   - Shuttle: 1 retry, 15min timeout
 *   - Pattern: 2 retries, 5min timeout
 */
export async function delegateToWeaveAgent(
	input: WeaveAgentDelegationInput,
): Promise<WeaveAgentDelegationResult> {
	const startTime = Date.now();
	const { agentId, userId, organizationId } = input;

	console.log(`[WeaveActivity] Delegating to ${agentId}`);

	if (!isWeaveAgent(agentId)) {
		throw ApplicationFailure.nonRetryable(
			`${agentId} is not a weave agent`,
			"INVALID_AGENT",
		);
	}

	// Lazy-import to avoid circular deps in the activity bundle
	const { delegateToAgent } = await import(
		"../orchestrator/delegation/delegate-to-agent"
	);

	// Enrich message with RAG, skills, project context, sandbox
	let enrichedMessage: string;
	try {
		enrichedMessage = await enrichWeaveDelegationMessage({
			agentId,
			message: input.message,
			projectId: input.projectId,
			userId,
			organizationId,
			sandboxSessionId: input.sandboxSessionId,
		});
	} catch (error) {
		console.warn("[WeaveActivity] Enrichment failed, using raw message", {
			agentId,
			error: String(error),
		});
		enrichedMessage = input.message;
	}

	// Heartbeat: let Temporal know we're alive during long agent calls
	const heartbeatInterval = setInterval(() => {
		try {
			Context.current().heartbeat({
				agentId,
				elapsedMs: Date.now() - startTime,
			});
		} catch {
			// Activity may have been cancelled
		}
	}, 10_000);

	try {
		const result = await delegateToAgent({
			agentId,
			message: enrichedMessage,
			userId,
			organizationId,
			projectId: input.projectId,
			timeout: input.timeoutMs,
			context: {
				...(input.delegationContext ?? {}),
				projectId: input.projectId,
				sandboxSessionId: input.sandboxSessionId,
				workDir: input.workDir,
			},
		});

		const durationMs = Date.now() - startTime;

		if (result.status === "failed") {
			throw ApplicationFailure.nonRetryable(
				`Agent ${agentId} failed: ${result.response}`,
				"AGENT_FAILED",
				{ agentId, response: result.response },
			);
		}

		return {
			agentId,
			status: "completed",
			response: result.response,
			artifacts: result.artifacts,
			durationMs,
			degraded: false,
		};
	} catch (error) {
		// Re-throw ApplicationFailure as-is (non-retryable)
		if (error instanceof ApplicationFailure) {
			throw error;
		}

		// Classify for Temporal retry policy
		if (isRetryableError(error)) {
			throw ApplicationFailure.retryable(
				`Transient error delegating to ${agentId}: ${error instanceof Error ? error.message : String(error)}`,
				"TRANSIENT_DELEGATION_ERROR",
				{ agentId },
			);
		}

		throw ApplicationFailure.nonRetryable(
			`Non-retryable error delegating to ${agentId}: ${error instanceof Error ? error.message : String(error)}`,
			"DELEGATION_ERROR",
			{ agentId },
		);
	} finally {
		clearInterval(heartbeatInterval);
	}
}

// =============================================================================
// Activity: delegateToPatternPlanner
// =============================================================================

export interface PatternPlannerInput {
	message: string;
	userId: string;
	organizationId?: string;
	projectId: string;
	projectName: string;
	description?: string;
	techStack?: string;
	planId?: string;
}

export interface PatternPlannerResult {
	planId: string;
	checkboxes: Array<{
		id: string;
		text: string;
		agent: string;
		category?: string;
		requiresReview?: boolean;
		reviewType?: string;
	}>;
	analysis?: string;
	durationMs: number;
}

/**
 * Delegate plan creation to the Pattern planner via A2A.
 *
 * Uses SecureA2AClient for HMAC-signed tenant context.
 * Includes heartbeats since Pattern calls Spindle/Thread internally.
 */
export async function delegateToPatternPlanner(
	input: PatternPlannerInput,
): Promise<PatternPlannerResult> {
	const startTime = Date.now();
	console.log("[WeaveActivity] Delegating to Pattern planner");

	const { SecureA2AClient } = await import("@repo/agent-core");

	// Throws a clear config error when unset in a deployed environment —
	// never a silent localhost fallback outside local dev.
	const plannersUrl = requireServiceUrl(
		"WEAVE_PLANNERS_URL",
		"http://localhost:8142",
	);

	const secureClient = new SecureA2AClient({
		timeout: 300_000, // 5 minutes — Pattern calls readers internally
		sourceAgent: "orchestrator",
	});

	const heartbeatInterval = setInterval(() => {
		try {
			Context.current().heartbeat({
				agent: "pattern",
				elapsedMs: Date.now() - startTime,
			});
		} catch {
			// cancelled
		}
	}, 10_000);

	try {
		// Short-lived reporting credential so the planner's model calls can
		// attribute usage to this run's actor (Fizzy #1894). Issued per
		// delegation; expires long before it could matter again.
		const aiToken = await issueAIToken({
			userId: input.userId,
			organizationId: input.organizationId,
			source: "weave-planner",
			expirySeconds: 30 * 60,
		});

		const task = await secureClient.sendMessageSecure(
			plannersUrl,
			{
				role: "user",
				parts: [{ type: "text", text: input.message }],
				metadata: {
					tenantContext: {
						userId: input.userId,
						organizationId: input.organizationId ?? null,
					},
					projectContext: {
						projectId: input.projectId,
						projectName: input.projectName,
						description: input.description,
						techStack: input.techStack,
					},
					planId: input.planId,
					aiToken,
				},
			},
			{
				userId: input.userId,
				organizationId: input.organizationId ?? null,
			},
		);

		// Pattern route returns JSON directly (not A2A task format)
		const data = task as unknown as {
			planId?: string;
			checkboxes?: PatternPlannerResult["checkboxes"];
			analysis?: string;
			error?: string;
		};

		if (data.error) {
			throw ApplicationFailure.nonRetryable(
				`Pattern planner failed: ${data.error}`,
				"PATTERN_FAILED",
			);
		}

		if (!data.planId || !data.checkboxes) {
			throw ApplicationFailure.nonRetryable(
				"Pattern planner returned incomplete result (missing planId or checkboxes)",
				"PATTERN_INCOMPLETE",
			);
		}

		return {
			planId: data.planId,
			checkboxes: data.checkboxes,
			analysis: data.analysis,
			durationMs: Date.now() - startTime,
		};
	} catch (error) {
		if (error instanceof ApplicationFailure) {
			throw error;
		}

		if (isRetryableError(error)) {
			throw ApplicationFailure.retryable(
				`Transient error in Pattern planner: ${error instanceof Error ? error.message : String(error)}`,
				"TRANSIENT_PATTERN_ERROR",
			);
		}

		throw ApplicationFailure.nonRetryable(
			`Pattern planner error: ${error instanceof Error ? error.message : String(error)}`,
			"PATTERN_ERROR",
		);
	} finally {
		clearInterval(heartbeatInterval);
	}
}
