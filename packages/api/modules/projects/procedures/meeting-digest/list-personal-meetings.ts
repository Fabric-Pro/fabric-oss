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

/**
 * List the authenticated user's personal calendar meetings for the digest's
 * "All Meetings" filter.
 *
 * PRIVACY CONTRACT — do not weaken without re-reading the design doc at
 * docs/superpowers/specs/2026-07-21-meeting-digest-personal-meetings-design.md:
 *   - Graph is called with the CALLER's delegated token (/me/calendarView), so
 *     one user physically cannot read another user's calendar (FR4/AC5).
 *   - Nothing here is written or cached. The single db call is a read of
 *     linked joinUrls, used only to avoid showing a meeting twice.
 *   - No Temporal (event history is durable storage), no Redis, no embeddings.
 */

export interface GraphCalendarMeeting {
	id: string;
	subject?: string;
	/** executeMicrosoftTeamsTool flattens start.dateTime to a string. */
	start?: string;
	/** executeMicrosoftTeamsTool flattens organizer to a plain display string. */
	organizer?: string;
	joinUrl?: string;
	isOnlineMeeting?: boolean;
}

export interface PersonalMeetingRow {
	id: string;
	subject: string;
	startTime: string | null;
	organizer: string;
	joinUrl: string;
	/**
	 * True when the meeting IS linked to this project but produced no team row,
	 * because no transcript has synced for it. It is a shared project meeting
	 * shown here only so it isn't invisible — the UI must NOT label it
	 * "Personal" or claim it is private to the caller (DEF-0).
	 */
	linkedWithoutTranscript: boolean;
	/**
	 * True when THIS OCCURRENCE already exists in the project as an imported
	 * context row (#2170).
	 *
	 * Per occurrence, not per series. A `joinUrl` is shared by every instance of
	 * a recurring meeting, so keying on it alone marked all of them the moment
	 * one was imported — telling the reader a still-private meeting was stored
	 * and shared, and withdrawing the Add action from the siblings. The
	 * occurrence is identified by the calendar instant, which is exactly what
	 * the import writes to `metadata.meetingDate`.
	 *
	 * The sheet's privacy notice is the reason this is a server fact rather than
	 * component state. It said "never stored in Fabric", flipped to the stored
	 * wording after an import, and then reverted on the next page load — telling
	 * the reader a meeting is private while a copy of it sits in the project's
	 * Context tab. That is precisely the untruth #2884 was opened to remove, so
	 * the answer has to survive a reload.
	 */
	alreadyImported: boolean;
}

/**
 * Matches a trailing UTC `Z` or a numeric offset (`+02:00` / `-05:00`) at the
 * END of the string only — the date portion's own dashes (`2026-07-14`) never
 * match this because they aren't at the string's end.
 */
