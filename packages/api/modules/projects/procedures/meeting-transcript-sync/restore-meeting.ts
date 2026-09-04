import { ORPCError } from "@orpc/server";
import {
	db,
	deleteMeetingArchive,
	getMeetingArchive,
	type MeetingArchivePayload,
} from "@repo/database";
import { logger } from "@repo/logs";
// Type-only: erased at compile time, so the runtime `await import("@repo/temporal")`
// below stays a dynamic import.
import type { getTemporalClient } from "@repo/temporal";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { requireContextSourceAdmin } from "../../lib/require-context-source-admin";

/**
 * AUTHORIZATION: same gate as unlinking — whoever can delete a meeting can undo
 * it, and nobody else. Restoring re-introduces content into the project's
 * answers, so it is not a lesser act than deleting.
 *
 * Rebuilds a meeting from its archive: the linked-meeting row, its transcripts,
 * and the context bodies those transcripts pointed at, then re-embeds so the
 * content is searchable again.
 *
 * Two things this deliberately does NOT do:
 *
 * - It does not restore action items, agendas or the provenance links from
 *   meeting action items to work items. Work items themselves were never
 *   affected — `UserStory.sourceMeetingTranscript` is `onDelete: SetNull`, so
 *   nothing ever leaves the roadmap — but a restored meeting's stories will not
 *   show it as their source. Deferred deliberately (#2355).
 * - It does not reuse the original row ids. Nothing outside the archive still
 *   references them: the cascade removed every child at delete time.
 */
