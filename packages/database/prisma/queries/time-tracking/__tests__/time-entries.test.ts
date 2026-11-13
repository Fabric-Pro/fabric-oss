/**
 * Which projects `listTimeAccessRows` reads, and the work-date conversion.
 *
 * Prisma's delegates are mocked, so this pins the WHERE each read is sent
 * with: only ACTIVE projects are offered for new time, while entries already
 * logged are checked against their projects whatever their status, so an
 * archived or completed project's entries stay readable. It also pins that
 * the author's name is saved with each write and that every author read and
 * write is keyed by the caller's id.
 *
 * Run with:
 *   pnpm --filter @repo/database test time-entries
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	member: { findFirst: vi.fn() },
	organization: { findUnique: vi.fn() },
	project: { findMany: vi.fn() },
	timeEntry: {
		findMany: vi.fn(),
		findFirst: vi.fn(),
		create: vi.fn(),
		update: vi.fn(),
		deleteMany: vi.fn(),
	},
}));

vi.mock("../../../client", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		db: {
			member: mocks.member,
			organization: mocks.organization,
			project: mocks.project,
			timeEntry: mocks.timeEntry,
		},
	};
});

const {
	createTimeEntry,
	deleteTimeEntry,
	findTimeEntryForAuthor,
	listAuthorLoggedTime,
	listAuthorTimeEntriesOnWorkDate,
	listTimeAccessRows,
	listTimeEntriesForAuthor,
	listTimeEntriesForAuthorStory,
	updateTimeEntry,
} = await import("../time-entries");

function savedRow() {
	return {
		id: "entry-1",
		organizationId: "org-1",
		projectId: "project-a",
		workDate: new Date("2026-11-10T00:00:00.000Z"),
		timezone: "UTC",
		durationMinutes: 60,
		startAt: null,
		stopAt: null,
		activity: "DEVELOPMENT",
		billable: true,
		description: null,
		storyId: null,
		storyIdentifier: null,
		storyTitle: null,
		startStopRequired: false,
		createdAt: new Date("2026-11-10T08:00:00Z"),
		updatedAt: new Date("2026-11-10T08:00:00Z"),
		project: { name: "Project A" },
	};
}

const values = {
	projectId: "project-a",
	workDate: "2026-11-10",
	timezone: "UTC",
	durationMinutes: 60,
	startAt: null,
	stopAt: null,
	activity: "DEVELOPMENT" as const,
	billable: true,
	description: null,
	storyId: null,
	storyIdentifier: null,
	storyTitle: null,
	startStopRequired: false,
	userNameSnapshot: "Ada Example",
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.member.findFirst.mockResolvedValue({ role: "member" });
	mocks.organization.findUnique.mockResolvedValue({
		timeRequireStartStop: false,
		timeDefaultBillable: null,
	});
	mocks.project.findMany.mockResolvedValue([]);
	mocks.timeEntry.findMany.mockResolvedValue([]);
});

describe("listTimeAccessRows", () => {
	it("offers only live ACTIVE projects for new time", async () => {
		await listTimeAccessRows({
			organizationId: "org-1",
			userId: "user-1",
			projects: "loggable",
		});

		expect(mocks.project.findMany.mock.calls[0][0].where).toEqual({
			organizationId: "org-1",
			deletedAt: null,
			status: "ACTIVE",
		});
	});

	it("reads named projects whatever their status", async () => {
		await listTimeAccessRows({
			organizationId: "org-1",
			userId: "user-1",
			projects: { ids: ["project-archived", "project-active"] },
		});

		expect(mocks.project.findMany.mock.calls[0][0].where).toEqual({
			organizationId: "org-1",
			deletedAt: null,
			id: { in: ["project-archived", "project-active"] },
		});
	});

	it("returns the caller's own membership row and ownership on each project", async () => {
		const acceptedAt = new Date("2026-01-01T00:00:00Z");
		mocks.project.findMany.mockResolvedValue([
			{
				id: "project-a",
				name: "Project A",
				userId: "user-2",
				billingModel: "FIXED_BID",
				timeRequireStartStop: false,
				timeDefaultBillable: null,
				members: [{ role: "EDITOR", acceptedAt, expiresAt: null }],
			},
			{
				id: "project-b",
				name: "Project B",
				userId: "user-1",
				billingModel: "TIME_AND_MATERIALS",
				timeRequireStartStop: true,
				timeDefaultBillable: false,
				members: [],
			},
		]);

		const rows = await listTimeAccessRows({
			organizationId: "org-1",
			userId: "user-1",
			projects: "loggable",
		});

		expect(rows.organizationRole).toBe("member");
		expect(rows.projects.map((project) => project.member)).toEqual([
			{ role: "EDITOR", acceptedAt, expiresAt: null },
			null,
		]);
		// Who created the project is reported as a flag, not as a user id.
		expect(rows.projects.map((project) => project.ownedByCaller)).toEqual([
			false,
			true,
		]);
		expect(rows.projects[0]).not.toHaveProperty("userId");
		expect(
			mocks.project.findMany.mock.calls[0][0].select.members.where,
		).toEqual({ userId: "user-1" });
	});
});

describe("work dates", () => {
	it("queries a work date as midnight UTC and reads it back unchanged", async () => {
		mocks.timeEntry.findMany.mockResolvedValue([
			{
				id: "entry-1",
				projectId: "project-a",
				workDate: new Date("2026-11-10T00:00:00.000Z"),
				durationMinutes: 60,
				startAt: null,
				stopAt: null,
				activity: "DEVELOPMENT",
				storyId: null,
				description: null,
			},
		]);

		const rows = await listAuthorTimeEntriesOnWorkDate({
			organizationId: "org-1",
			userId: "user-1",
			workDate: "2026-11-10",
		});

		expect(mocks.timeEntry.findMany.mock.calls[0][0].where).toEqual({
			organizationId: "org-1",
			userId: "user-1",
			workDate: new Date("2026-11-10T00:00:00.000Z"),
		});
		expect(rows[0].workDate).toBe("2026-11-10");
	});
});

describe("listAuthorTimeEntriesOnWorkDate with an overlapping span", () => {
	it("also reads timed entries that overlap the span on any work date", async () => {
		const startAt = new Date("2026-11-10T22:00:00.000Z");
		const stopAt = new Date("2026-11-11T02:00:00.000Z");

		await listAuthorTimeEntriesOnWorkDate({
			organizationId: "org-1",
			userId: "user-1",
			workDate: "2026-11-10",
			overlapping: { startAt, stopAt },
		});

		expect(mocks.timeEntry.findMany.mock.calls[0][0].where).toEqual({
			organizationId: "org-1",
			userId: "user-1",
			OR: [
				{ workDate: new Date("2026-11-10T00:00:00.000Z") },
				{ startAt: { lt: stopAt }, stopAt: { gt: startAt } },
			],
		});
	});
});

describe("listAuthorLoggedTime", () => {
	it("reads timed and duration-only entries over the window in one query", async () => {
		const from = new Date("2026-11-03T23:00:00.000Z");
		const to = new Date("2026-11-10T23:00:00.000Z");
		mocks.timeEntry.findMany.mockResolvedValue([
			{
				projectId: "project-a",
				workDate: new Date("2026-11-05T00:00:00.000Z"),
				storyId: "story-1",
				startAt: null,
				stopAt: null,
			},
			{
				projectId: "project-b",
				workDate: new Date("2026-11-06T00:00:00.000Z"),
				storyId: null,
				startAt: new Date("2026-11-06T09:00:00.000Z"),
				stopAt: new Date("2026-11-06T10:00:00.000Z"),
			},
			{
				projectId: "project-b",
				workDate: new Date("2026-11-03T00:00:00.000Z"),
				storyId: null,
				startAt: new Date("2026-11-03T22:00:00.000Z"),
				stopAt: new Date("2026-11-04T01:00:00.000Z"),
			},
		]);

		const logged = await listAuthorLoggedTime({
			organizationId: "org-1",
			userId: "user-1",
			from,
			to,
			fromDate: "2026-11-04",
			toDate: "2026-11-10",
		});

		expect(mocks.timeEntry.findMany).toHaveBeenCalledTimes(1);
		expect(mocks.timeEntry.findMany.mock.calls[0][0].where).toEqual({
			organizationId: "org-1",
			userId: "user-1",
			OR: [
				{ startAt: { lt: to }, stopAt: { gt: from } },
				{
					workDate: {
						gte: new Date("2026-11-04T00:00:00.000Z"),
						lte: new Date("2026-11-10T00:00:00.000Z"),
					},
				},
			],
		});
		expect(logged.intervals).toEqual([
			{
				startAt: new Date("2026-11-06T09:00:00.000Z"),
				endAt: new Date("2026-11-06T10:00:00.000Z"),
			},
			{
				startAt: new Date("2026-11-03T22:00:00.000Z"),
				endAt: new Date("2026-11-04T01:00:00.000Z"),
			},
		]);
		expect(logged.entries).toEqual([
			{
				projectId: "project-a",
				workDate: "2026-11-05",
				storyId: "story-1",
			},
			{ projectId: "project-b", workDate: "2026-11-06", storyId: null },
		]);
	});
});

describe("the author's name is saved with the entry", () => {
	it("writes it on create", async () => {
		mocks.timeEntry.create.mockResolvedValue(savedRow());

		await createTimeEntry({
			organizationId: "org-1",
			userId: "user-1",
			values,
		});

		expect(mocks.timeEntry.create.mock.calls[0][0].data).toMatchObject({
			userId: "user-1",
			userNameSnapshot: "Ada Example",
		});
	});

	it("refreshes it on update", async () => {
		mocks.timeEntry.update.mockResolvedValue(savedRow());

		await updateTimeEntry({
			id: "entry-1",
			userId: "user-1",
			values: { ...values, userNameSnapshot: "Ada Renamed" },
		});

		expect(mocks.timeEntry.update.mock.calls[0][0].data).toMatchObject({
			userNameSnapshot: "Ada Renamed",
		});
	});
});

describe("an entry whose author's account was deleted is nobody's own", () => {
	// Such an entry has a null userId. Every author read and write is keyed by
	// the caller's id, which a null never equals, so it never comes back here.
	it("is keyed by the caller's id in every author read and write", async () => {
		mocks.timeEntry.findFirst.mockResolvedValue(null);
		mocks.timeEntry.update.mockResolvedValue(savedRow());
		mocks.timeEntry.deleteMany.mockResolvedValue({ count: 0 });

		await listTimeEntriesForAuthor({
			organizationId: "org-1",
			userId: "user-1",
			from: "2026-11-09",
			to: "2026-11-15",
		});
		await listTimeEntriesForAuthorStory({
			organizationId: "org-1",
			projectId: "project-a",
			storyId: "story-1",
			userId: "user-1",
		});
		await findTimeEntryForAuthor({ id: "entry-1", userId: "user-1" });
		await updateTimeEntry({ id: "entry-1", userId: "user-1", values });
		await deleteTimeEntry({ id: "entry-1", userId: "user-1" });

		const wheres = [
			...mocks.timeEntry.findMany.mock.calls,
			...mocks.timeEntry.findFirst.mock.calls,
			...mocks.timeEntry.update.mock.calls,
			...mocks.timeEntry.deleteMany.mock.calls,
		].map((call) => call[0].where);
		expect(wheres).toHaveLength(5);
		for (const where of wheres) {
			expect(where.userId).toBe("user-1");
		}
	});

	it("does not return the author's id with an entry", async () => {
		mocks.timeEntry.findFirst.mockResolvedValue(savedRow());

		const entry = await findTimeEntryForAuthor({
			id: "entry-1",
			userId: "user-1",
		});

		expect(
			mocks.timeEntry.findFirst.mock.calls[0][0].select,
		).not.toHaveProperty("userId");
		expect(entry).not.toHaveProperty("userId");
	});
});
