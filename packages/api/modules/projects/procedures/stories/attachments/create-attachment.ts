import { ORPCError } from "@orpc/server";
import { config } from "@repo/config";
import { db, Prisma } from "@repo/database";
import {
	getStorageProvider,
	type StorageProviderInterface,
} from "@repo/storage";
import {
	EXCALIDRAW_MIME,
	isAllowedMime,
	isValidExcalidrawContent,
	sanitizeAttachmentFilename,
} from "@repo/utils/attachment";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";
import { resolveAttachmentLimits } from "../../../lib/attachment-limits";

const TEMP_PREFIX = "story-attachments-tmp/";
const FINAL_PREFIX = "story-attachments/";

// Excalidraw content validation buffers the whole object into app memory, so it
// gets its own small ceiling independent of the general attachment size cap
// (which can be raised for video, etc.). Real .excalidraw files are KB-sized;
// 5 MB is very generous. #1942.
const EXCALIDRAW_MAX_CONTENT_BYTES = 5 * 1024 * 1024;

/**
 * Best-effort delete of the staging (temp) object. A failure degrades to an
 * orphan swept by the deferred Part 5 retention job and never blocks the
 * response. Mirrors the orphan-warn style in delete-story.ts.
 */
async function deleteTempObjectBestEffort(
	storageProvider: StorageProviderInterface,
	tempKey: string,
	bucket: string,
): Promise<void> {
	try {
		await storageProvider.deleteFile(tempKey, { bucket });
	} catch (err) {
		console.warn(`[attachments] orphaned temp object: ${tempKey}`, err);
	}
}

/**
 * Persist a story attachment after the client has PUT the file to the presigned
 * URL minted by `createAttachmentUploadUrl` (which targets a TEMP key).
 *
 * Authorization: `requireProjectPermission(STORY_UPDATE)`.
 *
 * Overwrite-safety (reserve-then-promote): the presigned PUT only ever targets a
 * `story-attachments-tmp/` key. This procedure HEAD-verifies the temp object,
 * RESERVES the row first (unique final key, inside the FOR UPDATE / count-cap
 * transaction), and only THEN server-side copies temp -> final. Because the copy
 * runs after the unique-key insert commits, a replayed PUT or a double-submit
 * loses at the unique constraint (P2002) before any byte touches the final key —
 * the canonical (Locked) object can never be overwritten.
 *
 * #1702 Part 1 hardening — Codex finding #1.
 */