export const restoreMeetingProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/meeting-transcript-sync/restore",
		tags: ["Projects", "Meeting Transcript Sync"],
		summary: "Restore a deleted meeting",
		description:
			"Rebuilds a meeting and its transcripts from the recovery archive and re-embeds them.",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			archiveId: z.string(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;

		// The organization is a property of the project, not a caller claim.
		// `requireProjectPermission` has already authorized this project for
		// this user, so the authorized row is the only honest source of the
		// tenant — reading it from the input would let a caller choose which
		// tenant this request is accounted to (Fizzy #2355).
		const project = await db.project.findFirst({
			where: { id: input.projectId },
			select: { id: true, userId: true, organizationId: true },
		});

		if (!project) {
			throw new ORPCError("NOT_FOUND", { message: "Project not found" });
		}

		const organizationId = project.organizationId ?? undefined;

		await requireContextSourceAdmin({
			projectId: input.projectId,
			userId: user.id,
		});

		const archive = await getMeetingArchive({
			projectId: input.projectId,
			archiveId: input.archiveId,
		});

		if (!archive) {
			throw new ORPCError("NOT_FOUND", {
				message: "This deletion is no longer recoverable.",
			});
		}

		// The purge job is the authority on expiry, but it runs daily — an
		// archive can be past its window and still present. Refuse it here so
		// the answer does not depend on when the job last ran.
		if (archive.scheduledPurgeAt.getTime() <= Date.now()) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"The 7-day recovery window for this meeting has passed.",
			});
		}

		const payload = archive.payload as unknown as MeetingArchivePayload;

		// Relinking the same meeting in the meantime is the one way this can
		// collide: the live table has a unique key on (projectId, joinUrl).
		const existing = await db.projectLinkedMeeting.findFirst({
			where: { projectId: input.projectId, joinUrl: archive.joinUrl },
			select: { id: true },
		});

		if (existing) {
			throw new ORPCError("CONFLICT", {
				message:
					"This meeting has been linked again since it was deleted. Unlink it first, or keep the current one.",
			});
		}

		// Mirror the project's own tenancy onto every restored row, so a
		// meeting comes back into exactly the tenant it left.
		const tenant = {
			userId: project.organizationId ? null : project.userId,
			organizationId,
		};

		// One transaction: a partial restore would leave a meeting whose
		// transcripts are missing, with the archive already gone.
		const restored = await db.$transaction(async (tx) => {
			const meeting = await tx.projectLinkedMeeting.create({
				data: {
					projectId: input.projectId,
					joinUrl: payload.meeting.joinUrl,
					subject: payload.meeting.subject,
					organizer: payload.meeting.organizer,
					includedInDigest: payload.meeting.includedInDigest,
					// Restored stopped: syncing again is a separate, deliberate
					// click. Coming back to find a meeting quietly pulling new
					// occurrences would be its own surprise.
					deactivatedAt: new Date(),
					deactivatedById: user.id,
					...tenant,
				},
				select: { id: true },
			});

			const contextIds: string[] = [];

			for (const t of payload.transcripts) {
				let contextId: string | null = null;

				if (t.content !== null) {
					const ctx = await tx.projectContext.create({
						data: {
							projectId: input.projectId,
							type: "MEETING_TRANSCRIPT",
							content: t.content,
							originalFilename: t.contextFilename,
							extractionStatus: "COMPLETED",
							...tenant,
						},
						select: { id: true },
					});
					contextId = ctx.id;
					contextIds.push(ctx.id);
				}

				await tx.projectMeetingTranscript.create({
					data: {
						projectId: input.projectId,
						linkedMeetingId: meeting.id,
						meetingId: t.meetingId,
						transcriptId: t.transcriptId,
						meetingSubject: t.meetingSubject,
						meetingDate: t.meetingDate,
						contextId,
						summary: t.summary,
						keywords: t.keywords,
						speakerNames: t.speakerNames,
						contentLength: t.contentLength,
						wasSummarized: t.wasSummarized,
						syncedAt: t.syncedAt,
						...tenant,
					},
				});
			}

			return { meetingId: meeting.id, contextIds };
		});

		// Re-embed outside the transaction: the vectors were purged at delete
		// time, so until these finish the content is restored but not yet
		// searchable. Fire-and-forget, mirroring the sync's own embedding start.
		let client: Awaited<ReturnType<typeof getTemporalClient>> | null = null;
		try {
			const temporal = await import("@repo/temporal");
			client = await temporal.getTemporalClient();
		} catch (error) {
			logger.error("meeting.restore.temporal_client_unavailable", {
				projectId: input.projectId,
				archiveId: input.archiveId,
				contextCount: restored.contextIds.length,
				error,
			});
		}

		let reindexing = 0;
		if (client) {
			for (const contextId of restored.contextIds) {
				try {
					await client.workflow.start("contextEmbeddingWorkflow", {
						taskQueue: "project-documents",
						workflowId: `context-embedding-${contextId}-${Date.now()}`,
						args: [
							{
								contextId,
								projectId: input.projectId,
								userId: user.id,
								organizationId: organizationId ?? undefined,
								type: "MEETING_TRANSCRIPT",
								metadata: {
									sourceTitle: `Meeting Transcript: ${payload.meeting.subject ?? "Untitled meeting"}`,
									provider: "microsoft-teams",
								},
							},
						],
					});
					reindexing++;
				} catch (error) {
					// The row is back and readable; only search is missing. An
					// error rather than a warning because nothing else will
					// retry it — a re-embed has no sweep behind it.
					logger.error("meeting.restore.embedding_failed", {
						contextId,
						projectId: input.projectId,
						archiveId: input.archiveId,
						error,
					});
				}
			}
		}

		// Only once the rows are back. Losing the archive to a failed restore
		// would make the deletion permanent by accident.
		await deleteMeetingArchive({
			projectId: input.projectId,
			archiveId: input.archiveId,
		});

		recordAuditFromRequest(context, {
			action: "project.meeting.restored",
			category: "project",
			organizationId,
			projectId: input.projectId,
			resource: { type: "linked_meeting", id: restored.meetingId },
			metadata: {
				transcriptsRestored: payload.transcripts.length,
				archiveId: input.archiveId,
				payloadTruncated: archive.payloadTruncated,
			},
		});

		return {
			success: true,
			linkedMeetingId: restored.meetingId,
			transcriptsRestored: payload.transcripts.length,
			reindexing,
			// True when the bodies were too large to archive: the meeting and
			// its metadata are back, the transcript text is not.
			payloadTruncated: archive.payloadTruncated,
		};
	});