const OFFSET_SUFFIX = /(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Normalise a Graph `dateTimeTimeZone.dateTime` string to a real instant.
 *
 * `executeMicrosoftTeamsTool` flattens `event.start.dateTime` and discards
 * `event.start.timeZone` (microsoft/index.ts). Graph's `dateTimeTimeZone.dateTime`
 * has no offset suffix (e.g. `"2026-07-14T09:00:00.0000000"`) and this repo
 * sends no `Prefer: outlook.timezone` header anywhere, so the raw value is
 * UTC wall-clock time with the offset stripped. ECMAScript parses an
 * offset-less date-time string as LOCAL time, not UTC — so without this,
 * every non-UTC user sees a meeting time off by their zone offset, and
 * `groupPersonalMeetingsByDay` can bucket a near-midnight meeting onto the
 * wrong calendar day.
 *
 * Appending `Z` only when no offset is already present makes the string an
 * unambiguous UTC instant. Strings that already carry an offset (`Z` or
 * `+HH:MM`/`-HH:MM`) are left untouched; `null`/`undefined` stay `null`.
 */
export function normalizeGraphDateTime(
	value: string | null | undefined,
): string | null {
	if (value == null) {
		return null;
	}
	// Only a date-TIME can be missing a zone. Appending Z to "" or to a
	// date-only value would manufacture an Invalid Date out of something that
	// previously parsed fine. Graph's calendarView always returns the full
	// yyyy-MM-ddTHH:mm:ss.fffffff form, so this is belt-and-braces.
	if (value.length === 0 || !value.includes("T")) {
		return value;
	}
	return OFFSET_SUFFIX.test(value) ? value : `${value}Z`;
}

const canonicalJoinUrl = (url: string): string => url.trim().toLowerCase();

/**
 * One imported occurrence, as the row builder needs to see it.
 *
 * `meetingDate` is the calendar start time the importer stored — deliberately
 * the occurrence's own clock rather than the transcript's, precisely so the two
 * sides of this comparison are the same clock (see import-personal-meeting.ts).
 */
export interface ImportedOccurrence {
	joinUrl: string;
	meetingDate?: string | null;
}

/**
 * Identity of one occurrence: its series plus its instant.
 *
 * Compared as an INSTANT, not as text. Graph hands back
 * `2026-07-14T09:00:00.0000000Z` while the import stored whatever the client
 * sent (`2026-07-14T09:00:00.000Z`) — the same moment written two ways, which a
 * string comparison would call different and mark every occurrence unimported.
 *
 * Returns null when the moment cannot be established. Callers treat that as
 * "not imported": offering an action whose worst case is the server answering
 * `duplicate` is strictly better than claiming a private meeting is shared.
 *
 * KNOWN LIMIT, and a deliberate one. Because the key is the exact instant,
 * rescheduling an occurrence that was ALREADY imported stops it matching, and
 * the panel goes back to describing a stored transcript as private. A fuzzier
 * match (same UTC day, as `transcriptCoversOccurrence` uses in list-digest.ts)
 * would cover that, at the cost of collapsing two occurrences that fall on one
 * day back into a single answer. The two failure directions are not equal: a
 * false negative offers an action the server answers as `duplicate`, while a
 * false positive states something untrue about who can see someone's meeting.
 * The exact match is chosen for that asymmetry, not for convenience.
 */
function occurrenceKey(
	joinUrl: string | null | undefined,
	when: string | null | undefined,
): string | null {
	if (!joinUrl || !when) {
		return null;
	}
	const at = new Date(when).getTime();
	return Number.isNaN(at) ? null : `${canonicalJoinUrl(joinUrl)}|${at}`;
}

/**
 * Read the stored import rows into the shape the row builder compares against.
 *
 * Pure and exported ON PURPOSE. This is the single place the metadata key names
 * written by `buildImportedContextMetadata` are asserted, and the coupling is by
 * convention alone: nothing in the type system connects the two, because the
 * column is JSON. If `meetingDate` were renamed there, every occurrence would
 * quietly read `alreadyImported: false` and the sheet would go back to calling a
 * stored, project-visible transcript private — the #2884 untruth inverted, with
 * the whole suite still green. Its test feeds real `buildImportedContextMetadata`
 * output through, so the rename fails CI instead.
 *
 * `joinUrl` is required (without it there is nothing to match on); a row with no
 * `meetingDate` is kept but can never match, per `occurrenceKey`.
 */
export function toImportedOccurrences(
	rows: Array<{ metadata: unknown }>,
): ImportedOccurrence[] {
	return rows
		.map((row): ImportedOccurrence | null => {
			const metadata = row.metadata as {
				joinUrl?: string;
				meetingDate?: string;
			} | null;
			return metadata?.joinUrl
				? {
						joinUrl: metadata.joinUrl,
						meetingDate: metadata.meetingDate ?? null,
					}
				: null;
		})
		.filter((row): row is ImportedOccurrence => row !== null);
}

/**
 * Pure mapper — exported for unit tests, matching the `buildDigestRows`
 * convention in list-digest.ts.
 *
 * Keeps only online meetings (a joinUrl is the prerequisite for a transcript
 * ever existing).
 *
 * Suppression is keyed on `renderedJoinUrls` — the meetings that actually
 * produced a team row — NOT on `linkedJoinUrls`. This distinction is the whole
 * point (DEF-0): `buildDigestRows` maps over transcripts, so a linked meeting
 * with no synced transcript yields no team row, and suppressing it here on the
 * grounds that it "already appears as a team row" made it vanish from the digest
 * altogether. Observed live: 12 of one user's meetings in a single week were
 * linked-but-unsynced and appeared in neither list.
 *
 * `linkedJoinUrls` still matters, but only to classify what survives: a
 * surviving linked meeting is a shared project meeting, not a private one, and
 * carries `linkedWithoutTranscript: true` so the UI can say so.
 */
export function buildPersonalRows({
	graphMeetings,
	linkedJoinUrls,
	renderedJoinUrls,
	importedOccurrences,
}: {
	graphMeetings: GraphCalendarMeeting[];
	linkedJoinUrls: string[];
	/**
	 * Join URLs of linked meetings that have at least one synced transcript, i.e.
	 * the ones the team view will actually render. Omitted only by older callers;
	 * treating it as empty is the safe direction — it shows a meeting that might
	 * be a duplicate rather than hiding one that isn't.
	 */
	renderedJoinUrls?: string[];
	/**
	 * The occurrences this project already holds an imported transcript for
	 * (#2170) — join URL AND calendar instant, because a join URL alone cannot
	 * distinguish one instance of a recurring series from another. Absent for
	 * older callers, which reads as "none imported" — the same behaviour as
	 * before the field existed.
	 */
	importedOccurrences?: ImportedOccurrence[];
}): PersonalMeetingRow[] {
	const linked = new Set(linkedJoinUrls.map(canonicalJoinUrl));
	const rendered = new Set((renderedJoinUrls ?? []).map(canonicalJoinUrl));
	const imported = new Set(
		(importedOccurrences ?? [])
			.map((row) => occurrenceKey(row.joinUrl, row.meetingDate))
			.filter((key): key is string => key !== null),
	);

	return graphMeetings
		.filter(
			(m): m is GraphCalendarMeeting & { joinUrl: string } =>
				typeof m.joinUrl === "string" && m.joinUrl.length > 0,
		)
		.filter((m) => !rendered.has(canonicalJoinUrl(m.joinUrl)))
		.map((m) => {
			const startTime = normalizeGraphDateTime(m.start);
			const key = occurrenceKey(m.joinUrl, startTime);
			return {
				id: m.id,
				subject: m.subject || "Untitled Meeting",
				startTime,
				organizer: m.organizer || "Unknown",
				joinUrl: m.joinUrl,
				linkedWithoutTranscript: linked.has(
					canonicalJoinUrl(m.joinUrl),
				),
				alreadyImported: key !== null && imported.has(key),
			};
		});
}

export const listPersonalMeetingsProcedure = tenantProtectedProcedure
	// requireInputOrgPermission verifies membership of the org the CALLER
	// supplied. requireProjectPermission does not close this: it resolves on
	// (projectId, userId) and never reads the org, and hasProjectAccess ignores
	// its third argument outright. Without this a caller could pair a project
	// they legitimately reach with an organization they do not belong to — the
	// exact shape that shipped a cross-tenant read in open-decisions (#1899
	// ratchet, SOC 2 CC6.1/CC6.3).
	.use(requireInputOrgPermission(Permissions.PROJECT_READ))
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/meeting-digest/personal",
		tags: ["Projects", "Meeting Digest"],
		summary: "List personal calendar meetings",
		description:
			"List the authenticated user's own Teams calendar meetings for the digest's All Meetings filter. Never persisted.",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			from: z.coerce.date(),
			to: z.coerce.date(),
		}),
	)
	.handler(async ({ input, context }) => {
		if (!(await isFeatureEnabled("PERSONAL_MEETINGS"))) {
			throw new ORPCError("NOT_FOUND", {
				message: "Personal meetings are not enabled.",
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

		// The only database access in this feature, and read-only by contract.
		//
		// Both halves are needed. `linked` says which of the caller's calendar
		// meetings belong to this project; the transcript count says which of
		// those the TEAM view will actually render this window. Suppressing on
		// "linked" alone was DEF-0 — list-digest builds rows from transcripts, so
		// a linked meeting with none produces no team row, and dropping it here
		// removed it from the digest entirely.
		//
		// The meetingDate window mirrors list-digest's transcript filter exactly.
		// It has to: a meeting whose transcript falls outside the window renders
		// no team row IN THIS WINDOW, so it must survive here or vanish again.
		const linked = await db.projectLinkedMeeting.findMany({
			where: { projectId: input.projectId },
			select: {
				joinUrl: true,
				_count: {
					select: {
						transcripts: {
							where: {
								meetingDate: {
									gte: input.from,
									lte: input.to,
								},
							},
						},
					},
				},
			},
		});

		// #2170: which of these occurrences the project already holds an imported
		// copy of. One query for the whole window rather than one per row, and
		// read-only like everything else here — the no-persistence guarantee is
		// about what this lane WRITES, and it still writes nothing.
		const importedRows = await db.projectContext.findMany({
			where: {
				projectId: input.projectId,
				type: "MEETING_TRANSCRIPT",
				metadata: { path: ["origin"], equals: "personal-import" },
			},
			select: { metadata: true },
		});
		const importedOccurrences = toImportedOccurrences(importedRows);

		try {
			const result = (await executeMicrosoftTeamsTool(
				"list_calendar_meetings",
				{
					startDate: input.from.toISOString(),
					endDate: input.to.toISOString(),
				},
				user.id,
				organizationId ?? undefined,
			)) as { meetings?: GraphCalendarMeeting[] };

			return {
				meetings: buildPersonalRows({
					graphMeetings: result.meetings ?? [],
					linkedJoinUrls: linked.map((l) => l.joinUrl),
					renderedJoinUrls: linked
						.filter((l) => l._count.transcripts > 0)
						.map((l) => l.joinUrl),
					importedOccurrences,
				}),
			};
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Unknown error";

			// Not-connected is an expected state with its own UI affordance
			// (a "Connect Microsoft" CTA), not an error worth throwing.
			if (isMicrosoftNotConnectedError(message)) {
				return { meetings: [], error: "not-connected" as const };
			}

			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: `Failed to list personal meetings: ${message}`,
			});
		}
	});
