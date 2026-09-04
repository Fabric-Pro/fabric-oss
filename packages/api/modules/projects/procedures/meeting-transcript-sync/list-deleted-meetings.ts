import { ORPCError } from "@orpc/server";
import { db, listMeetingArchives } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * AUTHORIZATION: `PROJECT_READ` — seeing that a meeting was deleted, and by
 * whom, is not itself privileged. Acting on it is: restore carries the same gate
 * as deleting.
 *
 * The recently-deleted list. Returns only archives still inside their recovery
 * window; expired ones are filtered out rather than shown as un-restorable,
 * because the purge job runs daily and a row can outlive its own window by
 * up to a day.
 */
export const listDeletedMeetingsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/meeting-transcript-sync/deleted",
		tags: ["Projects", "Meeting Transcript Sync"],
		summary: "List recently deleted meetings",
		description:
			"Meetings deleted within the recovery window, with the time each has left.",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;

		// Authorized by `requireProjectPermission` above; this only confirms
		// the project still exists. Nothing here is tenant-scoped by an input
		// organization, because the archives are reached through the project.
		const project = await db.project.findFirst({
			where: { id: input.projectId },
			select: { id: true },
		});

		if (!project) {
			throw new ORPCError("NOT_FOUND", { message: "Project not found" });
		}

		const archives = await listMeetingArchives(input.projectId);

		// Resolve the deleters in one query rather than per row — "deleted by
		// you, today" is the line that makes this list readable.
		const deleterIds = [...new Set(archives.map((a) => a.deletedById))];
		const deleters =
			deleterIds.length > 0
				? await db.user.findMany({
						where: { id: { in: deleterIds } },
						select: { id: true, name: true, email: true },
					})
				: [];
		const deleterById = new Map(deleters.map((d) => [d.id, d]));

		return archives.map((a) => {
			const deleter = deleterById.get(a.deletedById);
			return {
				id: a.id,
				subject: a.subject,
				transcriptCount: a.transcriptCount,
				deletedAt: a.deletedAt,
				scheduledPurgeAt: a.scheduledPurgeAt,
				payloadTruncated: a.payloadTruncated,
				deletedByName: deleter?.name ?? deleter?.email ?? null,
				deletedByYou: a.deletedById === user.id,
			};
		});
	});
