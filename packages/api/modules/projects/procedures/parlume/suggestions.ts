import { ORPCError } from "@orpc/server";
import { db } from "@repo/database";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { getParlumeBridgeSettings } from "../../lib/parlume-attendee";
import { mayReadParlumeSessionContent } from "../../lib/parlume-confidential";
import { parlumeLog } from "../../lib/parlume-log";
import { sendParlumeReadAloud } from "../../lib/parlume-page-controls";
import { canReadParlumeTranscript } from "../../lib/parlume-transcript-access";
import { requireParlumeProject } from "./sessions";

/** A meeting gets at most ten suggestions an hour, so this covers a long one. */
const SUGGESTIONS_LIMIT = 50;

/**
 * A session's suggestions and recap, newest first: those posted in the meeting
 * chat and those kept for the team. The same readers as the Requests list. A
 * suggestion's quote is what someone said, word for word, so only those who
 * may read the meeting's transcript get it; other readers get the suggestion
 * without it.
 */
export const listParlumeSuggestionsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/parlume/sessions/{sessionId}/suggestions",
		tags: ["Projects", "Parlume"],
		summary: "Review Parlume's suggestions in a meeting",
	})
	.input(z.object({ projectId: z.string(), sessionId: z.string() }))
	.handler(async ({ input, context }) => {
		const project = await requireParlumeProject(input.projectId);
		const [items, session] = await Promise.all([
			db.parlumeSuggestion.findMany({
				where: {
					projectId: project.id,
					organizationId: project.organizationId,
					sessionId: input.sessionId,
					dismissedAt: null,
				},
				orderBy: [{ createdAt: "desc" }, { id: "desc" }],
				take: SUGGESTIONS_LIMIT,
				select: {
					id: true,
					kind: true,
					audience: true,
					text: true,
					speaker: true,
					quote: true,
					topic: true,
					chatTag: true,
					chatDelivery: true,
					createdAt: true,
				},
			}),
			db.parlumeMeetingSession.findFirst({
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
				},
			}),
		]);
		// A confidential meeting's suggestions are made from what it said.
		if (
			session === null ||
			!(await mayReadParlumeSessionContent({
				projectId: project.id,
				userId: context.user.id,
				session,
			}))
		) {
			return { items: [] };
		}
		const readsTranscript = await canReadParlumeTranscript({
			projectId: project.id,
			userId: context.user.id,
			inviterId: session.userId,
			inviteeEmails: session.inviteeEmails,
			confidential: session.confidential,
			attendeeUserIds: session.attendeeUserIds,
		});
		return {
			items: readsTranscript
				? items
				: items.map((item) => ({ ...item, quote: null })),
		};
	});

const suggestionInput = z.object({
	projectId: z.string(),
	sessionId: z.string(),
	suggestionId: z.string(),
});

/** Only a suggestion for the meeting to hear can be said in it, not the recap. */
const SAYABLE_KINDS: ReadonlySet<string> = new Set([
	"ANSWER",
	"MISSED_QUESTION",
]);

// Saying a suggestion speaks in the meeting, and dismissing one hides it from
// every reader, so both are for the project's members, not its viewers.
const suggestionControlProcedure = tenantProtectedProcedure.use(
	requireProjectPermission(Permissions.PROJECT_UPDATE),
);

/** The suggestion, when this member may see it: undismissed, in its session. */
async function requireSuggestion(
	input: z.infer<typeof suggestionInput>,
	userId: string,
) {
	const project = await requireParlumeProject(input.projectId);
	const suggestion = await db.parlumeSuggestion.findFirst({
		where: {
			id: input.suggestionId,
			sessionId: input.sessionId,
			projectId: project.id,
			organizationId: project.organizationId,
			dismissedAt: null,
		},
		select: {
			id: true,
			kind: true,
			text: true,
			session: {
				select: {
					id: true,
					status: true,
					confidential: true,
					attendeeUserIds: true,
					externalInvitees: true,
					guestJoinedAt: true,
				},
			},
		},
	});
	if (
		!suggestion ||
		!(await mayReadParlumeSessionContent({
			projectId: project.id,
			userId,
			session: suggestion.session,
		}))
	) {
		throw new ORPCError("NOT_FOUND", {
			message: "This suggestion is no longer on the page.",
		});
	}
	return { project, suggestion };
}

/**
 * Parlume says a suggestion in the meeting, for a member who pressed Say in
 * meeting on the Parlume page. Refused while a guest is or was expected in
 * the meeting: what the team keeps to itself is never said in front of one.
 */
export const sayParlumeSuggestionProcedure = suggestionControlProcedure
	.route({
		method: "POST",
		path: "/projects/{projectId}/parlume/sessions/{sessionId}/suggestions/{suggestionId}/say",
		tags: ["Projects", "Parlume"],
		summary: "Have Parlume say a suggestion in the meeting",
	})
	.input(suggestionInput)
	.handler(async ({ input, context }) => {
		const { project, suggestion } = await requireSuggestion(
			input,
			context.user.id,
		);
		const { session } = suggestion;
		if (session.status !== "ACTIVE") {
			throw new ORPCError("NOT_FOUND", {
				message: "Parlume is not in this meeting.",
			});
		}
		if (!SAYABLE_KINDS.has(suggestion.kind)) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"Only an answer or a missed question can be said in the meeting.",
			});
		}
		if (session.externalInvitees || session.guestJoinedAt !== null) {
			throw new ORPCError("CONFLICT", {
				message:
					"A guest is in this meeting, so Parlume says nothing from the page.",
			});
		}
		const settings = getParlumeBridgeSettings();
		const sent = settings
			? await sendParlumeReadAloud({
					settings,
					sessionId: session.id,
					suggestionId: suggestion.id,
					text: suggestion.text,
					actor: {
						id: context.user.id,
						name: context.user.name ?? null,
					},
				}).catch(() => null)
			: null;
		if (!sent) {
			parlumeLog("warn", "suggestion.say_failed", {
				sessionId: session.id,
				suggestionId: suggestion.id,
				configured: settings !== null,
			});
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: "Parlume's media bridge did not answer. Try again.",
			});
		}
		if (sent.spoken) {
			recordAuditFromRequest(context, {
				action: "project.parlume.suggestion_spoken",
				category: "project",
				organizationId: project.organizationId,
				projectId: project.id,
				resource: { type: "parlume_suggestion", id: suggestion.id },
				metadata: { sessionId: session.id },
			});
		}
		return { spoken: sent.spoken };
	});

/** A member takes a suggestion off the Parlume page, for every reader. */
export const dismissParlumeSuggestionProcedure = suggestionControlProcedure
	.route({
		method: "POST",
		path: "/projects/{projectId}/parlume/sessions/{sessionId}/suggestions/{suggestionId}/dismiss",
		tags: ["Projects", "Parlume"],
		summary: "Dismiss a Parlume suggestion",
	})
	.input(suggestionInput)
	.handler(async ({ input, context }) => {
		const { project, suggestion } = await requireSuggestion(
			input,
			context.user.id,
		);
		const dismissed = await db.parlumeSuggestion.updateMany({
			where: { id: suggestion.id, dismissedAt: null },
			data: { dismissedAt: new Date(), dismissedById: context.user.id },
		});
		if (dismissed.count > 0) {
			recordAuditFromRequest(context, {
				action: "project.parlume.suggestion_dismissed",
				category: "project",
				organizationId: project.organizationId,
				projectId: project.id,
				resource: { type: "parlume_suggestion", id: suggestion.id },
				metadata: { sessionId: suggestion.session.id },
			});
		}
		return { dismissed: dismissed.count > 0 };
	});
