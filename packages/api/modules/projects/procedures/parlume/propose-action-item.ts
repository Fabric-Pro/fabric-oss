import { ORPCError } from "@orpc/server";
import { db } from "@repo/database";
import { readParlumeNoteItems } from "@repo/utils/parlume-notes";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { parlumeLog } from "../../lib/parlume-log";
import {
	parlumeTranscriptLineHref,
	proposeParlumeActionItem,
} from "../../lib/parlume-note-proposals";
import { canReadParlumeTranscript } from "../../lib/parlume-transcript-access";
import { requireParlumeProject } from "./sessions";

/**
 * Proposes one action item of a finished meeting's notes as a ticket, into
 * the Proposal Inbox, where a person approves it. A member who may create
 * work items and may read the meeting's transcript may: the proposal links
 * to the transcript line, and a reader of the inbox who may not read the
 * transcript is refused there.
 *
 * Never for a confidential meeting: the inbox shows every proposal to every
 * project reader, and a confidential meeting's notes are for its attendees
 * and the project's managers.
 */
export const proposeParlumeActionItemProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_CREATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/parlume/sessions/{sessionId}/propose-action-item",
		tags: ["Projects", "Parlume"],
		summary: "Propose an action item of a Parlume meeting's notes",
	})
	.input(
		z.object({
			projectId: z.string(),
			sessionId: z.string(),
			anchorLine: z.number().int().min(1),
			text: z.string().min(1).max(600),
		}),
	)
	.handler(async ({ input, context }) => {
		const project = await requireParlumeProject(input.projectId);
		const session = await db.parlumeMeetingSession.findFirst({
			where: { id: input.sessionId, projectId: input.projectId },
			select: {
				id: true,
				userId: true,
				inviteeEmails: true,
				confidential: true,
				attendeeUserIds: true,
				transcriptContextId: true,
				transcriptDeletedAt: true,
				endedAt: true,
				createdAt: true,
				linkedMeeting: { select: { subject: true } },
			},
		});
		if (!session) {
			throw new ORPCError("NOT_FOUND", {
				message: "Parlume session not found",
			});
		}
		if (session.confidential) {
			throw new ORPCError("FORBIDDEN", {
				message:
					"A confidential meeting's action items are not proposed: every project reader sees the Proposal Inbox.",
			});
		}
		if (
			!(await canReadParlumeTranscript({
				projectId: input.projectId,
				userId: context.user.id,
				inviterId: session.userId,
				inviteeEmails: session.inviteeEmails,
				confidential: session.confidential,
				attendeeUserIds: session.attendeeUserIds,
			}))
		) {
			throw new ORPCError("FORBIDDEN", {
				message:
					"Only the people who may read this meeting's transcript can propose its action items.",
			});
		}
		if (!session.transcriptContextId || session.transcriptDeletedAt) {
			throw new ORPCError("CONFLICT", {
				message:
					"This meeting has no transcript any more, so its action items cannot be proposed.",
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
		const item = readParlumeNoteItems(transcript?.metadata).find(
			(note) =>
				note.kind === "action" &&
				note.anchorLine === input.anchorLine &&
				note.text === input.text,
		);
		if (!transcript || !item) {
			throw new ORPCError("NOT_FOUND", {
				message:
					"This action item is no longer in the meeting's notes.",
			});
		}
		const organization = await db.organization.findUnique({
			where: { id: project.organizationId },
			select: { slug: true },
		});

		const result = await proposeParlumeActionItem({
			projectId: input.projectId,
			organizationId: project.organizationId,
			userId: context.user.id,
			session: {
				id: session.id,
				meetingSubject: session.linkedMeeting?.subject ?? null,
				meetingDate: session.endedAt ?? session.createdAt,
			},
			item,
			transcriptHref: organization?.slug
				? parlumeTranscriptLineHref({
						organizationSlug: organization.slug,
						projectId: input.projectId,
						contextId: transcript.id,
						anchorLine: item.anchorLine,
					})
				: null,
		});

		parlumeLog("info", "notes.action_item_proposed", {
			sessionId: session.id,
			anchorLine: item.anchorLine,
			status: result.status,
		});
		if (result.status === "proposed") {
			recordAuditFromRequest(context, {
				action: "project.parlume.action_item_proposed",
				category: "project",
				organizationId: project.organizationId,
				projectId: input.projectId,
				resource: { type: "parlume_meeting_session", id: session.id },
				metadata: {
					proposalId: result.proposalId,
					anchorLine: item.anchorLine,
				},
			});
		}
		return result;
	});
