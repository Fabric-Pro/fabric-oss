/**
 * resyncUrlSource — URL Context Sources.
 *
 * Manual re-sync: flips the parent ProjectContext row back to PENDING and
 * kicks off `urlSourceCrawlWorkflow` with `mode: 'manual-resync'`.
 *
 * Same Firecrawl pre-flight as `processLink` so a revoked key surfaces
 * the SAME `FIRECRAWL_NOT_CONFIGURED` notice the dialog shows — no
 * second UI surface to keep in sync.
 */
import { ORPCError } from "@orpc/server";
import {
	db,
	getContextById,
	getSearchProviderConfig,
	hasProjectAccess,
	updateContextExtractionStatus,
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

		// Pre-flight Firecrawl key. Same shape as processLink so the UI's
		// notice card renders identically whether we're adding or
		// re-syncing.
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
					"URL sources need a Firecrawl API key. Configure it in Settings → Search Providers to re-sync.",
				data,
			});
		}

		// Decrypt the Firecrawl key for the workflow args (the workflow
		// embeds the key in its activity calls — Group 4 contract).
		let firecrawlApiKey: string;
		try {
			firecrawlApiKey = decryptApiKey(firecrawlConfig.encryptedApiKey);
		} catch (error) {
			logger.error(
				`[ResyncUrlSource] Failed to decrypt Firecrawl key: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: "Failed to read Firecrawl API key",
			});
		}

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
							apiKey: firecrawlApiKey,
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
