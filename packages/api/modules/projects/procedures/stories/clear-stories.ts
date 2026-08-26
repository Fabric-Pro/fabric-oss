import { db } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { clearProjectStoriesAndAttachments } from "../../lib/clear-project-stories-with-attachments";

export const clearStoriesProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_DELETE))
	.route({
		method: "DELETE",
		path: "/projects/{projectId}/stories",
		tags: ["Projects", "Stories"],
		summary: "Clear all stories",
		description:
			"Delete all user stories and their tasks from a project, optionally including the USER_STORY document",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			deleteDocument: z.boolean().optional().default(true),
		}),
	)
	.handler(async ({ input }) => {
		// Clear pipeline-generated stories only, preserving manually created Roadmap stories
		const result = await clearProjectStoriesAndAttachments(
			input.projectId,
			true,
		);

		// Also delete the USER_STORY document if requested
		let documentDeleted = false;
		if (input.deleteDocument) {
			const deleteResult = await db.projectDocument.deleteMany({
				where: {
					projectId: input.projectId,
					type: "USER_STORY",
				},
			});
			documentDeleted = deleteResult.count > 0;
		}

		return {
			success: true,
			deletedCount: result.count,
			documentDeleted,
		};
	});
