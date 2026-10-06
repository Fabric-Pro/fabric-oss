/**
 * Orchestrator Cancel Endpoint
 *
 * Stops an Advisor chat turn (and cancels legacy orchestrator runs).
 *
 * For a turn, the cancel is recorded durably on the turn row
 * (CANCEL_REQUESTED: who, when, source) BEFORE Temporal is asked to cancel,
 * so a Temporal outage cannot lose it — every dispatch check that reads the
 * turn after the cancel commits refuses a new model call. (A call whose
 * check passed just before the commit still starts; Temporal's cancel aborts
 * it, or, when Temporal is unreachable, it runs to completion and nothing
 * follows it. See turn-dispatch.ts in @repo/temporal.) Temporal NotFound means the run already
 * ended; a transport or auth error answers 503 and leaves the recorded
 * cancel in place. Stop before the browser has the executionId cancels by
 * the message's client key (a tombstone when no turn exists yet).
 *
 * @security This endpoint includes:
 * - Session-based authentication
 * - Rate limiting (10 cancel requests per minute)
 * - Execution ID format validation
 * - Audit logging of cancellation
 */

import { checkRateLimit } from "@repo/api/lib/rate-limit";
import {
	type ConversationTurn,
	finalizeConversationTurn,
	getConversationTurnForExecution,
	getConversationTurnOwnerForExecution,
	requestConversationTurnCancel,
} from "@repo/database";
import { getTemporalClient } from "@repo/temporal";
import { getSession } from "@saas/auth/lib/server";
import type { NextRequest } from "next/server";
import {
	isOrchestratorOrganizationMember,
	refuseUnlessRunOwner,
} from "../run-access";
import {
	isWorkflowNotFound,
	reconcileTurnWithWorkflow,
	resolveClientRequestKey,
	resolveTurnOrganization,
} from "../turn-admission";

// Rate limit: 10 cancel requests per minute per user
const CANCEL_RATE_LIMIT = { limit: 10, windowMs: 60_000 };

const EXECUTION_ID_PATTERN = /^orch-[a-f0-9-]{36}$/;

function json(status: number, body: Record<string, unknown>): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

/** Temporal could not be reached: retryable, and never reported as success. */
function unavailable(extra: Record<string, unknown>): Response {
	return new Response(
		JSON.stringify({
			error: "Temporarily unavailable",
			message:
				"The stop could not be delivered to the running workflow. Please retry.",
			...extra,
		}),
		{
			status: 503,
			headers: { "Content-Type": "application/json", "Retry-After": "2" },
		},
	);
}

function audit(details: Record<string, unknown>): void {
	console.log("[Orchestrator:Audit] Turn cancelled", {
		...details,
		reason: details.reason || "user_clicked_stop",
		timestamp: new Date().toISOString(),
	});
}

/** The Temporal client, or null when it cannot be acquired (logged). */
async function acquireTemporalClient(): Promise<any | null> {
	try {
		return await getTemporalClient();
	} catch (error) {
		console.error("[Orchestrator] Temporal client unavailable:", error);
		return null;
	}
}

/**
 * Deliver a recorded cancel to the turn's workflow. The cancel is already
 * durable, so every outcome here is about Temporal only:
 *   - NotFound: the run already ended (or never started) — reconcile the
 *     turn from what Temporal reports and answer success;
 *   - a closed run: reconcile likewise;
 *   - RUNNING: cancel it;
 *   - a transport/auth error: 503, with the recorded cancel left in place
 *     (every later dispatch check refuses a new model call; a call already
 *     past its check runs to completion).
 */
