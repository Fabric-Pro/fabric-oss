import { ORPCError } from "@orpc/server";
import { db } from "@repo/database";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { mayReadParlumeSessionContent } from "../../lib/parlume-confidential";
import { parlumeLog } from "../../lib/parlume-log";
import { canDeleteParlumeSession } from "../../lib/parlume-transcript-access";
import { requireParlumeProject } from "./sessions";

/**
 * Writes a finished meeting's notes again from its transcript, after the
 * notes failed or when a member wants them redone. The same people may as
 * may delete the session: the inviter and project managers, and for a
 * confidential meeting only those of them who may read it, since the notes
 * are written over for everyone who reads them.
 *
 * The run is a new notes workflow under its own id, so it never joins the
 * one finalization started. A second request while it runs joins it. The
 * notes read as being written until it ends; if it fails, the earlier notes
 * stay, marked failed.
 */
export const regenerateParlumeNotesProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "POST",
		path: "/projects/{projectId}/parlume/sessions/{sessionId}/regenerate-notes",
		tags: ["Projects", "Parlume"],
		summary: "Write a finished Parlume session's notes again",
	})
	.input(z.object({ projectId: z.string(), sessionId: z.string() }))
	.handler(async ({ input, context }) => {
		const project = await requireParlumeProject(input.projectId);
		const session = await db.parlumeMeetingSession.findFirst({
			where: { id: input.sessionId, projectId: input.projectId },
			select: {
				id: true,
				userId: true,
				transcriptContextId: true,
				transcriptDeletedAt: true,
				confidential: true,
				attendeeUserIds: true,
			},
		});
		if (!session) {
			throw new ORPCError("NOT_FOUND", {
				message: "Parlume session not found",
			});
		}
		if (
			!(await canDeleteParlumeSession({
				projectId: input.projectId,
				userId: context.user.id,
				inviterId: session.userId,
			})) ||
			!(await mayReadParlumeSessionContent({
				projectId: input.projectId,
				userId: context.user.id,
				session,
			}))
		) {
			throw new ORPCError("FORBIDDEN", {
				message:
					"Only the person who invited Parlume and project managers can regenerate these notes.",
			});
		}
		if (!session.transcriptContextId || session.transcriptDeletedAt) {
			throw new ORPCError("CONFLICT", {
				message:
					"This meeting has no transcript any more, so its notes cannot be written again.",
			});
		}
		const transcript = await db.projectContext.findFirst({
			where: {
				id: session.transcriptContextId,
				projectId: input.projectId,
				organizationId: project.organizationId,
			},
			select: { id: true, metadata: true },
		});
		const metadata =
			transcript?.metadata &&
			typeof transcript.metadata === "object" &&
			!Array.isArray(transcript.metadata)
				? transcript.metadata
				: null;
		if (!transcript || !metadata) {
			throw new ORPCError("NOT_FOUND", {
				message: "Parlume transcript not found",
			});
		}
		const status = metadata.parlumeNotesStatus;
		if (status !== "COMPLETED" && status !== "FAILED") {
			throw new ORPCError("CONFLICT", {
				message: "Parlume is still writing the notes of this meeting.",
			});
		}

		// Marked first, so the run cannot finish before the mark and be
		// overwritten by it; put back if the run does not start. The time
		// bounds how long the page waits for the new notes.
		await db.projectContext.update({
			where: { id: transcript.id },
			data: {
				metadata: {
					...metadata,
					parlumeNotesStatus: "PENDING",
					parlumeNotesRequestedAt: new Date().toISOString(),
				},
			},
		});
		try {
			const { getTemporalClient } = await import("@repo/temporal");
			const temporal = await getTemporalClient();
			await temporal.workflow.start("parlumeNotesWorkflow", {
				workflowIdConflictPolicy: "USE_EXISTING",
				taskQueue: "project-documents",
				workflowId: `parlume-notes-regenerate-${session.id}`,
				args: [
					{
						sessionId: session.id,
						organizationId: project.organizationId,
						userId: session.userId,
						regenerate: true,
					},
				],
			});
		} catch (error) {
			await db.projectContext.update({
				where: { id: transcript.id },
				data: { metadata },
			});
			throw error;
		}

		parlumeLog("info", "notes.regenerate_requested", {
			sessionId: session.id,
			previousStatus: status,
		});
		recordAuditFromRequest(context, {
			action: "project.parlume.notes_regenerated",
			category: "project",
			organizationId: project.organizationId,
			projectId: input.projectId,
			resource: { type: "parlume_meeting_session", id: session.id },
		});
		return { notesStatus: "PENDING" as const };
	});
