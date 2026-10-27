/**
 * Orchestrator Cancel Endpoint
 *
 * Stops an Advisor chat turn (and cancels legacy/non-turn orchestrator runs).
 *
 * For a turn, the cancel is recorded durably on the turn row
 * (CANCEL_REQUESTED: who, when, source) BEFORE Temporal is asked to cancel,
 * so a Temporal outage cannot lose it — every dispatch check that reads the
 * turn after the cancel commits refuses a new model call.
 *
 * For a run with no turn row, delegates authorization, run-pinning, and
 * content-free audit logging to `getAuthorizedChatRun`.
 */

import { recordAuditFromRequest } from "@repo/api/lib/audit";
import { checkRateLimit } from "@repo/api/lib/rate-limit";
import * as dbModule from "@repo/database";
import { getTemporalClient } from "@repo/temporal";
import {
	ChatRunAccessError,
	getAuthorizedChatRun,
} from "@saas/agents/lib/server/chat-run-control";
import { getSession } from "@saas/auth/lib/server";
import {
	isWorkflowNotFound,
	reconcileTurnWithWorkflow,
	resolveClientRequestKey,
	resolveTurnOrganization,
} from "../turn-admission";

const CANCEL_RATE_LIMIT = { limit: 10, windowMs: 60_000 };
const EXECUTION_ID_PATTERN =
	/^orch-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

function json(status: number, body: Record<string, unknown>): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

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

async function acquireTemporalClient(): Promise<any | null> {
	try {
		return await getTemporalClient();
	} catch (error) {
		console.error("[Orchestrator] Temporal client unavailable:", error);
		return null;
	}
}

async function cancelTurnInTemporal(args: {
	turn: dbModule.ConversationTurn;
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
			await dbModule.finalizeConversationTurn({
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

export async function POST(request: Request) {
	try {
		const session = await getSession();
		if (!session) {
			return json(401, { error: "Unauthorized" });
		}

		const userId = session.user.id;
		const rateLimitResult = await checkRateLimit(
			`orchestrator:cancel:${userId}`,
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

		const rawBody = await request.json().catch(() => null);
		if (!rawBody || typeof rawBody !== "object") {
			return json(400, { error: "Invalid control request" });
		}
		const body = rawBody as Record<string, unknown>;
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

		if (body.executionId !== undefined && !executionId) {
			return json(400, { error: "Invalid executionId format" });
		}
		if (!executionId && !clientRequestKey) {
			return json(400, {
				error: "executionId or clientRequestKey is required",
			});
		}
		if (executionId && !EXECUTION_ID_PATTERN.test(executionId)) {
			return json(400, { error: "Invalid executionId format" });
		}
		if (clientRequestKey && !resolveClientRequestKey(clientRequestKey).ok) {
			return json(400, { error: "Invalid clientRequestKey format" });
		}
		if (reason && reason.length > 500) {
			return json(400, { error: "Invalid control request" });
		}

		let hasTurnHelpers = false;
		let getTurnOwner:
			| typeof dbModule.getConversationTurnOwnerForExecution
			| undefined;
		try {
			hasTurnHelpers =
				typeof dbModule.requestConversationTurnCancel === "function" &&
				typeof dbModule.getConversationTurnForExecution === "function";
			getTurnOwner = dbModule.getConversationTurnOwnerForExecution;
		} catch {
			hasTurnHelpers = false;
		}

		if (
			hasTurnHelpers &&
			(clientRequestKey !== undefined ||
				body.organizationId !== undefined ||
				(session.session as { activeOrganizationId?: unknown })
					?.activeOrganizationId !== undefined)
		) {
			const resolvedOrganization = await resolveTurnOrganization({
				userId,
				requestedOrganizationId: body.organizationId,
				session: session.session,
			});
			if (!resolvedOrganization.ok) {
				return resolvedOrganization.response;
			}
			const organizationId = resolvedOrganization.organizationId;

			if (!executionId && clientRequestKey) {
				const recorded = await dbModule.requestConversationTurnCancel({
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
							message:
								"The message was stopped before it started",
						});
					case "scope_mismatch":
					case "conversation_forbidden":
					case "not_found":
						return json(403, {
							error: "Forbidden",
							message:
								"You are not authorized to cancel this turn",
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

			const targetExecutionId = executionId as string;
			const turn = await dbModule.getConversationTurnForExecution({
				executionId: targetExecutionId,
				userId,
				organizationId,
			});
			if (!turn) {
				if (typeof getTurnOwner === "function") {
					const owner = await getTurnOwner(targetExecutionId);
					if (owner) {
						return json(403, {
							error: "Forbidden",
							message:
								"You are not authorized to cancel this workflow",
						});
					}
				}
			} else {
				if (
					conversationId &&
					(turn.scopeConversationId ?? null) !== conversationId
				) {
					return json(403, {
						error: "Forbidden",
						message:
							"This turn belongs to a different conversation",
					});
				}
				const recorded = await dbModule.requestConversationTurnCancel({
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
						message:
							"You are not authorized to cancel this workflow",
					});
				}
				return cancelTurnInTemporal({
					turn: recorded.turn,
					userId,
					reason,
				});
			}
		}

		const targetExecutionId = executionId as string;
		const { handle, description, organizationId } =
			await getAuthorizedChatRun({
				executionId: targetExecutionId,
				userId,
				engine: "orchestrator",
				action: "cancel",
			});
		if (description.status.name !== "RUNNING") {
			return json(200, {
				success: true,
				executionId: targetExecutionId,
				message: `Workflow already ${description.status.name.toLowerCase()}`,
				alreadyTerminated: true,
			});
		}
		await handle.cancel();
		if (typeof recordAuditFromRequest === "function") {
			await recordAuditFromRequest(
				{
					headers: request.headers,
					user: session.user,
					session: session.session,
				},
				{
					action: "org.chat_run.cancel_requested",
					organizationId,
					resource: { type: "chat_run", id: targetExecutionId },
					metadata: {
						runId: description.runId,
						approvalId: undefined,
						approved: undefined,
					},
				},
			);
		}
		audit({ executionId: targetExecutionId, userId, reason });
		return json(200, {
			success: true,
			executionId: targetExecutionId,
			cancellationRequested: true,
			message: "Workflow cancelled",
		});
	} catch (error) {
		if (error instanceof ChatRunAccessError) {
			return json(error.status, { error: error.message });
		}
		if (isWorkflowNotFound(error)) {
			return json(200, {
				success: true,
				alreadyTerminated: true,
				message: "Workflow not found or already terminated",
			});
		}
		return unavailable({ cancelRecorded: false });
	}
}

export const runtime = "nodejs";
