import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
	projectMeetingTranscript: { findMany: vi.fn() },
	projectMeetingActionItem: { findMany: vi.fn() },
	decisionLogEntry: { findMany: vi.fn() },
	userStory: { findMany: vi.fn() },
}));

vi.mock("@repo/database", () => ({
	db: dbMock,
	tenantWhere: (userId: string, organizationId?: string | null) =>
		organizationId ? { organizationId } : { userId, organizationId: null },
}));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@temporalio/activity", () => ({ heartbeat: vi.fn() }));

import {
	ACTION_ITEM_CAP,
	CARRIED_ITEM_CAP,
	collectAgendaContextActivity,
	PRIOR_MEETING_CAP,
	PRIOR_MEETING_WINDOW_DAYS,
} from "../collect-agenda-context";

const OCCURRENCE_START = new Date("2026-08-05T09:00:00Z");

const TENANT = {
	projectId: "p1",
	organizationId: "org1",
	userId: "u1",
	linkedMeetingId: "lm_1",
	occurrenceStart: OCCURRENCE_START,
};

beforeEach(() => {
	vi.clearAllMocks();
	dbMock.projectMeetingTranscript.findMany.mockResolvedValue([]);
	dbMock.projectMeetingActionItem.findMany.mockResolvedValue([]);
	dbMock.decisionLogEntry.findMany.mockResolvedValue([]);
	dbMock.userStory.findMany.mockResolvedValue([]);
});

describe("collectAgendaContextActivity", () => {
	it("reports hadPriorTranscripts=false when the series has no history (FR5)", async () => {
		const result = await collectAgendaContextActivity(TENANT);
		expect(result.hadPriorTranscripts).toBe(false);
		expect(result.priorMeetings).toEqual([]);
	});

	it("reports hadPriorTranscripts=true and maps insight JSON", async () => {
		dbMock.projectMeetingTranscript.findMany.mockResolvedValue([
			{
				meetingSubject: "DSU",
				meetingDate: new Date("2026-07-22T09:00:00Z"),
				summary: "Discussed rollout.",
				extractedDecisions: [{ text: "Ship behind a flag" }],
				extractedQuestions: [{ text: "Who owns the migration?" }],
			},
		]);

		const result = await collectAgendaContextActivity(TENANT);

		expect(result.hadPriorTranscripts).toBe(true);
		expect(result.priorMeetings[0]).toMatchObject({
			summary: "Discussed rollout.",
			decisions: ["Ship behind a flag"],
			openQuestions: ["Who owns the migration?"],
		});
	});

	it("survives malformed insight JSON without throwing", async () => {
		dbMock.projectMeetingTranscript.findMany.mockResolvedValue([
			{
				meetingSubject: "DSU",
				meetingDate: null,
				summary: null,
				extractedDecisions: "not-an-array",
				extractedQuestions: [{ noTextField: true }, { text: "kept" }],
			},
		]);

		const result = await collectAgendaContextActivity(TENANT);

		expect(result.priorMeetings[0].decisions).toEqual([]);
		expect(result.priorMeetings[0].openQuestions).toEqual(["kept"]);
	});

	it("flags truncation when a cap bites instead of silently trimming", async () => {
		dbMock.projectMeetingActionItem.findMany.mockResolvedValue(
			Array.from({ length: ACTION_ITEM_CAP + 1 }, (_, i) => ({
				text: `item ${i}`,
				tentativeOwnerName: null,
				dueHint: null,
			})),
		);

		const result = await collectAgendaContextActivity(TENANT);

		expect(result.openActionItems).toHaveLength(ACTION_ITEM_CAP);
		expect(result.truncated.actionItems).toBe(true);
	});

	it("scopes every read to the tenant and the project", async () => {
		await collectAgendaContextActivity(TENANT);

		const transcriptWhere =
			dbMock.projectMeetingTranscript.findMany.mock.calls[0][0].where;
		expect(transcriptWhere).toMatchObject({
			projectId: "p1",
			linkedMeetingId: "lm_1",
			project: { organizationId: "org1" },
		});

		// UserStory carries no userId/organizationId columns of its own (verified
		// against schema.prisma) — tenancy is only reachable via the `project`
		// relation, so the scoping fragment nests under it.
		const storyWhere = dbMock.userStory.findMany.mock.calls[0][0].where;
		expect(storyWhere).toMatchObject({
			projectId: "p1",
			blocked: true,
			project: { organizationId: "org1" },
		});
		expect(dbMock.userStory.findMany.mock.calls[0][0].orderBy).toEqual([
			{ lastEditedAt: { sort: "desc", nulls: "last" } },
			{ createdAt: "desc" },
		]);
	});

	it("scopes personal-tenancy reads by userId AND null organizationId", async () => {
		await collectAgendaContextActivity({ ...TENANT, organizationId: null });

		// ProjectMeetingTranscript, ProjectMeetingActionItem, and UserStory carry
		// no userId/organizationId columns of their own — tenancy is only
		// reachable via the `project` relation, so the scoping fragment nests
		// under it for all three.
		const transcriptWhere =
			dbMock.projectMeetingTranscript.findMany.mock.calls[0][0].where;
		expect(transcriptWhere).toMatchObject({
			project: { userId: "u1", organizationId: null },
		});

		const actionItemWhere =
			dbMock.projectMeetingActionItem.findMany.mock.calls[0][0].where;
		expect(actionItemWhere).toMatchObject({
			transcript: { project: { userId: "u1", organizationId: null } },
		});

		const storyWhere = dbMock.userStory.findMany.mock.calls[0][0].where;
		expect(storyWhere).toMatchObject({
			project: { userId: "u1", organizationId: null },
		});

		// DecisionLogEntry genuinely owns userId/organizationId columns, so the
		// tenant fragment is spread directly onto its where clause instead of
		// nesting under a relation.
		const decisionWhere =
			dbMock.decisionLogEntry.findMany.mock.calls[0][0].where;
		expect(decisionWhere).toMatchObject({
			userId: "u1",
			organizationId: null,
		});
	});

	it("only reads OPEN root decisions that are not soft-deleted", async () => {
		await collectAgendaContextActivity(TENANT);

		const where = dbMock.decisionLogEntry.findMany.mock.calls[0][0].where;
		expect(where).toMatchObject({
			status: "OPEN",
			parentId: null,
			deletedAt: null,
			story: { projectId: "p1" },
		});
	});
});

