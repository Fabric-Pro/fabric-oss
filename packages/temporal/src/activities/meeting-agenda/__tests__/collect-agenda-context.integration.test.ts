import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Real-Postgres verification of the cross-meeting collector (#2105).
 *
 * The sibling unit test mocks the Prisma client, so it verifies the ARGUMENTS
 * this activity passes — not the SQL Prisma builds from them. The nested
 * `actionItems` select (a filtered, ordered, capped to-many read inside a
 * `findMany` select) is the one construct in this change that a mock cannot
 * validate, and a Prisma validation error there would only surface at runtime,
 * inside a Temporal activity, as a failed agenda.
 *
 * Gated on RUN_DB_INTEGRATION=1 like the other DB-backed tests in the repo, so
 * the ordinary no-Postgres unit run skips it rather than failing.
 *
 * Run against a throwaway database:
 *   DATABASE_URL=... DIRECT_URL=... RUN_DB_INTEGRATION=1 npx vitest run \
 *     src/activities/meeting-agenda/__tests__/collect-agenda-context.integration.test.ts
 *
 * `@temporalio/activity` is stubbed because `heartbeat()` throws outside an
 * activity context. That is the ONLY stub — `@repo/database` is the real client,
 * which is the entire point of this file.
 */

vi.mock("@temporalio/activity", () => ({ heartbeat: vi.fn() }));

import { db } from "@repo/database";
import {
	CARRIED_ITEM_CAP,
	collectAgendaContextActivity,
	PRIOR_MEETING_WINDOW_DAYS,
} from "../collect-agenda-context";

const RUN_DB = process.env.RUN_DB_INTEGRATION === "1";
const suite = RUN_DB ? describe : describe.skip;

// Fixed, namespaced ids so a partial failure is trivially identifiable and
// cleanable, and so a re-run cannot collide with its own leftovers.
const NS = "it2105";
const USER_ID = `${NS}_user`;
const ORG_ID = `${NS}_org`;
const PROJECT_ID = `${NS}_project`;
const SERIES_ID = `${NS}_series`;
/** A second series in the same project — nothing from it may leak into the first. */
const OTHER_SERIES_ID = `${NS}_series_other`;

const OCCURRENCE_START = new Date("2026-08-05T09:00:00Z");
const daysBefore = (n: number) =>
	new Date(OCCURRENCE_START.getTime() - n * 24 * 60 * 60 * 1000);

async function cleanup() {
	// Project cascades to linked meetings -> transcripts -> action items.
	await db.project.deleteMany({ where: { id: PROJECT_ID } });
	await db.organization.deleteMany({ where: { id: ORG_ID } });
	await db.user.deleteMany({ where: { id: USER_ID } });
}

suite("collectAgendaContextActivity against real Postgres (#2105)", () => {
	beforeAll(async () => {
		await cleanup();

		await db.user.create({
			data: {
				id: USER_ID,
				name: "Integration Fixture",
				email: `${NS}@example.test`,
				emailVerified: true,
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		});
		await db.organization.create({
			data: {
				id: ORG_ID,
				name: "Integration Org",
				createdAt: new Date(),
			},
		});
		await db.project.create({
			data: {
				id: PROJECT_ID,
				name: "Integration Project",
				userId: USER_ID,
				organizationId: ORG_ID,
			},
		});
		await db.projectLinkedMeeting.createMany({
			data: [
				{
					id: SERIES_ID,
					projectId: PROJECT_ID,
					joinUrl: `https://teams.example.test/${NS}/series`,
					subject: "Weekly Sync",
					userId: USER_ID,
					organizationId: ORG_ID,
				},
				{
					id: OTHER_SERIES_ID,
					projectId: PROJECT_ID,
					joinUrl: `https://teams.example.test/${NS}/other`,
					subject: "Unrelated Meeting",
					userId: USER_ID,
					organizationId: ORG_ID,
				},
			],
		});

		const transcript = async (
			id: string,
			linkedMeetingId: string,
			meetingDate: Date | null,
			subject: string,
		) => {
			await db.projectMeetingTranscript.create({
				data: {
					id,
					projectId: PROJECT_ID,
					linkedMeetingId,
					meetingId: `graph_${id}`,
					transcriptId: `tr_${id}`,
					meetingSubject: subject,
					meetingDate,
					summary: `Summary for ${subject}`,
					extractedDecisions: [{ text: `Decided in ${id}` }],
					extractedQuestions: [{ text: `Open in ${id}` }],
					userId: USER_ID,
					organizationId: ORG_ID,
				},
			});
		};

		// In window, newest first.
		await transcript("t_recent", SERIES_ID, daysBefore(7), "Weekly Sync");
		await transcript("t_older", SERIES_ID, daysBefore(14), "Weekly Sync");
		// Outside the lookback window — must be excluded.
		await transcript(
			"t_stale",
			SERIES_ID,
			daysBefore(PRIOR_MEETING_WINDOW_DAYS + 5),
			"Weekly Sync",
		);
		// NULL meetingDate — Postgres sorts NULLs FIRST on `ORDER BY ... DESC`, so
		// this is the row that could displace real occurrences without the filter.
		await transcript("t_undated", SERIES_ID, null, "Weekly Sync");
		// After the occurrence starts — the meeting's own transcript.
		await transcript("t_future", SERIES_ID, daysBefore(-1), "Weekly Sync");
		// Different series, same project — must not leak in.
		await transcript(
			"t_other",
			OTHER_SERIES_ID,
			daysBefore(3),
			"Unrelated Meeting",
		);

		await db.projectMeetingActionItem.createMany({
			data: [
				{
					id: `${NS}_ai_open_recent`,
					transcriptId: "t_recent",
					orderIndex: 0,
					text: "Chase the vendor contract",
					tentativeOwnerName: "Dana",
					userId: USER_ID,
					organizationId: ORG_ID,
				},
				{
					id: `${NS}_ai_done`,
					transcriptId: "t_recent",
					orderIndex: 1,
					text: "Already completed item",
					completedAt: new Date(),
					userId: USER_ID,
					organizationId: ORG_ID,
				},
				{
					id: `${NS}_ai_open_older`,
					transcriptId: "t_older",
					orderIndex: 0,
					text: "Draft the migration plan",
					userId: USER_ID,
					organizationId: ORG_ID,
				},
				{
					id: `${NS}_ai_other_series`,
					transcriptId: "t_other",
					orderIndex: 0,
					text: "Item from an unrelated meeting",
					userId: USER_ID,
					organizationId: ORG_ID,
				},
			],
		});
	}, 60_000);

	afterAll(async () => {
		await cleanup();
		await db.$disconnect();
	});

	it("executes the nested carried-item query Prisma actually builds", async () => {
		// The assertion that matters most is simply that this resolves: a bad
		// nested select is a PrismaClientValidationError, not a wrong answer.
		const context = await collectAgendaContextActivity({
			projectId: PROJECT_ID,
			organizationId: ORG_ID,
			userId: USER_ID,
			linkedMeetingId: SERIES_ID,
			occurrenceStart: OCCURRENCE_START,
		});

		expect(context.hadPriorTranscripts).toBe(true);
	});

	it("returns only in-window occurrences of THIS series (FR1)", async () => {
		const context = await collectAgendaContextActivity({
			projectId: PROJECT_ID,
			organizationId: ORG_ID,
			userId: USER_ID,
			linkedMeetingId: SERIES_ID,
			occurrenceStart: OCCURRENCE_START,
		});

		// t_stale (outside window), t_undated (NULL date), t_future (after the
		// occurrence) and t_other (different series) are all excluded.
		expect(context.priorMeetings).toHaveLength(2);
		expect(
			context.priorMeetings.map((m) => m.meetingDate?.toISOString()),
		).toEqual([daysBefore(7).toISOString(), daysBefore(14).toISOString()]);
	});

	it("carries open action items forward, attributed and newest-first (FR2)", async () => {
		const context = await collectAgendaContextActivity({
			projectId: PROJECT_ID,
			organizationId: ORG_ID,
			userId: USER_ID,
			linkedMeetingId: SERIES_ID,
			occurrenceStart: OCCURRENCE_START,
		});

		expect(context.carriedActionItems.map((i) => i.text)).toEqual([
			"Chase the vendor contract",
			"Draft the migration plan",
		]);
		expect(context.carriedActionItems[0]).toMatchObject({
			tentativeOwnerName: "Dana",
			fromMeetingSubject: "Weekly Sync",
			fromMeetingDate: daysBefore(7),
		});
		// The completed item is filtered by the nested `where`, in SQL.
		expect(context.carriedActionItems.map((i) => i.text)).not.toContain(
			"Already completed item",
		);
	});

	it("does not list a carried item again as a new item (D4)", async () => {
		const context = await collectAgendaContextActivity({
			projectId: PROJECT_ID,
			organizationId: ORG_ID,
			userId: USER_ID,
			linkedMeetingId: SERIES_ID,
			occurrenceStart: OCCURRENCE_START,
		});

		const openTexts = context.openActionItems.map((i) => i.text);
		expect(openTexts).not.toContain("Chase the vendor contract");
		expect(openTexts).not.toContain("Draft the migration plan");
		// The unrelated meeting's item is genuinely new business for this agenda,
		// so it survives the subtraction — proving D4 subtracts rather than wipes.
		expect(openTexts).toContain("Item from an unrelated meeting");
	});

	it("falls back cleanly for a series with no in-window history (FR3)", async () => {
		const context = await collectAgendaContextActivity({
			projectId: PROJECT_ID,
			organizationId: ORG_ID,
			userId: USER_ID,
			linkedMeetingId: SERIES_ID,
			// Far enough forward that every fixture falls out of the window.
			occurrenceStart: new Date("2027-08-05T09:00:00Z"),
		});

		expect(context.hadPriorTranscripts).toBe(false);
		expect(context.priorMeetings).toEqual([]);
		expect(context.carriedActionItems).toEqual([]);
	});

	it("applies the per-transcript read bound in SQL, not in memory", async () => {
		// Prove `take` inside the nested select is honoured by Postgres: write
		// CARRIED_ITEM_CAP + 5 open items on one transcript and confirm the read
		// stops at the bound (cap + 1, the truncation-detection row).
		const overflowTranscript = `${NS}_t_overflow`;
		const overflowSeries = `${NS}_series_overflow`;
		await db.projectLinkedMeeting.create({
			data: {
				id: overflowSeries,
				projectId: PROJECT_ID,
				joinUrl: `https://teams.example.test/${NS}/overflow`,
				subject: "Busy Meeting",
				userId: USER_ID,
				organizationId: ORG_ID,
			},
		});
		await db.projectMeetingTranscript.create({
			data: {
				id: overflowTranscript,
				projectId: PROJECT_ID,
				linkedMeetingId: overflowSeries,
				meetingId: `graph_${overflowTranscript}`,
				transcriptId: `tr_${overflowTranscript}`,
				meetingSubject: "Busy Meeting",
				meetingDate: daysBefore(2),
				userId: USER_ID,
				organizationId: ORG_ID,
			},
		});
		await db.projectMeetingActionItem.createMany({
			data: Array.from({ length: CARRIED_ITEM_CAP + 5 }, (_, i) => ({
				id: `${NS}_ai_overflow_${i}`,
				transcriptId: overflowTranscript,
				orderIndex: i,
				text: `overflow ${i}`,
				userId: USER_ID,
				organizationId: ORG_ID,
			})),
		});

		const context = await collectAgendaContextActivity({
			projectId: PROJECT_ID,
			organizationId: ORG_ID,
			userId: USER_ID,
			linkedMeetingId: overflowSeries,
			occurrenceStart: OCCURRENCE_START,
		});

		expect(context.carriedActionItems).toHaveLength(CARRIED_ITEM_CAP);
		expect(context.truncated.carriedActionItems).toBe(true);
		// Ordered by orderIndex asc, so the retained window starts at 0.
		expect(context.carriedActionItems[0].text).toBe("overflow 0");
	});
});
