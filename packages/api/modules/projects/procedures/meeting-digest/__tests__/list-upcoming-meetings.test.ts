import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildUpcomingRows } from "../list-upcoming-meetings";

const NOW = new Date("2026-07-24T12:00:00Z");

describe("buildUpcomingRows", () => {
	it("keeps only future online meetings, sorted soonest first", () => {
		const rows = buildUpcomingRows({
			graphMeetings: [
				{
					id: "a",
					subject: "Later",
					start: "2026-07-26T10:00:00.0000000",
					joinUrl: "https://teams/x",
				},
				{
					id: "b",
					subject: "Past",
					start: "2026-07-23T10:00:00.0000000",
					joinUrl: "https://teams/y",
				},
				{
					id: "c",
					subject: "Sooner",
					start: "2026-07-25T09:00:00.0000000",
					joinUrl: "https://teams/z",
				},
				{
					id: "d",
					subject: "No join url",
					start: "2026-07-25T09:00:00.0000000",
				},
			],
			linkedMeetings: [],
			now: NOW,
		});

		expect(rows.map((r) => r.subject)).toEqual(["Sooner", "Later"]);
	});

	it("appends Z to an offset-less Graph timestamp so it is read as UTC", () => {
		const [row] = buildUpcomingRows({
			graphMeetings: [
				{
					id: "a",
					subject: "DSU",
					start: "2026-07-25T09:00:00.0000000",
					joinUrl: "https://teams/x",
				},
			],
			linkedMeetings: [],
			now: NOW,
		});

		expect(row.startTime).toBe("2026-07-25T09:00:00.000Z");
	});

	it("attaches linkedMeetingId by case-insensitive joinUrl, null when unlinked", () => {
		const rows = buildUpcomingRows({
			graphMeetings: [
				{
					id: "a",
					subject: "Linked",
					start: "2026-07-25T09:00:00.0000000",
					joinUrl: "  HTTPS://Teams/X  ",
				},
				{
					id: "b",
					subject: "Unlinked",
					start: "2026-07-25T10:00:00.0000000",
					joinUrl: "https://teams/q",
				},
			],
			linkedMeetings: [{ id: "lm_1", joinUrl: "https://teams/x" }],
			now: NOW,
		});

		expect(rows[0]).toMatchObject({
			subject: "Linked",
			linkedMeetingId: "lm_1",
		});
		expect(rows[1]).toMatchObject({
			subject: "Unlinked",
			linkedMeetingId: null,
		});
	});

	it("drops meetings whose start time is unparseable", () => {
		const rows = buildUpcomingRows({
			graphMeetings: [
				{
					id: "a",
					subject: "Broken",
					start: "not-a-date",
					joinUrl: "https://teams/x",
				},
			],
			linkedMeetings: [],
			now: NOW,
		});

		expect(rows).toEqual([]);
	});

	it("falls back to placeholder subject and organizer", () => {
		const [row] = buildUpcomingRows({
			graphMeetings: [
				{
					id: "a",
					start: "2026-07-25T09:00:00.0000000",
					joinUrl: "https://teams/x",
				},
			],
			linkedMeetings: [],
			now: NOW,
		});

		expect(row.subject).toBe("Untitled Meeting");
		expect(row.organizer).toBe("Unknown");
	});

	it("reports the agenda status of a linked occurrence", () => {
		const [row] = buildUpcomingRows({
			graphMeetings: [
				{
					id: "a",
					subject: "DSU",
					start: "2026-07-25T09:00:00.0000000",
					joinUrl: "https://teams/x",
				},
			],
			linkedMeetings: [{ id: "lm_1", joinUrl: "https://teams/x" }],
			agendas: [
				{
					linkedMeetingId: "lm_1",
					occurrenceStart: new Date("2026-07-25T09:00:00.000Z"),
					status: "READY",
				},
			],
			now: NOW,
		});

		expect(row.agendaStatus).toBe("READY");
	});

	it("matches an agenda rescheduled to a different time on the same UTC day", () => {
		// utcDayRange is why a meeting moved from 09:00 to 14:00 keeps its
		// agenda. The indicator has to resolve the same way or it disagrees
		// with the sheet it links to.
		const [row] = buildUpcomingRows({
			graphMeetings: [
				{
					id: "a",
					subject: "DSU",
					start: "2026-07-25T14:00:00.0000000",
					joinUrl: "https://teams/x",
				},
			],
			linkedMeetings: [{ id: "lm_1", joinUrl: "https://teams/x" }],
			agendas: [
				{
					linkedMeetingId: "lm_1",
					occurrenceStart: new Date("2026-07-25T09:00:00.000Z"),
					status: "GENERATING",
				},
			],
			now: NOW,
		});

		expect(row.agendaStatus).toBe("GENERATING");
	});

	it("does not match an agenda from a different UTC day", () => {
		const [row] = buildUpcomingRows({
			graphMeetings: [
				{
					id: "a",
					subject: "DSU",
					start: "2026-07-26T09:00:00.0000000",
					joinUrl: "https://teams/x",
				},
			],
			linkedMeetings: [{ id: "lm_1", joinUrl: "https://teams/x" }],
			agendas: [
				{
					linkedMeetingId: "lm_1",
					occurrenceStart: new Date("2026-07-25T09:00:00.000Z"),
					status: "READY",
				},
			],
			now: NOW,
		});

		expect(row.agendaStatus).toBeNull();
	});

	it("never leaks another meeting's agenda onto a row", () => {
		const [row] = buildUpcomingRows({
			graphMeetings: [
				{
					id: "a",
					subject: "DSU",
					start: "2026-07-25T09:00:00.0000000",
					joinUrl: "https://teams/x",
				},
			],
			linkedMeetings: [{ id: "lm_1", joinUrl: "https://teams/x" }],
			agendas: [
				{
					linkedMeetingId: "lm_OTHER",
					occurrenceStart: new Date("2026-07-25T09:00:00.000Z"),
					status: "READY",
				},
			],
			now: NOW,
		});

		expect(row.agendaStatus).toBeNull();
	});

	it("takes the first of two same-day agendas, matching getAgenda's newest-first ordering", () => {
		// The handler reads `orderBy: { createdAt: "desc" }`, so the first row
		// for a key is the newest — the one getAgenda would return.
		const [row] = buildUpcomingRows({
			graphMeetings: [
				{
					id: "a",
					subject: "DSU",
					start: "2026-07-25T09:00:00.0000000",
					joinUrl: "https://teams/x",
				},
			],
			linkedMeetings: [{ id: "lm_1", joinUrl: "https://teams/x" }],
			agendas: [
				{
					linkedMeetingId: "lm_1",
					occurrenceStart: new Date("2026-07-25T16:00:00.000Z"),
					status: "READY",
				},
				{
					linkedMeetingId: "lm_1",
					occurrenceStart: new Date("2026-07-25T09:00:00.000Z"),
					status: "FAILED",
				},
			],
			now: NOW,
		});

		expect(row.agendaStatus).toBe("READY");
	});

	it("reports null agenda status for an unlinked meeting", () => {
		const [row] = buildUpcomingRows({
			graphMeetings: [
				{
					id: "a",
					subject: "Private 1:1",
					start: "2026-07-25T09:00:00.0000000",
					joinUrl: "https://teams/q",
				},
			],
			linkedMeetings: [],
			agendas: [],
			now: NOW,
		});

		expect(row.linkedMeetingId).toBeNull();
		expect(row.agendaStatus).toBeNull();
	});

	it("reports null agenda status for a linked meeting with no agenda", () => {
		const [row] = buildUpcomingRows({
			graphMeetings: [
				{
					id: "a",
					subject: "DSU",
					start: "2026-07-25T09:00:00.0000000",
					joinUrl: "https://teams/x",
				},
			],
			linkedMeetings: [{ id: "lm_1", joinUrl: "https://teams/x" }],
			agendas: [],
			now: NOW,
		});

		expect(row.agendaStatus).toBeNull();
	});
});

