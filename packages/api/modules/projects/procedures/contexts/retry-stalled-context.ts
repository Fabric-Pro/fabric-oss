/**
 * retryStalled — restart a context source whose processing stopped (Fizzy #2886).
 *
 * The Context tab's stall banner names the stuck sources and sends the viewer
 * to each one's row; this is the Retry on that row. Until it existed the only
 * way out was removing the source and adding it again, and "Sync now" could
 * not help a link either — it refuses any row still marked in flight, which a
 * stuck one always is.
 *
 * ## Only a source that really stopped
 *
 * The guard is the stall verdict itself, read for one row: in flight, with an
 * extraction lifecycle, and quiet for longer than the window the banner uses —
 * no write to the row, or a processing job that stopped heartbeating. Anything
 * else is refused. A run that is merely slow must not be doubled, and a live
 * integration whose status never moves has nothing to restart.
 *
 * ## Which workflow
 *
 * The one that would have produced the row in the first place, under a FRESH
 * workflow id — the first run's id may still be held by the dead execution, and
 * reusing it would be refused as a duplicate (the same reason the company
 * context retry suffixes its id):
 *
 * - a row with a stored original (`s3Path`: uploads, and Google Docs, which
 *   are exported to storage) is re-extracted from it, as a retry;
 * - a link is crawled again;
 * - anything else that holds its own text is embedded again from the row.
 *
 * A row with none of those has nothing to retry from, and says so.
 */
import { ORPCError } from "@orpc/server";
import {
	createBackgroundJob,
	db,
	failBackgroundJob,
	getContextById,
	getSearchProviderConfig,
	hasProjectAccess,
	seedSteps,
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
import { STALL_MINUTES_BY_SOURCE } from "../../../capabilities/thresholds";
import { hasExtractionLifecycle } from "../../lib/extraction-lifecycle";

const TASK_QUEUE = "project-documents";

const IN_FLIGHT_STATUSES = new Set(["PENDING", "EXTRACTING"]);

type RetryDispatch = "processing" | "crawl" | "embedding";

export const retryStalledContextProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.CONTEXT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/:projectId/contexts/:contextId/retry-stalled",
		tags: ["Projects", "Contexts"],
		summary: "Retry a stalled context source",
		description:
			"Restart processing for a context source that stopped partway through, under a fresh workflow id.",
	})
	.input(
		z.object({
			contextId: z.string(),
			projectId: z.string(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		// From the session, never the input: nothing on this call has a
		// reason to name an organization, and a caller-supplied one is
		// returned unchecked.
		const organizationId = resolveOrganizationId(
			undefined,
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

		// Tenant + IDOR guard — the same XOR filter the other context doors use.
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
				message: "Context not found",
			});
		}

		if (!hasExtractionLifecycle(existing)) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"This source is a live connection with no processing to retry.",
			});
		}
		if (!IN_FLIGHT_STATUSES.has(existing.extractionStatus)) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"Only a source that stopped processing can be retried.",
			});
		}

		const now = new Date();
		const cutoff = new Date(
			now.getTime() - STALL_MINUTES_BY_SOURCE.backgroundJob * 60 * 1000,
		);
		const runningJobs = await db.backgroundJob.findMany({
			where: {
				projectId: input.projectId,
				kind: "CONTEXT_PROCESSING",
				status: "RUNNING",
				sourceType: "projectContext",
				sourceId: existing.id,
			},
			select: { workflowId: true, heartbeatAt: true },
		});
		const liveJob = runningJobs.some((job) => job.heartbeatAt >= cutoff);
		const stalled =
			!liveJob && (existing.updatedAt < cutoff || runningJobs.length > 0);
		if (!stalled) {
			throw new ORPCError("CONFLICT", {
				message:
					"This source is still processing. Retry becomes available if it stops.",
			});
		}

		const dispatch: RetryDispatch | null = existing.s3Path
			? "processing"
			: existing.type === "LINK" && existing.sourceUrl
				? "crawl"
				: existing.content.trim().length > 0
					? "embedding"
					: null;
		if (dispatch === null) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"Nothing is stored for this source to retry from. Remove it and add it again.",
			});
		}

		// A multi-page crawl writes its pages, not the parent row, until it
		// ends — so a long one can be quiet past the window while it is very
		// much alive. Ask Temporal about the crawl the row names before
		// starting a second one to race it.
		if (dispatch === "crawl" && existing.urlActiveWorkflowId) {
			if (await isWorkflowRunning(existing.urlActiveWorkflowId)) {
				throw new ORPCError("CONFLICT", {
					message:
						"This source is still processing. Retry becomes available if it stops.",
				});
			}
		}

		// The crawl carries the key in its arguments. Read before anything is
		// written, so a missing key leaves the row exactly as it was.
		const firecrawlApiKey =
			dispatch === "crawl"
				? await readFirecrawlKey(user.id, organizationId)
				: null;

		// Claim the row: restart its clock and clear the dead run's message, so
		// it reads as freshly queued and the banner clears on the next read.
		// Conditional on the row being exactly as read, because the checks
		// above and this write are not one statement: two Retry presses —
		// two tabs, two teammates — both pass them, and an unconditional
		// write would let both start a workflow. The first claim moves
		// `updatedAt`, so the second matches nothing and stops here. The same
		// two fields `updateContextExtractionStatus` writes for PENDING.
		const claim = await db.projectContext.updateMany({
			where: {
				id: existing.id,
				updatedAt: existing.updatedAt,
				extractionStatus: { in: ["PENDING", "EXTRACTING"] },
			},
			data: { extractionStatus: "PENDING", extractionError: null },
		});
		if (claim.count === 0) {
			throw new ORPCError("CONFLICT", {
				message: "This source is already being retried.",
			});
		}

		// The dead run's job rows would otherwise keep the banner's clock
		// stopped: the stall verdict prefers a running job's heartbeat over
		// the row's own write, so touching the row alone would not clear it.
		for (const job of runningJobs) {
			await failBackgroundJob(
				{ workflowId: job.workflowId, sourceId: existing.id },
				{
					error: "Stopped responding — restarted by a retry",
					errorClass: "TimedOut",
				},
			);
		}

		const contextOrganizationId = existing.organizationId ?? undefined;
		let workflowId: string;
		try {
			const temporalClient = await getTemporalClient();
			if (dispatch === "processing") {
				workflowId = `project-context-processing-${existing.id}-retry-${Date.now()}`;
				await temporalClient.workflow.start(
					"projectContextProcessingWorkflow",
					withCorrelationMemo({
						taskQueue: TASK_QUEUE,
						workflowId,
						args: [
							{
								contextId: existing.id,
								projectId: input.projectId,
								userId: user.id,
								organizationId: contextOrganizationId,
								extractionStrategy: "local-only",
								isRetry: true,
							},
						],
					}),
				);
				await createBackgroundJob({
					kind: "CONTEXT_PROCESSING",
					title:
						existing.sourceTitle ||
						existing.originalFilename ||
						"Document processing",
					projectId: input.projectId,
					userId: user.id,
					organizationId: contextOrganizationId ?? null,
					workflowId,
					sourceType: "projectContext",
					sourceId: existing.id,
					steps: seedSteps([
						"download",
						"extract",
						"chunk",
						"embed",
						"store",
					]),
				});
			} else if (dispatch === "crawl") {
				workflowId = `url-crawl-${existing.id}-retry-${Date.now()}`;
				await temporalClient.workflow.start(
					"urlSourceCrawlWorkflow",
					withCorrelationMemo({
						taskQueue: TASK_QUEUE,
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
				// For the cancel procedure, as on every other crawl start.
				await db.projectContext.update({
					where: { id: existing.id },
					data: { urlActiveWorkflowId: workflowId },
				});
			} else {
				workflowId = `context-embedding-${existing.id}-${Date.now()}`;
				await temporalClient.workflow.start(
					"contextEmbeddingWorkflow",
					withCorrelationMemo({
						taskQueue: TASK_QUEUE,
						workflowId,
						args: [
							{
								// No body: the activity reads it back from
								// the row, so a long one never has to fit in
								// the workflow input.
								contextId: existing.id,
								projectId: input.projectId,
								userId: user.id,
								organizationId: contextOrganizationId,
								type: existing.type,
								metadata: (existing.metadata ?? undefined) as
									| Record<string, unknown>
									| undefined,
							},
						],
					}),
				);
			}
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Unknown error";
			logger.error(
				`[RetryStalledContext] Failed to restart ${dispatch} for context ${existing.id}: ${message}`,
			);
			// Honest about it: the row goes to Needs Care rather than back to
			// a "processing" state nothing is behind.
			await updateContextExtractionStatus(existing.id, "FAILED", {
				extractionError: `Failed to restart processing: ${message}`,
			}).catch(() => {
				/* swallow secondary failure */
			});
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: "Failed to restart processing for this source",
			});
		}

		logger.info(
			`[RetryStalledContext] Restarted ${dispatch} for context ${existing.id} as ${workflowId}`,
		);

		return { contextId: existing.id, dispatch, workflowId };
	});