export const createAttachmentProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/stories/{storyId}/attachments",
		tags: ["Projects", "Stories", "Attachments"],
		summary: "Persist a story attachment after upload",
	})
	.input(
		z.object({
			projectId: z.string(),
			userStoryId: z.string(),
			organizationId: z.string().nullable().optional(),
			storageKey: z.string().min(1),
			filename: z.string().min(1).max(255),
			// Optional at-creation designation. Omitted by the story-detail upload
			// path (defaults to LOCKED); the feature-creation flow sets it per file
			// (Asset -> LOCKED, Context only -> UNLOCKED). #1702 v1.
			designation: z.enum(["LOCKED", "UNLOCKED"]).optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const limits = resolveAttachmentLimits();

		// 1. IDOR: story must belong to the project.
		const story = await db.userStory.findFirst({
			where: { id: input.userStoryId, projectId: input.projectId },
			select: { id: true },
		});
		if (!story) {
			throw new ORPCError("NOT_FOUND", { message: "Feature not found" });
		}

		// 3. Structural temp-key validation. The presigned PUT targets a TEMP key;
		//    the remainder after the per-story prefix must be a single safe segment
		//    (no extra slashes / traversal, and not a final-prefixed bypass).
		const tmpStoryPrefix = `${TEMP_PREFIX}${input.projectId}/${input.userStoryId}/`;
		const suffix = input.storageKey.startsWith(tmpStoryPrefix)
			? input.storageKey.slice(tmpStoryPrefix.length)
			: null;
		if (suffix === null || !/^[A-Za-z0-9._-]+$/.test(suffix)) {
			throw new ORPCError("BAD_REQUEST", {
				message: "Invalid storage key",
			});
		}

		const bucket = config.storage.bucketNames.projectContexts;
		const storageProvider = getStorageProvider();

		// 4. HEAD the TEMP object: confirm it exists and obtain authoritative size +
		//    content-type. getFileMetadata returns null on NotFound and THROWS on
		//    provider/transient failures — don't mask a transient outage as a client
		//    error or strand the object; make persistence retryable.
		let meta: { size: number; contentType: string } | null;
		try {
			meta =
				(await storageProvider.getFileMetadata(input.storageKey, {
					bucket,
				})) ?? null;
		} catch {
			throw new ORPCError("SERVICE_UNAVAILABLE", {
				message: "Could not verify the uploaded file; please retry.",
			});
		}
		if (!meta || !(meta.size > 0)) {
			throw new ORPCError("BAD_REQUEST", {
				message: "Uploaded file not found in storage",
			});
		}

		// Capture into a const so the value narrows cleanly inside the closure below.
		const fileSize = meta.size;

		// 5. Validate size and mime from HEAD — not from client input.
		if (fileSize > limits.maxBytes) {
			throw new ORPCError("BAD_REQUEST", {
				message: `File size must be at most ${Math.floor(limits.maxBytes / (1024 * 1024))}MB`,
			});
		}
		const mimeType = meta.contentType || "application/octet-stream";
		if (!isAllowedMime(mimeType, limits.allowlist)) {
			throw new ORPCError("BAD_REQUEST", {
				message: `Unsupported file type: ${mimeType}`,
			});
		}

		// 5.5 Excalidraw content validation (#1942). The allowlist confirmed the
		//     declared type; because .excalidraw is JSON, verify the actual bytes
		//     are a well-formed Excalidraw document before promoting. Only this
		//     type is content-sniffed — every other type keeps the HEAD-only path.
		//     Size is already bounded by the check above, so buffering is safe.
		if (mimeType === EXCALIDRAW_MIME) {
			if (fileSize > EXCALIDRAW_MAX_CONTENT_BYTES) {
				await deleteTempObjectBestEffort(
					storageProvider,
					input.storageKey,
					bucket,
				);
				throw new ORPCError("BAD_REQUEST", {
					message: `Excalidraw files must be at most ${Math.floor(
						EXCALIDRAW_MAX_CONTENT_BYTES / (1024 * 1024),
					)}MB`,
				});
			}
			let body: { data: Buffer };
			try {
				body = await storageProvider.downloadFile(input.storageKey, {
					bucket,
				});
			} catch {
				// Transient provider error — mirror the HEAD path: retryable, keep temp.
				throw new ORPCError("SERVICE_UNAVAILABLE", {
					message:
						"Could not verify the uploaded file; please retry.",
				});
			}
			if (!isValidExcalidrawContent(body.data.toString("utf-8"))) {
				await deleteTempObjectBestEffort(
					storageProvider,
					input.storageKey,
					bucket,
				);
				throw new ORPCError("BAD_REQUEST", {
					message: "The file is not a valid Excalidraw document.",
				});
			}
		}

		// 6. Derive the deterministic final key from the validated suffix.
		const finalKey = `${FINAL_PREFIX}${input.projectId}/${input.userStoryId}/${suffix}`;

		// 7. RESERVE the row first (inside the FOR UPDATE / count-cap transaction).
		//    The promote (copy) runs only after this commits, so a replay/double-
		//    submit loses at the unique constraint before any byte touches finalKey.
		const reserveRow = async () => {
			try {
				return await db.$transaction(async (tx) => {
					// Lock the story row to make the count-check + insert atomic.
					await tx.$queryRaw`SELECT id FROM user_story WHERE id = ${input.userStoryId} FOR UPDATE`;

					// Soft-deleted rows do not count toward the per-story cap.
					const count = await tx.storyAttachment.count({
						where: { storyId: input.userStoryId, deletedAt: null },
					});
					if (count >= limits.maxPerStory) {
						throw new ORPCError("BAD_REQUEST", {
							message: `A work item can have at most ${limits.maxPerStory} attachments`,
						});
					}

					return tx.storyAttachment.create({
						data: {
							storyId: input.userStoryId,
							filename: sanitizeAttachmentFilename(
								input.filename,
							),
							mimeType,
							sizeBytes: fileSize,
							storageKey: finalKey,
							designation: input.designation ?? "LOCKED",
							source: "FABRIC",
							uploaderUserId: context.user.id,
						},
						select: {
							id: true,
							filename: true,
							mimeType: true,
							sizeBytes: true,
							designation: true,
							source: true,
							uploaderUserId: true,
							createdAt: true,
						},
					});
				});
			} catch (err) {
				// Reservation failed — NO copy has happened, so there is nothing on the
				// final key to clean up.
				if (
					err instanceof Prisma.PrismaClientKnownRequestError &&
					err.code === "P2002"
				) {
					// Duplicate finalKey (a double-submit): the final object is owned by
					// the pre-existing row. Drop the staging object and conflict.
					await deleteTempObjectBestEffort(
						storageProvider,
						input.storageKey,
						bucket,
					);
					throw new ORPCError("CONFLICT", {
						message: "This file is already attached",
					});
				}
				if (err instanceof ORPCError) {
					// Deterministic terminal error (e.g. count-cap exceeded) — staging
					// will not help a retry.
					await deleteTempObjectBestEffort(
						storageProvider,
						input.storageKey,
						bucket,
					);
					throw err;
				}
				// Transient/unknown DB error — KEEP temp so a same-key retry can re-HEAD
				// and re-reserve without re-uploading.
				throw err;
			}
		};
		const attachment = await reserveRow();

		// 8. PROMOTE: server-side copy temp -> final. Runs only after the unique-key
		//    insert committed, so it can never overwrite an already-owned object.
		try {
			await storageProvider.copyFile(input.storageKey, finalKey, {
				bucket,
			});
		} catch (err) {
			console.warn(
				`[attachments] promote failed; orphaned row for object: ${finalKey}`,
				err,
			);
			// The committed row points at a non-existent object — compensate by
			// removing the row (best-effort). Keep temp so the client can retry.
			try {
				await db.storyAttachment.delete({
					where: { id: attachment.id },
				});
			} catch (delErr) {
				console.warn(
					`[attachments] orphaned row after failed promote: ${attachment.id}`,
					delErr,
				);
			}
			throw new ORPCError("SERVICE_UNAVAILABLE", {
				message: "Could not finalize the uploaded file; please retry.",
			});
		}

		// 8.5 Post-copy ownership re-check — closes the promote-after-delete ORPHAN
		//     race under normal completion. Every deletion path removes the ROW before
		//     the OBJECT (single-story, bulk-clear, project-delete, member-cascade,
		//     PM-sync prune, removeAttachment), so if our row is gone *here* a
		//     concurrent parent-delete removed it during the copy window and our
		//     copyFile just recreated an orphan — remove what we created; never block.
		//     A crash between the copy and this check, and a key-reuse ABA via
		//     removeAttachment, are deferred residuals (see spec
		//     2026-06-27-create-attachment-post-copy-recheck).
		let stillOwned: { id: string } | null;
		try {
			stillOwned = await db.storyAttachment.findUnique({
				where: { id: attachment.id },
				select: { id: true },
			});
		} catch (err) {
			// Re-check READ failed (transient DB issue). The row committed and the copy
			// succeeded, so the attachment is valid; the re-check is opportunistic. Never
			// delete finalKey on an unconfirmed read — assume owned and fall through to
			// the success path.
			console.warn(
				`[attachments] post-copy re-check read failed; assuming owned: ${attachment.id}`,
				err,
			);
			stillOwned = { id: attachment.id };
		}
		if (!stillOwned) {
			try {
				await storageProvider.deleteFile(finalKey, { bucket });
			} catch (err) {
				console.warn(
					`[attachments] orphan after concurrent delete: ${finalKey}`,
					err,
				);
			}
			await deleteTempObjectBestEffort(
				storageProvider,
				input.storageKey,
				bucket,
			);
			throw new ORPCError("NOT_FOUND", {
				message: "The work item was deleted",
			});
		}

		// 9. Success — clean up the staging object (best-effort).
		await deleteTempObjectBestEffort(
			storageProvider,
			input.storageKey,
			bucket,
		);
		return { attachment };
	});
