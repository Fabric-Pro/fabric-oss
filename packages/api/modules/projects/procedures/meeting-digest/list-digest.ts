import { ORPCError } from "@orpc/server";
import { db, hasProjectAccess } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import {
	type ActionItemPayload,
	toActionItemPayload,
	toInsightsReady,
} from "./get-meeting";
import { utcDayKey } from "./occurrence-day";

type AnalysisStatus = "NOT_SCANNED" | "IN_PROGRESS" | "SCANNED" | "FAILED";

export interface DigestRow {
	linkedMeetingId: string;
	transcriptId: string;
	transcriptRef: string;
	subject: string | null;
	meetingDate: Date | null;
	hasTranscript: boolean;
	analysisStatus: AnalysisStatus;
	createdTaskCount: number;
	participantCount: number;
	includedInDigest: boolean;
	insightsReady: boolean;
	decisions: Array<{ text: string }>;
	actionItems: ActionItemPayload[];
	openQuestions: Array<{ text: string }>;
}

/** Pure: normalizes a Json-typed decisions/questions column into `{ text }[]`. */
function toTextOnlyItems(raw: unknown): Array<{ text: string }> {
	if (!Array.isArray(raw)) {
		return [];
	}
	return raw.map((el) => {
		const obj = (el ?? {}) as Record<string, unknown>;
		return { text: typeof obj.text === "string" ? obj.text : String(el) };
	});
}

/** Pure mapper — unit-tested in isolation, no DB. */
export function buildDigestRows(params: {
	linked: Array<{
		id: string;
		subject: string | null;
		includedInDigest: boolean;
	}>;
	transcripts: Array<{
		id: string;
		linkedMeetingId: string;
		transcriptId: string;
		meetingDate: Date | null;
		contextId: string | null;
		speakerNames: string[];
		analysisStatus: AnalysisStatus;
		analyzedProposalId: string | null;
		insightsExtractedAt: Date | null;
		insightsVersion: number | null;
		extractedDecisions: unknown;
		extractedQuestions: unknown;
		extractedActionItems: unknown;
		actionItemRows: Array<{
			id: string;
			orderIndex: number;
			text: string;
			tentativeOwnerName: string | null;
			dueHint: string | null;
			completedAt: Date | null;
			sourceQuote: string | null;
			anchorLine: number | null;
		}>;
	}>;
	createCountByProposalId: Map<string, number>;
}): DigestRow[] {
	const subjectByLinkedId = new Map(
		params.linked.map((l) => [l.id, l.subject]),
	);
	const includedByLinkedId = new Map(
		params.linked.map((l) => [l.id, l.includedInDigest]),
	);

	return params.transcripts.map((t) => ({
		linkedMeetingId: t.linkedMeetingId,
		transcriptId: t.transcriptId,
		transcriptRef: t.id,
		subject: subjectByLinkedId.get(t.linkedMeetingId) ?? null,
		meetingDate: t.meetingDate,
		hasTranscript: Boolean(t.contextId),
		analysisStatus: t.analysisStatus,
		createdTaskCount: t.analyzedProposalId
			? (params.createCountByProposalId.get(t.analyzedProposalId) ?? 0)
			: 0,
		participantCount: t.speakerNames.length,
		includedInDigest: includedByLinkedId.get(t.linkedMeetingId) ?? false,
		insightsReady: toInsightsReady(t),
		decisions: toTextOnlyItems(t.extractedDecisions),
		openQuestions: toTextOnlyItems(t.extractedQuestions),
		actionItems: toActionItemPayload({
			rows: t.actionItemRows,
			legacyJson: t.extractedActionItems,
		}),
	}));
}

/**
 * An included linked meeting occurrence that has happened but whose transcript
 * has not synced (#2051).
 *
 * The date comes from `ProjectMeetingAgenda.occurrenceStart`, which is
 * team-wide, DB-persisted and NOT Graph-derived — the only occurrence-date
 * source a team-facing endpoint is allowed (router.ts:783-785, FR4). Coverage
 * is therefore bounded to occurrences someone generated an agenda for; series
 * with no datable occurrence fall through to `seriesWithoutTranscripts`.
 */
