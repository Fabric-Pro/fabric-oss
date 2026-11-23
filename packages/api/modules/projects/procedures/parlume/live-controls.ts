import { ORPCError } from "@orpc/server";
import { db } from "@repo/database";
import { z } from "zod";
import {
	type AuditRequestContext,
	recordAuditFromRequest,
} from "../../../../lib/audit";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import {
	getParlumeBridgeSettings,
	type ParlumeLiveControl,
	sendParlumeLiveControl,
} from "../../lib/parlume-attendee";
import { parlumeLog } from "../../lib/parlume-log";
import { sessionSelect } from "../../lib/parlume-start";
import { requireParlumeProject } from "./sessions";

const liveControlInput = z.object({
	projectId: z.string(),
	sessionId: z.string(),
});

const AUDIT_ACTIONS: Record<ParlumeLiveControl, string> = {
	"stop-speech": "project.parlume.speech_stopped",
	pause: "project.parlume.listening_paused",
	resume: "project.parlume.listening_resumed",
	"continue-reading": "project.parlume.reading_continued",
};

// Anyone who can read the project sees and hears Parlume in its meetings, so
// anyone who can read it may stop it, pause it, or let it listen again: each
// only makes Parlume say or take in less, or restores what a member paused.
// Continuing a read only says more of a post the meeting chat already shows.
const liveControlProcedure = tenantProtectedProcedure.use(
	requireProjectPermission(Permissions.PROJECT_READ),
);

async function applyLiveControl(
	input: z.infer<typeof liveControlInput>,
	context: AuditRequestContext & {
		user: { id: string; name?: string | null };
	},
	control: ParlumeLiveControl,
) {
	const project = await requireParlumeProject(input.projectId);
	const session = await db.parlumeMeetingSession.findFirst({
		where: {
			id: input.sessionId,
			projectId: input.projectId,
			status: "ACTIVE",
		},
		select: { id: true },
	});
	if (!session) {
		throw new ORPCError("NOT_FOUND", {
			message: "Parlume is not in this meeting.",
		});
	}
	const settings = getParlumeBridgeSettings();
	const sent = settings
		? await sendParlumeLiveControl({
				settings,
				sessionId: session.id,
				control,
				actor: { id: context.user.id, name: context.user.name ?? null },
			}).catch(() => null)
		: null;
	if (!sent) {
		parlumeLog("warn", "live_control.failed", {
			sessionId: session.id,
			control,
			configured: settings !== null,
		});
		throw new ORPCError("INTERNAL_SERVER_ERROR", {
			message: "Parlume's media bridge did not answer. Try again.",
		});
	}
	recordAuditFromRequest(context, {
		action: AUDIT_ACTIONS[control],
		category: "project",
		organizationId: project.organizationId,
		projectId: input.projectId,
		resource: { type: "parlume_meeting_session", id: session.id },
	});
	return {
		changed: sent.changed,
		session: await db.parlumeMeetingSession.findUniqueOrThrow({
			where: { id: session.id },
			select: sessionSelect,
		}),
	};
}

export const stopParlumeSpeechProcedure = liveControlProcedure
	.route({
		method: "POST",
		path: "/projects/{projectId}/parlume/sessions/{sessionId}/stop-speech",
		tags: ["Projects", "Parlume"],
		summary: "Stop the answer Parlume is giving in a meeting",
	})
	.input(liveControlInput)
	.handler(({ input, context }) =>
		applyLiveControl(input, context, "stop-speech"),
	);

export const pauseParlumeListeningProcedure = liveControlProcedure
	.route({
		method: "POST",
		path: "/projects/{projectId}/parlume/sessions/{sessionId}/pause",
		tags: ["Projects", "Parlume"],
		summary: "Pause Parlume's listening in a meeting",
	})
	.input(liveControlInput)
	.handler(({ input, context }) => applyLiveControl(input, context, "pause"));

export const resumeParlumeListeningProcedure = liveControlProcedure
	.route({
		method: "POST",
		path: "/projects/{projectId}/parlume/sessions/{sessionId}/resume",
		tags: ["Projects", "Parlume"],
		summary: "Let Parlume listen again in a meeting",
	})
	.input(liveControlInput)
	.handler(({ input, context }) =>
		applyLiveControl(input, context, "resume"),
	);

export const continueParlumeReadingProcedure = liveControlProcedure
	.route({
		method: "POST",
		path: "/projects/{projectId}/parlume/sessions/{sessionId}/continue-reading",
		tags: ["Projects", "Parlume"],
		summary:
			"Read the next chapter of a long post Parlume is reading aloud",
	})
	.input(liveControlInput)
	.handler(({ input, context }) =>
		applyLiveControl(input, context, "continue-reading"),
	);
