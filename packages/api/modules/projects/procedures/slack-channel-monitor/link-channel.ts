import { ORPCError } from "@orpc/server";
import { db, ensureSlackChannelIntegrationContext } from "@repo/database";
import { getSlackCredentials } from "@repo/integrations/slack";
import { z } from "zod";
import { withCorrelationMemo } from "../../../../lib/temporal-correlation";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * Resolve the Slack workspace id for a credential set. Prefers the value
 * persisted on the WorkflowIntegration (OAuth flow path) and falls back to
 * Slack's `auth.test` API when only the bot token is stored (direct
 * bot-token connections from before the OAuth metadata capture landed).
 */
async function resolveSlackTeamMetadata(
	accessToken: string,
	teamId: string | undefined,
	teamName: string | undefined,
): Promise<{ teamId: string; teamName?: string }> {
	if (teamId) {
		return { teamId, teamName };
	}
	const response = await fetch("https://slack.com/api/auth.test", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${accessToken}`,
			"Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
		},
	});
	if (!response.ok) {
		throw new ORPCError("BAD_GATEWAY", {
			message: `Slack auth.test failed: ${response.status}`,
		});
	}
	const data = (await response.json()) as {
		ok: boolean;
		team?: string;
		team_id?: string;
		error?: string;
	};
	if (!data.ok || !data.team_id) {
		throw new ORPCError("BAD_REQUEST", {
			message: `Could not resolve Slack workspace id (${data.error ?? "unknown"}). Reconnect Slack in Settings > Integrations.`,
		});
	}
	return { teamId: data.team_id, teamName: teamName ?? data.team };
}

/**
 * AUTHORIZATION: Uses canEditProject() — only project owners/editors can link
 * Slack channels to a project.
 *
 * Links a Slack channel to a project for the event-driven channel monitor
 * workflow. Idempotent on (projectId, slackTeamId, channelId).
 *
 * If the project's monitor is **disabled**, the linked row is created with
 * `monitorEnabled = false`; the project-level enable procedure flips them
 * and kicks off backfill.
 *
 * If the project's monitor is **already enabled**, the linked row is created
 * with `monitorEnabled = true` and `monitorEnabledAt = now`, and a backfill
 * workflow is started immediately so the channel doesn't sit idle until the
 * user re-runs the enable flow.
 *
 * `slackTeamId` is optional: when omitted (the UI picker doesn't have it),
 * we resolve it from stored credentials or — for direct bot-token links
 * that don't persist workspace metadata — Slack's `auth.test` endpoint.
 *
 * `backfillMode` controls the initial `lastMessageTs` cursor on the linked
 * row so the subsequent backfill scans only the window the user picked:
 * `from-now` zeroes the historical window; `latest-7-days` (the default)
 * leaves the cursor null so the backfill activity uses its own 7-day
 * lookback default.
 */
export const linkChannelProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/slack-channel-monitor/link",
		tags: ["Projects", "Slack Channel Monitor"],
		summary: "Link a Slack channel to a project",
		description:
			"Links a Slack channel to a project for event-driven monitoring.",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			slackTeamId: z.string().optional(),
			channelId: z.string(),
			channelName: z.string().optional(),
			teamName: z.string().optional(),
			channelWebUrl: z.string().optional(),
			backfillMode: z
				.enum(["from-now", "latest-7-days"])
				.default("latest-7-days"),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const tenantFilter = organizationId
			? { organizationId }
			: { organizationId: null, userId: user.id };

		const project = await db.project.findFirst({
			where: { id: input.projectId, ...tenantFilter },
			select: {
				id: true,
				organizationId: true,
				slackChannelMonitorEnabled: true,
			},
		});

		if (!project) {
			throw new ORPCError("NOT_FOUND", {
				message: "Project not found",
			});
		}

		let slackTeamId = input.slackTeamId;
		let teamName = input.teamName;
		if (!slackTeamId) {
			const creds = await getSlackCredentials(
				user.id,
				organizationId ?? undefined,
			);
			const resolved = await resolveSlackTeamMetadata(
				creds.accessToken,
				creds.teamId,
				teamName ?? creds.teamName,
			);
			slackTeamId = resolved.teamId;
			teamName = resolved.teamName;
		}

		// from-now: anchor the cursor to "now" so the backfill workflow
		// resolves oldestTs = now and scans nothing earlier. latest-7-days:
		// leave the cursor null so the backfill uses its lookback default.
		const initialLastMessageTs =
			input.backfillMode === "from-now"
				? `${Math.floor(Date.now() / 1000)}.000000`
				: null;

		const monitorEnabled = project.slackChannelMonitorEnabled === true;
		const now = new Date();

		// Detect whether this is a fresh link vs an idempotent re-link so we
		// know whether to start a backfill. An existing row with
		// `backfillCompleteAt` already populated should not retrigger backfill.
		const existing = await db.projectLinkedSlackChannel.findUnique({
			where: {
				projectId_slackTeamId_channelId: {
					projectId: input.projectId,
					slackTeamId,
					channelId: input.channelId,
				},
			},
			select: { id: true, backfillCompleteAt: true },
		});
		const shouldKickoffBackfill =
			monitorEnabled &&
			(!existing || existing.backfillCompleteAt === null);

		const linked = await db.projectLinkedSlackChannel.upsert({
			where: {
				projectId_slackTeamId_channelId: {
					projectId: input.projectId,
					slackTeamId,
					channelId: input.channelId,
				},
			},
			create: {
				projectId: input.projectId,
				slackTeamId,
				channelId: input.channelId,
				channelName: input.channelName,
				teamName,
				channelWebUrl: input.channelWebUrl,
				lastMessageTs: initialLastMessageTs,
				monitorEnabled,
				monitorEnabledAt: monitorEnabled ? now : null,
				userId: user.id,
				organizationId: organizationId ?? null,
			},
			update: {
				channelName: input.channelName,
				teamName,
				channelWebUrl: input.channelWebUrl,
				// If the project monitor is enabled but this row had been
				// linked while disabled, flip it on now so the webhook
				// fanout's `monitorEnabled = true` filter picks it up.
				...(monitorEnabled
					? {
							monitorEnabled: true,
							monitorEnabledAt: existing?.backfillCompleteAt
								? undefined
								: now,
						}
					: {}),
			},
		});

		// Register the channel as a ProjectContext INTEGRATION row if it has
		// none. Linking from Project Settings wrote only the monitor row, so
		// those channels had no context row at all — and conversation capture
		// hangs its bundles off exactly that row, which made capture a
		// permanent no-op for them (Fizzy #2228). Teams has done this since it
		// gained the same picker gap; this is its Slack counterpart.
		//
		// At LINK time, deliberately, and never from the capture path: capture
		// finding no parent is the correct outcome for a channel the user just
		// unlinked, and an ensure there would resurrect the row mid-run.
		//
		// Idempotent — a second link of the same channel matches the existing
		// row on `metadata.channelId` and creates nothing. Best-effort: the
		// monitor link is the primary action and must not fail over this.
		try {
			await ensureSlackChannelIntegrationContext({
				projectId: input.projectId,
				channelId: input.channelId,
				channelName: input.channelName,
				slackTeamId,
				teamName,
				channelWebUrl: input.channelWebUrl,
				userId: user.id,
				organizationId: organizationId ?? undefined,
			});
		} catch (contextErr) {
			console.error(
				"[slack-channel-monitor:link] failed to register integration context",
				{
					projectId: input.projectId,
					channelId: input.channelId,
				},
				contextErr,
			);
		}

		// A Slack channel added via the Add Context dialog leaves a
		// metadata-only SLACK INTEGRATION context row in PENDING (the create
		// procedure can't link Slack — it lacks slackTeamId). Now that the
		// link succeeded, flip that row to COMPLETED so its "Pending" pill
		// resolves to "Ready". No-op when linking from Settings (no such row).
		// Best-effort: never fail the link over a status update.
		try {
			await db.projectContext.updateMany({
				where: {
					projectId: input.projectId,
					type: "INTEGRATION",
					extractionStatus: { in: ["PENDING", "EXTRACTING"] },
					metadata: { path: ["channelId"], equals: input.channelId },
				},
				data: {
					extractionStatus: "COMPLETED",
					extractedAt: new Date(),
				},
			});
		} catch (statusErr) {
			console.error(
				"[linkChannel] failed to mark Slack context COMPLETED",
				statusErr,
			);
		}

		// If the project's monitor is already running, kick off backfill for
		// this channel directly. The backfill workflow uses unique workflow
		// ids and the seen-message INSERT-as-lock is idempotent, so a
		// concurrent call here is safe.
		if (shouldKickoffBackfill) {
			try {
				const { getTemporalClient } = await import("@repo/temporal");
				const client = await getTemporalClient();
				const backfillWorkflowId = `slack-channel-backfill:${input.projectId}:${linked.id}:${Date.now()}`;
				await client.workflow.start(
					"slackChannelBackfillWorkflow",
					withCorrelationMemo({
						taskQueue: "ai-chat",
						workflowId: backfillWorkflowId,
						workflowIdReusePolicy: "ALLOW_DUPLICATE",
						args: [
							{
								projectId: input.projectId,
								linkedChannelId: linked.id,
								slackTeamId,
								channelId: input.channelId,
								channelName: input.channelName,
								channelWebUrl: input.channelWebUrl,
								userId: user.id,
								organizationId:
									project.organizationId ?? undefined,
								fromLastMessageTs:
									initialLastMessageTs ?? undefined,
								defaultBackfillHours: initialLastMessageTs
									? undefined
									: 24 * 7,
								source: "enable" as const,
							},
						],
					}),
				);
			} catch (err) {
				// Not fatal — the channel is still linked and the user can
				// re-trigger backfill via "Monitor now". Surface in logs so
				// it's diagnosable.
				console.error(
					"[slack-channel-monitor:link] backfill kickoff failed",
					{
						projectId: input.projectId,
						linkedChannelId: linked.id,
						channelId: input.channelId,
					},
					err,
				);
			}
		}

		return linked;
	});
