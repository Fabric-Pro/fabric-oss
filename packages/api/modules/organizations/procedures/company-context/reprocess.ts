import { ORPCError } from "@orpc/server";
import {
	type CompanyContextSourceListItem,
	claimCompanyContextSourceForReprocess,
	getCompanyContextSourceMeta,
	listCompanyContextSources,
	releaseCompanyContextSourceClaim,
} from "@repo/database";
import { logger } from "@repo/logs";
import { unsupportedEmbeddingModelMessage } from "@repo/rag";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import {
	assertCompanyContextEditor,
	loadCompanyContextSourceMeta,
} from "./lib/access";
import {
	isCompanySourceDeleting,
	isCompanySourceInFlight,
	loadCompanySourceIndexState,
	needsCompanySourceReprocessing,
	resolveCurrentCompanyModel,
} from "./lib/source-state";
import {
	type CompanyCrawlProvider,
	resolveCompanyCrawlProvider,
	startCompanyFileProcessing,
	startCompanyTextEmbedding,
	startCompanyUrlCrawl,
} from "./lib/workflows";

const SOURCE_IN_FLIGHT_MESSAGE =
	"This source is already being processed. Wait for it to finish before re-processing it.";

const SOURCE_DELETING_MESSAGE =
	"This source is being deleted, so it cannot be re-processed.";

/** The source fields re-processing reads. */
type ReprocessSource = Pick<
	CompanyContextSourceListItem,
	| "id"
	| "type"
	| "extractionStatus"
	| "contentHash"
	| "sourceTitle"
	| "originalFilename"
	| "sourceUrl"
	| "urlScope"
	| "urlMaxPages"
	| "urlRefreshMode"
>;

/**
 * Re-embed one source with the organization's current model, the cheapest
 * way its type allows:
 * - a text, or a file whose content was extracted: embed the stored text
 *   again;
 * - a file with nothing extracted: extract it again from the stored file;
 * - a website: crawl it again, re-embedding every page even when unchanged.
 *
 * The source is claimed first, in one write that sets it PENDING only while
 * nothing processes it and it is not being deleted; a request that loses the
 * claim answers CONFLICT and starts nothing, so two runs never replace one
 * source's points at once and no run starts on a source a delete has
 * tombstoned. The source reads PENDING until its run moves it on. A start
 * that fails marks the source FAILED (the crawl start does so itself) and
 * throws; a source a delete tombstoned since the claim keeps the delete's
 * status.
 */
async function reprocessSource(
	source: ReprocessSource,
	organizationId: string,
	userId: string,
	crawlProvider: () => Promise<CompanyCrawlProvider>,
): Promise<void> {
	if (source.type === "LINK") {
		if (!source.sourceUrl) {
			throw new ORPCError("BAD_REQUEST", {
				message: "This website source has no URL to crawl",
			});
		}
		const provider = await crawlProvider();
		await claimForReprocess(source.id, organizationId);
		await startCompanyUrlCrawl({
			source: { ...source, sourceUrl: source.sourceUrl },
			organizationId,
			userId,
			provider,
			// Re-embeds every page, unchanged ones included.
			mode: "manual-resync",
		});
		return;
	}

	await claimForReprocess(source.id, organizationId);
	try {
		if (source.type === "FILE" && !source.contentHash) {
			await startCompanyFileProcessing({
				sourceId: source.id,
				organizationId,
				userId,
				retry: true,
			});
		} else {
			await startCompanyTextEmbedding({
				sourceId: source.id,
				organizationId,
				userId,
				type: source.type,
				title: source.sourceTitle ?? source.originalFilename,
			});
		}
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "Unknown error";
		logger.error(
			`[CompanyContext] Failed to start re-processing company source ${source.id}: ${message}`,
		);
		await releaseCompanyContextSourceClaim({
			id: source.id,
			organizationId,
			status: "FAILED",
			extractionError: `Failed to start re-processing: ${message}`,
		}).catch(() => {
			/* the original error is what the caller needs */
		});
		throw new ORPCError("INTERNAL_SERVER_ERROR", {
			message: `Failed to start re-processing: ${message}`,
		});
	}
}

/**
 * Claim an idle source for this request's run, or answer CONFLICT — saying
 * which: the source is being deleted, or another run holds it.
 */
