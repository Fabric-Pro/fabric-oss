import { ORPCError } from "@orpc/server";
import { db } from "@repo/database";
import { executeSlackTool } from "@repo/integrations/slack";
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
	type ProbeOutcome,
	rebindMonitorWorkflow,
	runMonitorPreflight,
} from "../../lib/monitor-reconnect";

/**
 * Slack errors that describe the CALLER, not one channel.
 *
 * A revoked token makes every probe fail, which without this would report a
 * project's every channel as invisible and recommend against a reconnect that
 * was never the problem. The honest answer is "connect Slack first".
 */
const SLACK_ACCOUNT_ERRORS = [
	"invalid_auth",
	"not_authed",
	"token_revoked",
	"token_expired",
	"account_inactive",
	"missing_scope",
];

/**
 * AUTHORIZATION: `PROJECT_UPDATE` (EDITOR+), deliberately looser than
 * unlinking. Reconnecting destroys nothing, and editors lost the
 * unlink-and-relink workaround when unlinking became admin-only — this is what
 * replaces it (Fizzy #2355).
 *
 * Rebinds this project's Slack channel monitor to the calling user's Slack
 * account. Slack credentials resolve strictly per user — there is no
 * workspace-wide fallback — so a departed colleague's monitor is as dead as a
 * Teams one, and as quiet about it.
 *
 * Huddle-note ingest is rebound in the same call when it is enabled. It reads
 * the same linked rows under the same per-user credentials, so repairing only
 * the channel monitor would leave it dead behind a panel that now looks fixed —
 * the exact silent half-failure this work exists to remove.
 */
export const reconnectMonitorProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/slack-channel-monitor/reconnect",
		tags: ["Projects", "Slack Channel Monitor"],
		summary: "Reconnect a project's Slack channel monitor",
		description:
			"Checks which linked channels the calling user can reach, and rebinds the monitor — and huddle ingest, when enabled — to their Slack account.",
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
				slackChannelMonitorDebounceMs: true,
				slackChannelMonitorMaxHoldMs: true,
				slackChannelMonitorWorkflowId: true,
				slackChannelMonitorUserId: true,
				slackHuddleIngestEnabled: true,
				slackHuddleIngestIntervalMin: true,
				slackHuddleIngestWorkflowId: true,
				slackHuddleIngestEnabledAt: true,
			},
		});

		if (!project) {
			throw new ORPCError("NOT_FOUND", { message: "Project not found" });
		}

		const organizationId = project.organizationId ?? undefined;

		// Paused channels are excluded: they are not being scanned, so whether
		// the new account can see them says nothing about the repair.
		const channels = await db.projectLinkedSlackChannel.findMany({
			where: { projectId: input.projectId, deactivatedAt: null },
			select: { id: true, channelId: true, channelName: true },
		});

		if (channels.length === 0) {
			throw new ORPCError("BAD_REQUEST", {
				message: "This project has no actively scanned channels.",
			});
		}

		const report = await runMonitorPreflight({
			conversations: channels.map((channel) => ({
				id: channel.channelId,
				label: channel.channelName ?? "Untitled channel",
			})),
			// `get_channel_messages` is `conversations.history` on the same
			// credentials the scan uses, at the smallest page size — the
			// monitor's own question rather than a nearby one.
			probe: async (conversation): Promise<ProbeOutcome> => {
				try {
					await executeSlackTool(
						"get_channel_messages",
						{ channelId: conversation.id, limit: 1 },
						user.id,
						organizationId,
					);
					return "reachable";
				} catch (error) {
					const message =
						error instanceof Error ? error.message : String(error);

					// Slack signals everything by throwing, including "your
					// token is gone" — which is not a fact about this channel.
					if (
						SLACK_ACCOUNT_ERRORS.some((code) =>
							message.toLowerCase().includes(code),
						)
					) {
						throw new ORPCError("BAD_REQUEST", {
							message:
								"Your Slack connection is not usable, so we cannot check which channels you can see. Reconnect Slack in your integration settings first.",
						});
					}

					return classifyProviderError(message);
				}
			},
		});

		if (input.preflightOnly) {
			return {
				mode: "preflight" as const,
				...report,
				currentlyBoundTo: project.slackChannelMonitorUserId,
			};
		}

		assertPreflightAllowsRebind(report, "channel");

		const rebound = await rebindMonitorWorkflow({
			projectId: input.projectId,
			previousWorkflowId: project.slackChannelMonitorWorkflowId,
			cancelSignal: "cancelSlackChannelMonitor",
			workflowType: "slackChannelMonitorWorkflow",
			taskQueue: "ai-chat",
			// A fresh id rather than the stable `slack-channel-monitor:<project>`
			// the enable path uses: the old run is cancelled best-effort, and a
			// cancel that did not land would make a reused id collide.
			workflowId: `slack-channel-monitor:${input.projectId}:${Date.now()}`,
			logKey: "slackChannel",
			args: [
				{
					projectId: input.projectId,
					userId: user.id,
					organizationId,
					debounceMs: project.slackChannelMonitorDebounceMs ?? 30000,
					maxHoldMs: project.slackChannelMonitorMaxHoldMs ?? 300000,
				},
			],
		});

		let huddleWorkflowId: string | null = null;
		if (project.slackHuddleIngestEnabled) {
			const huddle = await rebindMonitorWorkflow({
				projectId: input.projectId,
				previousWorkflowId: project.slackHuddleIngestWorkflowId,
				cancelSignal: "cancelSlackHuddleIngest",
				workflowType: "slackHuddleIngestWorkflow",
				taskQueue: "project-documents",
				workflowId: `slack-huddle-ingest-${input.projectId}-${Date.now()}`,
				logKey: "slackHuddleIngest",
				args: [
					{
						projectId: input.projectId,
						userId: user.id,
						organizationId,
						intervalMinutes:
							project.slackHuddleIngestIntervalMin ?? 360,
						// Preserve the forward-only lower bound. Recomputing it
						// as "now" would silently skip every huddle between the
						// original enable and this repair.
						enabledAtMs:
							project.slackHuddleIngestEnabledAt?.getTime(),
					},
				],
			});
			huddleWorkflowId = huddle.workflowId;
		}

		// The linked rows' own `userId` is deliberately NOT rewritten: it is the
		// Job Hub's tenancy anchor for telemetry rows, never a credential
		// lookup. The account the scan actually runs under is the workflow
		// argument set above.
		await db.project.update({
			where: { id: input.projectId },
			data: {
				slackChannelMonitorEnabled: true,
				slackChannelMonitorWorkflowId: rebound.workflowId,
				slackChannelMonitorUserId: user.id,
				...(huddleWorkflowId
					? { slackHuddleIngestWorkflowId: huddleWorkflowId }
					: {}),
			},
		});

		// Failure counters describe the OLD account's access. Leaving them would
		// keep a repaired monitor showing the banner that sent someone here.
		await db.projectLinkedSlackChannel.updateMany({
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
				provider: "SLACK_CHANNEL",
				previouslyBoundTo: project.slackChannelMonitorUserId,
				reachableCount: report.reachableCount,
				unreachableCount: report.unreachableLabels.length,
				huddleIngestRebound: Boolean(huddleWorkflowId),
			},
		});

		return {
			mode: "reconnected" as const,
			...report,
			workflowId: rebound.workflowId,
			workflowStatus: rebound.status,
			huddleIngestRebound: Boolean(huddleWorkflowId),
			currentlyBoundTo: user.id,
		};
	});
