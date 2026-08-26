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
 * AUTHORIZATION: Uses hasProjectAccess() - any project member can view synced transcripts.
 *
 * Lists synced meeting transcript records for a project, optionally filtered
 * by linked meeting ID.
 */
export const listSyncedTranscriptsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/meeting-transcript-sync/transcripts",
		tags: ["Projects", "Meeting Transcript Sync"],
		summary: "List synced transcripts for a project",
		description:
			"Returns synced meeting transcript records, optionally filtered by linked meeting.",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			linkedMeetingId: z.string().optional(),
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

		const transcripts = await db.projectMeetingTranscript.findMany({
			where: {
				projectId: input.projectId,
				...(input.linkedMeetingId
					? { linkedMeetingId: input.linkedMeetingId }
					: {}),
			},
			orderBy: { syncedAt: "desc" },
		});

		return transcripts;
	});