async function claimForReprocess(
	sourceId: string,
	organizationId: string,
): Promise<void> {
	if (
		await claimCompanyContextSourceForReprocess({
			id: sourceId,
			organizationId,
		})
	) {
		return;
	}
	const current = await getCompanyContextSourceMeta(sourceId, organizationId);
	throw new ORPCError("CONFLICT", {
		message:
			current && isCompanySourceDeleting(current)
				? SOURCE_DELETING_MESSAGE
				: SOURCE_IN_FLIGHT_MESSAGE,
	});
}

/**
 * Re-embed company context with the organization's current embedding model
 * (Fizzy #2719): one source, or — without `sourceId` — every source that
 * `list` marks as needing re-processing. After the organization changes its
 * embedding model, sources embedded with the old one are not retrieved until
 * this runs, because their vectors live in the old model's space.
 *
 * Refused up front when no embedding provider is configured, or when the
 * current model's vectors cannot be stored; nothing is touched then. A single
 * source still processing — a website a scheduled refresh is crawling
 * included, or one another request has just claimed — answers CONFLICT,
 * since a second run would race the first, and so does a source being
 * deleted; across all stale sources, one in flight or being deleted is not
 * stale, and one that cannot start or be claimed is reported in `skipped`
 * while the rest go ahead.
 *
 * AUTHORIZATION: `ORG_UPDATE` against the requested organization, admin or
 * owner of it, then the company context gate. A single source is loaded by
 * `(id, organizationId)`.
 */
export const reprocessCompanyContextProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.ORG_UPDATE, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "POST",
		path: "/organizations/{organizationId}/company-context/reprocess",
		tags: ["Organizations", "Company context"],
		summary: "Re-process company context",
		description:
			"Re-embed one company context source, or every source embedded with an earlier model, with the organization's current embedding model.",
	})
	.input(
		z.object({
			organizationId: z.string().min(1),
			/** One source; omit to re-process every stale source. */
			sourceId: z.string().min(1).optional(),
		}),
	)
	.handler(async ({ context: { user }, input }) => {
		const { organizationId, sourceId } = input;
		await assertCompanyContextEditor(organizationId, user.id);

		const model = await resolveCurrentCompanyModel(organizationId, user.id);
		if (!model) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"No embedding provider is configured. Configure an AI provider with embedding support in Settings → AI Providers.",
				data: { code: "EMBEDDING_PROVIDER_NOT_CONFIGURED" },
			});
		}
		if (!model.supported) {
			throw new ORPCError("BAD_REQUEST", {
				message: unsupportedEmbeddingModelMessage(model),
				data: { code: "EMBEDDING_MODEL_UNSUPPORTED" },
			});
		}

		// One scraper for every website in the request, resolved on first use.
		const providers = new Map<string, Promise<CompanyCrawlProvider>>();
		const crawlProviderFor = (source: ReprocessSource) => () => {
			const scope = source.urlScope ?? "SINGLE_PAGE";
			let provider = providers.get(scope);
			if (!provider) {
				provider = resolveCompanyCrawlProvider(organizationId, scope);
				providers.set(scope, provider);
			}
			return provider;
		};

		if (sourceId) {
			const source = await loadCompanyContextSourceMeta(
				sourceId,
				organizationId,
			);
			// Answers early, before a website's scraper is resolved; the claim
			// in `reprocessSource` settles a request racing this one.
			if (isCompanySourceDeleting(source)) {
				throw new ORPCError("CONFLICT", {
					message: SOURCE_DELETING_MESSAGE,
				});
			}
			if (isCompanySourceInFlight(source)) {
				throw new ORPCError("CONFLICT", {
					message: SOURCE_IN_FLIGHT_MESSAGE,
				});
			}
			await reprocessSource(
				source,
				organizationId,
				user.id,
				crawlProviderFor(source),
			);
			return { reprocessed: [sourceId], skipped: [] };
		}

		const [sources, indexState] = await Promise.all([
			listCompanyContextSources(organizationId),
			loadCompanySourceIndexState(organizationId, model),
		]);
		const stale = sources.filter((source) =>
			needsCompanySourceReprocessing(source, indexState, model),
		);

		const reprocessed: string[] = [];
		const skipped: { sourceId: string; reason: string }[] = [];
		for (const source of stale) {
			try {
				await reprocessSource(
					source,
					organizationId,
					user.id,
					crawlProviderFor(source),
				);
				reprocessed.push(source.id);
			} catch (error) {
				if (!(error instanceof ORPCError)) {
					throw error;
				}
				skipped.push({ sourceId: source.id, reason: error.message });
			}
		}
		return { reprocessed, skipped };
	});
