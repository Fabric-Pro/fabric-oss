/**
 * cancelUrlSourceCrawl — URL Context Sources.
 *
 * User-driven crawl cancellation. Reads the in-flight workflowId off the
 * parent ProjectContext row (set by `resync-url-source` /
 * `process-context-link` at workflow.start time) and asks Temporal to
 * cancel that workflow handle. The workflow body catches `CancelledFailure`
 * from the firecrawl-crawl activity and finalizes through the normal
 * `updateParentStatusActivity` finalize step — which both flips the row
 * back to a terminal status (COMPLETED with whatever pages were indexed
 * before the cancel, OR FAILED) and clears `urlActiveWorkflowId`. The
 * pages already written to ProjectContextUrlPage rows + Qdrant are
 * deliberately preserved — partial progress survives the cancel.
 */
import { ORPCError } from "@orpc/server";
import { db, getContextById, hasProjectAccess } from "@repo/database";
import { logger } from "@repo/logs";
import { getTemporalClient } from "@repo/temporal";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

export const cancelUrlSourceCrawlProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.CONTEXT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/:projectId/contexts/:contextId/url-source/cancel",
		tags: ["Projects", "Contexts"],
		summary: "Cancel an in-flight URL crawl",
		description:
			"Signal cancellation to the Temporal workflow handling this URL source's crawl. Pages indexed so far are preserved.",
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

		// Tenant + IDOR guard mirrored from resyncUrlSource.
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
				message: "Only LINK contexts have URL processing to cancel",
			});
		}

		// Only mid-flight crawls are cancellable. COMPLETED / FAILED are
		// already terminal — nothing to cancel — and the UI should hide the
		// Cancel control in those cases. We return BAD_REQUEST so the UI
		// can show a clear error if a stale tab tries to cancel after a
		// crawl already finished.
		if (
			existing.extractionStatus !== "PENDING" &&
			existing.extractionStatus !== "EXTRACTING"
		) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"No processing is currently in progress for this URL source.",
			});
		}

		const workflowId = existing.urlActiveWorkflowId;
		if (!workflowId) {
			// Status says PENDING/EXTRACTING but we have no workflowId — the
			// row drifted out of sync (e.g., legacy crawls started before
			// this field existed). Best-effort: surface the inconsistency so
			// the operator can manually clear the status. Returning OK with
			// a no-op cancel would silently mask the underlying issue.
			logger.warn(
				`[CancelUrlSourceCrawl] Context ${existing.id} is in ${existing.extractionStatus} but has no urlActiveWorkflowId — cannot cancel`,
			);
			throw new ORPCError("BAD_REQUEST", {
				message:
					"This run pre-dates cancellation support and can't be cancelled. Wait for it to finish or contact support if it's stuck.",
			});
		}

		try {
			const temporalClient = await getTemporalClient();
			const handle = temporalClient.workflow.getHandle(workflowId);
			await handle.cancel();
			logger.info(
				`[CancelUrlSourceCrawl] Sent cancel to workflow ${workflowId} for context ${existing.id}`,
			);
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Unknown error";
			// Temporal returns NOT_FOUND for an unknown workflowId — the
			// workflow may have completed between the UI's click and our
			// cancel call. Treat that as success from the user's POV
			// (nothing to cancel) and clear the row's stale workflowId so
			// future re-syncs aren't blocked by the CONFLICT guard.
			if (/not\s+found/i.test(message)) {
				logger.warn(
					`[CancelUrlSourceCrawl] Workflow ${workflowId} not found — likely completed already; clearing urlActiveWorkflowId`,
				);
				await db.projectContext
					.update({
						where: { id: existing.id },
						data: { urlActiveWorkflowId: null },
					})
					.catch(() => {
						/* swallow secondary failure */
					});
				return {
					contextId: existing.id,
					status: "ALREADY_FINISHED" as const,
				};
			}
			logger.error(
				`[CancelUrlSourceCrawl] Failed to cancel ${workflowId}: ${message}`,
			);
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: `Failed to cancel processing: ${message}`,
			});
		}

		// Don't flip the parent status here — the workflow's catch /
		// finalize path is responsible for that. The UI's polling fetch
		// will see the new status within a few seconds.
		return {
			contextId: existing.id,
			status: "CANCELLING" as const,
		};
	});
