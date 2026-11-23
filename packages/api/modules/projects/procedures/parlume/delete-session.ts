import { ORPCError } from "@orpc/server";
import { db, purgeParlumeSessionContent } from "@repo/database";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { drainSyncedContextCleanupOnce } from "../../lib/delete-synced-context";
import { requestParlumeBridgePurge } from "../../lib/parlume-bridge-purge";
import { mayReadParlumeSessionContent } from "../../lib/parlume-confidential";
import { parlumeLog } from "../../lib/parlume-log";
import { sessionSelect } from "../../lib/parlume-start";
import { canDeleteParlumeSession } from "../../lib/parlume-transcript-access";
import { requireParlumeProject } from "./sessions";

/**
 * Deletes what a finished meeting said and asked: its transcript, the
 * requests with their proposed changes, the suggestions and the webhook
 * receipts. The session row and its notes stay; the notes go only when
 * someone deletes the transcript context in the Context tab.
 *
 * Only the person who invited Parlume and project managers may delete it; the
 * meeting's other invitees may read the transcript but not delete it for
 * everyone. The bridge is then asked to drop what it still holds of the
 * meeting, best effort. A session Parlume is
 * still in, or is still saving, is refused rather than stopped: a live bridge
 * would keep writing to it, and finalization would save a transcript again.
 * So is one whose notes are still being written from the transcript.
 */
export const deleteParlumeSessionProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "POST",
		path: "/projects/{projectId}/parlume/sessions/{sessionId}/delete",
		tags: ["Projects", "Parlume"],
		summary:
			"Delete a finished Parlume session's transcript, requests and suggestions, keeping its notes",
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
				confidential: true,
				attendeeUserIds: true,
			},
		});
		if (!session) {
			throw new ORPCError("NOT_FOUND", {
				message: "Parlume session not found",
			});
		}
		// A confidential meeting is deleted only by someone who may read it:
		// an inviter who was not there does not decide over its content.
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
					"Only the person who invited Parlume and project managers can delete this session.",
			});
		}
		if (
			await notesPending(session.transcriptContextId, {
				projectId: input.projectId,
				organizationId: project.organizationId,
			})
		) {
			throw new ORPCError("CONFLICT", {
				message:
					"Parlume is still writing the notes of this meeting. Delete the session when they are ready.",
			});
		}
		const { purged, vectorCleanup } = await purgeParlumeSessionContent({
			sessionId: session.id,
			projectId: input.projectId,
			scope: "SESSION",
		});
		if (!purged) {
			throw new ORPCError("CONFLICT", {
				message:
					"Parlume is still in this meeting or still saving it. Stop Parlume, wait until it has left, then delete the session.",
			});
		}
		if (vectorCleanup) {
			await drainSyncedContextCleanupOnce(vectorCleanup);
		}
		parlumeLog("info", "session.deleted", { sessionId: session.id });
		await requestParlumeBridgePurge(session.id, "deleted");
		recordAuditFromRequest(context, {
			action: "project.parlume.session_deleted",
			category: "project",
			organizationId: project.organizationId,
			projectId: input.projectId,
			resource: { type: "parlume_meeting_session", id: session.id },
		});
		return {
			session: await db.parlumeMeetingSession.findUniqueOrThrow({
				where: { id: session.id },
				select: sessionSelect,
			}),
		};
	});

async function notesPending(
	contextId: string | null,
	scope: { projectId: string; organizationId: string },
): Promise<boolean> {
	if (!contextId) {
		return false;
	}
	const context = await db.projectContext.findFirst({
		where: { id: contextId, ...scope },
		select: { metadata: true },
	});
	const metadata = context?.metadata;
	return (
		!!metadata &&
		typeof metadata === "object" &&
		!Array.isArray(metadata) &&
		metadata.parlumeNotesStatus === "PENDING"
	);
}
