/**
 * What the calendar time-evidence reads ask the database for.
 *
 * Prisma's delegates are mocked, so this pins the WHERE each read uses: only
 * active Teams series on the allowed projects of the organization; only ended
 * meetings the agent joined on its own, for the given series and window; and
 * the member's own meeting-agent sessions, claimed or not.
 *
 * Run with:
 *   pnpm --filter @repo/database test calendar-evidence
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	projectLinkedMeeting: { findMany: vi.fn() },
	parlumeMeetingSession: { findMany: vi.fn() },
}));

vi.mock("../../../client", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return { ...actual, db: mocks };
});

const {
	listActiveLinkedTeamsMeetings,
	listEndedAutoJoinSessions,
	listMemberManualMeetingSessions,
} = await import("../calendar-evidence");

const FROM = new Date("2026-11-02T00:00:00.000Z");
const TO = new Date("2026-11-09T00:00:00.000Z");

beforeEach(() => {
	vi.clearAllMocks();
	mocks.projectLinkedMeeting.findMany.mockResolvedValue([]);
	mocks.parlumeMeetingSession.findMany.mockResolvedValue([]);
});

describe("listActiveLinkedTeamsMeetings", () => {
	it("reads only active Teams series on the allowed projects of the organization", async () => {
		await listActiveLinkedTeamsMeetings({
			organizationId: "org-1",
			projectIds: ["project-a", "project-b"],
		});

		expect(mocks.projectLinkedMeeting.findMany).toHaveBeenCalledWith({
			where: {
				projectId: { in: ["project-a", "project-b"] },
				project: { organizationId: "org-1" },
				source: "TEAMS",
				deactivatedAt: null,
			},
			select: { id: true, projectId: true, joinUrl: true },
		});
	});

	it("reads nothing without an allowed project", async () => {
		await expect(
			listActiveLinkedTeamsMeetings({
				organizationId: "org-1",
				projectIds: [],
			}),
		).resolves.toEqual([]);
		expect(mocks.projectLinkedMeeting.findMany).not.toHaveBeenCalled();
	});
});

describe("listEndedAutoJoinSessions", () => {
	it("reads ended automatic joins of the series whose occurrence started in the window", async () => {
		await listEndedAutoJoinSessions({
			organizationId: "org-1",
			linkedMeetingIds: ["series-1"],
			from: FROM,
			to: TO,
		});

		const [call] = mocks.parlumeMeetingSession.findMany.mock.calls[0];
		expect(call.where).toEqual({
			organizationId: "org-1",
			trigger: "AUTO",
			linkedMeetingId: { in: ["series-1"] },
			occurrenceStart: { gte: FROM, lt: TO },
			joinedAt: { not: null },
			endedAt: { not: null },
		});
		// Whoever enabled automatic joining: the session is credited by calendar.
		expect(call.where).not.toHaveProperty("userId");
	});

	it("reads nothing without a series", async () => {
		await expect(
			listEndedAutoJoinSessions({
				organizationId: "org-1",
				linkedMeetingIds: [],
				from: FROM,
				to: TO,
			}),
		).resolves.toEqual([]);
		expect(mocks.parlumeMeetingSession.findMany).not.toHaveBeenCalled();
	});
});

describe("listMemberManualMeetingSessions", () => {
	it("reads the member's own meeting-agent sessions, ended or not", async () => {
		await listMemberManualMeetingSessions({
			organizationId: "org-1",
			userId: "user-1",
			projectIds: ["project-a"],
			from: FROM,
			to: TO,
		});

		expect(mocks.parlumeMeetingSession.findMany).toHaveBeenCalledWith({
			where: {
				organizationId: "org-1",
				userId: "user-1",
				projectId: { in: ["project-a"] },
				trigger: "MANUAL",
				joinedAt: { gte: FROM, lt: TO },
			},
			select: { id: true, projectId: true, joinedAt: true },
			orderBy: { joinedAt: "asc" },
		});
	});

	it("reads nothing without an allowed project", async () => {
		await expect(
			listMemberManualMeetingSessions({
				organizationId: "org-1",
				userId: "user-1",
				projectIds: [],
				from: FROM,
				to: TO,
			}),
		).resolves.toEqual([]);
		expect(mocks.parlumeMeetingSession.findMany).not.toHaveBeenCalled();
	});
});
