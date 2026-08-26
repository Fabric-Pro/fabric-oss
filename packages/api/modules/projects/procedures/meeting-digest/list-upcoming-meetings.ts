import { ORPCError } from "@orpc/server";
import { db, hasProjectAccess, isFeatureEnabled } from "@repo/database";
import {
	executeMicrosoftTeamsTool,
	isMicrosoftNotConnectedError,
} from "@repo/integrations/microsoft";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import {
	type GraphCalendarMeeting,
	normalizeGraphDateTime,
} from "./list-personal-meetings";
import { utcDayKey, utcDayRange } from "./occurrence-day";

/** Mirrors Prisma's `MeetingAgendaStatus` enum, narrowed to what the UI reads. */
type UpcomingAgendaStatus = "READY" | "GENERATING" | "FAILED";

/** The slice of `ProjectMeetingAgenda` this list needs to render an indicator. */
export interface AgendaStatusRow {
	linkedMeetingId: string;
	occurrenceStart: Date;
	status: UpcomingAgendaStatus;
}

/**
 * One upcoming calendar occurrence for the Meeting Digest's UPCOMING section
 * (#1901a).
 *
 * `linkedMeetingId === null` means the occurrence is on the caller's calendar
 * but the series is not linked to this project — the FR6 path, rendered as
 * "Link to generate agenda".
 *
 * There is deliberately no `endTime`: executeMicrosoftTeamsTool flattens only
 * `event.start.dateTime` and discards `event.end`, so duration is unavailable
 * without extending that wrapper.
 */
export interface UpcomingMeetingRow {
	joinUrl: string;
	subject: string;
	/** ISO-8601 UTC instant. */
	startTime: string;
	organizer: string;
	linkedMeetingId: string | null;
	/**
	 * Agenda-generation status for THIS occurrence (#2106), or null when the
	 * meeting is linked but has no agenda yet. Always null for an unlinked
	 * meeting: no row can exist for it, so the UI renders "not tracked" rather
	 * than "no agenda yet" — the two are different claims.
	 */
	agendaStatus: UpcomingAgendaStatus | null;
}

const normalizeJoinUrl = (url: string) => url.trim().toLowerCase();

/**
 * Pure mapper — exported for unit tests, matching the `buildDigestRows` /
 * `buildPersonalRows` convention.
 *
 * A joinUrl is the prerequisite for a meeting ever being linkable (and for a
 * transcript ever existing), so meetings without one are dropped. Occurrences
 * that already started are dropped: an agenda for a meeting in progress is not
 * what this feature is for.
 */
export function buildUpcomingRows({
	graphMeetings,
	linkedMeetings,
	agendas,
	now,
}: {
	graphMeetings: GraphCalendarMeeting[];
	linkedMeetings: { id: string; joinUrl: string }[];
	/** Newest-first, as read by the handler. Omitted by older callers. */
	agendas?: AgendaStatusRow[];
	now: Date;
}): UpcomingMeetingRow[] {
	const linkedByUrl = new Map(
		linkedMeetings.map((m) => [normalizeJoinUrl(m.joinUrl), m.id]),
	);

	// Keyed on (linkedMeetingId, UTC day) — the same resolution getAgenda uses,
	// so a rescheduled meeting's indicator matches the agenda its sheet opens.
	// The handler reads newest-first, so the FIRST entry for a key wins and
	// later ones are ignored; that reproduces getAgenda's
	// `orderBy: { createdAt: "desc" }` tiebreak for the documented case of a
	// meeting recurring twice within one UTC day.
	const agendaByOccurrence = new Map<string, UpcomingAgendaStatus>();
	for (const agenda of agendas ?? []) {
		const key = `${agenda.linkedMeetingId}:${utcDayKey(agenda.occurrenceStart)}`;
		if (!agendaByOccurrence.has(key)) {
			agendaByOccurrence.set(key, agenda.status);
		}
	}

	const rows: UpcomingMeetingRow[] = [];

	for (const meeting of graphMeetings) {
		if (
			typeof meeting.joinUrl !== "string" ||
			meeting.joinUrl.length === 0
		) {
			continue;
		}

		const normalizedStart = normalizeGraphDateTime(meeting.start);
		if (normalizedStart === null) {
			continue;
		}

		const startMs = Date.parse(normalizedStart);
		// A Graph payload we cannot place in time is worse than absent: it would
		// sort arbitrarily and produce an agenda keyed on an Invalid Date.
		if (Number.isNaN(startMs)) {
			continue;
		}
		if (startMs <= now.getTime()) {
			continue;
		}

		const linkedMeetingId =
			linkedByUrl.get(normalizeJoinUrl(meeting.joinUrl)) ?? null;

		rows.push({
			joinUrl: meeting.joinUrl,
			subject: meeting.subject || "Untitled Meeting",
			startTime: new Date(startMs).toISOString(),
			organizer: meeting.organizer || "Unknown",
			linkedMeetingId,
			agendaStatus: linkedMeetingId
				? (agendaByOccurrence.get(
						`${linkedMeetingId}:${utcDayKey(new Date(startMs))}`,
					) ?? null)
				: null,
		});
	}

	return rows.sort((a, b) => a.startTime.localeCompare(b.startTime));
}

/** Hard ceiling on the forward window. A month of calendar is plenty of prep. */
const MAX_DAYS_FORWARD = 30;

