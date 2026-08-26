import { ORPCError } from "@orpc/server";
import { db } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";

/**
 * Promote an inbound (PM-synced) attachment to a full Fabric-managed asset.
 *
 * Before promotion an inbound row is read-only: no lock toggle, no delete, and
 * the reconcile pass may soft-delete it when the file disappears from the PM
 * tool. After promotion it behaves exactly like a Fabric upload, and the
 * reconcile stops tracking it — Fabric never resurrects, and never deletes, a
 * file whose PM-side copy its owner removed.
 *
 * `sourceTool` is deliberately retained so the UI can keep showing
 * "Originally from Jira". Fizzy #1746 (AC-10).
 *
 * Idempotent: promoting an already-promoted row succeeds and returns it
 * unchanged (two tabs open, or a client retry of a lost response, must not
 * surface a false NOT_FOUND for a file that is present and promoted). A
 * Fabric-origin row — never inbound, nothing to promote — is BAD_REQUEST.
 *
 * Authorization: `requireProjectPermission(STORY_UPDATE)`. Tenancy mirrors the
 * sibling attachment procedures — project-scoped, without resolving an
 * organization from caller input.
 */
export const promoteAttachmentProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/stories/{storyId}/attachments/{attachmentId}/promote",
		tags: ["Projects", "Stories", "Attachments"],
		summary: "Promote a PM-synced attachment to a Fabric-managed asset",
	})
	.input(
		z.object({
			projectId: z.string(),
			userStoryId: z.string(),
			organizationId: z.string().nullable().optional(),
			attachmentId: z.string(),
		}),
	)
	.handler(async ({ input }) => {
		// IDOR + update in one statement. `source: "PM_SYNCED"` and
		// `promotedAt: null` scope it to an actual un-promoted inbound row, so a
		// Fabric-origin row or an already-promoted row never gets silently
		// re-stamped with a newer timestamp — they fall into the count === 0
		// branch below instead, which classifies and responds accordingly.
		const { count } = await db.storyAttachment.updateMany({
			where: {
				id: input.attachmentId,
				story: { id: input.userStoryId, projectId: input.projectId },
				deletedAt: null,
				source: "PM_SYNCED",
				promotedAt: null,
			},
			data: { promotedAt: new Date() },
		});

		if (count === 0) {
			// count === 0 collapses three different situations, and they must not
			// all read as NOT_FOUND: the row genuinely isn't here, it's
			// Fabric-origin (never inbound — nothing to promote), or it's already
			// promoted (two tabs open, or a client retry of a lost response).
			// Re-read scoped by id + story + project WITHOUT the source/promotedAt
			// filters — still `deletedAt: null` — to tell the three apart.
			const current = await db.storyAttachment.findFirst({
				where: {
					id: input.attachmentId,
					story: {
						id: input.userStoryId,
						projectId: input.projectId,
					},
					deletedAt: null,
				},
				select: {
					id: true,
					filename: true,
					promotedAt: true,
					source: true,
					sourceTool: true,
				},
			});

			if (!current) {
				throw new ORPCError("NOT_FOUND", {
					message: "Attachment not found",
				});
			}
			if (current.source === "FABRIC") {
				throw new ORPCError("BAD_REQUEST", {
					message:
						"This attachment is already Fabric-managed; there is nothing to promote.",
				});
			}
			// Only remaining case: PM_SYNCED with promotedAt already set —
			// idempotent success, return the row unchanged rather than
			// re-stamping a newer timestamp.
			return { attachment: current };
		}

		const attachment = await db.storyAttachment.findFirst({
			where: {
				id: input.attachmentId,
				story: { id: input.userStoryId, projectId: input.projectId },
				deletedAt: null,
			},
			select: {
				id: true,
				filename: true,
				promotedAt: true,
				source: true,
				sourceTool: true,
			},
		});

		// A concurrent removeAttachment can soft-delete the row between the
		// updateMany above and this re-read; without this check that race would
		// silently return { attachment: null } instead of reporting NOT_FOUND.
		if (!attachment) {
			throw new ORPCError("NOT_FOUND", {
				message: "Attachment not found",
			});
		}

		return { attachment };
	});