export interface AwaitingOccurrenceRow {
	linkedMeetingId: string;
	subject: string | null;
	occurrenceStart: Date;
	/**
	 * Carried so the client can suppress the PR #2226 personal-lane copy of the
	 * same meeting. That path only hides a linked meeting once it has a
	 * TRANSCRIPT, which by definition this one has not — without a join-URL to
	 * match on, an unsynced meeting with an agenda renders twice in one cell
	 * ("All meetings" scope): once as a team awaiting row, once as personal.
	 */
	joinUrl: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Does this transcript belong to this occurrence?
 *
 * The two timestamps come off DIFFERENT clocks, which is the whole reason this
 * is not a plain UTC-day comparison:
 *   - `occurrenceStart` is when the meeting STARTS (agenda identity, #1901).
 *   - `meetingDate` is `transcript.createdDateTime` — when the TRANSCRIPT was
 *     created, i.e. at or after the meeting ENDS (meeting-transcript-sync.ts,
 *     "Use the transcript's createdDateTime as the occurrence date").
 *
 * So a meeting that ends after UTC midnight — a 19:00 ET call starts 23:00 UTC
 * and its transcript lands just past 00:00 UTC the next day — lands on the
 * following UTC day and a same-day test would report a synced meeting as
 * "not synced".
 *
 * Two rules, unioned:
 *   - same UTC day, which keeps the getAgenda/buildUpcomingRows resolution and
 *     so still matches a meeting moved from 14:00 back to 10:00; plus
 *   - a forward window of one day from the start, which catches the crossing.
 *
 * The window is half-open and anchored on the start, so for a daily series the
 * next day's transcript cannot reach back and mask a genuinely missing one.
 */
function transcriptCoversOccurrence(
	meetingDate: Date,
	occurrenceStart: Date,
): boolean {
	if (utcDayKey(meetingDate) === utcDayKey(occurrenceStart)) {
		return true;
	}
	const delta = meetingDate.getTime() - occurrenceStart.getTime();
	return delta >= 0 && delta < DAY_MS;
}

/** Pure mapper — unit-tested in isolation, no DB. */
export function buildAwaitingOccurrences(params: {
	linked: Array<{
		id: string;
		subject: string | null;
		includedInDigest: boolean;
		joinUrl: string;
	}>;
	agendas: Array<{ linkedMeetingId: string; occurrenceStart: Date }>;
	transcripts: Array<{ linkedMeetingId: string; meetingDate: Date | null }>;
	now: Date;
}): AwaitingOccurrenceRow[] {
	const includedById = new Map(
		params.linked
			.filter((l) => l.includedInDigest)
			.map((l) => [l.id, { subject: l.subject, joinUrl: l.joinUrl }]),
	);

	// Grouped per series so each occurrence only scans its own transcripts — a
	// month of one daily series is ~22 dates, so the nested scan is trivial.
	const transcriptDatesByMeeting = new Map<string, Date[]>();
	for (const t of params.transcripts) {
		if (t.meetingDate == null) {
			continue;
		}
		const bucket = transcriptDatesByMeeting.get(t.linkedMeetingId);
		if (bucket) {
			bucket.push(t.meetingDate);
		} else {
			transcriptDatesByMeeting.set(t.linkedMeetingId, [t.meetingDate]);
		}
	}

	const seen = new Set<string>();
	const rows: AwaitingOccurrenceRow[] = [];

	for (const agenda of [...params.agendas].sort(
		(a, b) => b.occurrenceStart.getTime() - a.occurrenceStart.getTime(),
	)) {
		const series = includedById.get(agenda.linkedMeetingId);
		if (!series) {
			continue;
		}
		// A meeting that has not happened yet is not awaiting a transcript —
		// UpcomingMeetingsSection owns that state. Without this every scheduled
		// standup would render as a failure.
		if (agenda.occurrenceStart.getTime() > params.now.getTime()) {
			continue;
		}
		// Dedup key stays on the UTC day: it collapses two agendas for the same
		// series on one day, which is agenda-to-agenda identity, not the
		// cross-clock comparison above.
		const key = `${agenda.linkedMeetingId}:${utcDayKey(agenda.occurrenceStart)}`;
		if (seen.has(key)) {
			continue;
		}
		const synced = (
			transcriptDatesByMeeting.get(agenda.linkedMeetingId) ?? []
		).some((meetingDate) =>
			transcriptCoversOccurrence(meetingDate, agenda.occurrenceStart),
		);
		if (synced) {
			continue;
		}
		seen.add(key);
		rows.push({
			linkedMeetingId: agenda.linkedMeetingId,
			subject: series.subject,
			occurrenceStart: agenda.occurrenceStart,
			joinUrl: series.joinUrl,
		});
	}

	return rows;
}

/**
 * Pure: included series with zero synced transcript rows (any date) that also
 * produced no dated awaiting row in the requested window (#2051).
 *
 * The subtraction is what keeps the advisory band meaningful: once a series is
 * visible on the grid as an awaiting occurrence, repeating it in the "no
 * transcripts synced yet" sentence is noise. The band's job is precisely the
 * series the grid cannot place.
 *
 * `awaitingLinkedIds` is optional so callers and tests that predate #2051 keep
 * their meaning: an omitted list subtracts nothing.
 */
export function findSeriesWithoutTranscripts(params: {
	linked: Array<{
		id: string;
		subject: string | null;
		includedInDigest: boolean;
	}>;
	transcriptLinkedIds: string[];
	awaitingLinkedIds?: string[];
}): Array<{ linkedMeetingId: string; subject: string | null }> {
	const withTranscripts = new Set(params.transcriptLinkedIds);
	const awaiting = new Set(params.awaitingLinkedIds ?? []);
	return params.linked
		.filter(
			(l) =>
				l.includedInDigest &&
				!withTranscripts.has(l.id) &&
				!awaiting.has(l.id),
		)
		.map((l) => ({ linkedMeetingId: l.id, subject: l.subject }));
}

export const listDigestProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/meeting-digest",
		tags: ["Projects", "Meeting Digest"],
		summary: "List meetings for the project Meeting Digest",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			from: z.coerce.date().optional(),
			to: z.coerce.date().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const access = await hasProjectAccess(
			input.projectId,
			user.id,
			organizationId,
		);
		if (!access) {
			throw new ORPCError("FORBIDDEN", {
				message: "You do not have access to this project",
			});
		}

		const linked = await db.projectLinkedMeeting.findMany({
			where: { projectId: input.projectId },
			// joinUrl is read for #2051's awaiting rows, so the client can
			// suppress the PR #2226 personal-lane copy of the same meeting.
			select: {
				id: true,
				subject: true,
				includedInDigest: true,
				joinUrl: true,
			},
		});
		const linkedIds = linked.map((l) => l.id);

		const transcripts = linkedIds.length
			? await db.projectMeetingTranscript.findMany({
					where: {
						projectId: input.projectId,
						linkedMeetingId: { in: linkedIds },
						...(input.from || input.to
							? {
									meetingDate: {
										...(input.from
											? { gte: input.from }
											: {}),
										...(input.to ? { lte: input.to } : {}),
									},
								}
							: {}),
					},
					select: {
						id: true,
						linkedMeetingId: true,
						transcriptId: true,
						meetingDate: true,
						contextId: true,
						speakerNames: true,
						analysisStatus: true,
						analyzedProposalId: true,
						insightsExtractedAt: true,
						insightsVersion: true,
						extractedDecisions: true,
						extractedQuestions: true,
						extractedActionItems: true,
						actionItems: {
							select: {
								id: true,
								orderIndex: true,
								text: true,
								tentativeOwnerName: true,
								dueHint: true,
								completedAt: true,
								sourceQuote: true,
								anchorLine: true,
							},
						},
					},
					orderBy: { meetingDate: "desc" },
				})
			: [];

		// Availability check for the "no transcripts synced yet" note. Deliberately
		// NOT date-filtered — a series with only out-of-range transcripts is still
		// synced, just not visible in the requested window.
		const seriesWithAnyTranscript = linkedIds.length
			? await db.projectMeetingTranscript.findMany({
					where: {
						projectId: input.projectId,
						linkedMeetingId: { in: linkedIds },
					},
					select: { linkedMeetingId: true },
					distinct: ["linkedMeetingId"],
				})
			: [];

		// #2051 — occurrence dates for meetings whose transcript has not synced.
		// ProjectMeetingAgenda is the only occurrence-date source available to a
		// team-facing endpoint: it is shared, persisted, and not Graph-derived.
		// Scoped on projectId and served by @@index([projectId, occurrenceStart]).
		const agendaOccurrences = linkedIds.length
			? await db.projectMeetingAgenda.findMany({
					where: {
						projectId: input.projectId,
						linkedMeetingId: { in: linkedIds },
						...(input.from || input.to
							? {
									occurrenceStart: {
										...(input.from
											? { gte: input.from }
											: {}),
										...(input.to ? { lte: input.to } : {}),
									},
								}
							: {}),
					},
					select: {
						linkedMeetingId: true,
						occurrenceStart: true,
					},
				})
			: [];

		const proposalIds = transcripts
			.map((t) => t.analyzedProposalId)
			.filter((id): id is string => Boolean(id));

		const sessions = proposalIds.length
			? await db.backlogUpdateSession.findMany({
					where: {
						projectId: input.projectId,
						pendingProposalId: { in: proposalIds },
					},
					select: { pendingProposalId: true, createCount: true },
					orderBy: { createdAt: "desc" },
				})
			: [];

		const createCountByProposalId = new Map<string, number>();
		for (const s of sessions) {
			// Latest session wins (mirrors finalizeBacklogUpdateSession's findFirst + orderBy createdAt desc).
			if (
				s.pendingProposalId &&
				!createCountByProposalId.has(s.pendingProposalId)
			) {
				createCountByProposalId.set(
					s.pendingProposalId,
					s.createCount ?? 0,
				);
			}
		}

		const awaitingOccurrences = buildAwaitingOccurrences({
			linked,
			agendas: agendaOccurrences,
			transcripts,
			now: new Date(),
		});

		return {
			meetings: buildDigestRows({
				linked,
				transcripts: transcripts.map((t) => ({
					...t,
					actionItemRows: t.actionItems,
				})),
				createCountByProposalId,
			}),
			seriesWithoutTranscripts: findSeriesWithoutTranscripts({
				linked,
				transcriptLinkedIds: seriesWithAnyTranscript.map(
					(t) => t.linkedMeetingId,
				),
				awaitingLinkedIds: awaitingOccurrences.map(
					(a) => a.linkedMeetingId,
				),
			}),
			awaitingOccurrences,
		};
	});