/**
 * Cross-meeting context aggregation (#2105).
 */
describe("collectAgendaContextActivity — recurring-series aggregation (#2105)", () => {
	const priorTranscript = (
		overrides: Partial<{
			id: string;
			meetingSubject: string | null;
			meetingDate: Date | null;
			actionItems: Array<{
				id: string;
				text: string;
				tentativeOwnerName: string | null;
				dueHint: string | null;
			}>;
		}> = {},
	) => ({
		id: "t1",
		meetingSubject: "DSU",
		meetingDate: new Date("2026-07-29T09:00:00Z"),
		summary: "Discussed rollout.",
		extractedDecisions: [],
		extractedQuestions: [],
		actionItems: [],
		...overrides,
	});

	it("bounds prior occurrences by BOTH the count cap and the lookback window (FR1)", async () => {
		await collectAgendaContextActivity(TENANT);

		const call = dbMock.projectMeetingTranscript.findMany.mock.calls[0][0];
		expect(call.take).toBe(PRIOR_MEETING_CAP);

		// Half-open window: [occurrenceStart - N days, occurrenceStart).
		const expectedFloor = new Date(
			OCCURRENCE_START.getTime() -
				PRIOR_MEETING_WINDOW_DAYS * 24 * 60 * 60 * 1000,
		);
		expect(call.where.meetingDate).toEqual({
			gte: expectedFloor,
			lt: OCCURRENCE_START,
		});
	});

	it("excludes the occurrence's own transcript from its own history (G3)", async () => {
		// The upper bound is exclusive, so a transcript synced for THIS occurrence
		// can never be fed back to it as prior context during the post-start grace
		// window that generateAgenda allows.
		await collectAgendaContextActivity(TENANT);

		const { meetingDate } =
			dbMock.projectMeetingTranscript.findMany.mock.calls[0][0].where;
		expect(meetingDate.lt).toEqual(OCCURRENCE_START);
	});

	it("collects open action items from prior occurrences as old business (FR2)", async () => {
		dbMock.projectMeetingTranscript.findMany.mockResolvedValue([
			priorTranscript({
				id: "t_recent",
				meetingSubject: "Weekly Sync",
				meetingDate: new Date("2026-07-29T09:00:00Z"),
				actionItems: [
					{
						id: "ai_1",
						text: "Chase the vendor contract",
						tentativeOwnerName: "Dana",
						dueHint: "next week",
					},
				],
			}),
			priorTranscript({
				id: "t_older",
				meetingSubject: "Weekly Sync",
				meetingDate: new Date("2026-07-22T09:00:00Z"),
				actionItems: [
					{
						id: "ai_2",
						text: "Draft the migration plan",
						tentativeOwnerName: null,
						dueHint: null,
					},
				],
			}),
		]);

		const result = await collectAgendaContextActivity(TENANT);

		// Newest meeting first, attributed to the meeting that raised it.
		expect(result.carriedActionItems).toEqual([
			{
				text: "Chase the vendor contract",
				tentativeOwnerName: "Dana",
				dueHint: "next week",
				fromMeetingSubject: "Weekly Sync",
				fromMeetingDate: new Date("2026-07-29T09:00:00Z"),
			},
			{
				text: "Draft the migration plan",
				tentativeOwnerName: null,
				dueHint: null,
				fromMeetingSubject: "Weekly Sync",
				fromMeetingDate: new Date("2026-07-22T09:00:00Z"),
			},
		]);
	});

	it("reads only INCOMPLETE action items from prior occurrences", async () => {
		await collectAgendaContextActivity(TENANT);

		const select =
			dbMock.projectMeetingTranscript.findMany.mock.calls[0][0].select;
		expect(select.actionItems.where).toEqual({ completedAt: null });
		// The read itself is bounded, not merely the flattened result — one
		// pathological meeting must not pull thousands of rows into memory.
		expect(select.actionItems.take).toBe(CARRIED_ITEM_CAP + 1);
	});

	it("excludes carried items in the QUERY, not after the read (D4)", async () => {
		// Excluding up front is what keeps the read budget spent on genuinely new
		// work. Filtering afterwards fetched rows only to discard them: on staging,
		// 27 of the 51 fetched were carried, so the "new items" pool arrived at 24
		// instead of 50 — and shrank fastest exactly when the series was busiest.
		dbMock.projectMeetingTranscript.findMany.mockResolvedValue([
			priorTranscript({
				actionItems: [
					{
						id: "ai_dup",
						text: "Chase the vendor contract",
						tentativeOwnerName: null,
						dueHint: null,
					},
				],
			}),
		]);
		dbMock.projectMeetingActionItem.findMany.mockResolvedValue([
			{
				id: "ai_other",
				text: "Book the venue",
				tentativeOwnerName: null,
				dueHint: null,
			},
		]);

		const result = await collectAgendaContextActivity(TENANT);

		const where =
			dbMock.projectMeetingActionItem.findMany.mock.calls[0][0].where;
		expect(where.id).toEqual({ notIn: ["ai_dup"] });
		expect(result.carriedActionItems).toHaveLength(1);
		expect(result.openActionItems.map((i) => i.text)).toEqual([
			"Book the venue",
		]);
	});

	it("adds no id filter when nothing carried over", async () => {
		// Prisma treats `notIn: []` as a real, always-true filter rather than a
		// no-op, so the narrowing has to be omitted entirely.
		await collectAgendaContextActivity(TENANT);

		const where =
			dbMock.projectMeetingActionItem.findMany.mock.calls[0][0].where;
		expect(where.id).toBeUndefined();
	});

	it("caps carried items across the whole series and flags the truncation", async () => {
		dbMock.projectMeetingTranscript.findMany.mockResolvedValue([
			priorTranscript({
				actionItems: Array.from(
					{ length: CARRIED_ITEM_CAP + 1 },
					(_, i) => ({
						id: `ai_${i}`,
						text: `carried ${i}`,
						tentativeOwnerName: null,
						dueHint: null,
					}),
				),
			}),
		]);

		const result = await collectAgendaContextActivity(TENANT);

		expect(result.carriedActionItems).toHaveLength(CARRIED_ITEM_CAP);
		expect(result.truncated.carriedActionItems).toBe(true);
	});

	it("excludes the UNCAPPED carried set, so overflow cannot resurface as new (FR2)", async () => {
		// An item the cap pushed out of "old business" is still old business. If
		// only the surviving 20 were excluded from the query, the rest would come
		// straight back through the project-wide scan and be presented as NEW
		// items — the precise mislabelling FR2 exists to prevent, and silent.
		const overflow = Array.from(
			{ length: CARRIED_ITEM_CAP + 2 },
			(_, i) => ({
				id: `ai_${i}`,
				text: `carried ${i}`,
				tentativeOwnerName: null,
				dueHint: null,
			}),
		);
		dbMock.projectMeetingTranscript.findMany.mockResolvedValue([
			priorTranscript({ actionItems: overflow }),
		]);

		const result = await collectAgendaContextActivity(TENANT);

		expect(result.carriedActionItems).toHaveLength(CARRIED_ITEM_CAP);
		expect(result.truncated.carriedActionItems).toBe(true);

		// All CARRIED_ITEM_CAP + 2 are excluded, not just the ones that survived.
		const where =
			dbMock.projectMeetingActionItem.findMany.mock.calls[0][0].where;
		expect(where.id.notIn).toHaveLength(CARRIED_ITEM_CAP + 2);
		expect(where.id.notIn).toContain(`ai_${CARRIED_ITEM_CAP + 1}`);
	});

	it("reports action-item truncation honestly (#2105 QA, F1)", async () => {
		// Regression guard for F1. The bug was measuring the cap against a list
		// that an in-memory dedup had already shrunk, so a read that genuinely hit
		// its cap reported `false` — silently suppressing the "more open work than
		// fits" notice. Excluding carried rows in the query removed the shrinking
		// step, so applyCap once again sees exactly what the query returned.
		dbMock.projectMeetingActionItem.findMany.mockResolvedValue(
			Array.from({ length: ACTION_ITEM_CAP + 1 }, (_, i) => ({
				id: `ai_other_${i}`,
				text: `other ${i}`,
				tentativeOwnerName: null,
				dueHint: null,
			})),
		);

		const result = await collectAgendaContextActivity(TENANT);

		expect(result.openActionItems).toHaveLength(ACTION_ITEM_CAP);
		expect(result.truncated.actionItems).toBe(true);
	});

	it("falls back cleanly when the series has no in-window history (FR3)", async () => {
		const result = await collectAgendaContextActivity(TENANT);

		expect(result.hadPriorTranscripts).toBe(false);
		expect(result.priorMeetings).toEqual([]);
		expect(result.carriedActionItems).toEqual([]);
		expect(result.truncated.carriedActionItems).toBe(false);
	});
});
