import { createHash } from "node:crypto";
import { recordAuditFromRequest } from "../../../lib/audit";
import { isUniqueConstraintViolation } from "../../../lib/prisma-unique-violation";
import { withCorrelationMemo } from "../../../lib/temporal-correlation";
import {
	remoteServerConnectionId,
	requireRemoteServerAccess,
} from "../lib/remote-server-access";
/**
 * Send Follow-Up Prompt Procedure
 *
 * Sends a follow-up message to an in-progress Fabric Agents session.
 * Used when the agent is in AWAITING_REVIEW state and the user
 * wants to continue or provide additional instructions.
 *
 * AUTHORIZATION: Org-level AGENT_EXECUTE via middleware, PLUS a project-level
 * STORY_UPDATE check inside the handler (the input has only the run id, so
 * the project-scoped middleware can't gate this — resolve the projectId
 * after loading the run and check manually).
 */

import { randomUUID } from "node:crypto";
import { ORPCError } from "@orpc/client";
import {
	addCodingRunEvent,
	canEditProject,
	db,
	getCodingRun,
	isProjectReadOnly,
} from "@repo/database";
import { isFabricAgentsBridgeEnabled } from "@repo/temporal/coding-execution-rollout";
import { READ_ONLY_MODE_ERROR_CODE, READ_ONLY_MODE_MESSAGE } from "@repo/utils";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

