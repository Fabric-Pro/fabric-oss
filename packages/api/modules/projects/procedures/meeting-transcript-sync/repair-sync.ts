import { ORPCError } from "@orpc/server";
import { clearMeetingSyncFailures, db } from "@repo/database";
import { executeMicrosoftTeamsTool } from "@repo/integrations/microsoft";
import { logger } from "@repo/logs";
import type { getTemporalClient } from "@repo/temporal";
import { z } from "zod";
import { withCorrelationMemo } from "../../../../lib/temporal-correlation";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * Mirrors `DEFAULT_LOOKBACK_DAYS` in the sync activity. The preflight is only
 * honest while it reads the same window the sync reads — a meeting with no
 * occurrence inside it is one the sync would not have picked up either, so
 * reporting it as reachable would be the same lie in the other direction.
 */
const SYNC_LOOKBACK_DAYS = 30;

/**
 * AUTHORIZATION: `PROJECT_UPDATE` (EDITOR+), deliberately looser than
 * unlinking. Repair destroys nothing, and editors lost the unlink-and-relink
 * workaround when unlinking became admin-only — this is what replaces it
 * (Fizzy #2355).
 *
 * Rebinds a project's meeting sync to the calling user's Microsoft account.
 *
 * The sync is ONE project-level Temporal workflow carrying one user's id, so
 * when that person leaves, every meeting in the project stops at once — and
 * silently, because the failed lookup returns an empty list rather than an
 * error. There is no per-meeting owner to transfer; repair is necessarily
 * project-wide.
 *
 * Two modes. `preflight` resolves each linked meeting under the calling user
 * and reports the ones they cannot see, WITHOUT changing anything. That check
 * is the point: Microsoft grants transcript access per person, so rebinding to
 * someone with narrower access silently shrinks what the project collects, and
 * a shrunken sync is indistinguishable from a healthy one.
 */
