import { ORPCError } from "@orpc/server";
import {
	buildMeetingArchivePayload,
	createMeetingArchive,
	db,
	unlinkMeetingFromProject,
} from "@repo/database";
import { logger } from "@repo/logs";
// Type-only: erased at compile time, so the runtime `await import("@repo/temporal")`
// below stays a dynamic import.
import type { getTemporalClient } from "@repo/temporal";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import { withCorrelationMemo } from "../../../../lib/temporal-correlation";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { requireContextSourceAdmin } from "../../lib/require-context-source-admin";

/**
 * AUTHORIZATION: `PROJECT_UPDATE` on the middleware, escalated to
 * `PROJECT_SETTINGS_EDIT` in the handler by `requireContextSourceAdmin` while
 * the `MEETING_SYNC_CONTROLS` flag is on — see that helper for why the raise
 * lives there rather than on the middleware.
 *
 * Unlinks a meeting from a project. Cascading deletes remove associated
 * ProjectMeetingTranscript records via the DB relation. Also cleans up any
 * ProjectContext records that were created from synced transcripts: those with
 * a Qdrant vector are handed to contextDeletionWorkflow (which deletes vector
 * and row together), the rest are deleted directly. A workflow that cannot be
 * started falls back to direct deletion for that context alone and logs it —
 * the vector is orphaned in that case, so the log is the only trace.
 */
export const unlinkMeetingProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/meeting-transcript-sync/unlink",
		tags: ["Projects", "Meeting Transcript Sync"],
		summary: "Unlink a meeting from a project",
		description:
			"Removes a linked meeting and its associated transcript records from a project.",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			linkedMeetingId: z.string(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Verify project exists in tenant context.
		// Authorization enforced by `requireProjectPermission` above.
		const project = await db.project.findFirst({
			where: {
				id: input.projectId,
				...(organizationId
					? { organizationId }
					: { organizationId: null, userId: user.id }),
			},
			select: { id: true },
		});

		if (!project) {
			throw new ORPCError("NOT_FOUND", {
				message: "Project not found",
			});
		}

		// Destructive: raises the floor to PROJECT_ADMIN while the flag is on.
		// After the tenant check so a non-member still gets NOT_FOUND rather
		// than FORBIDDEN, which would confirm the project exists.
		await requireContextSourceAdmin({
			projectId: input.projectId,
			userId: user.id,
		});

		// Archive BEFORE deleting, and abort if archiving fails. A failed
		// deletion is recoverable by clicking again; a deletion whose archive
		// silently did not happen is exactly the outcome this card exists to
		// prevent (#2355).
		const archived = await buildMeetingArchivePayload({
			projectId: input.projectId,
			linkedMeetingId: input.linkedMeetingId,
		});

		if (!archived) {
			throw new ORPCError("NOT_FOUND", {
				message: "Linked meeting not found",
			});
		}

		const archive = await createMeetingArchive({
			projectId: input.projectId,
			joinUrl: archived.joinUrl,
			subject: archived.subject,
			transcriptCount: archived.transcriptCount,
			payloadTruncated: archived.truncated,
			payload: archived.payload,
			deletedById: user.id,
			userId: organizationId ? null : user.id,
			organizationId,
		});

		// Find transcript records that have associated ProjectContext entries
		// so we can clean those up after unlinking (including Qdrant embeddings)
		const transcriptsWithContexts =
			await db.projectMeetingTranscript.findMany({
				where: {
					projectId: input.projectId,
					linkedMeetingId: input.linkedMeetingId,
					contextId: { not: null },
				},
				select: { contextId: true },
			});

		const contextIds = transcriptsWithContexts
			.map((t) => t.contextId)
			.filter((id): id is string => id !== null);

		// Delete the linked meeting (cascades to transcript records)
		await unlinkMeetingFromProject(input.projectId, input.linkedMeetingId);

		// Clean up associated ProjectContext records + Qdrant embeddings
		if (contextIds.length > 0) {
			const contextsToDelete = await db.projectContext.findMany({
				where: {
					id: { in: contextIds },
					projectId: input.projectId,
				},
				select: { id: true, qdrantId: true, type: true },
			});

			// Contexts with a Qdrant vector go to contextDeletionWorkflow, which
			// owns BOTH the vector deletion and the DB row deletion so the two
			// cannot race. Everything else — and anything the workflow refused —
			// is deleted directly here.
			const idsForDirectDeletion: string[] = [];

			let client: Awaited<ReturnType<typeof getTemporalClient>> | null =
				null;
			try {
				const temporal = await import("@repo/temporal");
				client = await temporal.getTemporalClient();
			} catch (error) {
				// Degraded path: every vector below will be orphaned. Logged
				// once here rather than once per context.
				logger.error("meeting.unlink.temporal_client_unavailable", {
					projectId: input.projectId,
					linkedMeetingId: input.linkedMeetingId,
					contextCount: contextsToDelete.length,
					error,
				});
			}

			for (const ctx of contextsToDelete) {
				if (!ctx.qdrantId || !client) {
					idsForDirectDeletion.push(ctx.id);
					continue;
				}

				try {
					await client.workflow.start(
						"contextDeletionWorkflow",
						withCorrelationMemo({
							taskQueue: "project-documents",
							workflowId: `context-deletion-${ctx.id}-${Date.now()}`,
							args: [
								{
									contextId: ctx.id,
									projectId: input.projectId,
									userId: user.id,
									organizationId: organizationId ?? undefined,
									qdrantId: ctx.qdrantId,
									metadata: {
										contextType: ctx.type,
										contextName:
											"Meeting transcript (unlinked)",
										deletedBy:
											user.name || user.email || user.id,
									},
								},
							],
						}),
					);
				} catch (error) {
					// Only THIS context falls back. Contexts whose workflows
					// already started must not be re-queued, or their rows get
					// deleted twice. This one's vector is now orphaned in
					// Qdrant, which is why this is an error rather than a
					// warning: retrieval can keep returning it after the
					// meeting is gone, and this log is the only trace.
					logger.error(
						"meeting.unlink.context_deletion_workflow_failed",
						{
							contextId: ctx.id,
							qdrantId: ctx.qdrantId,
							projectId: input.projectId,
							linkedMeetingId: input.linkedMeetingId,
							error,
						},
					);
					idsForDirectDeletion.push(ctx.id);
				}
			}

			if (idsForDirectDeletion.length > 0) {
				await db.projectContext.deleteMany({
					where: {
						id: { in: idsForDirectDeletion },
						projectId: input.projectId,
					},
				});
			}
		}

		// Metadata carries the count, never the subject: a meeting title can name
		// a real client, and this row outlives the meeting it describes.
		recordAuditFromRequest(context, {
			action: "project.meeting.deleted",
			category: "project",
			organizationId,
			projectId: input.projectId,
			resource: { type: "linked_meeting", id: input.linkedMeetingId },
			metadata: {
				transcriptCount: archived.transcriptCount,
				archiveId: archive.id,
				payloadTruncated: archived.truncated,
			},
		});

		return {
			success: true,
			archiveId: archive.id,
			recoverableUntil: archive.scheduledPurgeAt,
			transcriptCount: archived.transcriptCount,
		};
	});
