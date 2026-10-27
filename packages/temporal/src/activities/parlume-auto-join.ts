/**
 * Parlume auto-join: Parlume joins each occurrence of a linked meeting series
 * whose auto-join switch is on, at its start time, without anyone inviting it.
 *
 * The planner runs every five minutes. It reads each enabler's Teams calendar
 * once for a short window around now, matches the occurrences of their series
 * by join URL, and starts one delayed workflow per occurrence that wakes a
 * minute before it begins. That workflow asks the web app to join; the web app
 * checks everything again at that moment and owns the session itself, because
 * the worker cannot reach the API package that starts one.
 */

import { db, isFeatureEnabled } from "@repo/database";
import {
	executeMicrosoftTeamsTool,
	isMicrosoftNotConnectedError,
} from "@repo/integrations/microsoft";
import { heartbeat } from "@temporalio/activity";
import {
	ApplicationFailure,
	WorkflowExecutionAlreadyStartedError,
} from "@temporalio/common";
import { getTemporalClient } from "../client";
import { parlumeActivityLog } from "./parlume-log";
import { getFabricInternalBaseUrl } from "./shared/fabric-internal-url";

/** How far ahead an occurrence is planned. Three planner runs see each one. */
export const PARLUME_AUTO_JOIN_LOOKAHEAD_MS = 15 * 60_000;
/**
 * How late Parlume still joins. Matches its lobby wait: an occurrence that
 * began longer ago than that is left alone rather than joined mid-meeting.
 */
export const PARLUME_AUTO_JOIN_LATE_CUTOFF_MS = 10 * 60_000;
/** How long before the start the join is requested, for the lobby. */
export const PARLUME_AUTO_JOIN_LEAD_MS = 60_000;
/** A ceiling on one planner run's series, logged when reached. */
const MAX_SERIES = 2_000;

const PARLUME_AUTO_JOIN_OCCURRENCE_WORKFLOW =
	"parlumeAutoJoinOccurrenceWorkflow";
const PARLUME_AUTO_JOIN_TASK_QUEUE = "fabric-worker";

/**
 * What a series' admins are told when its enabler's calendar cannot be read.
 * The planner clears only these once the calendar answers again, so a join
 * refusal the web app recorded stays until the next join or a new switch.
 */
export const PARLUME_AUTO_JOIN_CALENDAR_ERRORS = {
	notConnected:
		"Reconnect Microsoft in Settings → Integrations to keep auto-join working. Parlume reads the calendar of the person who turned it on.",
	unreadable:
		"Parlume could not read the Teams calendar of the person who turned on auto-join. It will try again in a few minutes.",
} as const;

const CALENDAR_ERROR_MESSAGES: string[] = Object.values(
	PARLUME_AUTO_JOIN_CALENDAR_ERRORS,
);

export interface AutoJoinSeries {
	id: string;
	joinUrl: string;
	userId: string;
	organizationId: string;
}

/** One calendar read: an enabler and the Microsoft connection it goes through. */
export interface AutoJoinGroup {
	userId: string;
	organizationId: string;
	series: AutoJoinSeries[];
}

export interface AutoJoinCalendarMeeting {
	start?: string | null;
	joinUrl?: string | null;
	isCancelled?: boolean;
}

export interface AutoJoinOccurrence {
	linkedMeetingId: string;
	/** ISO-8601 UTC instant of the occurrence's start. */
	occurrenceStart: string;
	startDelayMs: number;
}

const normalizeJoinUrl = (url: string) => url.trim().toLowerCase();

