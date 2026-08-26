/**
 * processLink — URL Context Sources.
 *
 * Multi-provider routing:
 *  1. Resolve a scrape-capable (and crawl-capable, for PATH_PREFIX) provider
 *     from the tenant's unified search-provider table via
 *     `getEnabledOrganizationSearchProviders` / `getEnabledUserSearchProviders`.
 *     Picker = `getWebScraperForTenant` from
 *     `packages/temporal/src/activities/lib/get-web-scraper.ts`.
 *  2. If no scrape-capable provider exists →
 *     `BAD_REQUEST { code: 'SCRAPE_PROVIDER_NOT_CONFIGURED', settingsPath }`.
 *  3. If PATH_PREFIX is requested but no crawl-capable (Firecrawl) provider →
 *     `BAD_REQUEST { code: 'CRAWL_PROVIDER_NOT_CONFIGURED', settingsPath }`.
 *  4. Legacy `FIRECRAWL_NOT_CONFIGURED` code stays alongside the new ones for
 *     UI back-compat (the new codes carry the same shape: `{ code,
 *     settingsPath }`).
 *  5. The chosen `providerName` is stamped onto the parent
 *     `ProjectContext.metadata.scraperProvider` so the drawer + analytics
 *     know which provider ran.
 *  6. The workflow + schedule receive `providerName` alongside the existing
 *     `apiKey` so the activity can dispatch to the right adapter.
 *
 * Tenant XOR isolation is unchanged (AGENTS.md).
 */
import { ORPCError } from "@orpc/server";
import {
	createLinkContext,
	db,
	getEnabledOrganizationSearchProviders,
	getEnabledUserSearchProviders,
	hasProjectAccess,
	updateContextExtractionStatus,
} from "@repo/database";
import { logger } from "@repo/logs";
import {
	cadenceNextFireUtc,
	createUrlSourceSchedule,
	getScheduleClient,
	getTemporalClient,
	isScheduledMode,
} from "@repo/temporal";
import { decryptApiKey } from "@repo/utils";
import { z } from "zod";
import { createNotification } from "../../../../lib/notification-service";
import { withCorrelationMemo } from "../../../../lib/temporal-correlation";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import {
	assertKnowledgeBaseCategoryIsDescribed,
	knowledgeBaseCategoryInputFields,
} from "./knowledge-base-category";
import { contextTabHref, displayUrl, estimateCopy } from "./lib/estimate-copy";

const URL_SCOPE_VALUES = ["SINGLE_PAGE", "PATH_PREFIX"] as const;
const URL_REFRESH_MODE_VALUES = [
	"ONCE",
	"DAILY",
	"WEEKLY",
	"MONTHLY",
	"LIVE",
] as const;

const MIN_MAX_PAGES = 1;
// Capped at 500 because at concurrency 1 with the per-scrape settle +
// selector wait + extraction, 500 pages already takes ~85 min wall-clock;
// going higher risks bumping the workflow's 120 min activity timeout.
// Default 200 keeps the Firecrawl spend low on the common case — most
// help centers and docs sites fit well under 200 pages.
const MAX_MAX_PAGES = 500;
const DEFAULT_MAX_PAGES = 200;

const URL_CONTEXT_TASK_QUEUE = "project-documents";
const URL_CRAWL_WORKFLOW_NAME = "urlSourceCrawlWorkflow";

/**
 * Provider names recognised by the URL-source flow. Mirror of
 * `WebScraperProviderName` in the temporal package — duplicated here so
 * the API package doesn't reach across into a workflow-side type. Kept in
 * lockstep via the test in `__tests__/process-context-link.test.ts`.
 */
type UrlSourceProviderName =
	| "firecrawl"
	| "jina"
	| "tavily"
	| "exa"
	| "parallel";

const SCRAPE_CAPABLE: ReadonlySet<UrlSourceProviderName> = new Set([
	"firecrawl",
	"jina",
	"tavily",
	"exa",
]);
const CRAWL_CAPABLE: ReadonlySet<UrlSourceProviderName> = new Set([
	"firecrawl",
]);

/**
 * Subset of the OrganizationSearchProvider / UserSearchProvider row shape we
 * need. Both Prisma models share these fields verbatim.
 */
interface SearchProviderRow {
	providerName: string;
	encryptedApiKey: string | null;
	enabled: boolean;
	isDefault: boolean;
	priority: number;
	createdAt: Date;
}

/**
 * BAD_REQUEST payload codes. The UI gates on `code` to render the correct
 * notice. `FIRECRAWL_NOT_CONFIGURED` is kept for back-compat: the UI knows
 * how to render it, so we still throw it when the tenant *does* have other
 * scrape providers but specifically asked for a crawl (PATH_PREFIX) — that
 * case is now `CRAWL_PROVIDER_NOT_CONFIGURED`, and the legacy code is reserved
 * for direct pre-flight calls from older clients.
 */
