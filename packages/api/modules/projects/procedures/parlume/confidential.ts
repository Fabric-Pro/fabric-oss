import { ORPCError } from "@orpc/server";
import { db } from "@repo/database";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
	userHasProjectPermission,
} from "../../../../orpc/procedures";
import {
	confidentialRangeSelect,
	markParlumeSessionConfidential,
	postParlumeConfidentialNotice,
	setParlumeConfidentialRange,
} from "../../lib/parlume-confidential";
import { sessionSelect } from "../../lib/parlume-start";
import { requireParlumeProject } from "./sessions";

/** Parlume may still be in the meeting, so its confidential part runs live. */
const LIVE_STATUSES = new Set(["PENDING", "JOINING", "ACTIVE", "LEAVING"]);

/**
 * Marks a meeting confidential, or removes the mark, from the Parlume page.
 * While Parlume is in the meeting this starts or ends its confidential part
 * from now, as "Parlume, confidential" does in the meeting, and the meeting
 * chat is told. Once it is over it marks or clears the whole meeting.
 *
 * Marking only keeps more to fewer people: the person who invited Parlume,
 * a project manager or anyone Fabric confirmed in the meeting may. Removing
 * the mark widens who reads the meeting, so only the inviter or a project
 * manager may, and the inviter only while they may read it themselves. While
 * a guest is or was expected in a live meeting, only a manager may end it.
 */
export const setParlumeConfidentialProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "POST",
		path: "/projects/{projectId}/parlume/sessions/{sessionId}/confidential",
		tags: ["Projects", "Parlume"],
		summary: "Mark a Parlume meeting confidential, or remove the mark",
	})
	.input(
		z.object({
			projectId: z.string(),
			sessionId: z.string(),
			confidential: z.boolean(),
		}),
	)
	.handler(async ({ input, context }) => {
		const project = await requireParlumeProject(input.projectId);
		const session = await db.parlumeMeetingSession.findFirst({
			where: {
				id: input.sessionId,
				projectId: project.id,
				organizationId: project.organizationId,
			},
			select: {
				...confidentialRangeSelect,
				status: true,
				attendeeUserIds: true,
			},
		});
		if (!session) {
			throw new ORPCError("NOT_FOUND", {
				message: "Parlume session not found.",
			});
		}
		const manages = await userHasProjectPermission({
			userId: context.user.id,
			projectId: project.id,
			permission: Permissions.PROJECT_MEMBERS_MANAGE,
		});
		const attended = session.attendeeUserIds.includes(context.user.id);
		const inviter = session.userId === context.user.id;
		const allowed = input.confidential
			? manages || inviter || attended
			: manages || (inviter && attended);
		if (!allowed) {
			throw new ORPCError("FORBIDDEN", {
				message: input.confidential
					? "Only the person who invited Parlume, a project manager or someone who was in the meeting can mark it confidential."
					: "Only a project manager, or the person who invited Parlume and was in the meeting, can remove the confidential mark.",
			});
		}
		const by = context.user.name ?? null;
		const live = LIVE_STATUSES.has(session.status);
		const change = input.confidential ? "on" : "off";
		if (live) {
			// A guest is or was expected: only a manager ends the part then.
			const range = await setParlumeConfidentialRange({
				session,
				switch: change,
				by,
				force: manages,
			});
			if (!range.changed && range.open && change === "off") {
				throw new ORPCError("FORBIDDEN", {
					message:
						"A guest is or was expected in this meeting, so only a project manager can end its confidential part.",
				});
			}
			if (range.changed) {
				await postParlumeConfidentialNotice({
					sessionId: session.id,
					switch: change,
					by,
				});
			}
		} else {
			await markParlumeSessionConfidential({
				sessionId: session.id,
				confidential: input.confidential,
				by,
			});
		}
		recordAuditFromRequest(context, {
			action: input.confidential
				? "project.parlume.confidential_marked"
				: "project.parlume.confidential_cleared",
			category: "project",
			organizationId: project.organizationId,
			projectId: project.id,
			resource: { type: "parlume_meeting_session", id: session.id },
			metadata: { scope: live ? "from_now" : "whole_meeting" },
		});
		return {
			session: await db.parlumeMeetingSession.findUniqueOrThrow({
				where: { id: session.id },
				select: sessionSelect,
			}),
		};
	});
