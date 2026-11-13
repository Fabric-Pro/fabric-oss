/**
 * The timer writes that must hold under retries and races: starting one per
 * member, the version compare-and-set behind every change, stopping exactly
 * once, the preference a start changes, and the activity a stop proposal is
 * read from.
 *
 * Prisma's delegates are mocked and `$transaction` runs its callback on the
 * same mocks, so this pins the conditional writes each function relies on
 * and what happens when one of them matches nothing.
 *
 * Run with:
 *   pnpm --filter @repo/database test time-timer
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const delegates = {
		timeTimer: {
			create: vi.fn(),
			findUnique: vi.fn(),
			findUniqueOrThrow: vi.fn(),
			updateMany: vi.fn(),
			deleteMany: vi.fn(),
		},
		timeTimerSegment: {
			findFirst: vi.fn(),
			update: vi.fn(),
			create: vi.fn(),
		},
		timeTimerStop: {
			create: vi.fn(),
			deleteMany: vi.fn(),
			findFirst: vi.fn(),
		},
		timeTrackingPreference: {
			updateMany: vi.fn(),
			findUnique: vi.fn(),
			upsert: vi.fn(),
		},
		timeEntry: { create: vi.fn(), findMany: vi.fn() },
		auditLog: { findFirst: vi.fn() },
	};
	return {
		...delegates,
		$transaction: vi.fn((fn: (tx: typeof delegates) => unknown) =>
			fn(delegates),
		),
	};
});

vi.mock("../../../client", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return { ...actual, db: mocks };
});

const {
	findOwnActivity,
	getTimeTrackingPreference,
	pauseTimeTimer,
	resumeTimeTimer,
	setTimeTrackingPreference,
	startTimeTimer,
	updateTimeTimer,
} = await import("../time-timer");
const { findTimeTimerStop, stopTimeTimer } = await import("../time-entries");

const NOW = new Date("2026-11-10T12:00:00.000Z");
const owner = { organizationId: "org-1", userId: "user-1" };

function timerRow(overrides: Record<string, unknown> = {}) {
	return {
		id: "timer-1",
		organizationId: "org-1",
		projectId: "project-a",
		activity: "DEVELOPMENT",
		storyId: null,
		storyIdentifier: null,
		storyTitle: null,
		description: null,
		billable: null,
		timezone: "UTC",
		status: "RUNNING",
		version: 1,
		createdAt: NOW,
		updatedAt: NOW,
		project: { name: "Project A" },
		segments: [{ startAt: new Date("2026-11-10T09:00:00Z"), stopAt: null }],
		...overrides,
	};
}

const timerValues = {
	projectId: "project-a",
	activity: "DEVELOPMENT" as const,
	storyId: null,
	storyIdentifier: null,
	storyTitle: null,
	description: null,
	billable: null,
};

const entryValues = {
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

function entryRow(id: string) {
	return {
		id,
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
		createdAt: NOW,
		updatedAt: NOW,
		project: { name: "Project A" },
	};
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("startTimeTimer", () => {
	it("creates the timer with its first segment open and shows a widget closed until the next start", async () => {
		mocks.timeTimer.create.mockResolvedValue(timerRow());
		mocks.timeTrackingPreference.updateMany.mockResolvedValue({ count: 1 });

		const result = await startTimeTimer({
			...owner,
			timezone: "UTC",
			values: timerValues,
			startAt: NOW,
		});

		expect(result.status).toBe("started");
		expect(result.timer.projectName).toBe("Project A");
		expect(mocks.timeTimer.create.mock.calls[0][0].data).toMatchObject({
			organizationId: "org-1",
			userId: "user-1",
			segments: {
				create: {
					organizationId: "org-1",
					userId: "user-1",
					startAt: NOW,
				},
			},
		});
		// Only HIDDEN_UNTIL_START flips: OFF is never matched, so it stays off.
		expect(mocks.timeTrackingPreference.updateMany).toHaveBeenCalledWith({
			where: {
				organizationId: "org-1",
				userId: "user-1",
				timerWidget: "HIDDEN_UNTIL_START",
			},
			data: { timerWidget: "SHOWN" },
		});
	});

	it("answers exists with the member's timer when the unique index refuses a second", async () => {
		mocks.timeTimer.create.mockRejectedValue(
			Object.assign(new Error("Unique constraint failed"), {
				code: "P2002",
			}),
		);
		mocks.timeTimer.findUnique.mockResolvedValue(
			timerRow({ id: "timer-0", status: "PAUSED" }),
		);

		const result = await startTimeTimer({
			...owner,
			timezone: "UTC",
			values: timerValues,
			startAt: NOW,
		});

		expect(result).toMatchObject({
			status: "exists",
			timer: { id: "timer-0", status: "PAUSED" },
		});
		expect(mocks.timeTimer.findUnique).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					organizationId_userId: {
						organizationId: "org-1",
						userId: "user-1",
					},
				},
			}),
		);
	});

	it("rethrows any other error", async () => {
		mocks.timeTimer.create.mockRejectedValue(new Error("connection lost"));

		await expect(
			startTimeTimer({
				...owner,
				timezone: "UTC",
				values: timerValues,
				startAt: NOW,
			}),
		).rejects.toThrow("connection lost");
	});
});

describe("pauseTimeTimer and resumeTimeTimer", () => {
	const key = { timerId: "timer-1", ...owner, version: 3, at: NOW };

	it("pauses only a RUNNING timer at the given version, raising the version and closing the open segment", async () => {
		mocks.timeTimer.updateMany.mockResolvedValue({ count: 1 });
		mocks.timeTimerSegment.findFirst.mockResolvedValue({
			id: "segment-1",
			startAt: new Date("2026-11-10T09:00:00Z"),
		});
		mocks.timeTimer.findUniqueOrThrow.mockResolvedValue(
			timerRow({ status: "PAUSED", version: 4 }),
		);

		const timer = await pauseTimeTimer(key);

		expect(timer?.version).toBe(4);
		expect(mocks.timeTimer.updateMany).toHaveBeenCalledWith({
			where: {
				id: "timer-1",
				organizationId: "org-1",
				userId: "user-1",
				version: 3,
				status: "RUNNING",
			},
			data: { status: "PAUSED", version: { increment: 1 } },
		});
		expect(mocks.timeTimerSegment.update).toHaveBeenCalledWith({
			where: { id: "segment-1" },
			data: { stopAt: NOW },
		});
	});

	it("never closes a segment before it opened", async () => {
		const openedLater = new Date(NOW.getTime() + 500);
		mocks.timeTimer.updateMany.mockResolvedValue({ count: 1 });
		mocks.timeTimerSegment.findFirst.mockResolvedValue({
			id: "segment-1",
			startAt: openedLater,
		});
		mocks.timeTimer.findUniqueOrThrow.mockResolvedValue(
			timerRow({ status: "PAUSED" }),
		);

		await pauseTimeTimer(key);

		expect(mocks.timeTimerSegment.update).toHaveBeenCalledWith({
			where: { id: "segment-1" },
			data: { stopAt: openedLater },
		});
	});

	it("changes nothing when the version or state does not match", async () => {
		mocks.timeTimer.updateMany.mockResolvedValue({ count: 0 });

		expect(await pauseTimeTimer(key)).toBeNull();
		expect(await resumeTimeTimer(key)).toBeNull();
		expect(mocks.timeTimerSegment.update).not.toHaveBeenCalled();
		expect(mocks.timeTimerSegment.create).not.toHaveBeenCalled();
	});

	it("resumes only a PAUSED timer, opening a new segment", async () => {
		mocks.timeTimer.updateMany.mockResolvedValue({ count: 1 });
		mocks.timeTimer.findUniqueOrThrow.mockResolvedValue(timerRow());

		await resumeTimeTimer(key);

		expect(mocks.timeTimer.updateMany.mock.calls[0][0]).toMatchObject({
			where: { version: 3, status: "PAUSED" },
			data: { status: "RUNNING", version: { increment: 1 } },
		});
		expect(mocks.timeTimerSegment.create).toHaveBeenCalledWith({
			data: {
				timerId: "timer-1",
				organizationId: "org-1",
				userId: "user-1",
				startAt: NOW,
			},
		});
	});
});

describe("updateTimeTimer", () => {
	it("writes the values only at the given version", async () => {
		mocks.timeTimer.updateMany.mockResolvedValue({ count: 0 });

		const timer = await updateTimeTimer({
			timerId: "timer-1",
			...owner,
			version: 2,
			values: timerValues,
		});

		expect(timer).toBeNull();
		expect(mocks.timeTimer.updateMany).toHaveBeenCalledWith({
			where: {
				id: "timer-1",
				organizationId: "org-1",
				userId: "user-1",
				version: 2,
			},
			data: { ...timerValues, version: { increment: 1 } },
		});
	});
});

describe("stopTimeTimer", () => {
	const key = { timerId: "timer-1", ...owner, version: 5, now: NOW };

	it("deletes the timer at its version, creates the entries and records them under the timer id", async () => {
		mocks.timeTimer.deleteMany.mockResolvedValue({ count: 1 });
		mocks.timeEntry.create
			.mockResolvedValueOnce(entryRow("entry-1"))
			.mockResolvedValueOnce(entryRow("entry-2"));

		const entries = await stopTimeTimer({
			...key,
			entries: [entryValues, entryValues],
		});

		expect(entries?.map((entry) => entry.id)).toEqual([
			"entry-1",
			"entry-2",
		]);
		expect(mocks.timeTimer.deleteMany).toHaveBeenCalledWith({
			where: {
				id: "timer-1",
				organizationId: "org-1",
				userId: "user-1",
				version: 5,
			},
		});
		expect(mocks.timeEntry.create.mock.calls[0][0].data).toMatchObject({
			organizationId: "org-1",
			userId: "user-1",
			userNameSnapshot: "Ada Example",
			workDate: new Date("2026-11-10T00:00:00.000Z"),
		});
		expect(mocks.timeTimerStop.create).toHaveBeenCalledWith({
			data: {
				timerId: "timer-1",
				organizationId: "org-1",
				userId: "user-1",
				version: 5,
				outcome: "SAVED",
				entryIds: ["entry-1", "entry-2"],
			},
		});
		expect(mocks.timeTimerStop.deleteMany).toHaveBeenCalledWith({
			where: {
				userId: "user-1",
				createdAt: { lt: new Date("2026-11-09T12:00:00.000Z") },
			},
		});
	});

	it("records a stop with no entries as discarded", async () => {
		mocks.timeTimer.deleteMany.mockResolvedValue({ count: 1 });

		const entries = await stopTimeTimer({ ...key, entries: [] });

		expect(entries).toEqual([]);
		expect(mocks.timeEntry.create).not.toHaveBeenCalled();
		expect(mocks.timeTimerStop.create.mock.calls[0][0].data).toMatchObject({
			outcome: "DISCARDED",
			entryIds: [],
		});
	});

	it("saves nothing when the timer is no longer at that version: the concurrent twin already stopped it", async () => {
		mocks.timeTimer.deleteMany.mockResolvedValue({ count: 0 });

		const entries = await stopTimeTimer({
			...key,
			entries: [entryValues],
		});

		expect(entries).toBeNull();
		expect(mocks.timeEntry.create).not.toHaveBeenCalled();
		expect(mocks.timeTimerStop.create).not.toHaveBeenCalled();
	});
});

describe("findTimeTimerStop", () => {
	it("returns the outcome with the member's entries that still exist", async () => {
		mocks.timeTimerStop.findFirst.mockResolvedValue({
			version: 5,
			outcome: "SAVED",
			entryIds: ["entry-1", "entry-2"],
		});
		mocks.timeEntry.findMany.mockResolvedValue([entryRow("entry-1")]);

		const stop = await findTimeTimerStop({
			timerId: "timer-1",
			userId: "user-1",
		});

		expect(stop?.outcome).toBe("SAVED");
		expect(stop?.entries.map((entry) => entry.id)).toEqual(["entry-1"]);
		expect(mocks.timeTimerStop.findFirst.mock.calls[0][0].where).toEqual({
			timerId: "timer-1",
			userId: "user-1",
		});
		expect(mocks.timeEntry.findMany.mock.calls[0][0].where).toEqual({
			id: { in: ["entry-1", "entry-2"] },
			userId: "user-1",
		});
	});

	it("reads no entries for a discarded timer", async () => {
		mocks.timeTimerStop.findFirst.mockResolvedValue({
			version: 2,
			outcome: "DISCARDED",
			entryIds: [],
		});

		const stop = await findTimeTimerStop({
			timerId: "timer-1",
			userId: "user-1",
		});

		expect(stop).toEqual({ version: 2, outcome: "DISCARDED", entries: [] });
		expect(mocks.timeEntry.findMany).not.toHaveBeenCalled();
	});
});

describe("time-tracking preferences", () => {
	it("answers the defaults when the member has no row", async () => {
		mocks.timeTrackingPreference.findUnique.mockResolvedValue(null);

		expect(await getTimeTrackingPreference(owner)).toEqual({
			timerWidget: "SHOWN",
			timerReminders: false,
		});
	});

	it("upserts only the given fields onto the member's own row", async () => {
		mocks.timeTrackingPreference.upsert.mockResolvedValue({
			timerWidget: "OFF",
			timerReminders: false,
		});

		await setTimeTrackingPreference({
			...owner,
			values: { timerWidget: "OFF" },
		});

		expect(mocks.timeTrackingPreference.upsert).toHaveBeenCalledWith({
			where: {
				organizationId_userId: {
					organizationId: "org-1",
					userId: "user-1",
				},
			},
			create: {
				timerWidget: "OFF",
				timerReminders: false,
				organizationId: "org-1",
				userId: "user-1",
			},
			update: { timerWidget: "OFF" },
			select: { timerWidget: true, timerReminders: true },
		});
	});
});

describe("findOwnActivity", () => {
	const after = new Date("2026-11-10T09:00:00Z");

	it("reads the member's newest successful own action in the window, leaving out the excluded prefix", async () => {
		mocks.auditLog.findFirst.mockResolvedValue(null);

		await findOwnActivity({
			...owner,
			after,
			before: NOW,
			excludeActionPrefix: "activity.timeTracking.timer.",
			pick: "newest",
		});

		expect(mocks.auditLog.findFirst).toHaveBeenCalledWith({
			where: {
				userId: "user-1",
				organizationId: "org-1",
				actorType: "user",
				impersonatedById: null,
				outcome: "success",
				createdAt: { gt: after, lt: NOW },
				NOT: {
					action: { startsWith: "activity.timeTracking.timer." },
				},
			},
			select: { action: true, createdAt: true },
			orderBy: { createdAt: "desc" },
		});
	});

	it("reads the oldest one instead when asked", async () => {
		mocks.auditLog.findFirst.mockResolvedValue(null);

		await findOwnActivity({
			...owner,
			after,
			before: NOW,
			excludeActionPrefix: "activity.timeTracking.timer.",
			pick: "oldest",
		});

		expect(mocks.auditLog.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({ orderBy: { createdAt: "asc" } }),
		);
	});
});
