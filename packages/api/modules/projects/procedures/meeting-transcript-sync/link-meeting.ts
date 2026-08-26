import { ORPCError } from "@orpc/server";
import { db, linkMeetingToProject } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * AUTHORIZATION: Uses canEditProject() - only project owners/editors can link meetings.
 *
 * Links a recurring Teams meeting to a project for transcript sync.
 * Upserts on projectId + joinUrl so re-linking the same meeting updates metadata.
 */
export const linkMeetingProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/meeting-transcript-sync/link",
		tags: ["Projects", "Meeting Transcript Sync"],
		summary: "Link a meeting to a project",
		description:
			"Links a recurring Teams meeting to a project for transcript sync. Upserts on projectId + joinUrl.",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			joinUrl: z.string().url(),
			subject: z.string().optional(),
			organizer: z.string().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Verify project exists in tenant context.
		// Authorization enforced by `requireProjectPermission` above.
		const project = await db.project.findFirst({
			where: {
				id: input.projectId,
				...(organizationId
					? { organizationId }
					: { organizationId: null, userId: user.id }),
			},
			select: { id: true },
		});

		if (!project) {
			throw new ORPCError("NOT_FOUND", {
				message: "Project not found",
			});
		}

		const linkedMeeting = await linkMeetingToProject({
			projectId: input.projectId,
			joinUrl: input.joinUrl,
			subject: input.subject,
			organizer: input.organizer,
			userId: user.id,
			organizationId,
		});

		return linkedMeeting;
	});
