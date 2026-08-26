import { ORPCError } from "@orpc/server";
import { db } from "@repo/database";
import { z } from "zod";
import { withCorrelationMemo } from "../../../../lib/temporal-correlation";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * AUTHORIZATION: Uses canEditProject() — only project owners/editors can
 * enable the Slack channel monitor.
 *
 * Enables the event-driven Slack channel monitor:
 *   1. Cancels any prior workflow on this project (best-effort; signal first
 *      for graceful drain, then `cancel()` as a hard stop).
 *   2. Starts `slackChannelMonitorWorkflow` with the workflow id convention
 *      `slack-channel-monitor:<projectId>` and `AllowDuplicate` reuse policy
 *      so a retry isn't blocked by a fresh-history-needs-a-new-id check.
 *   3. Flips `Project.slackChannelMonitorEnabled = true` and persists the
 *      workflow id so the webhook fanout helper can resolve the handle.
 *   4. Marks every `ProjectLinkedSlackChannel` row as `monitorEnabled = true`
 *      so the webhook fanout's `WHERE monitorEnabled = true` lookup includes
 *      them from the moment events start flowing.
 *   5. For each linked channel still pending backfill (`backfillCompleteAt IS
 *      NULL`), starts the `slackChannelBackfillWorkflow` as a child. Track 2
 *      throttles these via a per-workspace semaphore so a 10-channel enable
 *      doesn't blow Slack rate limits.
 *
 * The monitorEnabledAt timestamp is set BEFORE the workflow starts so any
 * webhook event arriving during the backfill window is captured; the
 * seen-message INSERT inside the analyze activity is the dedup boundary
 * (not a timestamp gate).
 */
export const enableSlackChannelMonitorProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/slack-channel-monitor/enable",
		tags: ["Projects", "Slack Channel Monitor"],
		summary: "Enable Slack channel monitor",
		description:
			"Starts an event-driven Temporal workflow for the Slack channel monitor.",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			// Debounce window: signals received within this window are batched
			// before the workflow drains its queue. Defaults match the schema.
			debounceMs: z.number().min(0).max(600_000).default(30_000),
			// Max hold window: never wait longer than this before flushing
			// (bounds staleness when traffic is sustained).
			maxHoldMs: z.number().min(1_000).max(3_600_000).default(300_000),
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
				slackChannelMonitorWorkflowId: true,
			},
		});

		if (!project) {
			throw new ORPCError("NOT_FOUND", {
				message: "Project not found",
			});
		}

		const linkedChannels = await db.projectLinkedSlackChannel.findMany({
			where: { projectId: input.projectId },
			select: {
				id: true,
				slackTeamId: true,
				channelId: true,
				channelName: true,
				channelWebUrl: true,
				backfillCompleteAt: true,
				monitorEnabledAt: true,
				lastMessageTs: true,
			},
		});

		if (linkedChannels.length === 0) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"At least one Slack channel must be linked before enabling the monitor",
			});
		}

		// Cancel any prior workflow — signal first for graceful drain (the
		// workflow drains its queue once, then exits), then hard cancel. Both
		// can throw if the workflow has already terminated; both are
		// best-effort. The atomic guarantee that a re-enable never collides
		// with a still-running run is `workflowIdConflictPolicy:
		// "TERMINATE_EXISTING"` on the start() below — cancel() only *requests*
		// cancellation and returns before the run closes, so without the
		// conflict policy the immediate start() would race it and throw
		// WorkflowExecutionAlreadyStarted (surfacing as a 500 on every other
		// save).
		if (project.slackChannelMonitorWorkflowId) {
			try {
				const { getTemporalClient } = await import("@repo/temporal");
				const client = await getTemporalClient();
				const handle = client.workflow.getHandle(
					project.slackChannelMonitorWorkflowId,
				);
				await handle.signal("cancelSlackChannelMonitor");
				await handle.cancel();
			} catch {
				// Already complete / cancelled — non-fatal.
			}
		}

		// Workflow id convention: `slack-channel-monitor:<projectId>` so the
		// webhook fanout helper can construct the id without a DB lookup when
		// the persisted `slackChannelMonitorWorkflowId` column is null. The
		// AllowDuplicate reuse policy means a re-enable after a normal
		// completion doesn't trip Temporal's id-collision rule.
		const workflowId = `slack-channel-monitor:${input.projectId}`;

		const { getTemporalClient } = await import("@repo/temporal");
		const client = await getTemporalClient();

		const handle = await client.workflow.start(
			"slackChannelMonitorWorkflow",
			withCorrelationMemo({
				taskQueue: "ai-chat",
				workflowId,
				workflowIdReusePolicy: "ALLOW_DUPLICATE",
				// Atomically terminate any still-running run with this id and
				// start fresh with the new debounce/maxHold args. Without this,
				// a re-enable racing the best-effort cancel() above throws
				// WorkflowExecutionAlreadyStarted on every other save.
				workflowIdConflictPolicy: "TERMINATE_EXISTING",
				args: [
					{
						projectId: input.projectId,
						userId: user.id,
						organizationId: project.organizationId ?? undefined,
						debounceMs: input.debounceMs,
						maxHoldMs: input.maxHoldMs,
					},
				],
			}),
		);

		// Mark `monitorEnabledAt` on every linked-channel row (so the seen-
		// message dedup window is well-defined) and flip `monitorEnabled = true`
		// so the webhook fanout lookup picks them up immediately.
		const now = new Date();
		await db.$transaction([
			db.project.update({
				where: { id: input.projectId, ...tenantFilter },
				data: {
					slackChannelMonitorEnabled: true,
					slackChannelMonitorWorkflowId: handle.workflowId,
					slackChannelMonitorDebounceMs: input.debounceMs,
					slackChannelMonitorMaxHoldMs: input.maxHoldMs,
				},
			}),
			db.projectLinkedSlackChannel.updateMany({
				where: { projectId: input.projectId },
				data: {
					monitorEnabled: true,
					// Only set monitorEnabledAt the first time it transitions
					// from null → now; preserve the original timestamp across
					// re-enables so the seen-message window stays anchored.
				},
			}),
			// Anchor monitorEnabledAt for rows where it hasn't been set yet.
			db.projectLinkedSlackChannel.updateMany({
				where: {
					projectId: input.projectId,
					monitorEnabledAt: null,
				},
				data: {
					monitorEnabledAt: now,
				},
			}),
		]);

		// Kick off a backfill child workflow for every linked channel that
		// hasn't completed one yet. The backfill workflow is registered by
		// Track 2; we pass per-channel context and let it own pagination,
		// `Retry-After` back-off, and per-thread analyze dispatch.
		const channelsNeedingBackfill = linkedChannels.filter(
			(c) => c.backfillCompleteAt === null,
		);
		const backfillWorkflowIds: string[] = [];
		// Default backfill window when the linked row has no cursor: 7 days.
		// from-now-linked channels carry an anchored `lastMessageTs` so the
		// workflow scans nothing earlier; latest-7-days-linked channels have
		// `lastMessageTs = null` and fall back to this lookback.
		const DEFAULT_BACKFILL_HOURS = 24 * 7;
		for (const channel of channelsNeedingBackfill) {
			const backfillWorkflowId = `slack-channel-backfill:${input.projectId}:${channel.id}:${Date.now()}`;
			try {
				await client.workflow.start(
					"slackChannelBackfillWorkflow",
					withCorrelationMemo({
						taskQueue: "ai-chat",
						workflowId: backfillWorkflowId,
						workflowIdReusePolicy: "ALLOW_DUPLICATE",
						args: [
							{
								projectId: input.projectId,
								linkedChannelId: channel.id,
								slackTeamId: channel.slackTeamId,
								channelId: channel.channelId,
								channelName: channel.channelName ?? undefined,
								channelWebUrl:
									channel.channelWebUrl ?? undefined,
								userId: user.id,
								organizationId:
									project.organizationId ?? undefined,
								fromLastMessageTs:
									channel.lastMessageTs ?? undefined,
								defaultBackfillHours: channel.lastMessageTs
									? undefined
									: DEFAULT_BACKFILL_HOURS,
								source: "enable" as const,
							},
						],
					}),
				);
				backfillWorkflowIds.push(backfillWorkflowId);
			} catch (err) {
				// One channel's backfill start failing doesn't block the others.
				// The user will see this channel's `backfillCompleteAt` stay null
				// and can re-trigger via `trigger-monitor-now`.
				console.error(
					"[slack-channel-monitor] backfill start failed",
					{
						projectId: input.projectId,
						linkedChannelId: channel.id,
						channelId: channel.channelId,
					},
					err,
				);
			}
		}

		return {
			workflowId: handle.workflowId,
			status: "enabled" as const,
			debounceMs: input.debounceMs,
			maxHoldMs: input.maxHoldMs,
			backfillWorkflowIds,
		};
	});