type ProviderNotConfiguredCode =
	| "SCRAPE_PROVIDER_NOT_CONFIGURED"
	| "CRAWL_PROVIDER_NOT_CONFIGURED"
	| "FIRECRAWL_NOT_CONFIGURED";

interface ProviderNotConfiguredData {
	code: ProviderNotConfiguredCode;
	settingsPath: string;
}

function buildSearchProvidersSettingsPath(orgSlug?: string | null): string {
	return orgSlug
		? `/app/${orgSlug}/settings/search-providers`
		: "/app/settings/search-providers";
}

async function resolveOrgSlug(
	organizationId: string | undefined,
): Promise<string | null> {
	if (!organizationId) {
		return null;
	}
	const org = await db.organization.findUnique({
		where: { id: organizationId },
		select: { slug: true },
	});
	return org?.slug ?? null;
}

/**
 * Reject `http(s)://user:pass@host/...`. zod's `.url()` already validates
 * the structure; this guard removes one specific abuse path (credentials
 * in URL) called out in the spec.
 */
function rejectCredentialedUrl(value: string): boolean {
	try {
		const parsed = new URL(value);
		return parsed.username === "" && parsed.password === "";
	} catch {
		return false;
	}
}

/**
 * Pick the first scrape-capable (and crawl-capable, when requireCrawl)
 * provider from the tenant's enabled list. Mirror of `getWebScraperForTenant`
 * minus the adapter construction — that happens activity-side in the worker.
 * Inlining the ordering here means the procedure doesn't depend on the
 * temporal worker code at compile time.
 */
function pickEnabledProvider(
	providers: SearchProviderRow[],
	requireCrawl: boolean,
): SearchProviderRow | null {
	const filter = requireCrawl
		? (n: string) => CRAWL_CAPABLE.has(n as UrlSourceProviderName)
		: (n: string) => SCRAPE_CAPABLE.has(n as UrlSourceProviderName);
	for (const provider of providers) {
		if (!provider.enabled || !provider.encryptedApiKey) {
			continue;
		}
		if (!filter(provider.providerName)) {
			continue;
		}
		return provider;
	}
	return null;
}

