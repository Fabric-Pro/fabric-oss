/**
 * Upsert URL Page Activity (URL Context Sources)
 *
 * Writes one row to `ProjectContextUrlPage` per crawled page. Computes a
 * sha256 content hash and short-circuits embedding when:
 *   - the row already exists, AND
 *   - `contentHash` matches the previous hash, AND
 *   - the caller is in `initial` or `scheduled` mode (NOT `manual-resync` —
 *     the user explicitly asked to re-embed).
 *
 * Returns a `skipped` flag the workflow uses to decide whether to call the
 * embed activity. `lastFetchedAt` is always bumped so the operator can see
 * a recent crawl even when content was unchanged.
 *
 * A hash match skips embedding — that is the whole point of storing the hash.
 */
import { createHash } from "node:crypto";
import type { ExtractionStatus } from "@repo/database";
import { db } from "@repo/database/prisma/client";
import { activityLogger } from "../lib/activity-logger";

export interface UpsertUrlPageActivityInput {
	parentContextId: string;
	projectId: string;
	pageUrl: string;
	pageTitle: string | null;
	content: string;
	etag?: string;
	lastModifiedHeader?: string;
	userId: string | null;
	organizationId: string | null;
	mode: "initial" | "manual-resync" | "scheduled";
}

export interface UpsertUrlPageActivityOutput {
	pageId: string;
	contentHash: string;
	skipped: boolean;
	reason?: "hash-unchanged" | "first-write";
}

/**
 * Stable sha256 over the raw markdown. We hash the content itself, not a
 * canonicalised form, because Firecrawl returns markdown deterministically
 * per page and any drift IS the signal we want to detect.
 */
function computeContentHash(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

export async function upsertUrlPageActivity(
	input: UpsertUrlPageActivityInput,
): Promise<UpsertUrlPageActivityOutput> {
	const {
		parentContextId,
		projectId,
		pageUrl,
		pageTitle,
		content,
		etag,
		lastModifiedHeader,
		userId,
		organizationId,
		mode,
	} = input;

	const contentHash = computeContentHash(content);
	const pendingStatus: ExtractionStatus = "PENDING";

	activityLogger.info("Upsert url page activity start", {
		parentContextId,
		pageUrl,
		mode,
	});

	const existing = await db.projectContextUrlPage.findFirst({
		where: { parentContextId, pageUrl },
		select: { id: true, contentHash: true },
	});

	if (existing) {
		const hashUnchanged = existing.contentHash === contentHash;
		// `manual-resync` is the explicit user-driven "Re-sync now" path.
		// Treat it as authoritative — always overwrite content + contentHash
		// regardless of whether the hash technically matches. This protects
		// against two failure modes seen on staging:
		//   1. Stale rows from before a bug fix where the scrape now returns
		//      better/different content, but a transient race / cache layer
		//      keeps the new bytes identical to the stored ones (unblocks
		//      the row even if hashes coincidentally match).
		//   2. Genuine content drift the user noticed by eye and clicked
		//      Re-sync to fix — we should honour that intent.
		// Scheduled re-syncs (cron path) keep the hash short-circuit to avoid
		// pointless re-embeds on unchanged content.
		const forceWrite = mode === "manual-resync";
		const skipEmbedding = hashUnchanged && !forceWrite;

		await db.projectContextUrlPage.update({
			where: { id: existing.id },
			data: {
				pageTitle,
				lastFetchedAt: new Date(),
				etag: etag ?? null,
				lastModifiedHeader: lastModifiedHeader ?? null,
				// Overwrite content when it actually changed OR when the user
				// explicitly asked for a re-sync (manual-resync mode).
				...(hashUnchanged && !forceWrite
					? {}
					: {
							content,
							contentHash,
							extractionStatus: pendingStatus,
						}),
			},
		});

		activityLogger.info("Upsert url page activity updated existing", {
			parentContextId,
			pageUrl,
			hashUnchanged,
			skipEmbedding,
			forceWrite,
			mode,
		});

		return {
			pageId: existing.id,
			contentHash,
			skipped: skipEmbedding,
			reason: skipEmbedding ? "hash-unchanged" : undefined,
		};
	}

	const created = await db.projectContextUrlPage.create({
		data: {
			parentContextId,
			projectId,
			pageUrl,
			pageTitle,
			content,
			contentHash,
			etag: etag ?? null,
			lastModifiedHeader: lastModifiedHeader ?? null,
			extractionStatus: pendingStatus,
			userId,
			organizationId,
		},
		select: { id: true },
	});

	activityLogger.info("Upsert url page activity created", {
		parentContextId,
		pageUrl,
		pageId: created.id,
	});

	return {
		pageId: created.id,
		contentHash,
		skipped: false,
		reason: "first-write",
	};
}