export const sendFollowUpProcedure = tenantProtectedProcedure
	.use(requireInputOrgPermission(Permissions.AGENT_EXECUTE))
	.route({
		method: "POST",
		path: "/coding-runs/{id}/follow-up",
		tags: ["CodingRuns"],
		summary: "Send a follow-up prompt to an active agent session",
	})
	.input(
		z.object({
			id: z.string(),
			message: z.string().min(1).max(4000),
			promptId: z.string().uuid().optional(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.output(z.object({ sent: z.boolean(), messageId: z.string().optional() }))
	.handler(async ({ input, context }) => {
		const { user } = context;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const run = await getCodingRun(input.id, user.id, organizationId);
		if (!run) {
			throw new ORPCError("NOT_FOUND", {
				message: "Coding run not found",
			});
		}

		const connectionId = remoteServerConnectionId(run.providerMetadata);
		if (connectionId) {
			await requireRemoteServerAccess({
				id: connectionId,
				projectId: run.projectId,
				userId: context.user.id,
			});
		}

		// Project-level authorization uses the same effective write permission as start.
		// Only callers with STORY_UPDATE
		// on this specific project can send follow-ups. Middleware above
		// already confirmed AGENT_EXECUTE at the org level.
		if (!(await canEditProject(run.projectId, user.id))) {
			throw new ORPCError("FORBIDDEN", {
				message:
					"You don't have permission to send messages to this session",
			});
		}

		const recordedRuntime = (
			run.providerMetadata as Record<string, unknown> | null
		)?.executionRuntime;
		if (
			(recordedRuntime === "fabric-agent-server" &&
				!isFabricAgentsBridgeEnabled()) ||
			(recordedRuntime === "legacy-background-agents" &&
				isFabricAgentsBridgeEnabled())
		) {
			throw new ORPCError("CONFLICT", {
				message:
					"The run's execution mode changed. Restore its original configuration before sending another prompt.",
			});
		}
		const native =
			isFabricAgentsBridgeEnabled() &&
			run.provider === "BACKGROUND_AGENTS" &&
			(run.providerMetadata as Record<string, unknown> | null)
				?.executionRuntime === "fabric-agent-server";
		if (native && input.promptId) {
			const request = await db.codingRunEvent.findUnique({
				where: { id: `follow-up-request:${run.id}:${input.promptId}` },
			});
			if (request) {
				const requestData = request.payloadJson as Record<
					string,
					unknown
				> | null;
				const digest = createHash("sha256")
					.update(input.message)
					.digest("hex");
				if (
					requestData?.digest !== digest ||
					requestData?.authorId !== user.id
				) {
					throw new ORPCError("CONFLICT", {
						message:
							"The follow-up identity is already bound to another request",
					});
				}
				const saved = await db.codingRunEvent.findUnique({
					where: { id: `follow-up:${run.id}:${input.promptId}` },
				});
				if (saved?.providerEventId) {
					return { sent: true, messageId: saved.providerEventId };
				}
			}
		}

		const allowedStatuses = [
			"RUNNING",
			"AWAITING_REVIEW",
			"PR_OPENED",
			...(native ? ["COMPLETED", "STARTING"] : []),
		];
		if (!allowedStatuses.includes(run.status)) {
			throw new ORPCError("BAD_REQUEST", {
				message: `Cannot send follow-up to a session with status: ${run.status}`,
			});
		}

		// Read-only mode: a follow-up drives more commits/PR
		// updates on the connected repository. Same typed block as start
		// (product decision 2026-07-23: code repos ARE in read-only scope).
		if (await isProjectReadOnly(run.projectId)) {
			throw new ORPCError("CONFLICT", {
				message: READ_ONLY_MODE_MESSAGE,
				data: { errorCode: READ_ONLY_MODE_ERROR_CODE },
			});
		}

		if (!isFabricAgentsBridgeEnabled()) {
			const botUrl = process.env.FABRIC_BOT_URL;
			const botSecret = process.env.FABRIC_BOT_SECRET;
			if (!botUrl || !botSecret) {
				throw new ORPCError("SERVICE_UNAVAILABLE", {
					message: "Follow-up messaging is not configured",
				});
			}
			const response = await fetch(`${botUrl}/webhook`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Fabric-Signature": botSecret,
					"X-Trace-Id": randomUUID(),
				},
				body: JSON.stringify({
					action: "prompted",
					codingRunId: run.id,
					workflowId: run.workflowId ?? `coding-run-${run.id}`,
					prompt: input.message,
					organizationId: organizationId ?? null,
				}),
			});
			if (!response.ok) {
				throw new ORPCError("INTERNAL_SERVER_ERROR", {
					message:
						"The legacy service could not accept the follow-up",
				});
			}
			return { sent: true };
		}
		if (!input.promptId) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"A stable promptId is required for native Fabric sessions",
			});
		}

		if (native && !["COMPLETED", "STARTING"].includes(run.status)) {
			throw new ORPCError("CONFLICT", {
				message:
					"Wait for the current turn to finish before continuing it here. Resolve native permission, authentication, and input requests in Fabric Agents.",
				data: { errorCode: "INPUT_REQUIRED" },
			});
		}

		if (
			native &&
			run.providerSessionId &&
			(run.status === "COMPLETED" || run.status === "STARTING")
		) {
			if (!run.organizationId) {
				throw new ORPCError("CONFLICT", {
					message:
						"This native session has no organization binding; reconcile it before continuing.",
				});
			}
			const workflowId = `coding-follow-up-${run.id}-${input.promptId}`;
			const digest = createHash("sha256")
				.update(input.message)
				.digest("hex");
			const reservationId = `follow-up-request:${run.id}:${input.promptId}`;
			const existing = await db.codingRunEvent.findUnique({
				where: { id: reservationId },
			});
			if (existing) {
				const payload = existing.payloadJson as Record<
					string,
					unknown
				> | null;
				if (
					payload?.digest !== digest ||
					payload?.authorId !== user.id
				) {
					throw new ORPCError("CONFLICT", {
						message:
							"The follow-up identity is already bound to another request",
					});
				}
				const saved = await db.codingRunEvent.findUnique({
					where: { id: `follow-up:${run.id}:${input.promptId}` },
				});
				if (saved?.providerEventId) {
					return { sent: true, messageId: saved.providerEventId };
				}
			}
			// Reserve the active slot before starting Temporal. The partial unique index also
			// prevents continuing this session while a newer run owns the same story/task.
			if (run.status === "COMPLETED" && !existing) {
				const { getTemporalClient } = await import("@repo/temporal");
				const temporal = await getTemporalClient();
				try {
					const previous = await temporal.workflow
						.getHandle(run.workflowId ?? `coding-run-${run.id}`)
						.describe();
					if (previous.status.name === "RUNNING") {
						throw new ORPCError("CONFLICT", {
							message:
								"The previous turn is still finishing cleanup. Retry this same follow-up shortly.",
						});
					}
				} catch (error) {
					if (
						!(error instanceof Error) ||
						error.name !== "WorkflowNotFoundError"
					) {
						throw error;
					}
				}
				try {
					await db.$transaction(async (tx) => {
						const claimed = await tx.codingRun.updateMany({
							where: { id: run.id, status: "COMPLETED" },
							data: {
								status: "STARTING",
								workflowId,
								startedAt: new Date(),
								completedAt: null,
							},
						});
						if (!claimed.count) {
							throw new ORPCError("CONFLICT", {
								message:
									"Another continuation has already claimed this session",
							});
						}
						await tx.codingRunEvent.create({
							data: {
								id: reservationId,
								codingRunId: run.id,
								eventType: "follow_up_requested",
								payloadJson: {
									promptId: input.promptId,
									digest,
									authorId: user.id,
								},
							},
						});
					});
				} catch (error) {
					if (isUniqueConstraintViolation(error)) {
						throw new ORPCError("CONFLICT", {
							message:
								"Another coding run already owns this story or task",
						});
					}
					throw error;
				}
				recordAuditFromRequest(context, {
					action: "weave.session.continuation_requested",
					category: "weave",
					organizationId: run.organizationId,
					projectId: run.projectId,
					resource: { type: "coding_run", id: run.id },
					metadata: { promptId: input.promptId, workflowId },
				});
			} else if (!existing && run.workflowId !== workflowId) {
				throw new ORPCError("CONFLICT", {
					message:
						"This session has a different continuation in progress",
				});
			}
			const reserved = await db.codingRunEvent.findUnique({
				where: { id: reservationId },
			});
			const payload = reserved?.payloadJson as Record<
				string,
				unknown
			> | null;
			if (payload?.digest !== digest || payload?.authorId !== user.id) {
				throw new ORPCError("CONFLICT", {
					message:
						"The follow-up identity is already bound to another request",
				});
			}
			const { getTemporalClient } = await import("@repo/temporal");
			const temporal = await getTemporalClient();
			let handle: ReturnType<typeof temporal.workflow.getHandle>;
			try {
				handle = await temporal.workflow.start(
					"codingRunFollowUpWorkflow",
					withCorrelationMemo({
						workflowId,
						taskQueue: "agents",
						workflowIdReusePolicy: "REJECT_DUPLICATE" as const,
						args: [
							{
								codingRunId: run.id,
								providerMetadata: run.providerMetadata,
								projectId: run.projectId,
								organizationId: run.organizationId,
								userId: user.id,
								sessionId: run.providerSessionId,
								content: input.message,
								promptId: input.promptId,
							},
						],
					}),
				);
			} catch (error) {
				if (
					!(error instanceof Error) ||
					error.name !== "WorkflowExecutionAlreadyStartedError"
				) {
					throw error;
				}
				handle = temporal.workflow.getHandle(workflowId);
			}
			// Success still means a durable native receipt, not just a queued workflow.
			for (let attempt = 0; attempt < 10; attempt++) {
				const receipt = await handle.query<{
					messageId: string;
				} | null>("codingFollowUpReceipt");
				if (receipt?.messageId) {
					return { sent: true, messageId: receipt.messageId };
				}
				await new Promise((resolve) => setTimeout(resolve, 500));
			}
			const state = await handle.describe();
			if (state.status.name !== "RUNNING") {
				throw new ORPCError("CONFLICT", {
					message:
						"Continuation requires recovery. Inspect the existing native session and confirm cancellation before starting another run.",
					data: { errorCode: "RECOVERY_REQUIRED" },
				});
			}
			throw new ORPCError("SERVICE_UNAVAILABLE", {
				message:
					"Follow-up queued; retry this same request to recover its receipt. Do not start a replacement session.",
			});
		}

		if (
			run.provider === "BACKGROUND_AGENTS" &&
			run.providerSessionId &&
			process.env.BACKGROUND_AGENTS_URL
		) {
			try {
				const { getCodingExecutionProvider } = await import(
					"@repo/temporal/coding-execution"
				);
				const provider = getCodingExecutionProvider(
					run.provider,
					run.providerMetadata,
				);
				const receipt = await provider.sendPrompt(
					run.providerSessionId,
					input.message,
					user.id,
					{ promptId: input.promptId },
				);
				if (run.status === "AWAITING_REVIEW") {
					await db.codingRun.updateMany({
						where: {
							id: run.id,
							projectId: run.projectId,
							status: "AWAITING_REVIEW",
						},
						data: { status: "RUNNING" },
					});
				}
				await addCodingRunEvent(run.id, "follow_up_sent", {
					authorId: user.id,
					contentLength: input.message.length,
					promptId: input.promptId,
					...(receipt ? { messageId: receipt.messageId } : {}),
				});
				return {
					sent: true,
					...(receipt ? { messageId: receipt.messageId } : {}),
				};
			} catch (error) {
				if (
					error &&
					typeof error === "object" &&
					"code" in error &&
					(error.code === "RECOVERY_REQUIRED" ||
						error.code === "INPUT_REQUIRED")
				) {
					throw new ORPCError("CONFLICT", {
						message:
							error instanceof Error
								? error.message
								: "Open the existing Fabric session to continue.",
						data: { errorCode: error.code },
					});
				}
				throw new ORPCError("INTERNAL_SERVER_ERROR", {
					message: `Failed to send follow-up: ${
						error instanceof Error ? error.message : String(error)
					}`,
				});
			}
		}

		throw new ORPCError("SERVICE_UNAVAILABLE", {
			message: "Follow-up messaging is not configured",
		});
	});
