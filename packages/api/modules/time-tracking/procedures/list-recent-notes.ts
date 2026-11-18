import { listRecentTimeEntryNotes } from "@repo/database";
import { z } from "zod";
import { INPUT_BOUNDS } from "../../../lib/zod-bounds";
import { projectNotFoundUnlessVisible } from "../../../orpc/middleware/project-visibility";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { requireTimeTrackingProject } from "../lib/save-entry";

/** How many recent notes a new entry is offered. */
const RECENT_NOTES_LIMIT = 5;

export const listRecentTimeNotesInputSchema = z.object({
	projectId: z.string().min(1).max(INPUT_BOUNDS.name),
});

/**
 * The caller's own recent notes on one project, for a new entry to reuse.
 * Only entries the caller logged themselves supply them; entries confirmed
 * from a suggestion do not.
 */
export const listRecentTimeNotesProcedure = tenantProtectedProcedure
	.use(projectNotFoundUnlessVisible)
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "GET",
		path: "/time-tracking/projects/{projectId}/recent-notes",
		tags: ["Time tracking"],
		summary: "List the caller's recent time entry notes on a project",
		description: `Up to ${RECENT_NOTES_LIMIT} distinct notes from the caller's own manually logged time entries on the project, most recently saved first. Entries confirmed from suggestions are not included.`,
	})
	.input(listRecentTimeNotesInputSchema)
	.handler(async ({ input, context }) => {
		const project = await requireTimeTrackingProject(input.projectId);
		const notes = await listRecentTimeEntryNotes({
			organizationId: project.organizationId,
			projectId: project.id,
			userId: context.user.id,
			limit: RECENT_NOTES_LIMIT,
		});
		return { notes };
	});
