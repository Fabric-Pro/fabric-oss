/**
 * resyncUrlPage — URL Context Sources (per-page retry for PATH_PREFIX).
 *
 * Re-scrapes a single child page of a PATH_PREFIX URL source without
 * re-running the entire parent's crawl. The PM ask: when a path-prefix
 * crawl has some COMPLETED and some FAILED pages, the user can hit a
 * Retry button on each failed row to re-scrape just that page instead of
 * paying Firecrawl credits to re-crawl every sibling.
 *
 * Delegates to the existing `urlSourceCrawlWorkflow` with
 * `mode: 'retry-single-page'` and `retryPageUrl` set. The workflow's
 * retry branch:
 *   1. Calls `firecrawlScrapeActivity(retryPageUrl, ...)` with the same
 *      scrapeOptions as the parent's crawl (the activity is provider-
 *      agnostic — it just reuses the parent's `providerName` + apiKey).
 *   2. Calls `upsertUrlPageActivity` in `manual-resync` semantics so
 *      content + extractionStatus are overwritten even on hash match.
 *   3. Calls `embedUrlPageActivity` to re-embed the page into Qdrant.
 *
 * Tenant isolation: same `tenantProtectedProcedure` +
 * `requireProjectPermission(CONTEXT_UPDATE)` guards as `resyncUrlSource`.
 * The XOR filter is verified against the parent context AND mirrored on
 * the child row lookup so personal-context users cannot address an org
 * page by id.
 */
import { ORPCError } from "@orpc/server";
import {
	db,
	getContextById,
	getSearchProviderConfig,
	hasProjectAccess,
} from "@repo/database";
import { logger } from "@repo/logs";
import { getTemporalClient } from "@repo/temporal";
import { decryptApiKey } from "@repo/utils";
import { z } from "zod";
import { withCorrelationMemo } from "../../../../lib/temporal-correlation";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

const URL_CONTEXT_TASK_QUEUE = "project-documents";
const URL_CRAWL_WORKFLOW_NAME = "urlSourceCrawlWorkflow";

interface FirecrawlNotConfiguredData {
	code: "FIRECRAWL_NOT_CONFIGURED";
	settingsPath: string;
}

function buildFirecrawlSettingsPath(orgSlug: string | null): string {
	return orgSlug
		? `/app/${orgSlug}/settings/search-providers`
		: "/app/settings/search-providers";
}

