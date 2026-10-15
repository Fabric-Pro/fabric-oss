/**
 * processLink — URL Context Sources.
 *
 * Multi-provider routing:
 *  1. Resolve a scrape-capable (and crawl-capable, for PATH_PREFIX) provider
 *     from the tenant's unified search-provider table via
 *     `getEnabledOrganizationSearchProviders` / `getEnabledUserSearchProviders`.
 *     Picker mirrors `getWebScraperForTenant` from
 *     `packages/temporal/src/activities/lib/get-web-scraper.ts`.
 *  2. If no scrape-capable provider exists →
 *     `BAD_REQUEST { code: 'SCRAPE_PROVIDER_NOT_CONFIGURED', settingsPath }`.
 *  3. If PATH_PREFIX is requested but no crawl-capable (Firecrawl or Cloudflare) provider →
 *     `BAD_REQUEST { code: 'CRAWL_PROVIDER_NOT_CONFIGURED', settingsPath }`.
 *  4. Resolution lives in `lib/url-source-provider.ts`, shared with every
 *     follow-up (re-sync, retry, page retry, schedule edit) and the company
 *     context crawls, so they all pick the same scraper.
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
import {
	providerWorkflowArgs,
	resolveOrgSlug,
	resolveUrlSourceProvider,
} from "./lib/url-source-provider";

export const URL_SCOPE_VALUES = ["SINGLE_PAGE", "PATH_PREFIX"] as const;
export const URL_REFRESH_MODE_VALUES = [
	"ONCE",
	"DAILY",
	"WEEKLY",
	"MONTHLY",
	"LIVE",
] as const;

export const MIN_MAX_PAGES = 1;
// Capped at 500 because at concurrency 1 with the per-scrape settle +
// selector wait + extraction, 500 pages already takes ~85 min wall-clock;
// going higher risks bumping the workflow's 120 min activity timeout.
// Default 200 keeps the Firecrawl spend low on the common case — most
// help centers and docs sites fit well under 200 pages.
export const MAX_MAX_PAGES = 500;
export const DEFAULT_MAX_PAGES = 200;

const URL_CONTEXT_TASK_QUEUE = "project-documents";
const URL_CRAWL_WORKFLOW_NAME = "urlSourceCrawlWorkflow";

/**
 * Reject `http(s)://user:pass@host/...`. zod's `.url()` already validates
 * the structure; this guard removes one specific abuse path (credentials
 * in URL) called out in the spec.
 */
export function rejectCredentialedUrl(value: string): boolean {
	try {
		const parsed = new URL(value);
		return parsed.username === "" && parsed.password === "";
	} catch {
		return false;
	}
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

		// Pre-flight: pick the tenant's scraper (XOR isolation: organization
		// providers, or the user's own with no organization) and decrypt its
		// key. We do this BEFORE persisting the parent row so the BAD_REQUEST
		// notice fires without leaving a dangling EXTRACTING context behind.
		// The key is reused for both the workflow kickoff (the activity
		// rebuilds the adapter from providerName + apiKey) and the per-context
		// Schedule; the row's stored endpoint (Cloudflare's account ID)
		// travels with them.
		const provider = await resolveUrlSourceProvider({
			organizationId,
			userId: user.id,
			scope,
		});
		const providerName = provider.providerName;

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
							...providerWorkflowArgs(provider),
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
						...providerWorkflowArgs(provider),
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
