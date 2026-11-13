import { ORPCError } from "@orpc/server";
import { db, LINKED_MEETING_SOURCE } from "@repo/database";
import { z } from "zod";
import { assertInputOrgMatchesProject } from "../../../../lib/authorized-project-tenant";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * Correct a meeting's title or date (Fizzy #3507, FR13 and FR16).
 *
 * A transcript imported from a folder takes its title from the file name and
 * its date from the file, or has no date at all. People fix both here, and a
 * meeting given a date leaves the digest's "Unknown date" list for its day.
 *
 * Only the digest's own record changes: the transcript text, and what was
 * extracted from it, stay as they were read. A file's meeting is its own
 * series, so the series takes the new title too; a Teams series is shared by
 * every occurrence and keeps its name.
 *
 * AUTHORIZATION: PROJECT_SETTINGS_EDIT, the same as choosing what the digest
 * includes.
 */
export const updateMeetingDetailsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_SETTINGS_EDIT))
	.route({
		method: "POST",
		path: "/projects/{projectId}/meeting-digest/meetings/{transcriptId}/details",
		tags: ["Projects", "Meeting Digest"],
		summary: "Correct a meeting's title or date",
	})
	.input(
		z
			.object({
				projectId: z.string(),
				organizationId: z.string().nullable().optional(),
				transcriptId: z.string().min(1),
				meetingSubject: z.string().trim().min(1).max(255).optional(),
				/** A day, or null to say the date is not known. */
				meetingDate: z.coerce.date().nullable().optional(),
			})
			.refine(
				(input) =>
					input.meetingSubject !== undefined ||
					input.meetingDate !== undefined,
				{ message: "Nothing to change" },
			),
	)
	.handler(async ({ input }) => {
		const project = await db.project.findUnique({
			where: { id: input.projectId },
			select: { id: true, organizationId: true },
		});
		if (!project) {
			throw new ORPCError("NOT_FOUND", { message: "Project not found" });
		}
		assertInputOrgMatchesProject(input.organizationId, project);

		// The same key `getMeeting` reads, so the detail sheet and the
		// "Unknown date" list both name a meeting the one way.
		const transcript = await db.projectMeetingTranscript.findFirst({
			where: {
				projectId: input.projectId,
				transcriptId: input.transcriptId,
			},
			select: {
				id: true,
				linkedMeetingId: true,
				linkedMeeting: { select: { source: true } },
			},
		});
		if (!transcript) {
			throw new ORPCError("NOT_FOUND", { message: "Meeting not found" });
		}

		const updated = await db.$transaction(async (tx) => {
			const record = await tx.projectMeetingTranscript.update({
				where: { id: transcript.id },
				data: {
					...(input.meetingSubject !== undefined
						? { meetingSubject: input.meetingSubject }
						: {}),
					...(input.meetingDate !== undefined
						? { meetingDate: input.meetingDate }
						: {}),
				},
				select: { id: true, meetingSubject: true, meetingDate: true },
			});
			if (
				input.meetingSubject !== undefined &&
				transcript.linkedMeeting.source !== LINKED_MEETING_SOURCE.TEAMS
			) {
				await tx.projectLinkedMeeting.update({
					where: { id: transcript.linkedMeetingId },
					data: { subject: input.meetingSubject },
				});
			}
			return record;
		});

		return updated;
	});