export const resyncUrlPageProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.CONTEXT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/:projectId/contexts/:parentContextId/url-pages/:pageId/resync",
		tags: ["Projects", "Contexts"],
		summary: "Re-scrape a single URL page",
		description:
			"Re-scrape one child page under a PATH_PREFIX URL source. Skips the full parent crawl. Uses the same scrapeOptions / embed pipeline as the parent.",
	})
	.input(
		z.object({
			pageId: z.string(),
			parentContextId: z.string(),
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

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

		// Parent guard — XOR-isolated. Mirrors `listUrlPages` / `resyncUrlSource`.
		const parent = await getContextById(
			input.parentContextId,
			input.projectId,
			{
				userId: user.id,
				organizationId: organizationId ?? null,
			},
		);
		if (!parent) {
			throw new ORPCError("NOT_FOUND", {
				message: "URL context not found",
			});
		}
		if (parent.type !== "LINK") {
			throw new ORPCError("BAD_REQUEST", {
				message: "Only LINK contexts have URL pages",
			});
		}
		if (!parent.sourceUrl) {
			throw new ORPCError("BAD_REQUEST", {
				message: "URL context has no sourceUrl",
			});
		}

		// Child row guard: mirror the tenant XOR so a personal-context
		// caller can't address an org child row by id. RLS provides
		// defence-in-depth; this gives the UI a typed NOT_FOUND.
		const tenantFilter = organizationId
			? { organizationId, userId: user.id }
			: { organizationId: null, userId: user.id };

		const page = await db.projectContextUrlPage.findFirst({
			where: {
				id: input.pageId,
				parentContextId: input.parentContextId,
				...tenantFilter,
			},
			select: {
				id: true,
				pageUrl: true,
				parentContextId: true,
			},
		});
		if (!page) {
			throw new ORPCError("NOT_FOUND", {
				message: "URL page not found",
			});
		}

		// Pre-flight Firecrawl key — same shape as resyncUrlSource so the
		// UI's notice card renders identically. We resolve the key here
		// (not in the workflow) because the worker sandbox can't reach
		// the credential store and the activity needs a literal key.
		//
		// Note: `parent.metadata.scraperProvider` records which provider
		// crawled originally, but the retry today always uses Firecrawl
		// for parity with `resyncUrlSource`. If we add multi-provider
		// scrape (Jina/Tavily) for child retries this is the spot to
		// resolve the original provider via `getSearchProviderConfig`.
		const firecrawlConfig = await getSearchProviderConfig({
			userId: user.id,
			organizationId,
			providerName: "firecrawl",
		});
		if (
			!firecrawlConfig ||
			!firecrawlConfig.enabled ||
			!firecrawlConfig.encryptedApiKey
		) {
			let orgSlug: string | null = null;
			if (organizationId) {
				const org = await db.organization.findUnique({
					where: { id: organizationId },
					select: { slug: true },
				});
				orgSlug = org?.slug ?? null;
			}
			const data: FirecrawlNotConfiguredData = {
				code: "FIRECRAWL_NOT_CONFIGURED",
				settingsPath: buildFirecrawlSettingsPath(orgSlug),
			};
			throw new ORPCError("BAD_REQUEST", {
				message:
					"URL sources need a Firecrawl API key. Configure it in Settings → Search Providers to retry pages.",
				data,
			});
		}

		let firecrawlApiKey: string;
		try {
			firecrawlApiKey = decryptApiKey(firecrawlConfig.encryptedApiKey);
		} catch (error) {
			logger.error(
				`[ResyncUrlPage] Failed to decrypt Firecrawl key: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: "Failed to read Firecrawl API key",
			});
		}

		// Flip the child row's status to PENDING + clear the error
		// optimistically. The workflow's upsert activity will move it
		// back to PENDING / COMPLETED on success (it sets PENDING on
		// content-change paths; the embed pipeline finalizes COMPLETED).
		// On failure the workflow's retry-single-page branch DOES NOT
		// touch the parent row, so the child stays in whatever state
		// the upsert activity left it in.
		await db.projectContextUrlPage.update({
			where: { id: page.id },
			data: {
				extractionStatus: "PENDING",
				extractionError: null,
			},
		});

		try {
			const temporalClient = await getTemporalClient();
			await temporalClient.workflow.start(
				URL_CRAWL_WORKFLOW_NAME,
				withCorrelationMemo({
					taskQueue: URL_CONTEXT_TASK_QUEUE,
					// `Date.now()` suffix keeps the workflowId unique across
					// repeated retries of the same page.
					workflowId: `url-crawl-${parent.id}-retry-${page.id}-${Date.now()}`,
					args: [
						{
							contextId: parent.id,
							url: parent.sourceUrl,
							scope: parent.urlScope ?? "PATH_PREFIX",
							maxPages: parent.urlMaxPages ?? 100,
							projectId: input.projectId,
							userId: user.id,
							organizationId: organizationId ?? null,
							apiKey: firecrawlApiKey,
							urlRefreshMode: parent.urlRefreshMode ?? undefined,
							parentSourceTitle: parent.sourceTitle ?? null,
							mode: "retry-single-page",
							retryPageUrl: page.pageUrl,
						},
					],
				}),
			);
			logger.info(
				`[ResyncUrlPage] Started retry-single-page workflow for context=${parent.id} page=${page.id}`,
			);
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Unknown error";
			logger.error(
				`[ResyncUrlPage] Failed to start retry workflow for ${page.id}: ${message}`,
			);
			// Best-effort: revert the optimistic PENDING flip to FAILED so
			// the UI's red badge stays accurate when workflow start blows up.
			await db.projectContextUrlPage
				.update({
					where: { id: page.id },
					data: {
						extractionStatus: "FAILED",
						extractionError: `Failed to start retry: ${message}`,
					},
				})
				.catch(() => {
					/* swallow secondary failure */
				});
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: `Failed to start page retry: ${message}`,
			});
		}

		return {
			pageId: page.id,
			status: "EXTRACTING" as const,
		};
	});
