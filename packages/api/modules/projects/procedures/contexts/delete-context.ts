import { ORPCError } from "@orpc/client";
import { getContextById, hasProjectAccess } from "@repo/database";
import {
	deleteUrlSourceSchedule,
	getScheduleClient,
	getTemporalClient,
} from "@repo/temporal";
import { z } from "zod";
import { emitActivity, emitContextChange } from "../../../../lib/realtime";
import { withCorrelationMemo } from "../../../../lib/temporal-correlation";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

export const deleteContextProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.CONTEXT_DELETE))
	.route({
		method: "DELETE",
		path: "/projects/:projectId/contexts/:id",
		tags: ["Projects", "Contexts"],
		summary: "Delete context",
		description:
			"Delete a context from database and Qdrant via Temporal workflow",
	})
	.input(
		z.object({
			projectId: z.string(),
			id: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Check project access
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

		// Get context to verify it belongs to the project
		const projectContext = await getContextById(input.id);

		if (!projectContext || projectContext.projectId !== input.projectId) {
			throw new ORPCError("NOT_FOUND", {
				message: "Context not found",
			});
		}

		// Lock-while-crawling guard for LINK contexts. Deleting mid-crawl
		// would orphan the running Temporal workflow (it would keep writing
		// upserts against a row about to be cascade-deleted, throwing on
		// every page) and leave stranded ProjectContextUrlPage rows behind.
		// Force the user to cancel the crawl first — the cancel-url-source
		// procedure handles cleanup gracefully via the workflow's
		// CancellationScope.nonCancellable finalize branch. Other context
		// types (FILE / TEXT / MEETING_TRANSCRIPT) don't have crawls, so the
		// guard is LINK-only.
		if (
			projectContext.type === "LINK" &&
			(projectContext.extractionStatus === "PENDING" ||
				projectContext.extractionStatus === "EXTRACTING")
		) {
			throw new ORPCError("CONFLICT", {
				message:
					"Processing is currently running for this URL source. Cancel it before deleting the source.",
			});
		}

		// Prepare context name for events
		const contextName =
			projectContext.originalFilename ||
			projectContext.sourceTitle ||
			`${projectContext.type} context`;

		// URL Context Sources: if this is a LINK row with
		// a scheduled cadence (DAILY/WEEKLY/MONTHLY), drop the Temporal
		// Schedule BEFORE the deletion workflow runs so we don't leave an
		// orphan firing against a deleted contextId. Best-effort —
		// failures here don't block the deletion path; the reconciliation
		// workflow (Group 5) sweeps any drift.
		if (projectContext.type === "LINK" && projectContext.urlScheduleId) {
			try {
				const scheduleClient = await getScheduleClient();
				await deleteUrlSourceSchedule(
					{ scheduleId: projectContext.urlScheduleId },
					scheduleClient,
				);
				console.log(
					`[DeleteContext] Deleted URL source schedule ${projectContext.urlScheduleId} for context ${input.id}`,
				);
			} catch (error) {
				console.error(
					`[DeleteContext] Failed to delete URL source schedule for ${input.id}: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
				// Continue with deletion — the reconciliation workflow will
				// clean this up on the next sweep.
			}
		}

		// Start Temporal workflow for durable deletion
		try {
			const client = await getTemporalClient();
			const workflowId = `context-deletion-${input.id}-${Date.now()}`;

			await client.workflow.start(
				"contextDeletionWorkflow",
				withCorrelationMemo({
					taskQueue: "project-documents",
					workflowId,
					args: [
						{
							contextId: input.id,
							projectId: input.projectId,
							userId: user.id,
							organizationId,
							qdrantId: projectContext.qdrantId ?? undefined,
							metadata: {
								contextType: projectContext.type,
								contextName,
								deletedBy: user.name || user.email || user.id,
							},
						},
					],
				}),
			);

			console.log(
				`[DeleteContext] Started context deletion workflow ${workflowId}`,
			);
		} catch (error) {
			console.error(
				`[DeleteContext] Failed to start context deletion workflow for ${input.id}: ${error}`,
			);
			// Don't throw - we'll still emit events and return success
			// The workflow provides durability, but if it fails to start,
			// we should still notify the UI
		}

		// Emit real-time events for collaboration (immediate feedback)
		await Promise.all([
			emitContextChange({
				projectId: input.projectId,
				contextId: input.id,
				action: "deleted",
				userId: user.id,
				userName: user.name || "Anonymous",
				contextType: projectContext.type,
				contextName,
			}),
			emitActivity({
				projectId: input.projectId,
				userId: user.id,
				userName: user.name || "Anonymous",
				activityType: "context_deleted",
				resourceType: "context",
				resourceId: input.id,
				resourceName: contextName,
				timestamp: new Date().toISOString(),
			}),
		]);

		return { success: true };
	});
