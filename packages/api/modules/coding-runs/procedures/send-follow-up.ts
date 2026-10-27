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

import { ORPCError } from "@orpc/client";
import {
	addCodingRunEvent,
	getCodingRun,
	getProjectMemberRole,
	isProjectReadOnly,
	updateCodingRunStatus,
} from "@repo/database";
import {
	hasPermission,
	Permissions as ProjectPerms,
	resolveProjectPermissions,
} from "@repo/permissions";
import { READ_ONLY_MODE_ERROR_CODE, READ_ONLY_MODE_MESSAGE } from "@repo/utils";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

export const sendFollowUpProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.AGENT_EXECUTE))
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
			promptId: z.string().uuid(),
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

		// Project-level authorization: only project members with STORY_UPDATE
		// on this specific project can send follow-ups. Middleware above
		// already confirmed AGENT_EXECUTE at the org level.
		const projectRole = await getProjectMemberRole(run.projectId, user.id);
		const projectGranted = resolveProjectPermissions(projectRole);
		if (!hasPermission(projectGranted, ProjectPerms.STORY_UPDATE)) {
			throw new ORPCError("FORBIDDEN", {
				message:
					"You don't have permission to send messages to this session",
			});
		}

		const allowedStatuses = ["RUNNING", "AWAITING_REVIEW", "PR_OPENED"];
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

		if (
			run.provider === "BACKGROUND_AGENTS" &&
			run.providerSessionId &&
			process.env.BACKGROUND_AGENTS_URL
		) {
			try {
				const { getCodingExecutionProvider } = await import(
					"@repo/temporal/coding-execution"
				);
				const provider = getCodingExecutionProvider(run.provider);
				const receipt = await provider.sendPrompt(
					run.providerSessionId,
					input.message,
					user.id,
					{ promptId: input.promptId },
				);
				if (run.status === "AWAITING_REVIEW") {
					await updateCodingRunStatus(run.id, "RUNNING");
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
