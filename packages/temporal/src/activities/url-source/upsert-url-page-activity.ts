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
 *
 * A page a crawl could not fetch keeps its content and vectors and is marked
 * FAILED with a fetch-failure reason (`record-url-page-fetch-failure-activity`).
 * When a later fetch finds its content unchanged and it still holds vectors,
 * it is COMPLETED again and its reason cleared
 * (`urlPageFetchFailureRestorableWhere`), with no embed: its indexed content
 * is the content just fetched. Any other page keeps its status. Both owners.
 * A marked page that holds no vectors has nothing indexed, so its content is
 * embedded like a changed page's (the company owner embeds any page that is
 * not COMPLETED, below).
 *
 * A company owner (Fizzy #2719) writes `CompanyContextUrlPage` under the
 * owner's organization, with two more reasons to re-embed a page whose content
 * hash matches:
 *   - its vectors were not written by the organization's current embedding
 *     model (or it holds none), so a scheduled refresh after a model switch
 *     re-embeds every page;
 *   - it is not COMPLETED. A content write stores the new hash and resets the
 *     page to PENDING but keeps the earlier version's vectors until the embed
 *     replaces them, so a crawl stopped in between leaves a matching hash in
 *     front of stale vectors. Only COMPLETED says the stored content is the
 *     indexed one.
 * A missing owner is the project owner, unchanged.
 */
import { createHash } from "node:crypto";
import {
	type ExtractionStatus,
	URL_PAGE_FETCH_FAILURE_PREFIX,
	urlPageFetchFailureRestorableWhere,
} from "@repo/database";
import { db } from "@repo/database/prisma/client";
import {
	type CompanyContextOwner,
	type ContextOwner,
	resolveContextOwner,
} from "../../lib/context-owner";
import { companyLinkCrawlStore } from "../../lib/context-row-store";
import { activityLogger } from "../lib/activity-logger";
import { currentCompanyEmbeddingModel } from "./lib/company-embedding-model";

export interface UpsertUrlPageActivityInput {
	parentContextId: string;
	/** The parent's project; absent for a company source. */
	projectId?: string;
	pageUrl: string;
	pageTitle: string | null;
	content: string;
	etag?: string;
	lastModifiedHeader?: string;
	userId: string | null;
	organizationId: string | null;
	mode: "initial" | "manual-resync" | "scheduled";
	/** Who owns the parent; absent is the project owner (`../../lib/context-owner`). */
	owner?: ContextOwner;
}

export interface UpsertUrlPageActivityOutput {
	pageId: string;
	contentHash: string;
	skipped: boolean;
	reason?:
		| "hash-unchanged"
		| "first-write"
		| "embedding-model-changed"
		| "not-embedded";
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
	const owner = resolveContextOwner(input);
	if (owner.kind === "company") {
		return upsertCompanyUrlPage(input, owner);
	}

	const { projectId } = owner;
	const {
		parentContextId,
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
		select: {
			id: true,
			contentHash: true,
			extractionStatus: true,
			extractionError: true,
			embeddedAt: true,
		},
	});

	if (existing) {
		const hashUnchanged = existing.contentHash === contentHash;
		// A page a failed fetch marked that holds no vectors has nothing
		// indexed to restore; its unchanged content is embedded instead.
		const markedWithNothingIndexed =
			existing.extractionStatus === "FAILED" &&
			existing.embeddedAt === null &&
			(existing.extractionError?.startsWith(
				URL_PAGE_FETCH_FAILURE_PREFIX,
			) ??
				false);
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
		const keepsStoredContent = hashUnchanged && !forceWrite;
		const skipEmbedding = keepsStoredContent && !markedWithNothingIndexed;

		await db.projectContextUrlPage.update({
			where: { id: existing.id },
			data: {
				pageTitle,
				lastFetchedAt: new Date(),
				etag: etag ?? null,
				lastModifiedHeader: lastModifiedHeader ?? null,
				// Overwrite content when it actually changed, when the user
				// explicitly asked for a re-sync (manual-resync mode), or when
				// a failed fetch left the page with nothing indexed. The
				// earlier failure reason no longer describes the page.
				...(skipEmbedding
					? {}
					: {
							content,
							contentHash,
							extractionStatus: pendingStatus,
							extractionError: null,
						}),
			},
		});

		// A page a failed fetch marked is COMPLETED again by its unchanged
		// content; the WHERE leaves every other page's status alone.
		let restored = false;
		if (skipEmbedding) {
			const { count } = await db.projectContextUrlPage.updateMany({
				where: {
					id: existing.id,
					parentContextId,
					...urlPageFetchFailureRestorableWhere(),
				},
				data: { extractionStatus: "COMPLETED", extractionError: null },
			});
			restored = count > 0;
		}

		activityLogger.info("Upsert url page activity updated existing", {
			parentContextId,
			pageUrl,
			hashUnchanged,
			skipEmbedding,
			forceWrite,
			restored,
			mode,
		});

		return {
			pageId: existing.id,
			contentHash,
			skipped: skipEmbedding,
			reason: skipEmbedding
				? "hash-unchanged"
				: keepsStoredContent
					? "not-embedded"
					: undefined,
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

/**
 * The company owner's upsert. The content write follows the project rules
 * (a hash match keeps the page unless the user asked for a re-sync); the
 * embed decision adds the model and status checks described at the top of
 * this file.
 */
async function upsertCompanyUrlPage(
	input: UpsertUrlPageActivityInput,
	owner: CompanyContextOwner,
): Promise<UpsertUrlPageActivityOutput> {
	const {
		parentContextId,
		pageUrl,
		pageTitle,
		content,
		etag,
		lastModifiedHeader,
		userId,
		mode,
	} = input;
	const crawls = companyLinkCrawlStore(owner);

	activityLogger.info("Upsert company url page activity start", {
		parentContextId,
		organizationId: owner.organizationId,
		pageUrl,
		mode,
	});

	const written = await crawls.upsertPage({
		sourceId: parentContextId,
		pageUrl,
		pageTitle,
		content,
		etag,
		lastModifiedHeader,
		force: mode === "manual-resync",
	});

	if (!written.unchanged) {
		return {
			pageId: written.pageId,
			contentHash: written.contentHash,
			skipped: false,
		};
	}

	// An unresolved model re-embeds the page: the embed step resolves the
	// model again, and records on the page why it cannot.
	const current = await currentCompanyEmbeddingModel(
		owner,
		userId,
		"re-embedding the page",
	);
	const embedding = await crawls.getPageEmbedding(written.pageId);
	const embeddedWithCurrentModel =
		current !== null &&
		embedding?.embeddedAt != null &&
		embedding.embeddingModel === current;
	const contentIndexed =
		embeddedWithCurrentModel && embedding?.extractionStatus === "COMPLETED";

	activityLogger.info("Upsert company url page activity kept content", {
		parentContextId,
		pageUrl,
		embeddedWithCurrentModel,
		contentIndexed,
	});

	if (contentIndexed) {
		return {
			pageId: written.pageId,
			contentHash: written.contentHash,
			skipped: true,
			reason: "hash-unchanged",
		};
	}
	return {
		pageId: written.pageId,
		contentHash: written.contentHash,
		skipped: false,
		reason: embeddedWithCurrentModel
			? "not-embedded"
			: "embedding-model-changed",
	};
}
