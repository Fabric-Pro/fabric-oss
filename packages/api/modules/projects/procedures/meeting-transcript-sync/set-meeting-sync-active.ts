import { ORPCError } from "@orpc/server";
import {
	db,
	deactivateLinkedMeeting,
	reactivateLinkedMeeting,
} from "@repo/database";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * AUTHORIZATION: `PROJECT_SETTINGS_EDIT` (project admins and owners).
 *
 * Stopping a meeting's sync is not destructive, but it is the non-destructive
 * half of a pair whose other half destroys context, and holding both to the
 * same floor is what keeps the menu legible: everything that changes whether a
 * meeting feeds the project is an admin action. Linking deliberately stays at
 * `PROJECT_UPDATE` — a team member may need to add a meeting the owner was not
 * in (Fizzy #2355).
 *
 * "Stop syncing" writes one nullable timestamp and nothing else. No transcript,
 * no context, no vector is touched, which is the entire point: it is the answer
 * to "I want this meeting to stop pulling in new occurrences, and I want to keep
 * everything it already gave me."
 */
export const setMeetingSyncActiveProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_SETTINGS_EDIT))
	.route({
		method: "POST",
		path: "/projects/{projectId}/meeting-transcript-sync/set-active",
		tags: ["Projects", "Meeting Transcript Sync"],
		summary: "Start or stop syncing a linked meeting",
		description:
			"Stops future transcript syncing for a linked meeting while keeping every transcript and context it has already captured, or resumes it.",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			linkedMeetingId: z.string(),
			active: z.boolean(),
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
			select: { id: true, organizationId: true },
		});

		if (!project) {
			throw new ORPCError("NOT_FOUND", {
				message: "Project not found",
			});
		}

		const organizationId = project.organizationId ?? undefined;

		// Scoped by projectId as well as id: the id alone would let a caller in
		// one project stop a meeting linked to another.
		const meeting = await db.projectLinkedMeeting.findFirst({
			where: { id: input.linkedMeetingId, projectId: input.projectId },
			select: { id: true },
		});

		if (!meeting) {
			throw new ORPCError("NOT_FOUND", {
				message: "Linked meeting not found",
			});
		}

		const updated = input.active
			? await reactivateLinkedMeeting({
					projectId: input.projectId,
					linkedMeetingId: input.linkedMeetingId,
				})
			: await deactivateLinkedMeeting({
					projectId: input.projectId,
					linkedMeetingId: input.linkedMeetingId,
					userId: user.id,
				});

		recordAuditFromRequest(context, {
			action: "project.meeting.sync_stopped",
			category: "project",
			organizationId,
			projectId: input.projectId,
			resource: { type: "linked_meeting", id: input.linkedMeetingId },
			metadata: { active: input.active },
		});

		return {
			success: true,
			linkedMeetingId: updated.id,
			deactivatedAt: updated.deactivatedAt,
		};
	});
