import { ORPCError } from "@orpc/server";
import { db } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";

export const setAttachmentDesignationProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_UPDATE))
	.route({
		method: "PATCH",
		path: "/projects/{projectId}/stories/{storyId}/attachments/{attachmentId}/designation",
		tags: ["Projects", "Stories", "Attachments"],
		summary: "Lock or unlock a story attachment",
	})
	.input(
		z.object({
			projectId: z.string(),
			userStoryId: z.string(),
			organizationId: z.string().nullable().optional(),
			attachmentId: z.string(),
			designation: z.enum(["LOCKED", "UNLOCKED"]),
		}),
	)
	.handler(async ({ input }) => {
		// The AI-isolation invariant rides on `promotedAt`, not on STORY_UPDATE
		// alone: an un-promoted inbound row (source PM_SYNCED, promotedAt null)
		// is read-only in the UI, but nothing below this point checked that
		// server-side — any member with STORY_UPDATE could UNLOCK an
		// un-promoted PM file directly, and the AI-context resolver selects
		// purely on `designation: "UNLOCKED"`, so its extractedText would flow
		// into a prompt before anyone confirmed the file. Read the row first so
		// this can be reported as FORBIDDEN rather than folded into the
		// update's `where`, which would misleadingly collapse it into NOT_FOUND.
		const existing = await db.storyAttachment.findFirst({
			where: {
				id: input.attachmentId,
				story: { id: input.userStoryId, projectId: input.projectId },
				deletedAt: null,
			},
			select: { source: true, promotedAt: true },
		});
		if (!existing) {
			throw new ORPCError("NOT_FOUND", {
				message: "Attachment not found",
			});
		}
		if (existing.source === "PM_SYNCED" && existing.promotedAt === null) {
			throw new ORPCError("FORBIDDEN", {
				message:
					"This attachment must be promoted before its designation can be changed.",
			});
		}

		// IDOR + update in one statement: only a row scoped to this story/project
		// is touched; count === 0 here means a concurrent change (soft-delete)
		// raced with the read above — IDOR itself was already checked.
		// Soft-deleted rows are excluded — designation changes are not allowed on them.
		const { count } = await db.storyAttachment.updateMany({
			where: {
				id: input.attachmentId,
				story: { id: input.userStoryId, projectId: input.projectId },
				deletedAt: null,
			},
			data: { designation: input.designation },
		});

		if (count === 0) {
			throw new ORPCError("NOT_FOUND", {
				message: "Attachment not found",
			});
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
				mimeType: true,
				sizeBytes: true,
				designation: true,
				source: true,
				createdAt: true,
			},
		});
		if (!attachment) {
			throw new ORPCError("NOT_FOUND", {
				message: "Attachment not found",
			});
		}

		return { attachment };
	});
