import { ORPCError } from "@orpc/server";
import { claimCompanyContextSourceForReprocess } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import {
	assertCompanyContextEditor,
	isCrawlInFlight,
	loadCompanyContextSourceMeta,
} from "./lib/access";
import { isCompanySourceDeleting } from "./lib/source-state";
import {
	ensureCompanyUrlRefreshSchedule,
	resolveCompanyCrawlProvider,
	startCompanyUrlCrawl,
} from "./lib/workflows";

const WEBSITE_DELETING_MESSAGE =
	"This website is being deleted, so it cannot be re-synced.";

const CRAWL_IN_FLIGHT_MESSAGE =
	"Processing is already in progress for this website. Wait for it to finish or cancel it before re-syncing.";

/**
 * Re-crawl a company website source now (Fizzy #2719) — the company twin of
 * `projects.contexts.resyncUrlSource`. A manual re-sync re-embeds every page,
 * even one whose content is unchanged.
 *
 * Refused with CONFLICT while a crawl is queued or running — one this API
 * started, or a scheduled refresh — so a second crawl cannot race the first
 * for the source's pages, and for a source being deleted. The source is
 * claimed before the crawl starts, in one write that sets it PENDING only
 * while nothing processes it and it is not being deleted: a crawl or a
 * delete that gets to it between the read and the claim wins, and the
 * re-sync answers CONFLICT without starting anything or rewriting the
 * status. A crawl start that fails marks the source FAILED, unless a delete
 * has tombstoned it since.
 *
 * A DAILY / WEEKLY / MONTHLY source also gets its refresh schedule back when
 * it has none, or Temporal no longer knows the one it records: this is the
 * repair path for a schedule whose creation failed. A schedule that still
 * cannot be created is reported as `scheduleWarning` beside the started
 * crawl.
 *
 * The scraper is chosen as `processLink` chooses it — for the source's scope,
 * from the organization's providers — with the same BAD_REQUEST codes when
 * none is configured.
 *
 * AUTHORIZATION: `ORG_UPDATE` against the requested organization, admin or
 * owner of it, then the company context gate. The source is loaded by
 * `(id, organizationId)`.
 */
export const resyncCompanyContextUrlSourceProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.ORG_UPDATE, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "POST",
		path: "/organizations/{organizationId}/company-context/{sourceId}/url-source/resync",
		tags: ["Organizations", "Company context"],
		summary: "Re-sync a company context website",
		description:
			"Crawl a company context website source again now and re-embed its pages.",
	})
	.input(
		z.object({
			organizationId: z.string().min(1),
			sourceId: z.string().min(1),
		}),
	)
	.handler(async ({ context: { user }, input }) => {
		const { organizationId, sourceId } = input;
		await assertCompanyContextEditor(organizationId, user.id);

		const source = await loadCompanyContextSourceMeta(
			sourceId,
			organizationId,
		);
		if (source.type !== "LINK" || !source.sourceUrl) {
			throw new ORPCError("BAD_REQUEST", {
				message: "Only a website source can be re-synced",
			});
		}
		if (isCompanySourceDeleting(source)) {
			throw new ORPCError("CONFLICT", {
				message: WEBSITE_DELETING_MESSAGE,
			});
		}
		if (isCrawlInFlight(source)) {
			throw new ORPCError("CONFLICT", {
				message: CRAWL_IN_FLIGHT_MESSAGE,
			});
		}

		const provider = await resolveCompanyCrawlProvider(
			organizationId,
			source.urlScope ?? "SINGLE_PAGE",
		);

		// PENDING, and the previous failure's message cleared, so the page
		// resets at once; the crawl moves the source on from here.
		if (
			!(await claimCompanyContextSourceForReprocess({
				id: sourceId,
				organizationId,
			}))
		) {
			// Tombstoned, or claimed by a crawl, since the read.
			const current = await loadCompanyContextSourceMeta(
				sourceId,
				organizationId,
			);
			throw new ORPCError("CONFLICT", {
				message: isCompanySourceDeleting(current)
					? WEBSITE_DELETING_MESSAGE
					: CRAWL_IN_FLIGHT_MESSAGE,
			});
		}

		const crawlSource = { ...source, sourceUrl: source.sourceUrl };
		await startCompanyUrlCrawl({
			source: crawlSource,
			organizationId,
			userId: user.id,
			provider,
			mode: "manual-resync",
		});

		const scheduleWarning = await ensureCompanyUrlRefreshSchedule({
			source: crawlSource,
			organizationId,
			userId: user.id,
			provider,
		});

		return {
			sourceId,
			status: "EXTRACTING" as const,
			...(scheduleWarning ? { scheduleWarning } : {}),
		};
	});