async function cancelTurnInTemporal(args: {
	turn: ConversationTurn;
	userId: string;
	reason: string | undefined;
}): Promise<Response> {
	const { turn } = args;
	const executionId = turn.executionId;
	if (!executionId) {
		return json(200, {
			success: true,
			cancelledBeforeStart: true,
			message: "The message was stopped before it started",
		});
	}
	// Acquired only now, after the cancel is durable: a cold process that
	// cannot connect to Temporal still leaves the Stop recorded, and the
	// turn's later dispatch checks refuse every new model request.
	const temporalClient = await acquireTemporalClient();
	if (!temporalClient) {
		return unavailable({ cancelRecorded: true, executionId });
	}
	const handle = temporalClient.workflow.getHandle(executionId);
	let statusName: string;
	try {
		statusName = (await handle.describe()).status.name;
	} catch (error) {
		if (isWorkflowNotFound(error)) {
			if (
				turn.status === "START_PENDING" ||
				turn.status === "CANCEL_REQUESTED"
			) {
				// Possibly not started YET: the recorded cancel stops the
				// start (or the first dispatch); a later reconcile settles
				// the turn if its starter is gone.
				const settled = await reconcileTurnWithWorkflow({
					turn,
					temporalClient,
				});
				return json(200, {
					success: true,
					executionId,
					cancelRecorded: true,
					alreadyTerminated: settled === "terminalized",
				});
			}
			await finalizeConversationTurn({
				turnId: turn.id,
				executionId,
				userId: turn.userId,
				organizationId: turn.organizationId,
				outcome: "CANCELLED",
				terminalReason: "reconciled: workflow not found",
			});
			return json(200, {
				success: true,
				executionId,
				message: "Workflow not found or already terminated",
				alreadyTerminated: true,
			});
		}
		console.error("[Orchestrator] Temporal unavailable for cancel:", error);
		return unavailable({ cancelRecorded: true, executionId });
	}

	if (statusName !== "RUNNING") {
		const settled = await reconcileTurnWithWorkflow({
			turn,
			temporalClient,
		});
		return json(200, {
			success: true,
			executionId,
			message: `Workflow already ${statusName.toLowerCase()}`,
			alreadyTerminated: settled === "terminalized",
		});
	}

	try {
		await handle.cancel();
	} catch (error) {
		console.error("[Orchestrator] Temporal cancel failed:", error);
		return unavailable({ cancelRecorded: true, executionId });
	}
	audit({ executionId, userId: args.userId, reason: args.reason });
	return json(200, {
		success: true,
		executionId,
		cancelRecorded: true,
		message: "Workflow cancelled",
	});
}

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

		const body = (await request.json()) as Record<string, unknown>;
		const executionId =
			typeof body.executionId === "string" && body.executionId
				? body.executionId
				: undefined;
		const clientRequestKey =
			typeof body.clientRequestKey === "string" && body.clientRequestKey
				? body.clientRequestKey
				: undefined;
		const conversationId =
			typeof body.conversationId === "string" && body.conversationId
				? body.conversationId
				: undefined;
		const reason =
			typeof body.reason === "string" ? body.reason : undefined;

		if (!executionId && !clientRequestKey) {
			return json(400, {
				error: "executionId or clientRequestKey is required",
			});
		}

		// Validate executionId format to prevent injection
		if (executionId && !EXECUTION_ID_PATTERN.test(executionId)) {
			return json(400, { error: "Invalid executionId format" });
		}
		if (clientRequestKey && !resolveClientRequestKey(clientRequestKey).ok) {
			return json(400, { error: "Invalid clientRequestKey format" });
		}

		// The turn record is scoped to the caller's user AND organization.
		const resolvedOrganization = await resolveTurnOrganization({
			userId,
			requestedOrganizationId: body.organizationId,
			session: session.session,
		});
		if (!resolvedOrganization.ok) {
			return resolvedOrganization.response;
		}
		const organizationId = resolvedOrganization.organizationId;

		// No Temporal client yet: every turn cancel is authorized and recorded
		// in the database first; the client is acquired only to deliver it.

		// =================================================================
		// Stop before `started`: the browser has only the message's key.
		// =================================================================
		if (!executionId && clientRequestKey) {
			const recorded = await requestConversationTurnCancel({
				userId,
				organizationId,
				clientRequestKey,
				conversationId: conversationId ?? null,
				source: "USER_STOP",
				requestedByUserId: userId,
			});
			switch (recorded.outcome) {
				case "tombstoned":
					audit({
						clientRequestKey,
						userId,
						reason,
						beforeStart: true,
					});
					return json(200, {
						success: true,
						cancelledBeforeStart: true,
						message: "The message was stopped before it started",
					});
				case "scope_mismatch":
				case "conversation_forbidden":
				case "not_found":
					return json(403, {
						error: "Forbidden",
						message: "You are not authorized to cancel this turn",
					});
				case "already_terminal":
					return json(200, {
						success: true,
						executionId: recorded.turn.executionId,
						message: `Turn already ${recorded.turn.status.toLowerCase()}`,
						alreadyTerminated: true,
					});
				default:
					return cancelTurnInTemporal({
						turn: recorded.turn,
						userId,
						reason,
					});
			}
		}

		// executionId is set from here on.
		const targetExecutionId = executionId as string;

		// =================================================================
		// A chat turn: record the cancel durably FIRST, then ask Temporal.
		// =================================================================
		const turn = await getConversationTurnForExecution({
			executionId: targetExecutionId,
			userId,
			organizationId,
		});
		if (!turn) {
			const owner =
				await getConversationTurnOwnerForExecution(targetExecutionId);
			if (owner) {
				// Someone else's turn, or this user's in another organization.
				return json(403, {
					error: "Forbidden",
					message: "You are not authorized to cancel this workflow",
				});
			}
		} else {
			if (
				conversationId &&
				(turn.scopeConversationId ?? null) !== conversationId
			) {
				// The caller's own turn, but named under another
				// conversation: refuse rather than act on the wrong chat.
				return json(403, {
					error: "Forbidden",
					message: "This turn belongs to a different conversation",
				});
			}
			const recorded = await requestConversationTurnCancel({
				userId,
				organizationId,
				executionId: targetExecutionId,
				source: "USER_STOP",
				requestedByUserId: userId,
			});
			if (recorded.outcome === "already_terminal") {
				return json(200, {
					success: true,
					executionId: targetExecutionId,
					message: `Turn already ${recorded.turn.status.toLowerCase()}`,
					alreadyTerminated: true,
				});
			}
			if (
				recorded.outcome !== "recorded" &&
				recorded.outcome !== "already_requested"
			) {
				return json(403, {
					error: "Forbidden",
					message: "You are not authorized to cancel this workflow",
				});
			}
			return cancelTurnInTemporal({
				turn: recorded.turn,
				userId,
				reason,
			});
		}

		// =================================================================
		// A run with no turn row (started before turns existed): the memo is
		// the only owner record, and a memo with no owner fails closed.
		// =================================================================
		const temporalClient = await acquireTemporalClient();
		if (!temporalClient) {
			return unavailable({ cancelRecorded: false });
		}
		const handle = temporalClient.workflow.getHandle(targetExecutionId);
		let description: Awaited<ReturnType<typeof handle.describe>>;
		try {
			description = await handle.describe();
		} catch (error) {
			if (isWorkflowNotFound(error)) {
				return json(200, {
					success: true,
					executionId: targetExecutionId,
					message: "Workflow not found or already terminated",
					alreadyTerminated: true,
				});
			}
			// A transport or auth failure is not "already ended".
			console.error(
				"[Orchestrator] Temporal unavailable for cancel:",
				error,
			);
			return unavailable({ cancelRecorded: false });
		}
		const memo = description.memo as Record<string, unknown> | undefined;
		const refusal = await refuseUnlessRunOwner({
			executionId: targetExecutionId,
			userId,
			memo,
			notOwnerMessage: "You are not authorized to cancel this workflow",
		});
		if (refusal) {
			return refusal;
		}
		const workflowOrgId = memo?.organizationId;
		if (workflowOrgId) {
			// Membership: one helper for every paired route (../run-access.ts).
			if (
				!(await isOrchestratorOrganizationMember(
					userId,
					workflowOrgId as string,
				))
			) {
				return json(403, {
					error: "Forbidden",
					message: "You are not a member of this organization",
				});
			}
		}
		if (description.status.name !== "RUNNING") {
			// Workflow already completed/failed/cancelled
			return json(200, {
				success: true,
				executionId: targetExecutionId,
				message: `Workflow already ${description.status.name.toLowerCase()}`,
				alreadyTerminated: true,
			});
		}
		try {
			await handle.cancel();
		} catch (error) {
			console.error("[Orchestrator] Temporal cancel failed:", error);
			return unavailable({ cancelRecorded: false });
		}
		audit({ executionId: targetExecutionId, userId, reason });
		return json(200, {
			success: true,
			executionId: targetExecutionId,
			message: "Workflow cancelled",
		});
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
