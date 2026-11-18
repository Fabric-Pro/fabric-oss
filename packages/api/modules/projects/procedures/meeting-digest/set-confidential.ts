import { ORPCError } from "@orpc/server";
import { db, retireContextSummariesCoveringSeries } from "@repo/database";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * Mark one linked series confidential, or not. A confidential series'
 * transcripts stay out of every later answer, recap and agenda; the
 * transcripts themselves are kept.
 *
 * The same permission as the series' other Parlume settings. The
 * organization is the loaded project's, never the caller's input.
 */
export const setConfidentialProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_MEMBERS_MANAGE))
	.route({
		method: "PATCH",
		path: "/projects/{projectId}/meeting-digest/{linkedMeetingId}/confidential",
		tags: ["Projects", "Meeting Digest"],
		summary:
			"Keep a linked series' transcripts out of later answers, recaps and agendas",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			linkedMeetingId: z.string(),
			confidential: z.boolean(),
		}),
	)
	.handler(async ({ input, context }) => {
		const project = await db.project.findFirst({
			where: { id: input.projectId },
			select: { organizationId: true },
		});
		if (!project?.organizationId) {
			throw new ORPCError("NOT_FOUND", { message: "Project not found" });
		}
		const series = await db.projectLinkedMeeting.findFirst({
			where: { id: input.linkedMeetingId, projectId: input.projectId },
			select: { id: true, subject: true },
		});
		if (!series) {
			throw new ORPCError("NOT_FOUND", {
				message: "Linked meeting not found",
			});
		}

		const updated = await db.projectLinkedMeeting.update({
			where: { id: series.id },
			data: { confidential: input.confidential },
			select: { confidential: true },
		});
		if (updated.confidential) {
			await retireContextSummariesCoveringSeries({
				projectId: input.projectId,
				linkedMeetingId: series.id,
			});
		}

		recordAuditFromRequest(context, {
			action: "project.meeting_digest.confidentiality_changed",
			category: "project",
			organizationId: project.organizationId,
			projectId: input.projectId,
			resource: {
				type: "linked_meeting",
				id: series.id,
				...(series.subject ? { name: series.subject } : {}),
			},
			metadata: { confidential: updated.confidential },
		});

		return {
			linkedMeetingId: series.id,
			confidential: updated.confidential,
		};
	});
