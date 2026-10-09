/**
 * Embed URL Page Activity (URL Context Sources)
 *
 * Calls `embedProjectContext` from `@repo/rag` to chunk + embed the page's
 * markdown and store the resulting vectors in Qdrant. Stamps the
 * chunk-metadata contract:
 *   - `sourceUrl`   = the actual indexed page URL (NOT the parent's URL)
 *   - `sourceTitle` = the user's parent label
 *   - `parentContextId` = parent ProjectContext.id (for chunk-delete grouping)
 *
 * The shared `embedProjectContext` already sets `originalContextId = contextId`
 * to drive filter-based chunk deletion; we pass the per-page id so cascade
 * cleanup on parent delete still finds every chunk.
 *
 * On success the activity bumps `embeddedAt`, `chunkCount`, `qdrantId`,
 * and flips `extractionStatus` to COMPLETED on the page row.
 *
 * A company owner (Fizzy #2719) embeds into the organization's company
 * collection instead, per the company vector contract: every point carries
 * `originalContextId` = the source, `contextId` = the page,
 * `parentContextId` = the source, and the identity of the model that
 * produced it, which is also stamped on the `CompanyContextUrlPage` row. Each
 * pass replaces the page's earlier points rather than adding to them. A
 * missing owner is the project owner, unchanged.
 */
import {
	AIProviderNotConfiguredError,
	getSystemEmbeddingRAGProviderConfig,
} from "@repo/ai";
import { db } from "@repo/database/prisma/client";
import {
	deleteCompanyContextRowPoints,
	embedCompanyContext,
	embedProjectContext,
	resolveCompanyEmbeddingModel,
	unsupportedEmbeddingModelMessage,
} from "@repo/rag";
import { ApplicationFailure, heartbeat } from "@temporalio/activity";
import {
	type CompanyContextOwner,
	type ContextOwner,
	resolveContextOwner,
} from "../../lib/context-owner";
import { companyLinkCrawlStore } from "../../lib/context-row-store";
import { activityLogger } from "../lib/activity-logger";
import { COMPANY_CRAWL_NO_EMBEDDING_PROVIDER_MESSAGE } from "./company-gate-activity";

export interface EmbedUrlPageActivityInput {
	pageId: string;
	parentContextId: string;
	/** The parent's project; absent for a company source. */
	projectId?: string;
	pageUrl: string;
	parentSourceTitle: string | null;
	content: string;
	userId: string;
	organizationId?: string;
	/** Who owns the parent; absent is the project owner (`../../lib/context-owner`). */
	owner?: ContextOwner;
}

export interface EmbedUrlPageActivityOutput {
	success: boolean;
	qdrantId?: string;
	chunkCount: number;
	error?: string;
}

export async function embedUrlPageActivity(
	input: EmbedUrlPageActivityInput,
): Promise<EmbedUrlPageActivityOutput> {
	const owner = resolveContextOwner(input);
	if (owner.kind === "company") {
		return embedCompanyUrlPage(input, owner);
	}

	const { projectId } = owner;
	const {
		pageId,
		parentContextId,
		pageUrl,
		parentSourceTitle,
		content,
		userId,
		organizationId,
	} = input;

	activityLogger.info("Embed url page activity start", {
		pageId,
		parentContextId,
		pageUrl,
	});

	if (!content || content.trim().length === 0) {
		activityLogger.warn("Skipping empty content", { pageId });
		await db.projectContextUrlPage.update({
			where: { id: pageId },
			data: { extractionStatus: "COMPLETED", chunkCount: 0 },
		});
		return { success: true, chunkCount: 0 };
	}

	const providerConfig = await getSystemEmbeddingRAGProviderConfig({
		userId,
		organizationId,
	});

	// Heartbeat every 10s so the 30s workflow heartbeatTimeout has headroom
	// during the embedding loop (each chunk = one provider HTTP call).
	const heartbeatInterval = setInterval(() => {
		try {
			heartbeat();
		} catch {
			// Outside an activity context (tests).
		}
	}, 10_000);

	try {
		const result = await embedProjectContext({
			contextId: pageId,
			projectId,
			userId,
			organizationId,
			content,
			type: "LINK",
			apiKey: providerConfig,
			metadata: {
				// Chunk-metadata contract — citations resolve via these
				// fields downstream.
				sourceUrl: pageUrl,
				sourceTitle: parentSourceTitle ?? undefined,
				parentContextId,
			},
			// URL pages live in `ProjectContextUrlPage`, not `ProjectContext`.
			// Without this opt-out, embedProjectContext tried
			// `markContextAsEmbedded(pageId, ...)` → `projectContext.update({
			// id: pageId })` → "No record was found for an update" failure
			// on every page, leaving chunks unmarked even though they were
			// successfully written to Qdrant. The follow-up
			// `projectContextUrlPage.update` below stamps qdrantId +
			// embeddedAt on the right row.
			skipDbUpdate: true,
		});

		if (!result.success) {
			activityLogger.error(
				"Embed url page activity failed",
				new Error(result.error ?? "unknown"),
				{ pageId, pageUrl },
			);
			await db.projectContextUrlPage.update({
				where: { id: pageId },
				data: {
					extractionStatus: "FAILED",
					extractionError: result.error ?? "Unknown embedding error",
				},
			});
			throw ApplicationFailure.retryable(
				result.error ?? "URL page embedding failed",
				"EMBED_URL_PAGE_FAILED",
			);
		}

		await db.projectContextUrlPage.update({
			where: { id: pageId },
			data: {
				qdrantId: result.qdrantId ?? null,
				embeddedAt: new Date(),
				chunkCount: result.chunksCreated ?? 0,
				extractionStatus: "COMPLETED",
				extractionError: null,
			},
		});

		activityLogger.info("Embed url page activity success", {
			pageId,
			pageUrl,
			chunkCount: result.chunksCreated ?? 0,
		});

		return {
			success: true,
			qdrantId: result.qdrantId,
			chunkCount: result.chunksCreated ?? 0,
		};
	} finally {
		clearInterval(heartbeatInterval);
	}
}