// --- @repo/database + @repo/integrations/microsoft + orpc/procedures mocks,
// hoisted so the factories below can close over them (pattern mirrors
// meeting-digest/__tests__/agenda.test.ts) --------------------------------
const {
	mockDb,
	mockHasProjectAccess,
	mockIsFeatureEnabled,
	mockExecuteMicrosoftTeamsTool,
} = vi.hoisted(() => ({
	mockDb: {
		projectLinkedMeeting: { findMany: vi.fn() },
		projectMeetingAgenda: { findMany: vi.fn() },
	},
	mockHasProjectAccess: vi.fn(),
	mockIsFeatureEnabled: vi.fn(),
	mockExecuteMicrosoftTeamsTool: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: mockDb,
	hasProjectAccess: (...args: unknown[]) => mockHasProjectAccess(...args),
	isFeatureEnabled: (...args: unknown[]) => mockIsFeatureEnabled(...args),
}));

vi.mock("@repo/integrations/microsoft", () => ({
	executeMicrosoftTeamsTool: (...args: unknown[]) =>
		mockExecuteMicrosoftTeamsTool(...args),
}));

vi.mock("../../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: unknown) => ({ _handler: fn }),
	});
	return {
		tenantProtectedProcedure: chainable,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requireInputOrgPermission: () => (c: unknown) => c,
		requireProjectPermission: () => (c: unknown) => c,
		resolveOrganizationId: (organizationId: string | null | undefined) =>
			organizationId ?? undefined,
	};
});