/**
 * List the caller's upcoming online meetings, annotated with whether each
 * series is linked to this project (#1901a).
 *
 * Reads Graph with the CALLER's delegated token (/me/calendarView), so this is
 * inherently per-user: two members of the same project see their own calendars.
 * The agenda built on top is keyed on the MEETING, not on who saw it, so the
 * asymmetry is intentional and does not fork the shared agenda.
 *
 * Nothing is persisted here. The single db read fetches linked joinUrls so the
 * UI can tell a linked occurrence from an unlinked one (FR6).
 */
export const listUpcomingMeetingsProcedure = tenantProtectedProcedure
	// See list-personal-meetings.ts:117-123 — requireProjectPermission does not
	// verify the org taken from input, and hasProjectAccess ignores its third
	// argument. Both gates, always.
	.use(requireInputOrgPermission(Permissions.PROJECT_READ))
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/meeting-digest/upcoming",
		tags: ["Projects", "Meeting Digest"],
		summary: "List upcoming calendar meetings for this project",
		description:
			"List the caller's upcoming online meetings, marking which are linked to this Fabric project. Never persisted.",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			// Day-chunked fetching (#2106): the client asks for [now, now+2d)
			// first so first paint costs one Graph page, then [now+2d, now+14d)
			// on demand. Graph's calendarView is walked 50 events per page,
			// sequentially, so a full 14-day window on a busy calendar is three
			// or more serial round trips before anything renders.
			startOffsetDays: z
				.number()
				.int()
				.min(0)
				.max(MAX_DAYS_FORWARD)
				.default(0),
			daysForward: z
				.number()
				.int()
				.min(1)
				.max(MAX_DAYS_FORWARD)
				.default(14),
		}),
	)
	.handler(async ({ input, context }) => {
		if (!(await isFeatureEnabled("MEETING_AGENDA"))) {
			throw new ORPCError("NOT_FOUND", {
				message: "Meeting agendas are not enabled.",
			});
		}

		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const hasAccess = await hasProjectAccess(
			input.projectId,
			user.id,
			organizationId,
		);
		if (!hasAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		// Defaulted again here, not only in the schema: the handler is also
		// invoked directly (tests, and any future internal caller) where zod
		// never runs, and `undefined * DAY_MS` is NaN — which reaches Graph as
		// an Invalid Date and surfaces as a bare 500.
		const startOffsetDays = input.startOffsetDays ?? 0;

		// Validated here rather than with a zod `.refine`: refining the
		// object turns it into a ZodEffects, which the OpenAPI route
		// generator cannot read `{projectId}` out of.
		if (startOffsetDays >= input.daysForward) {
			throw new ORPCError("BAD_REQUEST", {
				message: "startOffsetDays must be less than daysForward.",
			});
		}

		const now = new Date();
		const DAY_MS = 24 * 60 * 60 * 1000;
		const windowStart = new Date(now.getTime() + startOffsetDays * DAY_MS);
		const windowEnd = new Date(now.getTime() + input.daysForward * DAY_MS);

		// Deliberately NOT filtered on includedInDigest: a series can be linked
		// to this project but toggled out of the digest, and it must still
		// read as linked here. Filtering on includedInDigest made such a
		// series come back with linkedMeetingId: null — shown with the "Link
		// to generate agenda" CTA even though it can never be linked again
		// (@@unique([projectId, joinUrl]) already claims that joinUrl) (#1901
		// final review, FIX 7). This list is calendar-driven, not
		// digest-driven, so an excluded-but-linked series still belongs here
		// with the "Generate agenda" action, same as any other linked series.
		//
		// Both reads are issued together and both finish long before Graph
		// does, so the agenda read (#2106) adds nothing to the critical path.
		// It is scoped on projectId — access to which both middlewares above
		// have already verified — and served by
		// @@index([projectId, occurrenceStart]).
		const [linkedMeetings, agendas] = await Promise.all([
			db.projectLinkedMeeting.findMany({
				where: { projectId: input.projectId },
				select: { id: true, joinUrl: true },
			}),
			db.projectMeetingAgenda.findMany({
				where: {
					projectId: input.projectId,
					occurrenceStart: {
						gte: utcDayRange(windowStart).gte,
						lt: utcDayRange(windowEnd).lt,
					},
				},
				select: {
					linkedMeetingId: true,
					occurrenceStart: true,
					status: true,
				},
				// Newest first, so buildUpcomingRows' first-wins map matches
				// getAgenda's own tiebreak.
				orderBy: { createdAt: "desc" },
			}),
		]);

		try {
			const result = (await executeMicrosoftTeamsTool(
				"list_calendar_meetings",
				{
					startDate: windowStart.toISOString(),
					endDate: windowEnd.toISOString(),
				},
				user.id,
				organizationId ?? undefined,
			)) as { meetings?: GraphCalendarMeeting[] };

			return {
				meetings: buildUpcomingRows({
					graphMeetings: result.meetings ?? [],
					linkedMeetings,
					agendas,
					now,
				}),
			};
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Unknown error";

			// Not-connected is an expected state with its own "Connect Microsoft"
			// CTA, not an error worth throwing.
			if (isMicrosoftNotConnectedError(message)) {
				return { meetings: [], error: "not-connected" as const };
			}

			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: `Failed to list upcoming meetings: ${message}`,
			});
		}
	});
