import { listTimeEntriesForAuthorStory } from "@repo/database";
import { z } from "zod";
import { INPUT_BOUNDS } from "../../../lib/zod-bounds";
import { projectNotFoundUnlessVisible } from "../../../orpc/middleware/project-visibility";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import {
	requireTimeTrackingProject,
	serializeTimeEntry,
} from "../lib/save-entry";

export const listTimeEntriesForStoryInputSchema = z.object({
	projectId: z.string().min(1).max(INPUT_BOUNDS.name),
	storyId: z.string().min(1).max(INPUT_BOUNDS.name),
});

/** The caller's own entries on one work item, and their total. */
export const listTimeEntriesForStoryProcedure = tenantProtectedProcedure
	.use(projectNotFoundUnlessVisible)
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "GET",
		path: "/time-tracking/projects/{projectId}/stories/{storyId}/entries",
		tags: ["Time tracking"],
		summary: "List the caller's time on a work item",
		description:
			"The caller's own time entries linked to one work item of the project, with their total in minutes.",
	})
	.input(listTimeEntriesForStoryInputSchema)
	.handler(async ({ input, context }) => {
		const project = await requireTimeTrackingProject(input.projectId);
		const entries = await listTimeEntriesForAuthorStory({
			organizationId: project.organizationId,
			projectId: project.id,
			storyId: input.storyId,
			userId: context.user.id,
		});
		return {
			entries: entries.map(serializeTimeEntry),
			totalMinutes: entries.reduce(
				(sum, entry) => sum + entry.durationMinutes,
				0,
			),
		};
	});
