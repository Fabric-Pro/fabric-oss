/**
 * The database side of calendar time evidence: the Teams series linked to a
 * member's projects, the meetings the agent joined for those series, and the
 * member's own meeting-agent sessions. The worker matches them against the
 * member's own calendar, which is read there and never stored; see
 * `time-evidence.ts` for what each source means.
 *
 * Only ids, project ids and times are read.
 */

import { db } from "../../client";

/** A Teams series linked to a project, as calendar meetings are matched to it. */
export interface LinkedTeamsMeeting {
	id: string;
	projectId: string;
	joinUrl: string;
}

/**
 * The active Teams series linked to `projectIds` of the organization. An
 * uploaded transcript's row is not a Teams meeting and is left out, as is a
 * series whose sync was stopped.
 */
export async function listActiveLinkedTeamsMeetings(params: {
	organizationId: string;
	projectIds: readonly string[];
}): Promise<LinkedTeamsMeeting[]> {
	if (params.projectIds.length === 0) {
		return [];
	}
	return db.projectLinkedMeeting.findMany({
		where: {
			projectId: { in: [...params.projectIds] },
			project: { organizationId: params.organizationId },
			source: "TEAMS",
			deactivatedAt: null,
		},
		select: { id: true, projectId: true, joinUrl: true },
	});
}

/**
 * Meetings the agent joined on its own for `linkedMeetingIds`, whose
 * occurrence started in `[from, to)` and that have ended. Whoever enabled
 * automatic joining, so the caller decides which members to credit.
 */
export async function listEndedAutoJoinSessions(params: {
	organizationId: string;
	linkedMeetingIds: readonly string[];
	from: Date;
	to: Date;
}) {
	if (params.linkedMeetingIds.length === 0) {
		return [];
	}
	return db.parlumeMeetingSession.findMany({
		where: {
			organizationId: params.organizationId,
			trigger: "AUTO",
			linkedMeetingId: { in: [...params.linkedMeetingIds] },
			occurrenceStart: { gte: params.from, lt: params.to },
			joinedAt: { not: null },
			endedAt: { not: null },
		},
		select: {
			id: true,
			projectId: true,
			linkedMeetingId: true,
			occurrenceStart: true,
			joinedAt: true,
			endedAt: true,
		},
		orderBy: { occurrenceStart: "asc" },
	});
}

/**
 * Meetings the member had the agent join themselves on `projectIds`, joined
 * in `[from, to)`, whether or not a suggestion already claimed them or they
 * have ended: a calendar meeting they cover is never suggested beside them.
 */
export async function listMemberManualMeetingSessions(params: {
	organizationId: string;
	userId: string;
	projectIds: readonly string[];
	from: Date;
	to: Date;
}) {
	if (params.projectIds.length === 0) {
		return [];
	}
	return db.parlumeMeetingSession.findMany({
		where: {
			organizationId: params.organizationId,
			userId: params.userId,
			projectId: { in: [...params.projectIds] },
			trigger: "MANUAL",
			joinedAt: { gte: params.from, lt: params.to },
		},
		select: { id: true, projectId: true, joinedAt: true },
		orderBy: { joinedAt: "asc" },
	});
}
