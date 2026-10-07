import { ORPCError } from "@orpc/server";
import {
	createCompanyLinkSource,
	updateCompanyContextSourceStatus,
} from "@repo/database";
import { cadenceNextFireUtc } from "@repo/temporal";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import {
	DEFAULT_MAX_PAGES,
	MAX_MAX_PAGES,
	MIN_MAX_PAGES,
	rejectCredentialedUrl,
	URL_REFRESH_MODE_VALUES,
	URL_SCOPE_VALUES,
} from "../../../projects/procedures/contexts/process-context-link";
import {
	MAX_INSTRUCTIONS_LENGTH,
	MAX_SOURCE_TYPE_LENGTH,
} from "../../../projects/procedures/contexts/update-context-metadata";
import { assertCompanyContextEditor } from "./lib/access";
import {
	type CompanyCrawlProvider,
	type CompanyCrawlSource,
	type CompanyScheduleWarning,
	resolveCompanyCrawlProvider,
	scheduleCompanyUrlRefresh,
	startCompanyUrlCrawl,
} from "./lib/workflows";

/**
 * The most URLs one bulk request adds — the Link tab's batch limit
 * (`URL_BULK_MAX_LINES` in `apps/web/modules/saas/context-sources/lib/url-source.ts`),
 * enforced here as well so a direct call cannot exceed it.
 */
export const COMPANY_CONTEXT_BULK_URL_MAX = 50;

/**
 * Only a web page can be crawled. zod's `.url()` also accepts `javascript:`,
 * `data:`, `file:` and any other scheme `URL` parses, none of which a scraper
 * should ever be pointed at.
 */
function isHttpUrl(value: string): boolean {
	try {
		const { protocol } = new URL(value);
		return protocol === "http:" || protocol === "https:";
	} catch {
		return false;
	}
}

/**
 * One website URL, validated as the project `processLink` validates it, and
 * limited to http(s).
 */
const websiteUrl = z
	.string()
	.url()
	.refine(isHttpUrl, {
		message: "Only http:// and https:// website URLs can be added.",
	})
	.refine(rejectCredentialedUrl, {
		message: "URL must be public; remove embedded credentials.",
	});

const processLinkInput = z
	.object({
		organizationId: z.string().min(1),
		/** One website. Exactly one of `url` and `urls`. */
		url: websiteUrl.optional(),
		/**
		 * A bulk paste: each URL becomes its own source with the shared scope
		 * and refresh settings, labelled by its scraped title.
		 */
		urls: z
			.array(websiteUrl)
			.min(1)
			.max(COMPANY_CONTEXT_BULK_URL_MAX)
			.optional(),
		/** Only with a single `url`; a bulk source takes its page title. */
		label: z.string().max(120).optional(),
		scope: z.enum(URL_SCOPE_VALUES).default("SINGLE_PAGE"),
		maxPages: z
			.number()
			.int()
			.min(MIN_MAX_PAGES)
			.max(MAX_MAX_PAGES)
			.default(DEFAULT_MAX_PAGES),
		// No LIVE: nothing re-fetches a company website when a Proposal or
		// Business Case retrieves it, so LIVE would behave as ONCE.
		refreshMode: z
			.enum(URL_REFRESH_MODE_VALUES)
			.exclude(["LIVE"])
			.default("ONCE"),
		sourceType: z
			.string()
			.trim()
			.min(1)
			.max(MAX_SOURCE_TYPE_LENGTH)
			.optional(),
		aiInstructions: z
			.string()
			.trim()
			.max(MAX_INSTRUCTIONS_LENGTH)
			.optional(),
	})
	.refine(
		(input) => (input.url === undefined) !== (input.urls === undefined),
		{
			message: "Pass exactly one of url and urls",
		},
	)
	.refine((input) => input.label === undefined || input.url !== undefined, {
		message: "A label applies to a single url only",
		path: ["label"],
	});

type ProcessLinkInput = z.infer<typeof processLinkInput>;

/** How one URL of the request fared. */
interface AddedWebsite {
	url: string;
	sourceId: string;
	status: "EXTRACTING" | "FAILED";
	error?: string;
	/**
	 * Present when the crawl started but the refresh schedule of a DAILY /
	 * WEEKLY / MONTHLY source could not be created. The source records no
	 * schedule then; re-syncing it tries again.
	 */
	scheduleWarning?: CompanyScheduleWarning;
}

/**
 * Create one LINK source, flip it to EXTRACTING, start its first crawl and,
 * for a scheduled cadence, its refresh schedule. A crawl that cannot start
 * leaves the source FAILED and comes back as `startError`, for the caller to
 * throw or report; a schedule that cannot be created comes back as
 * `scheduleWarning`, beside the running crawl.
 */
