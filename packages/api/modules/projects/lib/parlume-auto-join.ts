import { ORPCError } from "@orpc/server";
import { db, isFeatureEnabled, isProjectReadOnly } from "@repo/database";
import { assertProjectPermission, Permissions } from "../../../orpc/procedures";
import {
	hasParlumeExternalInvitees,
	parlumeInternalInviteeEmails,
} from "./parlume-guests";
import { parlumeLog } from "./parlume-log";
import { resolveParlumeGuestPolicy } from "./parlume-provider-settings";
import {
	getParlumeReadiness,
	isParlumeReady,
	PARLUME_VOICE_REQUIRED,
	type ParlumeReadiness,
} from "./parlume-readiness";
import {
	FABRIC_AGENT_KIND,
	findLiveParlumeSession,
	PARLUME_ALREADY_IN_MEETING,
	PARLUME_MEETING_BOT_REQUIRED,
	PARLUME_PLATFORM_REQUIRED,
	startParlumeMeetingSession,
} from "./parlume-start";

/** Why a series' joins stopped when its enabler can no longer invite Parlume. */
export const PARLUME_AUTO_JOIN_PERMISSION_LOST =
	"The person who turned on auto-join can no longer invite Parlume to this project. A project admin needs to turn it on again.";

/**
 * Why an occurrence was not joined while its project is in Read-only mode:
 * sending a bot into a meeting is a write to a connected source.
 */
export const PARLUME_AUTO_JOIN_READ_ONLY =
	"Parlume did not join because this project is in Read-only mode. A project admin can turn Read-only mode off in the project settings.";

/**
 * Why an occurrence was not joined when the organization keeps Parlume to
 * internal meetings and the invitation names an external guest.
 */
export const PARLUME_AUTO_JOIN_EXTERNAL_GUESTS =
	"Parlume did not join because the invitation includes people outside your organization, and your organization keeps Parlume to internal meetings. An organization admin can change this in Settings → Meeting assistant.";

/**
 * How late after an occurrence's start Parlume still joins it. The planner
 * plans no occurrence older than this; a join it planned in time can still
 * arrive later, after a worker outage, a slow calendar read or retries.
 */
const PARLUME_AUTO_JOIN_LATE_CUTOFF_MS = 10 * 60_000;

/** Why an occurrence was not joined when its join came after that cutoff. */
export const PARLUME_AUTO_JOIN_LATE =
	"Parlume did not join a meeting of this series because its join came more than 10 minutes after the meeting started.";

/**
 * The first readiness item that is missing, as the reason an automatic join
 * was refused. Each names the settings page that fixes it.
 */
export function parlumeReadinessRefusal(
	readiness: ParlumeReadiness,
): string | null {
	if (!readiness.meetingBot.ready) {
		return PARLUME_MEETING_BOT_REQUIRED;
	}
	if (!readiness.voice.ready) {
		return PARLUME_VOICE_REQUIRED;
	}
	if (!readiness.platform.ready) {
		return PARLUME_PLATFORM_REQUIRED;
	}
	return null;
}

export type ParlumeAutoJoinOutcome =
	| { outcome: "started"; sessionId: string }
	| {
			outcome: "skipped";
			reason:
				| "series_not_found"
				| "disabled"
				| "flag_off"
				| "duplicate"
				| "already_in_meeting";
	  }
	| {
			outcome: "skipped";
			reason: "read_only" | "external_guests" | "late";
			message: string;
	  }
	| {
			outcome: "refused";
			reason: "permission_lost" | "not_ready" | "start_refused";
			message: string;
	  }
	| { outcome: "failed"; message: string };

function isUniqueViolation(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		(error as { code?: unknown }).code === "P2002"
	);
}

async function recordAutoJoinError(
	linkedMeetingId: string,
	message: string,
): Promise<void> {
	await db.projectLinkedMeeting.updateMany({
		where: { id: linkedMeetingId },
		data: {
			parlumeAutoJoinError: message,
			parlumeAutoJoinErrorAt: new Date(),
		},
	});
}