/**
 * Whether Temporal still reports this execution as running. An execution it
 * cannot find — expired from retention, never started — is not running.
 */
async function isWorkflowRunning(workflowId: string): Promise<boolean> {
	try {
		const temporalClient = await getTemporalClient();
		const description = await temporalClient.workflow
			.getHandle(workflowId)
			.describe();
		return description.status.name === "RUNNING";
	} catch {
		return false;
	}
}

/** The crawl's Firecrawl key, with the same refusal the add-link dialog shows. */
async function readFirecrawlKey(
	userId: string,
	organizationId: string | undefined,
): Promise<string> {
	const config = await getSearchProviderConfig({
		userId,
		organizationId,
		providerName: "firecrawl",
	});
	if (!config || !config.enabled || !config.encryptedApiKey) {
		let orgSlug: string | null = null;
		if (organizationId) {
			const org = await db.organization.findUnique({
				where: { id: organizationId },
				select: { slug: true },
			});
			orgSlug = org?.slug ?? null;
		}
		throw new ORPCError("BAD_REQUEST", {
			message:
				"URL sources need a Firecrawl API key. Configure it in Settings → Search Providers to retry.",
			data: {
				code: "FIRECRAWL_NOT_CONFIGURED",
				settingsPath: orgSlug
					? `/app/${orgSlug}/settings/search-providers`
					: "/app/settings/search-providers",
			},
		});
	}
	try {
		return decryptApiKey(config.encryptedApiKey);
	} catch (error) {
		logger.error(
			`[RetryStalledContext] Failed to decrypt Firecrawl key: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		throw new ORPCError("INTERNAL_SERVER_ERROR", {
			message: "Failed to read Firecrawl API key",
		});
	}
}