async function addWebsite(
	input: ProcessLinkInput,
	url: string,
	label: string | undefined,
	provider: CompanyCrawlProvider,
	userId: string,
): Promise<{
	sourceId: string;
	startError?: ORPCError<string, unknown>;
	scheduleWarning?: CompanyScheduleWarning;
}> {
	const { organizationId, scope, refreshMode } = input;
	const maxPages = scope === "PATH_PREFIX" ? input.maxPages : null;

	const created = await createCompanyLinkSource({
		organizationId,
		createdByUserId: userId,
		sourceUrl: url,
		sourceTitle: label ?? null,
		urlScope: scope,
		urlMaxPages: maxPages ?? undefined,
		urlRefreshMode: refreshMode,
		// Stamped now so "next refresh" shows before the schedule first fires.
		urlNextRefreshAt: cadenceNextFireUtc(refreshMode, new Date()),
		sourceType: input.sourceType,
		aiInstructions: input.aiInstructions,
		metadata: {
			addedBy: userId,
			addedAt: new Date().toISOString(),
			scope,
			maxPages,
			refreshMode,
			scraperProvider: provider.providerName,
		},
	});
	await updateCompanyContextSourceStatus(
		created.id,
		organizationId,
		"EXTRACTING",
	);

	const source: CompanyCrawlSource = {
		id: created.id,
		sourceUrl: url,
		sourceTitle: label ?? null,
		urlScope: scope,
		urlMaxPages: maxPages,
		urlRefreshMode: refreshMode,
	};
	try {
		await startCompanyUrlCrawl({
			source,
			organizationId,
			userId,
			provider,
			mode: "initial",
		});
	} catch (error) {
		if (error instanceof ORPCError) {
			return { sourceId: created.id, startError: error };
		}
		throw error;
	}
	const scheduleWarning = await scheduleCompanyUrlRefresh({
		source,
		organizationId,
		userId,
		provider,
	});
	return scheduleWarning
		? { sourceId: created.id, scheduleWarning }
		: { sourceId: created.id };
}

/**
 * Add one website, or up to 50 in bulk, to the organization's company context
 * and start crawling them (Fizzy #2719) — the company twin of
 * `projects.contexts.processLink`, with the same URL validation, scope,
 * page-count and refresh options, and the same scraper pre-flight and
 * BAD_REQUEST codes when none is configured. Only http(s) URLs are accepted.
 *
 * The scraper is resolved once, before any source is written, so a missing
 * provider leaves nothing behind. A single URL whose crawl cannot start
 * answers INTERNAL_SERVER_ERROR, as for a project; in a bulk request each URL
 * is reported on its own and one failure does not stop the rest. A refresh
 * schedule that cannot be created does not fail the request — the crawl is
 * already running — but is reported on its URL as `scheduleWarning`.
 *
 * AUTHORIZATION: `ORG_UPDATE` against the requested organization, admin or
 * owner of it, then the company context gate.
 */
export const processCompanyContextLinkProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.ORG_UPDATE, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "POST",
		path: "/organizations/{organizationId}/company-context/link",
		tags: ["Organizations", "Company context"],
		summary: "Add company context websites",
		description:
			"Add one website, or up to 50 in bulk, to the organization's company context and start crawling them.",
	})
	.input(processLinkInput)
	.handler(async ({ context: { user }, input }) => {
		const { organizationId } = input;
		await assertCompanyContextEditor(organizationId, user.id);

		const provider = await resolveCompanyCrawlProvider(
			organizationId,
			input.scope,
		);

		if (input.url !== undefined) {
			const { sourceId, startError, scheduleWarning } = await addWebsite(
				input,
				input.url,
				input.label,
				provider,
				user.id,
			);
			if (startError) {
				throw startError;
			}
			const added: AddedWebsite = {
				url: input.url,
				sourceId,
				status: "EXTRACTING",
				...(scheduleWarning ? { scheduleWarning } : {}),
			};
			return { sources: [added] };
		}

		// Sequential: each start is one Temporal call, and a batch is at most 50.
		const sources: AddedWebsite[] = [];
		for (const url of new Set(input.urls ?? [])) {
			const { sourceId, startError, scheduleWarning } = await addWebsite(
				input,
				url,
				undefined,
				provider,
				user.id,
			);
			sources.push(
				startError
					? {
							url,
							sourceId,
							status: "FAILED",
							error: startError.message,
						}
					: {
							url,
							sourceId,
							status: "EXTRACTING",
							...(scheduleWarning ? { scheduleWarning } : {}),
						},
			);
		}
		return { sources };
	});