const OFFSET_SUFFIX = /(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Graph's `dateTimeTimeZone.dateTime` carries no offset and, with no
 * `Prefer: outlook.timezone` header, is UTC wall-clock time; read without a
 * zone it would parse as the worker's local time. The API's
 * `normalizeGraphDateTime` applies the same rule to the same field.
 */
export function parseGraphStart(
	value: string | null | undefined,
): number | null {
	if (!value || !value.includes("T")) {
		return null;
	}
	const ms = Date.parse(OFFSET_SUFFIX.test(value) ? value : `${value}Z`);
	return Number.isNaN(ms) ? null : ms;
}

/** One group per (enabler, organization): each is one calendar read. */
export function groupAutoJoinSeries(series: AutoJoinSeries[]): AutoJoinGroup[] {
	const groups = new Map<string, AutoJoinGroup>();
	for (const entry of series) {
		const key = JSON.stringify([entry.userId, entry.organizationId]);
		const group = groups.get(key) ?? {
			userId: entry.userId,
			organizationId: entry.organizationId,
			series: [],
		};
		group.series.push(entry);
		groups.set(key, group);
	}
	return [...groups.values()];
}

/**
 * The occurrences of a group's series that start within the planning window:
 * no later than the lookahead, and no earlier than the late cutoff. Each joins
 * a minute before its start, or straight away when that has passed. A
 * cancelled occurrence is never planned.
 */
export function matchAutoJoinOccurrences(input: {
	series: Pick<AutoJoinSeries, "id" | "joinUrl">[];
	meetings: AutoJoinCalendarMeeting[];
	now: number;
}): AutoJoinOccurrence[] {
	const seriesByUrl = new Map(
		input.series.map((entry) => [
			normalizeJoinUrl(entry.joinUrl),
			entry.id,
		]),
	);
	const occurrences = new Map<string, AutoJoinOccurrence>();
	for (const meeting of input.meetings) {
		if (!meeting.joinUrl || meeting.isCancelled) {
			continue;
		}
		const linkedMeetingId = seriesByUrl.get(
			normalizeJoinUrl(meeting.joinUrl),
		);
		const startMs = parseGraphStart(meeting.start);
		if (!linkedMeetingId || startMs === null) {
			continue;
		}
		if (
			startMs < input.now - PARLUME_AUTO_JOIN_LATE_CUTOFF_MS ||
			startMs > input.now + PARLUME_AUTO_JOIN_LOOKAHEAD_MS
		) {
			continue;
		}
		const occurrence: AutoJoinOccurrence = {
			linkedMeetingId,
			occurrenceStart: new Date(startMs).toISOString(),
			startDelayMs: Math.max(
				0,
				startMs - PARLUME_AUTO_JOIN_LEAD_MS - input.now,
			),
		};
		occurrences.set(parlumeAutoJoinWorkflowId(occurrence), occurrence);
	}
	return [...occurrences.values()];
}

/**
 * One workflow per occurrence, whichever planner run sees it first: the id is
 * the series and the occurrence's start, and a duplicate start is refused.
 */
export function parlumeAutoJoinWorkflowId(occurrence: {
	linkedMeetingId: string;
	occurrenceStart: string;
}): string {
	return `parlume-autojoin-${occurrence.linkedMeetingId}-${Date.parse(occurrence.occurrenceStart)}`;
}

async function readCalendar(
	owner: { userId: string; organizationId: string },
	window: { start: number; end: number },
): Promise<AutoJoinCalendarMeeting[]> {
	const result = (await executeMicrosoftTeamsTool(
		"list_calendar_meetings",
		{
			startDate: new Date(window.start).toISOString(),
			endDate: new Date(window.end).toISOString(),
		},
		owner.userId,
		owner.organizationId,
	)) as { meetings?: AutoJoinCalendarMeeting[]; error?: string };
	if (result.error) {
		throw new Error(result.error);
	}
	return result.meetings ?? [];
}

async function setCalendarError(
	group: AutoJoinGroup,
	message: string,
): Promise<void> {
	await db.projectLinkedMeeting.updateMany({
		where: { id: { in: group.series.map((entry) => entry.id) } },
		data: {
			parlumeAutoJoinError: message,
			parlumeAutoJoinErrorAt: new Date(),
		},
	});
}

async function clearCalendarError(group: AutoJoinGroup): Promise<void> {
	await db.projectLinkedMeeting.updateMany({
		where: {
			id: { in: group.series.map((entry) => entry.id) },
			parlumeAutoJoinError: { in: CALENDAR_ERROR_MESSAGES },
		},
		data: { parlumeAutoJoinError: null, parlumeAutoJoinErrorAt: null },
	});
}

/** Start an occurrence's delayed join; false when a run already started it. */
async function scheduleOccurrence(
	occurrence: AutoJoinOccurrence,
): Promise<boolean> {
	const client = await getTemporalClient();
	try {
		await client.workflow.start(PARLUME_AUTO_JOIN_OCCURRENCE_WORKFLOW, {
			taskQueue: PARLUME_AUTO_JOIN_TASK_QUEUE,
			workflowId: parlumeAutoJoinWorkflowId(occurrence),
			workflowIdReusePolicy: "REJECT_DUPLICATE",
			args: [
				{
					linkedMeetingId: occurrence.linkedMeetingId,
					occurrenceStart: occurrence.occurrenceStart,
				},
			],
			startDelay: occurrence.startDelayMs,
			workflowExecutionTimeout: "1 hour",
		});
		return true;
	} catch (error) {
		if (error instanceof WorkflowExecutionAlreadyStartedError) {
			return false;
		}
		throw error;
	}
}

async function loadEnabledSeries(): Promise<AutoJoinSeries[]> {
	const rows = await db.projectLinkedMeeting.findMany({
		where: {
			parlumeAutoJoin: true,
			deactivatedAt: null,
			parlumeAutoJoinUserId: { not: null },
			project: { organizationId: { not: null }, deletedAt: null },
		},
		select: {
			id: true,
			joinUrl: true,
			parlumeAutoJoinUserId: true,
			project: { select: { organizationId: true } },
		},
		orderBy: { id: "asc" },
		take: MAX_SERIES,
	});
	if (rows.length === MAX_SERIES) {
		parlumeActivityLog("warn", "auto_join.plan_capped", {
			max: MAX_SERIES,
		});
	}
	const enabled = new Map<string, Promise<boolean>>();
	const flagsOn = (organizationId: string) => {
		const cached = enabled.get(organizationId);
		if (cached) {
			return cached;
		}
		const check = Promise.all([
			isFeatureEnabled("PARLUME_MEETINGS", organizationId),
			isFeatureEnabled("MEETING_AGENDA", organizationId),
		]).then(([parlume, agenda]) => parlume && agenda);
		enabled.set(organizationId, check);
		return check;
	};
	const series: AutoJoinSeries[] = [];
	for (const row of rows) {
		const organizationId = row.project.organizationId;
		const userId = row.parlumeAutoJoinUserId;
		if (organizationId && userId && (await flagsOn(organizationId))) {
			series.push({
				id: row.id,
				joinUrl: row.joinUrl,
				userId,
				organizationId,
			});
		}
	}
	return series;
}

export interface PlanParlumeAutoJoinsResult {
	groups: number;
	scheduled: number;
	alreadyScheduled: number;
	calendarFailures: number;
}

/**
 * One planner run. A group whose calendar cannot be read records why on its
 * series and the run moves on; nothing about one enabler stops another's.
 */
export async function planParlumeAutoJoins(): Promise<PlanParlumeAutoJoinsResult> {
	const groups = groupAutoJoinSeries(await loadEnabledSeries());
	const result: PlanParlumeAutoJoinsResult = {
		groups: groups.length,
		scheduled: 0,
		alreadyScheduled: 0,
		calendarFailures: 0,
	};
	for (const group of groups) {
		heartbeat({ userId: group.userId });
		const now = Date.now();
		let meetings: AutoJoinCalendarMeeting[];
		try {
			meetings = await readCalendar(group, {
				start: now - PARLUME_AUTO_JOIN_LATE_CUTOFF_MS,
				end: now + PARLUME_AUTO_JOIN_LOOKAHEAD_MS,
			});
		} catch (error) {
			const message =
				error instanceof Error ? error.message : String(error);
			const notConnected = isMicrosoftNotConnectedError(message);
			result.calendarFailures += 1;
			parlumeActivityLog("warn", "auto_join.calendar_failed", {
				userId: group.userId,
				organizationId: group.organizationId,
				seriesCount: group.series.length,
				notConnected,
				error: message.slice(0, 300),
			});
			await setCalendarError(
				group,
				notConnected
					? PARLUME_AUTO_JOIN_CALENDAR_ERRORS.notConnected
					: PARLUME_AUTO_JOIN_CALENDAR_ERRORS.unreadable,
			);
			continue;
		}
		await clearCalendarError(group);
		for (const occurrence of matchAutoJoinOccurrences({
			series: group.series,
			meetings,
			now,
		})) {
			if (await scheduleOccurrence(occurrence)) {
				result.scheduled += 1;
				parlumeActivityLog("info", "auto_join.scheduled", {
					linkedMeetingId: occurrence.linkedMeetingId,
					occurrenceStart: occurrence.occurrenceStart,
					startDelayMs: occurrence.startDelayMs,
				});
			} else {
				result.alreadyScheduled += 1;
			}
		}
	}
	parlumeActivityLog("info", "auto_join.planned", { ...result });
	return result;
}

/** How far either side of the scheduled start the calendar is read again. */
export const PARLUME_AUTO_JOIN_CONFIRM_WINDOW_MS = 2 * 60_000;
/** How far an occurrence's start may be from the scheduled one and still be it. */
export const PARLUME_AUTO_JOIN_START_TOLERANCE_MS = 60_000;
const CONFIRM_READ_ATTEMPTS = 3;
const CONFIRM_READ_RETRY_MS = 10_000;

/**
 * Recorded when the calendar could not be read just before an occurrence, so
 * that occurrence was not joined. Not a planner calendar error: it stays until
 * the next join or switch, rather than being cleared when the calendar answers.
 */
export const PARLUME_AUTO_JOIN_CONFIRM_UNREADABLE =
	"Parlume did not join a meeting of this series because the Teams calendar of the person who turned on auto-join could not be read just before it started.";

/**
 * Whether the calendar still has the occurrence a join was scheduled for: the
 * series' join link, a start within a minute of the scheduled one, and not
 * cancelled.
 */
export function isOccurrenceStillScheduled(input: {
	joinUrl: string;
	occurrenceStartMs: number;
	meetings: AutoJoinCalendarMeeting[];
}): boolean {
	const joinUrl = normalizeJoinUrl(input.joinUrl);
	return input.meetings.some((meeting) => {
		const startMs = parseGraphStart(meeting.start);
		return (
			!meeting.isCancelled &&
			!!meeting.joinUrl &&
			normalizeJoinUrl(meeting.joinUrl) === joinUrl &&
			startMs !== null &&
			Math.abs(startMs - input.occurrenceStartMs) <=
				PARLUME_AUTO_JOIN_START_TOLERANCE_MS
		);
	});
}

type ConfirmCalendarRead =
	| { meetings: AutoJoinCalendarMeeting[] }
	| { error: string; notConnected: boolean };

/** A few reads ten seconds apart, so a passing Graph error does not cost the join. */
async function readCalendarToConfirm(
	owner: { userId: string; organizationId: string },
	window: { start: number; end: number },
): Promise<ConfirmCalendarRead> {
	for (let attempt = 1; ; attempt++) {
		try {
			return { meetings: await readCalendar(owner, window) };
		} catch (error) {
			const message =
				error instanceof Error ? error.message : String(error);
			const notConnected = isMicrosoftNotConnectedError(message);
			if (notConnected || attempt >= CONFIRM_READ_ATTEMPTS) {
				return { error: message, notConnected };
			}
			await new Promise((resolve) =>
				setTimeout(resolve, CONFIRM_READ_RETRY_MS),
			);
		}
	}
}

export type ConfirmParlumeAutoJoinResult =
	| { proceed: true }
	| {
			proceed: false;
			outcome: "skipped";
			reason:
				| "occurrence_moved_or_cancelled"
				| "calendar_not_connected"
				| "calendar_unreadable";
	  };

/**
 * Just before a scheduled join, read the enabler's calendar again around the
 * occurrence's start: the meeting may have been cancelled or moved since the
 * planner saw it. A moved meeting is the planner's to schedule again, under
 * the id of its new start. When the series is no longer on, the web app is
 * asked anyway: it checks the series itself and records why it does not join.
 */
export async function confirmParlumeAutoJoinOccurrence(input: {
	linkedMeetingId: string;
	occurrenceStart: string;
}): Promise<ConfirmParlumeAutoJoinResult> {
	const series = await db.projectLinkedMeeting.findFirst({
		where: { id: input.linkedMeetingId },
		select: {
			joinUrl: true,
			parlumeAutoJoin: true,
			parlumeAutoJoinUserId: true,
			deactivatedAt: true,
			project: { select: { organizationId: true } },
		},
	});
	const userId = series?.parlumeAutoJoinUserId;
	const organizationId = series?.project.organizationId;
	if (
		!series?.parlumeAutoJoin ||
		series.deactivatedAt ||
		!userId ||
		!organizationId
	) {
		return { proceed: true };
	}
	const occurrenceStartMs = Date.parse(input.occurrenceStart);
	const read = await readCalendarToConfirm(
		{ userId, organizationId },
		{
			start: occurrenceStartMs - PARLUME_AUTO_JOIN_CONFIRM_WINDOW_MS,
			end: occurrenceStartMs + PARLUME_AUTO_JOIN_CONFIRM_WINDOW_MS,
		},
	);
	if ("error" in read) {
		parlumeActivityLog("warn", "auto_join.confirm_failed", {
			...input,
			notConnected: read.notConnected,
			error: read.error.slice(0, 300),
		});
		await db.projectLinkedMeeting.updateMany({
			where: { id: input.linkedMeetingId },
			data: {
				parlumeAutoJoinError: read.notConnected
					? PARLUME_AUTO_JOIN_CALENDAR_ERRORS.notConnected
					: PARLUME_AUTO_JOIN_CONFIRM_UNREADABLE,
				parlumeAutoJoinErrorAt: new Date(),
			},
		});
		return {
			proceed: false,
			outcome: "skipped",
			reason: read.notConnected
				? "calendar_not_connected"
				: "calendar_unreadable",
		};
	}
	if (
		!isOccurrenceStillScheduled({
			joinUrl: series.joinUrl,
			occurrenceStartMs,
			meetings: read.meetings,
		})
	) {
		parlumeActivityLog("info", "auto_join.skipped", {
			...input,
			reason: "occurrence_moved_or_cancelled",
		});
		return {
			proceed: false,
			outcome: "skipped",
			reason: "occurrence_moved_or_cancelled",
		};
	}
	return { proceed: true };
}

/** Thrown for a refusal the web app answered with a 4xx: never retried. */
export const PARLUME_AUTO_JOIN_REJECTED = "ParlumeAutoJoinRejected";

const AUTO_JOIN_REQUEST_TIMEOUT_MS = 90_000;

/**
 * Ask the web app to join one occurrence. A decision about the meeting comes
 * back as a 200 with its outcome; a 4xx is final; anything else is retried by
 * the workflow's bounded policy.
 */
export async function requestParlumeAutoJoin(input: {
	linkedMeetingId: string;
	occurrenceStart: string;
}): Promise<{ outcome: string }> {
	const secret = process.env.AGENT_SERVICE_SECRET;
	if (!secret) {
		throw ApplicationFailure.nonRetryable(
			"AGENT_SERVICE_SECRET is not configured on the worker.",
			PARLUME_AUTO_JOIN_REJECTED,
		);
	}
	const response = await fetch(
		`${getFabricInternalBaseUrl()}/api/internal/parlume/auto-join`,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Agent-Service-Token": secret,
			},
			body: JSON.stringify(input),
			signal: AbortSignal.timeout(AUTO_JOIN_REQUEST_TIMEOUT_MS),
		},
	);
	if (response.status >= 400 && response.status < 500) {
		parlumeActivityLog("warn", "auto_join.rejected", {
			...input,
			status: response.status,
		});
		throw ApplicationFailure.nonRetryable(
			`The web app refused the auto-join request (HTTP ${response.status}).`,
			PARLUME_AUTO_JOIN_REJECTED,
		);
	}
	if (!response.ok) {
		throw new Error(`Auto-join request failed (HTTP ${response.status}).`);
	}
	const body = (await response.json()) as { outcome?: unknown };
	const outcome = typeof body.outcome === "string" ? body.outcome : "unknown";
	parlumeActivityLog("info", "auto_join.requested", { ...input, outcome });
	return { outcome };
}
