import { db } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { canReadParlumeTranscript } from "../../lib/parlume-transcript-access";
import { requireParlumeProject } from "./sessions";

/**
 * The newest lines the page shows while the meeting runs: about twenty
 * minutes of talk. The whole transcript is in project Context afterwards.
 */
const PARLUME_LIVE_TRANSCRIPT_LINES = 200;

/**
 * What a meeting said so far, oldest first: its spoken lines, its chat
 * messages and the moments Parlume's listening paused or resumed. Only the
 * readers of the meeting's transcript get it (`canReadParlumeTranscript`);
 * every other project reader gets nothing, without being told what exists.
 */
export const listParlumeLiveTranscriptProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/parlume/sessions/{sessionId}/transcript",
		tags: ["Projects", "Parlume"],
		summary: "Follow what a Parlume meeting says while it runs",
	})
	.input(z.object({ projectId: z.string(), sessionId: z.string() }))
	.handler(async ({ input, context }) => {
		const project = await requireParlumeProject(input.projectId);
		const session = await db.parlumeMeetingSession.findFirst({
			where: {
				id: input.sessionId,
				projectId: project.id,
				organizationId: project.organizationId,
			},
			select: {
				userId: true,
				inviteeEmails: true,
				confidential: true,
				attendeeUserIds: true,
				transcriptDeletedAt: true,
			},
		});
		if (
			!session ||
			session.transcriptDeletedAt ||
			!(await canReadParlumeTranscript({
				projectId: project.id,
				userId: context.user.id,
				inviterId: session.userId,
				inviteeEmails: session.inviteeEmails,
				confidential: session.confidential,
				attendeeUserIds: session.attendeeUserIds,
			}))
		) {
			return { readable: false, segments: [] };
		}
		const newest = await db.parlumeMeetingSegment.findMany({
			where: {
				sessionId: input.sessionId,
				projectId: project.id,
				organizationId: project.organizationId,
			},
			orderBy: [{ createdAt: "desc" }, { id: "desc" }],
			take: PARLUME_LIVE_TRANSCRIPT_LINES,
			select: {
				id: true,
				source: true,
				speakerName: true,
				text: true,
				createdAt: true,
			},
		});
		return { readable: true, segments: newest.reverse() };
	});