/**
 * Join one occurrence of an auto-join series, as the scheduler asks at its
 * start time. Everything the switch was turned on under is checked again
 * here, because time has passed since: the series is still on and linked,
 * both flags are on, the project is not in Read-only mode (a bot joining is a
 * write to a connected source), the person who turned it on can still invite
 * Parlume to the project, Parlume is ready, this occurrence has no session yet,
 * no session of the series, manual or automatic, is in the meeting, where
 * the organization keeps Parlume to internal meetings the invitation names
 * nobody outside it, and the occurrence began no more than ten minutes ago.
 * An invitation that names someone outside it starts a session that
 * counts as having a guest from the start. The session keeps the addresses
 * of the invitees from inside the organization, who may read its transcript.
 *
 * A decision about the meeting (skipped, refused, the bot could not start) is
 * returned, never thrown, so the scheduler does not retry it; a refusal or a
 * failed start is written on the series for its admins to see. Only an error
 * that is not a decision (a database outage) escapes, and the caller answers
 * it as retryable.
 */
export async function runParlumeAutoJoin(input: {
	linkedMeetingId: string;
	occurrenceStart: Date;
	/** The email domains of the occurrence's invitees, from the calendar. */
	inviteeDomains: string[];
	/** The addresses of its invitees from the enabler's domain. */
	inviteeEmails: string[];
}): Promise<ParlumeAutoJoinOutcome> {
	const { linkedMeetingId, occurrenceStart } = input;
	const series = await db.projectLinkedMeeting.findFirst({
		where: { id: linkedMeetingId },
		select: {
			id: true,
			projectId: true,
			joinUrl: true,
			deactivatedAt: true,
			parlumeAutoJoin: true,
			parlumeAutoJoinUserId: true,
			parlumeAutoJoinToolsReadOnly: true,
			parlumeAutoJoinSuggestions: true,
			parlumeAutoJoinSuggestionAudience: true,
			parlumeAutoJoinUser: { select: { email: true } },
			project: { select: { organizationId: true } },
		},
	});
	const log = (event: string, meta: Record<string, unknown> = {}) =>
		parlumeLog("info", `auto_join.${event}`, {
			linkedMeetingId,
			occurrenceStart: occurrenceStart.toISOString(),
			...meta,
		});
	if (!series) {
		log("skipped", { reason: "series_not_found" });
		return { outcome: "skipped", reason: "series_not_found" };
	}
	const userId = series.parlumeAutoJoinUserId;
	const organizationId = series.project.organizationId;
	if (
		!series.parlumeAutoJoin ||
		series.deactivatedAt ||
		!userId ||
		!organizationId
	) {
		log("skipped", { reason: "disabled" });
		return { outcome: "skipped", reason: "disabled" };
	}
	const [parlumeOn, agendaOn] = await Promise.all([
		isFeatureEnabled("PARLUME_MEETINGS", organizationId),
		isFeatureEnabled("MEETING_AGENDA", organizationId),
	]);
	if (!parlumeOn || !agendaOn) {
		log("skipped", { reason: "flag_off", organizationId });
		return { outcome: "skipped", reason: "flag_off" };
	}
	if (await isProjectReadOnly(series.projectId)) {
		await recordAutoJoinError(linkedMeetingId, PARLUME_AUTO_JOIN_READ_ONLY);
		log("skipped", { reason: "read_only", organizationId });
		return {
			outcome: "skipped",
			reason: "read_only",
			message: PARLUME_AUTO_JOIN_READ_ONLY,
		};
	}

	const refuse = async (
		reason: "permission_lost" | "not_ready" | "start_refused",
		message: string,
	): Promise<ParlumeAutoJoinOutcome> => {
		await recordAutoJoinError(linkedMeetingId, message);
		parlumeLog("warn", "auto_join.refused", {
			linkedMeetingId,
			occurrenceStart: occurrenceStart.toISOString(),
			organizationId,
			reason,
		});
		return { outcome: "refused", reason, message };
	};

	try {
		await assertProjectPermission(
			series.projectId,
			userId,
			Permissions.PROJECT_MEMBERS_MANAGE,
		);
	} catch (error) {
		if (error instanceof ORPCError) {
			return refuse("permission_lost", PARLUME_AUTO_JOIN_PERMISSION_LOST);
		}
		throw error;
	}

	const existing = await db.parlumeMeetingSession.findFirst({
		where: { linkedMeetingId, occurrenceStart },
		select: { id: true },
	});
	if (existing) {
		log("skipped", { reason: "duplicate", sessionId: existing.id });
		return { outcome: "skipped", reason: "duplicate" };
	}
	const live = await findLiveParlumeSession(linkedMeetingId);
	if (live) {
		log("skipped", { reason: "already_in_meeting", sessionId: live.id });
		return { outcome: "skipped", reason: "already_in_meeting" };
	}

	const readiness = await getParlumeReadiness({ userId, organizationId });
	if (!isParlumeReady(readiness)) {
		return refuse(
			"not_ready",
			parlumeReadinessRefusal(readiness) ?? PARLUME_PLATFORM_REQUIRED,
		);
	}

	const externalInvitees = hasParlumeExternalInvitees({
		inviteeDomains: input.inviteeDomains,
		enablerEmail: series.parlumeAutoJoinUser?.email ?? null,
	});
	if (
		externalInvitees &&
		(await resolveParlumeGuestPolicy(organizationId)) === "INTERNAL_ONLY"
	) {
		await recordAutoJoinError(
			linkedMeetingId,
			PARLUME_AUTO_JOIN_EXTERNAL_GUESTS,
		);
		log("skipped", { reason: "external_guests", organizationId });
		return {
			outcome: "skipped",
			reason: "external_guests",
			message: PARLUME_AUTO_JOIN_EXTERNAL_GUESTS,
		};
	}

	const lateMs = Date.now() - occurrenceStart.getTime();
	if (lateMs > PARLUME_AUTO_JOIN_LATE_CUTOFF_MS) {
		await recordAutoJoinError(linkedMeetingId, PARLUME_AUTO_JOIN_LATE);
		log("skipped", { reason: "late", organizationId, lateMs });
		return {
			outcome: "skipped",
			reason: "late",
			message: PARLUME_AUTO_JOIN_LATE,
		};
	}

	try {
		const { session, alreadyInMeeting } = await startParlumeMeetingSession(
			{
				projectId: series.projectId,
				organizationId,
				userId,
				meetingUrl: series.joinUrl,
				agentKind: FABRIC_AGENT_KIND,
				toolsReadOnly: series.parlumeAutoJoinToolsReadOnly,
				suggestionsEnabled: series.parlumeAutoJoinSuggestions,
				suggestionAudience: series.parlumeAutoJoinSuggestionAudience,
				trigger: "AUTO",
				linkedMeetingId,
				occurrenceStart,
				externalInvitees,
				inviteeEmails: parlumeInternalInviteeEmails({
					inviteeEmails: input.inviteeEmails,
					enablerEmail: series.parlumeAutoJoinUser?.email ?? null,
				}),
			},
			// No person asked for this session; the audit row records it as a
			// system action on behalf of the enabler.
			{},
		);
		if (alreadyInMeeting) {
			// Someone invited Parlume to this meeting since the check above.
			log("skipped", {
				reason: "already_in_meeting",
				sessionId: session.id,
			});
			return { outcome: "skipped", reason: "already_in_meeting" };
		}
		await db.projectLinkedMeeting.updateMany({
			where: { id: linkedMeetingId, parlumeAutoJoinError: { not: null } },
			data: { parlumeAutoJoinError: null, parlumeAutoJoinErrorAt: null },
		});
		log("started", { sessionId: session.id, organizationId });
		return { outcome: "started", sessionId: session.id };
	} catch (error) {
		if (isUniqueViolation(error)) {
			log("skipped", { reason: "duplicate" });
			return { outcome: "skipped", reason: "duplicate" };
		}
		if (!(error instanceof ORPCError)) {
			throw error;
		}
		if (error.message.startsWith(PARLUME_ALREADY_IN_MEETING)) {
			// Someone invited Parlume to this meeting since the check above.
			log("skipped", { reason: "already_in_meeting" });
			return { outcome: "skipped", reason: "already_in_meeting" };
		}
		if (
			error.code === "BAD_GATEWAY" ||
			error.code === "INTERNAL_SERVER_ERROR"
		) {
			// The session row exists and is FAILED with the same message; a
			// retry would only create a second attempt the person did not ask
			// for, so this is final.
			await recordAutoJoinError(linkedMeetingId, error.message);
			parlumeLog("warn", "auto_join.failed", {
				linkedMeetingId,
				occurrenceStart: occurrenceStart.toISOString(),
				organizationId,
				code: error.code,
			});
			return { outcome: "failed", message: error.message };
		}
		return refuse("start_refused", error.message);
	}
}
