import {
	type CompanyContextCrawlPageSummary,
	listCompanyContextSources,
	summarizeCompanyContextCrawlPages,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertCompanyContextReader } from "./lib/access";
import {
	describeCompanyModel,
	isCompanySourceDeleting,
	loadCompanySourceIndexState,
	needsCompanySourceReprocessing,
	resolveCurrentCompanyModel,
} from "./lib/source-state";

/**
 * A first crawl's progress (see `crawlProgress` below). `pages` is read only
 * for a source a crawl holds, so it is absent otherwise.
 */
function firstCrawlProgress(
	extractedAt: Date | null,
	pages: CompanyContextCrawlPageSummary | undefined,
): { processedPages: number; totalPages: number } | null {
	if (extractedAt !== null || !pages || pages.totalPages === 0) {
		return null;
	}
	return {
		processedPages: pages.processedPages,
		totalPages: pages.totalPages,
	};
}

/**
 * List the organization's company context sources (Fizzy #2719), newest
 * first and without their content.
 *
 * Each source carries its processing state as a project source does, plus:
 * - `ready`: it is retrievable — the same predicate retrieval and the
 *   empty-context notice use, under the organization's current embedding
 *   model;
 * - `needsReprocessing`: it, or one of its crawled pages, was indexed with a
 *   model that is no longer the organization's, so it is not retrieved until
 *   `reprocess` re-embeds it. A source that is merely not ready yet — still
 *   processing, or refreshing on its schedule — is not flagged;
 * - `crawlInProgress`: a crawl of the website holds its slot, whether this API
 *   started it or its refresh schedule did;
 * - `crawlProgress`: while the website's first crawl holds the slot and has
 *   found the site's pages, how many of them are done (indexed, or failed to
 *   index) out of all found so far; null otherwise. A first crawl creates
 *   every page its sitemap pass found as pending before it scrapes them one
 *   at a time, so for a large site this runs for hours, and the website is
 *   not ready until the crawl finishes. Pages found by following links are
 *   added as they are scraped, so the total can grow. A page whose scrape
 *   fails is marked failed at once and counts as done, unless the URL was
 *   refused for good (robots, unsupported type) and holds no content, in
 *   which case its row is removed and it leaves the count. A later crawl
 *   is not counted:
 *   the site's pages keep their earlier state until each is scraped again,
 *   so it would read as nearly done throughout. A website has finished a
 *   crawl once `extractedAt` is set; only a completed crawl sets it, and
 *   nothing clears it (a failed crawl can clear `urlLastSyncedAt`);
 * - `crawlLastFetchedAt`: while any crawl holds the slot, when it last
 *   fetched one of the site's pages (a crawl stamps every page it fetches,
 *   changed or not); null otherwise. The page reads it to tell a crawl that
 *   is still working from one whose slot was never released;
 * - `deleting`: a delete of the source has started. It stays listed until the
 *   deletion workflow removes it, is never ready or offered for
 *   re-processing, and can only be deleted again.
 *
 * `embeddingModel` is that current model, or null when no embedding provider
 * is configured (then nothing is ready).
 *
 * AUTHORIZATION: `ORG_READ` against the requested organization, membership of
 * it, then the company context gate. Any member reads; a project guest is not
 * a member.
 */
export const listCompanyContextSourcesProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.ORG_READ, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "GET",
		path: "/organizations/{organizationId}/company-context",
		tags: ["Organizations", "Company context"],
		summary: "List company context sources",
		description:
			"The files, texts and websites the organization maintains about itself for Proposals and Business Cases, with each source's processing and retrieval state.",
	})
	.input(z.object({ organizationId: z.string().min(1) }))
	.handler(async ({ context: { user }, input: { organizationId } }) => {
		await assertCompanyContextReader(organizationId, user.id);

		const [sources, model] = await Promise.all([
			listCompanyContextSources(organizationId),
			resolveCurrentCompanyModel(organizationId, user.id),
		]);
		const [indexState, crawlPages] = await Promise.all([
			loadCompanySourceIndexState(organizationId, model),
			summarizeCompanyContextCrawlPages({
				organizationId,
				parentSourceIds: sources
					.filter((source) => source.urlActiveWorkflowId !== null)
					.map((source) => source.id),
			}),
		]);

		return {
			sources: sources.map(
				({ _count, urlActiveWorkflowId, deletingAt, ...source }) => ({
					...source,
					urlPageCount: _count.urlPages,
					crawlInProgress: urlActiveWorkflowId !== null,
					crawlProgress: firstCrawlProgress(
						source.extractedAt,
						crawlPages.get(source.id),
					),
					crawlLastFetchedAt:
						crawlPages.get(source.id)?.lastFetchedAt ?? null,
					deleting: isCompanySourceDeleting({ deletingAt }),
					ready: indexState.readyIds.has(source.id),
					needsReprocessing: needsCompanySourceReprocessing(
						{ ...source, urlActiveWorkflowId, deletingAt },
						indexState,
						model,
					),
				}),
			),
			embeddingModel: describeCompanyModel(model),
		};
	});
