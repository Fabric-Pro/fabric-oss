import { ORPCError } from "@orpc/server";
import { db } from "@repo/database";
import { executeMicrosoftTeamsTool } from "@repo/integrations/microsoft";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import {
	assertPreflightAllowsRebind,
	classifyProviderError,
	rebindMonitorWorkflow,
	runMonitorPreflight,
} from "../../lib/monitor-reconnect";

/**
 * AUTHORIZATION: `PROJECT_UPDATE` (EDITOR+), deliberately looser than
 * unlinking. Reconnecting destroys nothing, and editors lost the
 * unlink-and-relink workaround when unlinking became admin-only — this is what
 * replaces it (Fizzy #2355).
 *
 * Rebinds this project's Teams chat monitor to the calling user's Microsoft
 * account. See `../../lib/monitor-reconnect` for why the binding exists at all
 * and why the repair is necessarily monitor-wide.
 *
 * Two modes. `preflightOnly` probes each actively scanned chat under the calling
 * user and reports what they cannot see, WITHOUT changing anything. That check
 * is the point: Microsoft grants chat membership per person, so rebinding to
 * someone with narrower access silently shrinks what the project collects, and a
 * shrunken monitor is indistinguishable from a healthy one.
 */
export const reconnectMonitorProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/teams-chat-monitor/reconnect",
		tags: ["Projects", "Teams Chat Monitor"],
		summary: "Reconnect a project's Teams chat monitor",
		description:
			"Checks which linked chats the calling user can reach, and rebinds the monitor to their Microsoft account.",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			/** True = report only. False = rebind. */
			preflightOnly: z.boolean().default(true),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;

		// The organization is a property of the project, not a caller claim.
		const project = await db.project.findFirst({
			where: { id: input.projectId },
			select: {
				id: true,
				organizationId: true,
				teamsChatMonitorIntervalMin: true,
				teamsChatMonitorQuietWindowMin: true,
				teamsChatMonitorWorkflowId: true,
				teamsChatMonitorUserId: true,
			},
		});

		if (!project) {
			throw new ORPCError("NOT_FOUND", { message: "Project not found" });
		}

		const organizationId = project.organizationId ?? undefined;

		// Paused chats are excluded: they are not being scanned, so whether the
		// new account can see them says nothing about the repair.
		const chats = await db.projectLinkedTeamsChat.findMany({
			where: { projectId: input.projectId, deactivatedAt: null },
			select: { id: true, chatId: true, chatTopic: true },
		});

		if (chats.length === 0) {
			throw new ORPCError("BAD_REQUEST", {
				message: "This project has no actively scanned chats.",
			});
		}

		const report = await runMonitorPreflight({
			conversations: chats.map((chat) => ({
				id: chat.chatId,
				label: chat.chatTopic ?? "Untitled chat",
			})),
			// The monitor's OWN fetch, at the smallest page size. Asking a
			// different Graph endpoint is what made the meeting preflight report
			// every meeting as invisible: `/me/onlineMeetings` answers only for
			// the organizer, so it was answering a question nobody had asked.
			probe: async (conversation) => {
				const result = (await executeMicrosoftTeamsTool(
					"list_chat_messages_for_monitor",
					{ chatId: conversation.id, top: 1 },
					user.id,
					organizationId,
				)) as { error?: string };

				return result?.error
					? classifyProviderError(result.error)
					: "reachable";
			},
		});

		if (input.preflightOnly) {
			return {
				mode: "preflight" as const,
				...report,
				currentlyBoundTo: project.teamsChatMonitorUserId,
			};
		}

		assertPreflightAllowsRebind(report, "chat");

		const rebound = await rebindMonitorWorkflow({
			projectId: input.projectId,
			previousWorkflowId: project.teamsChatMonitorWorkflowId,
			cancelSignal: "cancelTeamsChatMonitor",
			workflowType: "teamsChatMonitorWorkflow",
			taskQueue: "ai-chat",
			workflowId: `teams-chat-monitor-${input.projectId}-${Date.now()}`,
			logKey: "teamsChat",
			args: [
				{
					projectId: input.projectId,
					userId: user.id,
					organizationId,
					intervalMinutes: project.teamsChatMonitorIntervalMin ?? 360,
					quietWindowMinutes:
						project.teamsChatMonitorQuietWindowMin ?? 60,
				},
			],
		});

		// The linked rows' own `userId` is deliberately NOT rewritten: it is the
		// Job Hub's tenancy anchor for telemetry rows, never a credential
		// lookup. The account the scan actually runs under is the workflow
		// argument set above.
		await db.project.update({
			where: { id: input.projectId },
			data: {
				teamsChatMonitorEnabled: true,
				teamsChatMonitorWorkflowId: rebound.workflowId,
				teamsChatMonitorUserId: user.id,
			},
		});

		// Failure counters describe the OLD account's access. Leaving them would
		// keep a repaired monitor showing the banner that sent someone here.
		await db.projectLinkedTeamsChat.updateMany({
			where: { projectId: input.projectId },
			data: {
				consecutiveFailures: 0,
				lastErrorMessage: null,
				lastErrorAt: null,
			},
		});

		recordAuditFromRequest(context, {
			action: "project.context_source.reconnected",
			category: "project",
			organizationId,
			projectId: input.projectId,
			resource: { type: "project", id: input.projectId },
			metadata: {
				provider: "MICROSOFT_TEAMS_CHAT",
				previouslyBoundTo: project.teamsChatMonitorUserId,
				reachableCount: report.reachableCount,
				unreachableCount: report.unreachableLabels.length,
			},
		});

		return {
			mode: "reconnected" as const,
			...report,
			workflowId: rebound.workflowId,
			workflowStatus: rebound.status,
			currentlyBoundTo: user.id,
		};
	});