/** `ApplicationFailure.type` of a company page embed that cannot succeed on retry. */
const EMBED_COMPANY_URL_PAGE_UNAVAILABLE = "EMBED_COMPANY_URL_PAGE_UNAVAILABLE";

/**
 * The company owner's embed: the page's chunks go to the organization's
 * company collection, and the page row records the model that wrote them.
 *
 * - A model that cannot index company context fails the page before anything
 *   is written, non-retryably. So does a missing embedding provider. Both are
 *   read from the organization's own embedding configuration, as the embed
 *   itself resolves it, so an acting member's personal key decides neither.
 * - The page records the model the embed reports having used, which is the
 *   one checked here unless the organization switched models in between.
 * - Empty content completes the page with no points, removing any an earlier
 *   version of the page left.
 * - The page's earlier points are removed before the new ones are written, so
 *   a page that shrank keeps no stale chunks; from then on a failure removes
 *   whatever this pass wrote and clears the page's index markers, so a failed
 *   page holds no vectors. Temporal retries it.
 * - A page deleted while it was embedded (pruned, or its source deleted)
 *   loses the points this pass wrote.
 */
async function embedCompanyUrlPage(
	input: EmbedUrlPageActivityInput,
	owner: CompanyContextOwner,
): Promise<EmbedUrlPageActivityOutput> {
	const {
		pageId,
		parentContextId,
		pageUrl,
		parentSourceTitle,
		content,
		userId,
	} = input;
	const { organizationId } = owner;
	const crawls = companyLinkCrawlStore(owner);
	const removePagePoints = () =>
		deleteCompanyContextRowPoints({ organizationId, contextIds: [pageId] });

	activityLogger.info("Embed company url page activity start", {
		pageId,
		parentContextId,
		organizationId,
		pageUrl,
	});

	try {
		const model = await resolveCompanyEmbeddingModel({
			organizationId,
			userId,
		});
		if (!model.supported) {
			const reason = unsupportedEmbeddingModelMessage(model);
			await crawls.recordPageFailure(pageId, reason);
			throw ApplicationFailure.nonRetryable(
				reason,
				EMBED_COMPANY_URL_PAGE_UNAVAILABLE,
			);
		}
	} catch (error) {
		if (!(error instanceof AIProviderNotConfiguredError)) {
			throw error;
		}
		await crawls.recordPageFailure(
			pageId,
			COMPANY_CRAWL_NO_EMBEDDING_PROVIDER_MESSAGE,
		);
		throw ApplicationFailure.nonRetryable(
			COMPANY_CRAWL_NO_EMBEDDING_PROVIDER_MESSAGE,
			EMBED_COMPANY_URL_PAGE_UNAVAILABLE,
		);
	}

	if (!content || content.trim().length === 0) {
		activityLogger.warn("Skipping empty content", { pageId });
		await removePagePoints();
		await crawls.completeEmptyPage(pageId);
		return { success: true, chunkCount: 0 };
	}

	const heartbeatInterval = setInterval(() => {
		try {
			heartbeat();
		} catch {
			// Outside an activity context (tests).
		}
	}, 10_000);

	let pointsRemoved = false;
	try {
		await removePagePoints();
		pointsRemoved = true;

		const result = await embedCompanyContext({
			contextId: pageId,
			userId,
			content,
			type: "LINK",
			metadata: {
				sourceUrl: pageUrl,
				sourceTitle: parentSourceTitle ?? undefined,
			},
			company: {
				organizationId,
				sourceId: parentContextId,
				contextType: "LINK",
				parentContextId,
			},
		});

		if (!result.success || !result.embeddingModel) {
			throw ApplicationFailure.retryable(
				result.error ?? "URL page embedding failed",
				"EMBED_URL_PAGE_FAILED",
			);
		}

		const chunkCount = result.chunksCreated ?? 0;
		const marked = await crawls.markPageEmbedded(pageId, {
			embeddingModel: result.embeddingModel,
			qdrantId: result.qdrantId ?? null,
			chunkCount,
		});
		if (!marked) {
			await removePagePoints();
			activityLogger.info(
				"Company url page was deleted while it was embedded; removed its points",
				{ pageId, parentContextId },
			);
			return { success: true, chunkCount: 0 };
		}

		activityLogger.info("Embed company url page activity success", {
			pageId,
			pageUrl,
			chunkCount,
		});

		return { success: true, qdrantId: result.qdrantId, chunkCount };
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "Unknown embedding error";
		activityLogger.error(
			"Embed company url page activity failed",
			error instanceof Error ? error : new Error(message),
			{ pageId, pageUrl },
		);
		if (pointsRemoved) {
			// A partial embed may have written some chunks. A failed page
			// holds none, so they cannot be retrieved as if it were whole;
			// a retry writes them again.
			await removePagePoints().catch((deleteError) => {
				activityLogger.warn(
					"Failed to remove a failed company url page's points",
					{ pageId, deleteError },
				);
			});
		}
		await crawls
			.recordPageFailure(pageId, message, { pointsRemoved })
			.catch((writeError) => {
				activityLogger.warn(
					"Failed to flag company url page as FAILED",
					{
						pageId,
						writeError,
					},
				);
			});
		throw error;
	} finally {
		clearInterval(heartbeatInterval);
	}
}
