/**
 * resyncUrlPage — URL Context Sources (per-page retry for PATH_PREFIX).
 *
 * Re-scrapes a single child page of a PATH_PREFIX URL source without
 * re-running the entire parent's crawl. The PM ask: when a path-prefix
 * crawl has some COMPLETED and some FAILED pages, the user can hit a
 * Retry button on each failed row to re-scrape just that page instead of
 * paying scraper credits to re-crawl every sibling.
 *
 * Delegates to the existing `urlSourceCrawlWorkflow` with
 * `mode: 'retry-single-page'` and `retryPageUrl` set. The workflow's
 * retry branch:
 *   1. Calls `firecrawlScrapeActivity(retryPageUrl, ...)` with the same
 *      scrapeOptions as the parent's crawl (the activity is provider-
 *      agnostic — it dispatches on the `providerName` + apiKey it is given).
 *   2. Calls `upsertUrlPageActivity` in `manual-resync` semantics so
 *      content + extractionStatus are overwritten even on hash match.
 *   3. Calls `embedUrlPageActivity` to re-embed the page into Qdrant.
 * A scrape that fails puts the page back to FAILED instead
 * (`recordUrlPageRetryFailureActivity`).
 *
 * Tenant isolation: same `tenantProtectedProcedure` +
 * `requireProjectPermission(CONTEXT_UPDATE)` guards as `resyncUrlSource`.
 * The XOR filter is verified against the parent context AND mirrored on
 * the child row lookup so personal-context users cannot address an org
 * page by id.
 */
import { ORPCError } from "@orpc/server";
import { db, getContextById, hasProjectAccess } from "@repo/database";
import { logger } from "@repo/logs";
import { getTemporalClient } from "@repo/temporal";
import { z } from "zod";
import { withCorrelationMemo } from "../../../../lib/temporal-correlation";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import {
	providerWorkflowArgs,
	resolveUrlSourceProvider,
} from "./lib/url-source-provider";

const URL_CONTEXT_TASK_QUEUE = "project-documents";
const URL_CRAWL_WORKFLOW_NAME = "urlSourceCrawlWorkflow";

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

		// Pre-flight the scraper — same resolver as `resyncUrlSource`, so the
		// UI's notice card renders identically. We resolve the key here (not
		// in the workflow) because the worker sandbox can't reach the
		// credential store and the activity needs a literal key.
		//
		// One page needs only a provider that can scrape, whatever the
		// parent's scope: a path-prefix parent crawled with Firecrawl can have
		// a failed page retried through Jina, say, when that is what the
		// tenant now has. `parent.metadata.scraperProvider` records which
		// provider crawled originally; it is a record, not a pin.
		const provider = await resolveUrlSourceProvider({
			organizationId,
			userId: user.id,
			scope: "SINGLE_PAGE",
		});

		// Flip the child row's status to PENDING optimistically. The
		// workflow's upsert activity rewrites the content and clears the
		// error, and the embed pipeline finalizes COMPLETED. The error is
		// kept until then: when the retry's scrape fails, the workflow
		// puts the row back to FAILED and reads it to choose the reason
		// (`urlPageRetryFetchFailureWritableWhere`). The workflow's
		// retry-single-page branch never touches the parent row.
		await db.projectContextUrlPage.update({
			where: { id: page.id },
			data: { extractionStatus: "PENDING" },
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
							...providerWorkflowArgs(provider),
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
