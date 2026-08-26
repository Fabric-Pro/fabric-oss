import { ORPCError } from "@orpc/server";
import { db } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";

/**
 * Remove a story attachment. Only UNLOCKED attachments may be deleted.
 *
 * Authorization: `requireProjectPermission(STORY_UPDATE)`.
 *
 * Flow (single soft-delete path — always on):
 *  1. IDOR guard — fetch the attachment row, verifying it belongs to the story
 *     and project (and is not already soft-deleted). NOT_FOUND if absent.
 *     An un-promoted inbound row (source PM_SYNCED, promotedAt null) is
 *     read-only — FORBIDDEN, even for a caller with STORY_UPDATE — because
 *     "read-only until promoted" is an AI-isolation boundary (Fizzy #1746),
 *     not just a UI affordance.
 *  2. Soft-delete: `updateMany` sets `deletedAt`, guarded by an additional
 *     `designation: "UNLOCKED"` and `deletedAt: null` predicate. If
 *     `count === 0` the row was present (IDOR passed) but no longer matched
 *     at the moment of update — either a concurrent lock toggle set it to
 *     LOCKED (respond BAD_REQUEST), or a concurrent remove already soft-deleted
 *     it (respond NOT_FOUND). A live re-read on `count === 0` disambiguates the
 *     two — the IDOR snapshot's `designation` can be stale under a concurrent
 *     lock, so the classification reads the CURRENT row, not the snapshot.
 *
 * There is no removal-time R2 object delete on this path — the row is only
 * hidden (`deletedAt` set), never destroyed here — so the F1 storageKey-reuse
 * ABA residual (a concurrent createAttachment replay rebinding the key between
 * this handler's read and its object delete) cannot arise: there is no
 * removal-time object delete for a rebind to race against. The always-on
 * purge job (`purgeExpiredAttachmentsActivity`) reclaims both the row and its
 * R2 object after the retention window expires.
 *
 * #1702 Part 1 — Task 8. De-gated (always-on) — see Task 3 of the de-gating refactor.
 */
export const removeAttachmentProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_UPDATE))
	.route({
		method: "DELETE",
		path: "/projects/{projectId}/stories/{storyId}/attachments/{attachmentId}",
		tags: ["Projects", "Stories", "Attachments"],
		summary: "Remove an Unlocked story attachment",
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
		// 1. IDOR guard — fetch the attachment row, verifying it belongs to the
		//    story and project. deletedAt: null ensures an already-soft-deleted
		//    row is invisible (idempotent double-remove reads as NOT_FOUND).
		const attachment = await db.storyAttachment.findFirst({
			where: {
				id: input.attachmentId,
				story: { id: input.userStoryId, projectId: input.projectId },
				deletedAt: null,
			},
			select: { id: true, source: true, promotedAt: true },
		});
		if (!attachment) {
			throw new ORPCError("NOT_FOUND", {
				message: "Attachment not found",
			});
		}

		// An un-promoted inbound row (source PM_SYNCED, promotedAt null) is
		// read-only in the UI — no lock/unlock, no delete. STORY_UPDATE alone
		// must not be able to bypass that: deleting it is the other half of the
		// AI-isolation hole this designation gate closes (see
		// set-attachment-designation.ts).
		if (
			attachment.source === "PM_SYNCED" &&
			attachment.promotedAt === null
		) {
			throw new ORPCError("FORBIDDEN", {
				message:
					"This attachment must be promoted before it can be removed.",
			});
		}

		// 2. Soft-delete: hide the row (set deletedAt) and KEEP the object — the
		//    always-on purge job reclaims both after the retention window. No
		//    deleteFile here, so the F1 key-reuse ABA cannot arise on this path.
		//    count===0 ⇒ a concurrent lock/remove in the read→update window;
		//    disambiguate via a live re-read (the IDOR snapshot may be stale).
		const { count } = await db.storyAttachment.updateMany({
			where: {
				id: input.attachmentId,
				story: { id: input.userStoryId, projectId: input.projectId },
				designation: "UNLOCKED",
				deletedAt: null,
			},
			data: { deletedAt: new Date() },
		});
		if (count === 0) {
			// Re-read the CURRENT row: the IDOR snapshot's designation may be stale if
			// a concurrent lock landed between the read and this update, so count===0
			// can mean either a concurrent soft-delete (row now gone → NOT_FOUND) or a
			// concurrent lock of a still-live row (→ BAD_REQUEST). Classify from live
			// state, never from the pre-update snapshot.
			const live = await db.storyAttachment.findFirst({
				where: {
					id: input.attachmentId,
					story: {
						id: input.userStoryId,
						projectId: input.projectId,
					},
					deletedAt: null,
				},
				select: { designation: true },
			});
			if (live?.designation === "LOCKED") {
				throw new ORPCError("BAD_REQUEST", {
					message: "Unlock this file before removing it",
				});
			}
			throw new ORPCError("NOT_FOUND", {
				message: "Attachment not found",
			});
		}
		return { removed: true as const };
	});
