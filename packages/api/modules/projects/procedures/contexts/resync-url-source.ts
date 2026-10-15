/**
 * resyncUrlSource — URL Context Sources.
 *
 * Manual re-sync: flips the parent ProjectContext row back to PENDING and
 * kicks off `urlSourceCrawlWorkflow` with `mode: 'manual-resync'`.
 *
 * Same scraper pre-flight as `processLink` (`resolveUrlSourceProvider`): the
 * tenant's first enabled provider that can scrape — or crawl, for a path
 * prefix — is chosen fresh on every re-sync, so a tenant on Jina, Tavily, Exa
 * or Cloudflare can re-sync like one on Firecrawl, and a missing provider
 * surfaces the SAME `SCRAPE_PROVIDER_NOT_CONFIGURED` /
 * `CRAWL_PROVIDER_NOT_CONFIGURED` notice the dialog shows — no second UI
 * surface to keep in sync.
 */
import { ORPCError } from "@orpc/server";
import {
	db,
	getContextById,
	hasProjectAccess,
	updateContextExtractionStatus,
} from "@repo/database";
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

export const resyncUrlSourceProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.CONTEXT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/:projectId/contexts/:contextId/url-source/resync",
		tags: ["Projects", "Contexts"],
		summary: "Re-sync URL context source",
		description:
			"Flip extractionStatus to PENDING and start urlSourceCrawlWorkflow with mode=manual-resync.",
	})
	.input(
		z.object({
			contextId: z.string(),
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

		// Tenant + IDOR guard — same XOR filter as updateUrlSource.
		const existing = await getContextById(
			input.contextId,
			input.projectId,
			{
				userId: user.id,
				organizationId: organizationId ?? null,
			},
		);
		if (!existing) {
			throw new ORPCError("NOT_FOUND", {
				message: "URL context not found",
			});
		}
		if (existing.type !== "LINK") {
			throw new ORPCError("BAD_REQUEST", {
				message: "Only LINK contexts can be re-synced as URL sources",
			});
		}
		if (!existing.sourceUrl) {
			throw new ORPCError("BAD_REQUEST", {
				message: "URL context has no sourceUrl to re-sync",
			});
		}

		// Server-side guard against concurrent re-syncs. The UI disables the
		// Re-sync button while a crawl is in flight, but a second tab, a
		// different teammate, or a curl could still call the procedure. If
		// the parent context is mid-crawl (PENDING or EXTRACTING) refuse here
		// rather than spawning a duplicate workflow that races the running
		// one for row writes.
		if (
			existing.extractionStatus === "PENDING" ||
			existing.extractionStatus === "EXTRACTING"
		) {
			throw new ORPCError("CONFLICT", {
				message:
					"Processing is already in progress for this URL source. Wait for it to finish or cancel it before triggering another re-sync.",
			});
		}

		// Pre-flight the scraper, before anything is written, so a missing
		// provider leaves the row exactly as it was. The key travels in the
		// workflow args (the activity sandbox can't reach the credential
		// store).
		const provider = await resolveUrlSourceProvider({
			organizationId,
			userId: user.id,
			scope: existing.urlScope ?? "SINGLE_PAGE",
		});

		// Flip status to PENDING and clear any prior error so the UI's red
		// badge resets immediately. The workflow will move us to EXTRACTING
		// once it picks up the task.
		await updateContextExtractionStatus(existing.id, "PENDING", {
			extractionError: undefined,
		});

		// Suffix with timestamp so a manual re-sync after a prior completed
		// run isn't rejected as a duplicate workflowId. Captured here so we
		// can stamp it on the context row for the cancel procedure to look
		// up, then start the workflow with the exact same id.
		const workflowId = `url-crawl-${existing.id}-resync-${Date.now()}`;

		try {
			const temporalClient = await getTemporalClient();
			await temporalClient.workflow.start(
				URL_CRAWL_WORKFLOW_NAME,
				withCorrelationMemo({
					taskQueue: URL_CONTEXT_TASK_QUEUE,
					workflowId,
					args: [
						{
							contextId: existing.id,
							url: existing.sourceUrl,
							scope: existing.urlScope ?? "SINGLE_PAGE",
							maxPages: existing.urlMaxPages ?? 100,
							projectId: input.projectId,
							userId: user.id,
							organizationId: organizationId ?? null,
							...providerWorkflowArgs(provider),
							urlRefreshMode:
								existing.urlRefreshMode ?? undefined,
							parentSourceTitle: existing.sourceTitle ?? null,
							mode: "manual-resync",
						},
					],
				}),
			);
			// Stamp the workflow id on the context row so the cancel
			// procedure can find this exact handle later. Cleared by
			// updateParentStatusActivity on COMPLETED/FAILED.
			await db.projectContext.update({
				where: { id: existing.id },
				data: { urlActiveWorkflowId: workflowId },
			});
			logger.info(
				`[ResyncUrlSource] Started urlSourceCrawlWorkflow (manual-resync) for context ${existing.id} as ${workflowId}`,
			);
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Unknown error";
			logger.error(
				`[ResyncUrlSource] Failed to start crawl for ${existing.id}: ${message}`,
			);
			await updateContextExtractionStatus(existing.id, "FAILED", {
				extractionError: `Failed to start crawl: ${message}`,
			}).catch(() => {
				/* swallow secondary failure */
			});
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: `Failed to start URL re-sync: ${message}`,
			});
		}

		return {
			contextId: existing.id,
			status: "EXTRACTING" as const,
		};
	});
