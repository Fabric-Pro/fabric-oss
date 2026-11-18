/**
 * Collect a member's unclaimed evidence over a range of work dates and group
 * it into the blocks of time to suggest. Deterministic: no model is involved,
 * and the duration of each block comes only from evidence with a time span.
 *
 * Besides the database, the member's own Microsoft 365 calendar is read here
 * for Teams meetings on linked series (`calendar-evidence.ts`). The calendar
 * is read with the member's own connection only, within a deadline; when it
 * cannot be read, the run goes on with the database evidence. Nothing of a
 * meeting but a hash of its event id, its project and its times leaves this
 * activity, whose result the workflow history records.
 */

import {
	type CollectedTimeEvidence,
	collectUnclaimedTimeEvidence,
	filterUnclaimedTimeEvidence,
	listActiveLinkedTeamsMeetings,
	listAuthorLoggedTime,
	listEndedAutoJoinSessions,
	listMemberManualMeetingSessions,
	resolveOwnWorkflowIntegrationForProvider,
} from "@repo/database";
import {
	type CalendarTimeEvidenceEvent,
	executeMicrosoftTeamsTool,
	isMicrosoftNotConnectedError,
} from "@repo/integrations/microsoft";
import { logger } from "@repo/logs";
import { groupTimeEvidence, zonedMidnight } from "@repo/utils/time-suggestions";
import { addDays } from "@repo/utils/time-tracking";
import {
	buildCalendarTimeEvidence,
	CALENDAR_OCCURRENCE_TOLERANCE_MS,
	qualifyCalendarMeetings,
} from "./calendar-evidence";
import type { TimeSuggestionCandidate } from "./types";

/**
 * The most blocks one generation suggests. The newest work dates are kept;
 * evidence of the rest stays unclaimed for the next generation.
 */
export const MAX_TIME_SUGGESTION_CANDIDATES = 100;

/**
 * How long the calendar read may take. Well inside the activity's 60-second
 * limit, so a slow Graph still leaves the database evidence time to become
 * suggestions.
 */
export const CALENDAR_READ_TIMEOUT_MS = 20_000;

export interface CollectTimeSuggestionCandidatesInput {
	organizationId: string;
	userId: string;
	fromDate: string;
	toDate: string;
	timezone: string;
	/**
	 * The projects the member could discover and log time on when the run
	 * started, with their names.
	 */
	projects: { id: string; name: string }[];
}

/**
 * The member's calendar over `[from, to)`, through the connection pinned by
 * id, given up when the deadline passes.
 */
async function readOwnCalendar(params: {
	organizationId: string;
	userId: string;
	integrationId: string;
	from: Date;
	to: Date;
}): Promise<CalendarTimeEvidenceEvent[]> {
	const deadline = AbortSignal.timeout(CALENDAR_READ_TIMEOUT_MS);
	const expired = new Promise<never>((_, reject) => {
		deadline.addEventListener("abort", () => reject(deadline.reason), {
			once: true,
		});
	});
	const result = (await Promise.race([
		executeMicrosoftTeamsTool(
			"list_calendar_time_evidence",
			{
				startDate: params.from.toISOString(),
				endDate: params.to.toISOString(),
				signal: deadline,
			},
			params.userId,
			params.organizationId,
			params.integrationId,
		),
		expired,
	])) as { events?: CalendarTimeEvidenceEvent[] };
	return result.events ?? [];
}

/**
 * The member's unclaimed evidence from their calendar meetings on `projectIds`
 * that started in `[from, to)`. Empty without a linked Teams series, without
 * their own Microsoft connection, or when the calendar cannot be read.
 */
