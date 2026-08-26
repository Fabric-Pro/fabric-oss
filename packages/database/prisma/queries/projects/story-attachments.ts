/**
 * Story-attachment reads/writes for the PM attachment sync engine (Fizzy
 * #1745). Kept separate from the general `StoryAttachment` CRUD queries
 * because these two are consumed only by `reconcileStoryAttachments` (a
 * Temporal activity, transport-free by design) — everything it needs to read
 * and the one field set it writes back after a successful upload.
 */
import { randomUUID } from "node:crypto";
import { config } from "@repo/config";
import { uploadFile } from "@repo/storage";
import { sanitizeAttachmentFilename } from "@repo/utils/attachment";
import { db } from "../../client";

/**
 * Rows for the reconcile engine's push pass. Scoped to the story's own
 * project (`story: { projectId }`) so a stale/foreign `storyId` can never
 * read another tenant's attachments. Excludes soft-deleted rows — a deleted
 * attachment must never be re-uploaded to the PM tool. Ordered by upload time
 * so the rendered attachment block (and the resulting GitLab issue body /
 * activity feed) has a stable, deterministic order across pushes instead of
 * churning with whatever order Postgres happens to return.
 */
export async function getStoryAttachmentsForSync(
	storyId: string,
	projectId: string,
) {
	return db.storyAttachment.findMany({
		where: { storyId, deletedAt: null, story: { projectId } },
		orderBy: { createdAt: "asc" },
		select: {
			id: true,
			filename: true,
			mimeType: true,
			storageKey: true,
			designation: true,
			source: true,
			contentHash: true,
			externalAttachmentId: true,
		},
	});
}

/**
 * Persist the PM-side handle and content hash after a successful upload, so
 * the next reconcile pass recognizes the row as already pushed instead of
 * uploading it again.
 */
export async function updateStoryAttachmentSyncState(
	id: string,
	data: { externalAttachmentId: string; contentHash: string },
): Promise<void> {
	await db.storyAttachment.update({ where: { id }, data });
}

/**
 * Where an imported attachment's bytes live. Same prefix scheme as
 * `create-attachment.ts`'s `finalKey`, so the retention purge and the
 * tenant-path rules apply to a pulled file exactly as they do to an uploaded
 * one.
 */
const FINAL_PREFIX = "story-attachments/";

/**
 * Import one attachment pulled from a PM tool (Fizzy #1745, AC-5).
 *
 * Bytes first, row second. Storage is not transactional with the database, so
 * one of the two orders has to be chosen deliberately: writing the row first
 * would leave a row pointing at bytes that never arrived — a broken download
 * for the user, and a `contentHash` that lies. This order at worst leaves an
 * orphaned object, which the retention sweep already collects.
 */
export async function importPulledStoryAttachment(input: {
	storyId: string;
	projectId: string;
	filename: string;
	mimeType: string;
	data: Buffer;
	contentHash: string;
	externalAttachmentId: string;
	uploaderUserId?: string | null;
}): Promise<{ id: string }> {
	// Tenancy. A stale or forged storyId must not be able to write an
	// attachment into another tenant's story; this mirrors the
	// `story: { projectId }` scoping the read side already uses.
	const story = await db.userStory.findFirst({
		where: { id: input.storyId, projectId: input.projectId },
		select: { id: true },
	});
	if (!story) {
		throw new Error(
			`Story ${input.storyId} not found in project ${input.projectId}`,
		);
	}

	const safeName = sanitizeAttachmentFilename(input.filename);
	const storageKey = `${FINAL_PREFIX}${input.projectId}/${input.storyId}/${randomUUID()}-${safeName}`;
	await uploadFile(storageKey, input.data, {
		bucket: config.storage.bucketNames.projectContexts,
		contentType: input.mimeType,
	});

	return db.storyAttachment.create({
		data: {
			storyId: input.storyId,
			filename: safeName,
			mimeType: input.mimeType,
			sizeBytes: input.data.length,
			storageKey,
			// The card's pull section, AC-3: land UNLOCKED so the user can lock
			// afterwards. Note this differs from the UPLOAD path, which defaults
			// to LOCKED — an uploaded file is one the user chose to add and may
			// not want shared, whereas a pulled one is already visible on the PM
			// item it came from.
			designation: "UNLOCKED",
			// Never FABRIC: the push half owns Fabric-origin rows and would try
			// to upload this straight back to the tool it came from.
			source: "PM_SYNCED",
			contentHash: input.contentHash,
			externalAttachmentId: input.externalAttachmentId,
			uploaderUserId: input.uploaderUserId ?? null,
		},
		select: { id: true },
	});
}

/**
 * Record one attachment sync discrepancy (Fizzy #1745, AC-7/AC-8/AC-9).
 *
 * The first writer this model has had: it has been in the schema since #1702
 * with nothing reading or writing it.
 *
 * NEVER THROWS. A sync issue is a report ABOUT a pull, never the point of one.
 * Letting a write failure escape would turn "we noticed a discrepancy" into
 * "the pull failed" — the exact inversion AC-4 forbids on the push side.
 */
export async function recordStoryAttachmentSyncIssue(input: {
	storyId: string;
	sourceTool: string;
	filename: string;
	reason: string;
}): Promise<void> {
	try {
		await db.storyAttachmentSyncIssue.create({
			data: {
				storyId: input.storyId,
				sourceTool: input.sourceTool,
				filename: input.filename,
				reason: input.reason,
			},
		});
	} catch {
		// Deliberately swallowed — see the contract above.
	}
}
