import { config } from "@repo/config";
import { db, deleteStory } from "@repo/database";
import { getStorageProvider } from "@repo/storage";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

export const deleteStoryProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_DELETE))
	.route({
		method: "DELETE",
		path: "/projects/{projectId}/stories/{storyId}",
		tags: ["Projects", "Stories"],
		summary: "Delete user story",
		description: "Delete a user story and its tasks",
	})
	.input(
		z.object({
			projectId: z.string(),
			storyId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		// Snapshot the story title BEFORE the delete fires so the audit row
		// preserves a name even when the underlying row is gone (D11).
		const snapshot = await db.userStory.findFirst({
			where: { id: input.storyId, projectId: input.projectId },
			select: { title: true },
		});

		// Capture attachment storage keys BEFORE the cascade removes the rows, so
		// we can delete the underlying R2 objects (the FK cascade deletes rows,
		// not files).
		const attachmentKeys = await db.storyAttachment.findMany({
			where: { storyId: input.storyId },
			select: { storageKey: true },
		});

		await deleteStory(input.storyId, input.projectId);

		// Best-effort object cleanup (mirrors removeAttachment). A failure degrades
		// to an orphan (swept by the deferred Part 5 retention job) and never
		// blocks the delete or the audit log.
		if (attachmentKeys.length > 0) {
			const bucket = config.storage.bucketNames.projectContexts;
			const storageProvider = getStorageProvider();
			await Promise.allSettled(
				attachmentKeys.map(async ({ storageKey }) => {
					try {
						await storageProvider.deleteFile(storageKey, {
							bucket,
						});
					} catch (err) {
						console.warn(
							`[attachments] orphaned object after story delete: ${storageKey}`,
							err,
						);
					}
				}),
			);
		}

		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Audit-log emission. Resource name was snapshotted above
		// pre-delete so the row reflects what was destroyed.
		recordAuditFromRequest(context, {
			action: "story.deleted",
			category: "story",
			organizationId,
			projectId: input.projectId,
			resource: {
				type: "story",
				id: input.storyId,
				name: snapshot?.title ?? null,
			},
		});

		return { success: true };
	});
