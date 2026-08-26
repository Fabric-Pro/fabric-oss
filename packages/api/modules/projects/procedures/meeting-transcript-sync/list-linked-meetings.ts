import { ORPCError } from "@orpc/server";
import { db, hasProjectAccess } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * AUTHORIZATION: Uses hasProjectAccess() - any project member can view linked meetings.
 *
 * Lists all meetings linked to a project, including transcript counts per meeting.
 */
export const listLinkedMeetingsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/meeting-transcript-sync/linked",
		tags: ["Projects", "Meeting Transcript Sync"],
		summary: "List linked meetings for a project",
		description:
			"Returns all meetings linked to a project with their transcript counts.",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const access = await hasProjectAccess(
			input.projectId,
			user.id,
			organizationId,
		);
		if (!access) {
			throw new ORPCError("FORBIDDEN", {
				message: "You do not have access to this project",
			});
		}

		const linkedMeetings = await db.projectLinkedMeeting.findMany({
			where: { projectId: input.projectId },
			include: {
				_count: {
					select: { transcripts: true },
				},
			},
			orderBy: { linkedAt: "desc" },
		});

		return linkedMeetings;
	});