export const processContextLinkProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.CONTEXT_CREATE))
	.route({
		method: "POST",
		path: "/projects/:projectId/contexts/link",
		tags: ["Projects", "Contexts"],
		summary: "Process URL context source",
		description:
			"Add a URL as a project context source. Pre-flights a scrape-capable search provider, persists the parent ProjectContext row, and starts the urlSourceCrawlWorkflow for async crawl + embedding.",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			url: z.string().url().refine(rejectCredentialedUrl, {
				message: "URL must be public; remove embedded credentials.",
			}),
			label: z.string().max(120).optional(),
			scope: z.enum(URL_SCOPE_VALUES).default("SINGLE_PAGE").optional(),
			maxPages: z
				.number()
				.int()
				.min(MIN_MAX_PAGES)
				.max(MAX_MAX_PAGES)
				.default(DEFAULT_MAX_PAGES)
				.optional(),
			refreshMode: z.enum(URL_REFRESH_MODE_VALUES).default("ONCE"),
			...knowledgeBaseCategoryInputFields,
			// User-declared type label + AI guidance (Fizzy #1888). Optional.
			sourceType: z.string().trim().min(1).max(80).optional(),
			aiInstructions: z.string().trim().max(500).optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Project access — same guard as every other contexts procedure.
		const hasAccess = await hasProjectAccess(
			input.projectId,
			user.id,
			organizationId,
		);
		if (!hasAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		assertKnowledgeBaseCategoryIsDescribed(input);

		const scope = input.scope ?? "SINGLE_PAGE";
		const requireCrawl = scope === "PATH_PREFIX";

		// Pre-flight: read the tenant's enabled search providers (XOR
		// isolation) and pick the first scrape-capable one. We do this
		// BEFORE persisting the parent row so the BAD_REQUEST notice fires
		// without leaving a dangling EXTRACTING context behind.
		let providers: SearchProviderRow[];
		if (organizationId) {
			providers =
				await getEnabledOrganizationSearchProviders(organizationId);
		} else {
			providers = await getEnabledUserSearchProviders(user.id);
		}

		const scrapeCandidate = pickEnabledProvider(providers, false);
		if (!scrapeCandidate) {
			const settingsPath = buildSearchProvidersSettingsPath(
				await resolveOrgSlug(organizationId),
			);
			const data: ProviderNotConfiguredData = {
				code: "SCRAPE_PROVIDER_NOT_CONFIGURED",
				settingsPath,
			};
			throw new ORPCError("BAD_REQUEST", {
				message:
					"URL sources need a search provider with scraping (Firecrawl, Jina, Tavily, or Exa). Configure one in Settings → Search Providers.",
				data,
			});
		}

		// For PATH_PREFIX we additionally require a crawl-capable provider
		// (Firecrawl in v1.1). Other providers don't expose multi-page
		// includePaths/limit endpoints, so PATH_PREFIX with Jina/Tavily/Exa
		// would silently fall back to a single-page scrape — surfacing the
		// limitation explicitly is the better UX.
		const chosenProvider = requireCrawl
			? pickEnabledProvider(providers, true)
			: scrapeCandidate;
		if (!chosenProvider) {
			const settingsPath = buildSearchProvidersSettingsPath(
				await resolveOrgSlug(organizationId),
			);
			const data: ProviderNotConfiguredData = {
				code: "CRAWL_PROVIDER_NOT_CONFIGURED",
				settingsPath,
			};
			throw new ORPCError("BAD_REQUEST", {
				message:
					"Path-prefix crawls currently require Firecrawl. Configure Firecrawl in Settings → Search Providers, or pick Single page.",
				data,
			});
		}

		const providerName =
			chosenProvider.providerName as UrlSourceProviderName;

		// Decrypt the chosen provider's key once and reuse for both the
		// workflow kickoff (the activity rebuilds the adapter from
		// providerName + apiKey) and the per-context Schedule.
		let apiKey: string;
		try {
			if (!chosenProvider.encryptedApiKey) {
				throw new Error("Provider row missing encrypted API key");
			}
			apiKey = decryptApiKey(chosenProvider.encryptedApiKey);
		} catch (error) {
			logger.error(
				`[ProcessLink] Failed to decrypt API key for ${providerName}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: `Failed to read ${providerName} API key`,
			});
		}

		const maxPages =
			scope === "PATH_PREFIX"
				? (input.maxPages ?? DEFAULT_MAX_PAGES)
				: null;
		// `refreshMode` is `.default("ONCE")` on the zod schema, but we
		// belt-and-braces apply the same fallback here so direct handler
		// invocations (e.g. tests) never persist `undefined`.
		const refreshMode = input.refreshMode ?? "ONCE";

		// Persist the parent ProjectContext row. Stamp the chosen provider
		// name on `metadata.scraperProvider` so the drawer + analytics know
		// which provider ran. Other URL columns are patched in the second
		// update below to avoid widening `createLinkContext`.
		const projectContext = await createLinkContext({
			projectId: input.projectId,
			sourceUrl: input.url,
			sourceTitle: input.label,
			metadata: {
				addedBy: user.id,
				addedAt: new Date().toISOString(),
				scope,
				maxPages,
				refreshMode,
				scraperProvider: providerName,
			},
			knowledgeBaseSourceCategory: input.knowledgeBaseSourceCategory,
			knowledgeBaseSourceCategoryOther:
				input.knowledgeBaseSourceCategoryOther,
			sourceType: input.sourceType,
			aiInstructions: input.aiInstructions,
			userId: user.id,
			organizationId,
		});

		// Stamp the new URL Context Sources columns and flip status to
		// EXTRACTING. We use the existing `updateContextExtractionStatus`
		// helper for status / extractedAt bookkeeping and then a direct
		// Prisma update for the URL-specific columns to avoid widening that
		// helper for one caller.
		//
		// `urlNextRefreshAt` is stamped here so the Details sidebar can
		// surface "Next refresh in N hours" BEFORE the schedule first fires.
		// The workflow recomputes this on every fire (see
		// `computeNextRefreshAt` in `url-source-crawl.ts`); the
		// `cadenceNextFireUtc` helper is the canonical first-stamp source
		// because it aligns to the actual cron midnight rather than now+24h.
		const nextRefreshAt = cadenceNextFireUtc(refreshMode, new Date());
		await updateContextExtractionStatus(projectContext.id, "EXTRACTING");
		await db.projectContext.update({
			where: { id: projectContext.id },
			data: {
				urlScope: scope,
				urlMaxPages: maxPages,
				urlRefreshMode: refreshMode,
				urlNextRefreshAt: nextRefreshAt,
			},
		});

		// Kick off the crawl workflow. We invoke by string name so this
		// procedure has no compile-time dependency on the workflow module —
		// the worker resolves the name at activation time. The
		// `url-crawl-${contextId}` workflowId makes Temporal start
		// idempotent across retries.
		const workflowId = `url-crawl-${projectContext.id}`;
		try {
			const temporalClient = await getTemporalClient();
			await temporalClient.workflow.start(
				URL_CRAWL_WORKFLOW_NAME,
				withCorrelationMemo({
					taskQueue: URL_CONTEXT_TASK_QUEUE,
					workflowId,
					args: [
						{
							contextId: projectContext.id,
							url: input.url,
							scope,
							maxPages: maxPages ?? DEFAULT_MAX_PAGES,
							projectId: input.projectId,
							userId: user.id,
							organizationId: organizationId ?? null,
							apiKey,
							providerName,
							urlRefreshMode: refreshMode,
							parentSourceTitle: input.label ?? null,
							mode: "initial",
						},
					],
				}),
			);
			// Stamp the workflowId for the cancel procedure to look up.
			// Cleared by updateParentStatusActivity on COMPLETED/FAILED.
			await db.projectContext.update({
				where: { id: projectContext.id },
				data: { urlActiveWorkflowId: workflowId },
			});
			logger.info(
				`[ProcessLink] Started urlSourceCrawlWorkflow for context ${projectContext.id} (provider=${providerName}) as ${workflowId}`,
			);

			// Emit the persistent CONTEXT_INDEXING_STARTED notification so the
			// user has a bell row when they navigate away from the wizard /
			// post-creation surface mid-crawl. Spec §8.2 "started" block.
			//
			// `dedupeKey` namespaces on `contextId` so rapid retry-cancel-
			// retry sequences on the same URL coalesce into ONE unread row
			// (via the partial unique index at `schema.prisma:8901-8903` —
			// the 60s coalescing window kills any duplicate insert from a
			// double-click or a workflow restart). The completed-row uses a
			// different prefix (`context-indexing-completed:`) so the
			// "started" and "completed" rows for the same crawl don't
			// collide. Spec §8.5.
			//
			// Best-effort: a notification dispatch must never break the
			// procedure's response — the crawl is already in flight and the
			// in-dialog sonner toast (§8.4) is the primary feedback channel.
			try {
				const orgSlug = await resolveOrgSlug(organizationId);
				await createNotification({
					userId: user.id,
					organizationId: organizationId ?? null,
					type: "CONTEXT_INDEXING_STARTED",
					category: "CONTEXT_INDEXING_STARTED",
					title: `Indexing ${displayUrl(input.url)}`,
					snippet: estimateCopy(scope, maxPages ?? DEFAULT_MAX_PAGES),
					link: contextTabHref(input.projectId, orgSlug),
					source: { projectId: input.projectId },
					payload: {
						contextId: projectContext.id,
						sourceUrl: input.url,
						scope,
					},
					dedupeKey: `context-indexing-started:${projectContext.id}`,
				});
			} catch (notifyError) {
				logger.warn(
					`[ProcessLink] Failed to emit CONTEXT_INDEXING_STARTED notification for ${projectContext.id}: ${
						notifyError instanceof Error
							? notifyError.message
							: String(notifyError)
					}`,
				);
			}
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Unknown error";
			logger.error(
				`[ProcessLink] Failed to start urlSourceCrawlWorkflow for ${projectContext.id}: ${message}`,
			);
			// Mark the parent row FAILED so the UI's red badge has accurate
			// state. Best-effort — if this update fails we still surface the
			// original error.
			await updateContextExtractionStatus(projectContext.id, "FAILED", {
				extractionError: `Failed to start crawl: ${message}`,
			}).catch((updateErr) => {
				logger.error(
					`[ProcessLink] Failed to mark context ${projectContext.id} FAILED: ${updateErr}`,
				);
			});
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: `Failed to start URL crawl: ${message}`,
			});
		}

		// Schedule lifecycle. For DAILY / WEEKLY / MONTHLY we
		// create a per-context Temporal Schedule so the workflow fires
		// without a user action. ONCE and LIVE never get a schedule.
		//
		// Best-effort: a schedule-create failure does NOT fail the
		// procedure — the initial crawl has already started and the
		// reconciliation workflow will sweep up any drift.
		if (isScheduledMode(refreshMode)) {
			try {
				const scheduleClient = await getScheduleClient();
				const result = await createUrlSourceSchedule(
					{
						contextId: projectContext.id,
						url: input.url,
						scope,
						maxPages: maxPages ?? DEFAULT_MAX_PAGES,
						projectId: input.projectId,
						userId: user.id,
						organizationId: organizationId ?? null,
						apiKey,
						providerName,
						refreshMode,
						parentSourceTitle: input.label ?? null,
					},
					scheduleClient,
				);
				await db.projectContext.update({
					where: { id: projectContext.id },
					data: { urlScheduleId: result.scheduleId },
				});
				logger.info(
					`[ProcessLink] Created schedule ${result.scheduleId} for context ${projectContext.id}`,
				);
			} catch (error) {
				const message =
					error instanceof Error ? error.message : String(error);
				logger.error(
					`[ProcessLink] Failed to create schedule for ${projectContext.id}: ${message}`,
				);
				// Do NOT throw — the initial crawl is already in flight.
			}
		}

		return {
			contextId: projectContext.id,
			status: "EXTRACTING" as const,
		};
	});