export const repairSyncProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/meeting-transcript-sync/repair",
		tags: ["Projects", "Meeting Transcript Sync"],
		summary: "Reconnect a project's meeting sync",
		description:
			"Checks which linked meetings the calling user can reach, and rebinds the sync to their Microsoft account.",
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
		// `requireProjectPermission` has already authorized this project for
		// this user, so the authorized row is the only honest source of the
		// tenant — reading it from the input would let a caller choose which
		// tenant this request is accounted to (Fizzy #2355).
		const project = await db.project.findFirst({
			where: { id: input.projectId },
			select: {
				id: true,
				organizationId: true,
				meetingTranscriptSyncEnabled: true,
				meetingTranscriptSyncIntervalMin: true,
				meetingTranscriptSyncWorkflowId: true,
				meetingTranscriptSyncUserId: true,
			},
		});

		if (!project) {
			throw new ORPCError("NOT_FOUND", { message: "Project not found" });
		}

		const organizationId = project.organizationId ?? undefined;

		const meetings = await db.projectLinkedMeeting.findMany({
			where: { projectId: input.projectId, deactivatedAt: null },
			select: { id: true, joinUrl: true, subject: true },
		});

		if (meetings.length === 0) {
			throw new ORPCError("BAD_REQUEST", {
				message: "This project has no actively syncing meetings.",
			});
		}

		// Ask the question the SYNC will ask, with the same call and the same
		// match: one calendar read over the same lookback, then linked join
		// URLs matched case-insensitively — mirroring
		// `listRecentMeetingInstancesForLinkedUrls`.
		//
		// This used to resolve each meeting through `get_meeting_by_join_url`,
		// which answers a DIFFERENT question: that endpoint is
		// `/me/onlineMeetings?$filter=JoinWebUrl eq ...`, and Graph returns a
		// row there only for the meeting's ORGANIZER. Every meeting somebody
		// else organized — which is most of them — came back empty and was
		// reported as invisible, so the preflight told people their whole
		// project would stop syncing when nothing was wrong with it at all.
		const lookbackDays = SYNC_LOOKBACK_DAYS;
		const startDate = new Date(
			Date.now() - lookbackDays * 24 * 60 * 60 * 1000,
		).toISOString();

		let calendar: {
			meetings?: Array<{ joinUrl?: string | null }>;
			error?: string;
		};
		try {
			calendar = (await executeMicrosoftTeamsTool(
				"list_calendar_meetings",
				{ daysBack: lookbackDays, startDate },
				user.id,
				organizationId ?? undefined,
			)) as typeof calendar;
		} catch (error) {
			// "We could not check" is not "you can see nothing". Reporting the
			// latter is what made the old preflight recommend against a repair
			// that would have worked.
			logger.error("meeting.repair.preflight_calendar_failed", {
				projectId: input.projectId,
				error,
			});
			throw new ORPCError("SERVICE_UNAVAILABLE", {
				message:
					"Could not read your Microsoft calendar, so we cannot tell which meetings would keep syncing. Try again.",
			});
		}

		if (calendar?.error) {
			throw new ORPCError("BAD_REQUEST", {
				message: `Could not read your Microsoft calendar: ${calendar.error}`,
			});
		}

		const visibleJoinUrls = new Set(
			(calendar?.meetings ?? [])
				.map((m) => m.joinUrl?.toLowerCase())
				.filter((url): url is string => Boolean(url)),
		);

		const unreachable = meetings
			.filter((m) => !visibleJoinUrls.has(m.joinUrl.toLowerCase()))
			.map((m) => ({ subject: m.subject }));

		const reachableCount = meetings.length - unreachable.length;

		if (input.preflightOnly) {
			return {
				mode: "preflight" as const,
				totalMeetings: meetings.length,
				reachableCount,
				unreachableSubjects: unreachable.map((m) => m.subject),
				currentlyBoundTo: project.meetingTranscriptSyncUserId,
			};
		}

		if (reachableCount === 0) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"None of this project's meetings are visible to your Microsoft account, so reconnecting would stop the sync entirely.",
			});
		}

		const temporal = await import("@repo/temporal");
		let client: Awaited<ReturnType<typeof getTemporalClient>>;
		try {
			client = await temporal.getTemporalClient();
		} catch (error) {
			logger.error("meeting.repair.temporal_unavailable", {
				projectId: input.projectId,
				error,
			});
			throw new ORPCError("SERVICE_UNAVAILABLE", {
				message: "Could not reach the workflow service. Try again.",
			});
		}

		// Cancel the old workflow best-effort — it may already be gone. A
		// failed cancel is survivable: transcript ingestion is idempotent
		// (isTranscriptAlreadySynced + hasTranscriptNearOccurrence + the
		// transcript unique key), so two workflows racing costs Graph calls,
		// not duplicated or lost data.
		if (project.meetingTranscriptSyncWorkflowId) {
			try {
				const handle = client.workflow.getHandle(
					project.meetingTranscriptSyncWorkflowId,
				);
				await handle.signal("cancelMeetingTranscriptSync");
				await handle.cancel();
			} catch (error) {
				logger.warn("meeting.repair.old_workflow_cancel_failed", {
					projectId: input.projectId,
					workflowId: project.meetingTranscriptSyncWorkflowId,
					error,
				});
			}
		}

		const intervalMinutes = project.meetingTranscriptSyncIntervalMin ?? 60;
		const workflowId = `meeting-transcript-sync-${input.projectId}-${Date.now()}`;

		const handle = await client.workflow.start(
			"meetingTranscriptSyncWorkflow",
			withCorrelationMemo({
				taskQueue: "project-documents",
				workflowId,
				args: [
					{
						projectId: input.projectId,
						userId: user.id,
						organizationId: organizationId ?? undefined,
						intervalMinutes,
					},
				],
			}),
		);

		// Confirm it is actually running before reporting success — otherwise
		// repair can report a rebind that never happened.
		const description = await client.workflow
			.getHandle(handle.workflowId)
			.describe();

		await db.project.update({
			where: { id: input.projectId },
			data: {
				meetingTranscriptSyncEnabled: true,
				meetingTranscriptSyncWorkflowId: handle.workflowId,
				meetingTranscriptSyncUserId: user.id,
			},
		});

		await clearMeetingSyncFailures(input.projectId);

		return {
			mode: "repaired" as const,
			totalMeetings: meetings.length,
			reachableCount,
			unreachableSubjects: unreachable.map((m) => m.subject),
			workflowId: handle.workflowId,
			workflowStatus: description.status.name,
			currentlyBoundTo: user.id,
		};
	});