async function collectUnclaimedCalendarEvidence(params: {
	organizationId: string;
	userId: string;
	projectIds: string[];
	from: Date;
	to: Date;
}): Promise<CollectedTimeEvidence[]> {
	const linkedMeetings = await listActiveLinkedTeamsMeetings({
		organizationId: params.organizationId,
		projectIds: params.projectIds,
	});
	if (linkedMeetings.length === 0) {
		return [];
	}
	// Never a connection shared with the organization: that would read a
	// teammate's calendar as the member's.
	const own = await resolveOwnWorkflowIntegrationForProvider(
		"MICROSOFT_GRAPH",
		params.userId,
		params.organizationId,
	);
	if (!own) {
		return [];
	}

	let events: CalendarTimeEvidenceEvent[];
	try {
		events = await readOwnCalendar({ ...params, integrationId: own.id });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logger.warn(
			"[TimeSuggestions] calendar not read; using database evidence only",
			{
				organizationId: params.organizationId,
				userId: params.userId,
				reason: isMicrosoftNotConnectedError(message)
					? "not-connected"
					: "unreadable",
				detail: message,
			},
		);
		return [];
	}

	const meetings = qualifyCalendarMeetings({
		events,
		linkedMeetings,
		from: params.from,
		to: params.to,
	});
	if (meetings.length === 0) {
		return [];
	}
	const starts = meetings.map((meeting) => meeting.startAt.getTime());
	const ends = meetings.map((meeting) => meeting.endAt.getTime());
	const earliest = new Date(
		Math.min(...starts) - CALENDAR_OCCURRENCE_TOLERANCE_MS,
	);
	const [autoSessions, manualSessions] = await Promise.all([
		listEndedAutoJoinSessions({
			organizationId: params.organizationId,
			linkedMeetingIds: [
				...new Set(meetings.map((meeting) => meeting.linkedMeetingId)),
			],
			from: earliest,
			to: new Date(
				Math.max(...starts) + CALENDAR_OCCURRENCE_TOLERANCE_MS + 1,
			),
		}),
		listMemberManualMeetingSessions({
			organizationId: params.organizationId,
			userId: params.userId,
			projectIds: [
				...new Set(meetings.map((meeting) => meeting.projectId)),
			],
			from: earliest,
			to: new Date(Math.max(...ends) + 1),
		}),
	]);

	return filterUnclaimedTimeEvidence(
		params.userId,
		buildCalendarTimeEvidence({ meetings, autoSessions, manualSessions }),
	);
}

export async function collectTimeSuggestionCandidatesActivity(
	input: CollectTimeSuggestionCandidatesInput,
): Promise<TimeSuggestionCandidate[]> {
	const from = zonedMidnight(input.fromDate, input.timezone);
	const to = zonedMidnight(addDays(input.toDate, 1), input.timezone);
	const projectNames = new Map(
		input.projects.map((project) => [project.id, project.name]),
	);
	const projectIds = [...projectNames.keys()];

	const [stored, calendar, logged] = await Promise.all([
		collectUnclaimedTimeEvidence({
			organizationId: input.organizationId,
			userId: input.userId,
			projectIds,
			from,
			to,
		}),
		collectUnclaimedCalendarEvidence({
			organizationId: input.organizationId,
			userId: input.userId,
			projectIds,
			from,
			to,
		}),
		listAuthorLoggedTime({
			organizationId: input.organizationId,
			userId: input.userId,
			from,
			to,
			fromDate: input.fromDate,
			toDate: input.toDate,
		}),
	]);
	const evidence = [...stored, ...calendar];
	if (evidence.length === 0) {
		return [];
	}

	const stories = new Map<
		string,
		{ identifier: string | null; title: string | null }
	>();
	for (const item of evidence) {
		if (item.storyId) {
			stories.set(item.storyId, {
				identifier: item.storyIdentifier,
				title: item.storyTitle,
			});
		}
	}

	const groups = groupTimeEvidence({
		evidence,
		timeZone: input.timezone,
		loggedIntervals: logged.intervals,
		loggedEntries: logged.entries,
	});

	return groups
		.reverse()
		.slice(0, MAX_TIME_SUGGESTION_CANDIDATES)
		.map((group) => {
			const story = group.storyId
				? stories.get(group.storyId)
				: undefined;
			return {
				workDate: group.workDate,
				projectId: group.projectId,
				projectName: projectNames.get(group.projectId) ?? "",
				storyId: group.storyId,
				storyIdentifier: story?.identifier ?? null,
				storyTitle: story?.title ?? null,
				activity: group.activity,
				durationMinutes: group.durationMinutes,
				startAt: group.startAt?.toISOString() ?? null,
				stopAt: group.stopAt?.toISOString() ?? null,
				evidence: group.evidence.map((item) => ({
					kind: item.kind,
					sourceId: item.sourceId,
					occurredAt: item.occurredAt.toISOString(),
					startAt: item.startAt?.toISOString() ?? null,
					endAt: item.endAt?.toISOString() ?? null,
				})),
			};
		});
}