type ListUpcomingResult = {
	meetings: { linkedMeetingId: string | null }[];
	error?: "not-connected";
};
type ListUpcomingHandler = (args: {
	input: Record<string, unknown>;
	context: { user: { id: string }; session: Record<string, unknown> };
}) => Promise<ListUpcomingResult>;

describe("listUpcomingMeetingsProcedure — behavioural", () => {
	beforeEach(async () => {
		vi.clearAllMocks();
		mockIsFeatureEnabled.mockResolvedValue(true);
		mockHasProjectAccess.mockResolvedValue(true);
		mockDb.projectMeetingAgenda.findMany.mockResolvedValue([]);
	});

	it("marks a linked-but-excluded series as linked, not as 'link to generate agenda' (#1901 final review, FIX 7)", async () => {
		// A series can be linked to the project but toggled OUT of the digest
		// (includedInDigest: false) — it must still resolve to its
		// linkedMeetingId here. Before the fix, the db read filtered on
		// includedInDigest: true, so this came back linkedMeetingId: null and
		// showed "Link to generate agenda" even though @@unique([projectId,
		// joinUrl]) means it can never be linked again.
		mockDb.projectLinkedMeeting.findMany.mockResolvedValue([
			{ id: "lm_1", joinUrl: "https://teams/x" },
		]);
		mockExecuteMicrosoftTeamsTool.mockResolvedValue({
			meetings: [
				{
					id: "g1",
					subject: "Sprint Sync",
					start: "2099-01-01T09:00:00.0000000",
					joinUrl: "https://teams/x",
					organizer: "Ann",
				},
			],
		});

		const { listUpcomingMeetingsProcedure } = await import(
			"../list-upcoming-meetings"
		);
		const listUpcoming = (
			listUpcomingMeetingsProcedure as unknown as {
				_handler: ListUpcomingHandler;
			}
		)._handler;

		const result = await listUpcoming({
			input: {
				projectId: "project-1",
				organizationId: "org-1",
				daysForward: 14,
			},
			context: { user: { id: "user-1" }, session: {} },
		});

		expect(result.meetings).toEqual([
			expect.objectContaining({ linkedMeetingId: "lm_1" }),
		]);
		// The read must not scope on includedInDigest — this list is
		// calendar-driven, not digest-driven.
		expect(mockDb.projectLinkedMeeting.findMany).toHaveBeenCalledWith(
			expect.objectContaining({ where: { projectId: "project-1" } }),
		);
	});

	it("reads agendas for the requested window, scoped to the project, newest first", async () => {
		mockDb.projectLinkedMeeting.findMany.mockResolvedValue([
			{ id: "lm_1", joinUrl: "https://teams/x" },
		]);
		mockDb.projectMeetingAgenda.findMany.mockResolvedValue([]);
		mockExecuteMicrosoftTeamsTool.mockResolvedValue({ meetings: [] });

		const { listUpcomingMeetingsProcedure } = await import(
			"../list-upcoming-meetings"
		);
		const listUpcoming = (
			listUpcomingMeetingsProcedure as unknown as {
				_handler: ListUpcomingHandler;
			}
		)._handler;

		await listUpcoming({
			input: {
				projectId: "project-1",
				organizationId: "org-1",
				startOffsetDays: 0,
				daysForward: 2,
			},
			context: { user: { id: "user-1" }, session: {} },
		});

		const call = mockDb.projectMeetingAgenda.findMany.mock.calls[0][0];
		expect(call.where.projectId).toBe("project-1");
		expect(call.orderBy).toEqual({ createdAt: "desc" });
		expect(call.where.occurrenceStart.gte).toBeInstanceOf(Date);
		expect(call.where.occurrenceStart.lt).toBeInstanceOf(Date);
		// Whole UTC days, so an occurrence anywhere in the boundary day matches.
		expect(call.where.occurrenceStart.gte.toISOString()).toMatch(
			/T00:00:00\.000Z$/,
		);
	});

	it("offsets the Graph window start by startOffsetDays", async () => {
		mockDb.projectLinkedMeeting.findMany.mockResolvedValue([]);
		mockDb.projectMeetingAgenda.findMany.mockResolvedValue([]);
		mockExecuteMicrosoftTeamsTool.mockResolvedValue({ meetings: [] });

		const { listUpcomingMeetingsProcedure } = await import(
			"../list-upcoming-meetings"
		);
		const listUpcoming = (
			listUpcomingMeetingsProcedure as unknown as {
				_handler: ListUpcomingHandler;
			}
		)._handler;

		await listUpcoming({
			input: {
				projectId: "project-1",
				organizationId: "org-1",
				startOffsetDays: 2,
				daysForward: 14,
			},
			context: { user: { id: "user-1" }, session: {} },
		});

		const [, args] = mockExecuteMicrosoftTeamsTool.mock.calls[0];
		const spanDays =
			(Date.parse(args.endDate) - Date.parse(args.startDate)) /
			86_400_000;
		expect(spanDays).toBeCloseTo(12, 5);
	});

	it("rejects a window whose offset is not below daysForward", async () => {
		mockDb.projectLinkedMeeting.findMany.mockResolvedValue([]);
		mockDb.projectMeetingAgenda.findMany.mockResolvedValue([]);

		const { listUpcomingMeetingsProcedure } = await import(
			"../list-upcoming-meetings"
		);
		const listUpcoming = (
			listUpcomingMeetingsProcedure as unknown as {
				_handler: ListUpcomingHandler;
			}
		)._handler;

		await expect(
			listUpcoming({
				input: {
					projectId: "project-1",
					organizationId: "org-1",
					startOffsetDays: 14,
					daysForward: 14,
				},
				context: { user: { id: "user-1" }, session: {} },
			}),
		).rejects.toThrow(/startOffsetDays/);
	});
});

describe("listUpcomingMeetingsProcedure wiring", () => {
	const source = readFileSync(
		join(__dirname, "..", "list-upcoming-meetings.ts"),
		"utf8",
	);

	it("stacks both org gates", () => {
		// requireProjectPermission resolves on (projectId, userId) and never reads
		// the org; hasProjectAccess ignores its third argument. Without the input
		// gate a caller can pair a project they reach with an org they do not.
		expect(source).toContain(
			"requireInputOrgPermission(Permissions.PROJECT_READ)",
		);
		expect(source).toContain(
			"requireProjectPermission(Permissions.PROJECT_READ)",
		);
	});

	it("is gated on the MEETING_AGENDA flag", () => {
		expect(source).toContain('isFeatureEnabled("MEETING_AGENDA")');
	});

	it("is registered in the projects router", () => {
		const router = readFileSync(
			join(__dirname, "..", "..", "..", "router.ts"),
			"utf8",
		);
		expect(router).toContain("listUpcoming: listUpcomingMeetingsProcedure");
	});
});
