/**
 * The suggestion writes that must hold under retries and races: starting a
 * run, storing its suggestions, confirming one exactly once, and dismissing.
 *
 * Prisma's delegates are mocked and `$transaction` runs its callback on the
 * same mocks, so this pins the conditional updates each write relies on and
 * what happens when one of them matches nothing.
 *
 * Run with:
 *   pnpm --filter @repo/database test time-suggestions
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const delegates = {
		timeSuggestionRun: {
			findFirst: vi.fn(),
			findUniqueOrThrow: vi.fn(),
			create: vi.fn(),
			update: vi.fn(),
			updateMany: vi.fn(),
		},
		timeSuggestion: {
			create: vi.fn(),
			delete: vi.fn(),
			findFirst: vi.fn(),
			findMany: vi.fn(),
			update: vi.fn(),
			updateMany: vi.fn(),
		},
		timeSuggestionEvidence: { createMany: vi.fn() },
		timeEntry: { findFirst: vi.fn(), create: vi.fn() },
		user: { findUnique: vi.fn() },
	};
	return {
		...delegates,
		$queryRaw: vi.fn(),
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
	dismissTimeSuggestion,
	failTimeSuggestionRun,
	findLatestTimeSuggestionRunStart,
	listMemberTimeZoneCandidates,
	listPendingTimeSuggestions,
	persistTimeSuggestions,
	startTimeSuggestionRun,
	TIME_SUGGESTION_RUN_TIMEOUT_MS,
} = await import("../time-suggestions");
const { confirmTimeSuggestionAsEntry } = await import("../time-entries");

const NOW = new Date("2026-11-10T12:00:00.000Z");
const owner = { organizationId: "org-1", userId: "user-1" };

beforeEach(() => {
	vi.clearAllMocks();
});

describe("findLatestTimeSuggestionRunStart", () => {
	function sentQuery() {
		const [strings, ...values] = mocks.$queryRaw.mock.calls[0] as [
			TemplateStringsArray,
			...unknown[],
		];
		return { sql: strings.join("$").replace(/\s+/g, " "), values };
	}

	it("reads the newest start among the member's runs spanning at least the given days", async () => {
		const startedAt = new Date("2026-11-10T08:00:00Z");
		mocks.$queryRaw.mockResolvedValue([{ startedAt }]);

		await expect(
			findLatestTimeSuggestionRunStart({ ...owner, minSpanDays: 7 }),
		).resolves.toEqual(startedAt);

		const { sql, values } = sentQuery();
		expect(sql).toContain(
			'WHERE "organizationId" = $ AND "userId" = $ AND ("toDate" - "fromDate" + 1) >= $',
		);
		expect(sql).toContain('ORDER BY "startedAt" DESC LIMIT 1');
		expect(values).toEqual(["org-1", "user-1", 7]);
	});

	it("is null when no such run exists", async () => {
		mocks.$queryRaw.mockResolvedValue([]);

		await expect(
			findLatestTimeSuggestionRunStart({ ...owner, minSpanDays: 7 }),
		).resolves.toBeNull();
	});
});

describe("listMemberTimeZoneCandidates", () => {
	const at = (iso: string) => new Date(iso);

	it("puts the profile's zone first, then the newer of the last entry and run", async () => {
		mocks.user.findUnique.mockResolvedValue({ timezone: "Asia/Tokyo" });
		mocks.timeEntry.findFirst.mockResolvedValue({
			timezone: "Europe/Berlin",
			createdAt: at("2026-11-09T08:00:00Z"),
		});
		mocks.timeSuggestionRun.findFirst.mockResolvedValue({
			timezone: "America/New_York",
			startedAt: at("2026-11-10T08:00:00Z"),
		});

		await expect(listMemberTimeZoneCandidates(owner)).resolves.toEqual([
			"Asia/Tokyo",
			"America/New_York",
			"Europe/Berlin",
		]);
		expect(mocks.timeEntry.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: owner,
				orderBy: { createdAt: "desc" },
			}),
		);
		expect(mocks.timeSuggestionRun.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: owner,
				orderBy: { startedAt: "desc" },
			}),
		);
	});

	it("skips a profile without a zone", async () => {
		mocks.user.findUnique.mockResolvedValue({ timezone: null });
		mocks.timeEntry.findFirst.mockResolvedValue({
			timezone: "Europe/Berlin",
			createdAt: at("2026-11-10T08:00:00Z"),
		});
		mocks.timeSuggestionRun.findFirst.mockResolvedValue(null);

		await expect(listMemberTimeZoneCandidates(owner)).resolves.toEqual([
			"Europe/Berlin",
		]);
	});

	it("is empty when nothing is stored", async () => {
		mocks.user.findUnique.mockResolvedValue(null);
		mocks.timeEntry.findFirst.mockResolvedValue(null);
		mocks.timeSuggestionRun.findFirst.mockResolvedValue(null);

		await expect(listMemberTimeZoneCandidates(owner)).resolves.toEqual([]);
	});
});

describe("startTimeSuggestionRun", () => {
	const input = {
		...owner,
		fromDate: "2026-11-04",
		toDate: "2026-11-10",
		timezone: "Europe/Berlin",
		automatic: true,
		now: NOW,
	};

	it("opens a run when none is generating", async () => {
		mocks.timeSuggestionRun.findFirst.mockResolvedValue(null);
		mocks.timeSuggestionRun.create.mockResolvedValue({ id: "run-1" });

		await expect(startTimeSuggestionRun(input)).resolves.toEqual({
			status: "started",
			runId: "run-1",
		});
		expect(mocks.timeSuggestionRun.create).toHaveBeenCalledWith({
			data: {
				organizationId: "org-1",
				userId: "user-1",
				fromDate: new Date("2026-11-04T00:00:00.000Z"),
				toDate: new Date("2026-11-10T00:00:00.000Z"),
				timezone: "Europe/Berlin",
				automatic: true,
				status: "GENERATING",
			},
			select: { id: true },
		});
	});

	it("records a run the member asked for as not automatic", async () => {
		mocks.timeSuggestionRun.findFirst.mockResolvedValue(null);
		mocks.timeSuggestionRun.create.mockResolvedValue({ id: "run-1" });

		await startTimeSuggestionRun({ ...input, automatic: false });

		expect(
			mocks.timeSuggestionRun.create.mock.calls[0][0].data,
		).toMatchObject({ automatic: false });
	});

	it("answers in_flight while a live run is generating", async () => {
		mocks.timeSuggestionRun.findFirst.mockResolvedValue({
			id: "run-0",
			startedAt: new Date(NOW.getTime() - 60_000),
		});

		await expect(startTimeSuggestionRun(input)).resolves.toEqual({
			status: "in_flight",
		});
		expect(mocks.timeSuggestionRun.create).not.toHaveBeenCalled();
	});

	it("reclaims a run stuck past the timeout, then opens a new one", async () => {
		mocks.timeSuggestionRun.findFirst.mockResolvedValue({
			id: "run-0",
			startedAt: new Date(
				NOW.getTime() - TIME_SUGGESTION_RUN_TIMEOUT_MS - 1,
			),
		});
		mocks.timeSuggestionRun.create.mockResolvedValue({ id: "run-1" });

		await expect(startTimeSuggestionRun(input)).resolves.toEqual({
			status: "started",
			runId: "run-1",
		});
		expect(mocks.timeSuggestionRun.updateMany).toHaveBeenCalledWith({
			where: { id: "run-0", status: "GENERATING" },
			data: expect.objectContaining({
				status: "FAILED",
				finishedAt: NOW,
			}),
		});
	});

	it("answers in_flight when a concurrent start wins the unique index", async () => {
		mocks.timeSuggestionRun.findFirst.mockResolvedValue(null);
		mocks.timeSuggestionRun.create.mockRejectedValue(
			Object.assign(new Error("Unique constraint failed"), {
				code: "P2002",
			}),
		);

		await expect(startTimeSuggestionRun(input)).resolves.toEqual({
			status: "in_flight",
		});
	});
});

describe("failTimeSuggestionRun", () => {
	it("only fails a run still generating, scoped to its owner", async () => {
		mocks.timeSuggestionRun.updateMany.mockResolvedValue({ count: 0 });

		await expect(
			failTimeSuggestionRun({ runId: "run-1", ...owner, error: "boom" }),
		).resolves.toBe(false);
		expect(mocks.timeSuggestionRun.updateMany).toHaveBeenCalledWith({
			where: {
				id: "run-1",
				organizationId: "org-1",
				userId: "user-1",
				status: "GENERATING",
			},
			data: expect.objectContaining({ status: "FAILED", error: "boom" }),
		});
	});
});

describe("persistTimeSuggestions", () => {
	const occurredAt = new Date("2026-11-03T09:00:00.000Z");
	function suggestion(sourceId: string) {
		return {
			projectId: "project-a",
			workDate: "2026-11-03",
			timezone: "UTC",
			activity: "TESTING" as const,
			durationMinutes: null,
			startAt: null,
			stopAt: null,
			description: "Testing",
			explanation: "Suggested from 1 recorded test result.",
			storyId: null,
			storyIdentifier: null,
			storyTitle: null,
			expiresAt: new Date("2026-11-16T00:00:00.000Z"),
			evidence: [
				{
					kind: "TEST_RESULT" as const,
					sourceId,
					projectId: "project-a",
					occurredAt,
					startAt: null,
					endAt: null,
				},
			],
		};
	}

	it("stores nothing for a run that is no longer generating", async () => {
		mocks.timeSuggestionRun.updateMany.mockResolvedValue({ count: 0 });

		await expect(
			persistTimeSuggestions({
				runId: "run-1",
				...owner,
				suggestions: [suggestion("event-1")],
			}),
		).resolves.toEqual({ persisted: false, createdCount: 0 });
		expect(mocks.timeSuggestion.create).not.toHaveBeenCalled();
	});

	it("stores each suggestion with its evidence and counts them on the run", async () => {
		mocks.timeSuggestionRun.updateMany.mockResolvedValue({ count: 1 });
		mocks.timeSuggestionRun.findUniqueOrThrow.mockResolvedValue({
			automatic: false,
		});
		mocks.timeSuggestion.create
			.mockResolvedValueOnce({ id: "s-1" })
			.mockResolvedValueOnce({ id: "s-2" });
		mocks.timeSuggestionEvidence.createMany.mockResolvedValue({ count: 1 });

		await expect(
			persistTimeSuggestions({
				runId: "run-1",
				...owner,
				suggestions: [suggestion("event-1"), suggestion("event-2")],
			}),
		).resolves.toEqual({ persisted: true, createdCount: 2 });
		expect(mocks.timeSuggestion.create.mock.calls[0][0].data).toMatchObject(
			{
				organizationId: "org-1",
				userId: "user-1",
				workDate: new Date("2026-11-03T00:00:00.000Z"),
				automatic: false,
			},
		);
		expect(mocks.timeSuggestionEvidence.createMany).toHaveBeenCalledWith({
			data: [
				expect.objectContaining({
					suggestionId: "s-1",
					sourceId: "event-1",
					userId: "user-1",
					organizationId: "org-1",
				}),
			],
			skipDuplicates: true,
		});
		expect(mocks.timeSuggestionRun.update).toHaveBeenCalledWith({
			where: { id: "run-1" },
			data: { createdCount: 2 },
		});
	});

	it("copies an automatic run's origin onto every suggestion it stores", async () => {
		mocks.timeSuggestionRun.updateMany.mockResolvedValue({ count: 1 });
		mocks.timeSuggestionRun.findUniqueOrThrow.mockResolvedValue({
			automatic: true,
		});
		mocks.timeSuggestion.create
			.mockResolvedValueOnce({ id: "s-1" })
			.mockResolvedValueOnce({ id: "s-2" });
		mocks.timeSuggestionEvidence.createMany.mockResolvedValue({ count: 1 });

		await persistTimeSuggestions({
			runId: "run-1",
			...owner,
			suggestions: [suggestion("event-1"), suggestion("event-2")],
		});

		expect(mocks.timeSuggestionRun.findUniqueOrThrow).toHaveBeenCalledWith({
			where: { id: "run-1" },
			select: { automatic: true },
		});
		expect(
			mocks.timeSuggestion.create.mock.calls.map(
				([args]) => args.data.automatic,
			),
		).toEqual([true, true]);
	});

	it("drops a suggestion whose evidence a concurrent run claimed first", async () => {
		mocks.timeSuggestionRun.updateMany.mockResolvedValue({ count: 1 });
		mocks.timeSuggestionRun.findUniqueOrThrow.mockResolvedValue({
			automatic: false,
		});
		mocks.timeSuggestion.create.mockResolvedValue({ id: "s-1" });
		mocks.timeSuggestionEvidence.createMany.mockResolvedValue({ count: 0 });

		await expect(
			persistTimeSuggestions({
				runId: "run-1",
				...owner,
				suggestions: [suggestion("event-1")],
			}),
		).resolves.toEqual({ persisted: true, createdCount: 0 });
		expect(mocks.timeSuggestion.delete).toHaveBeenCalledWith({
			where: { id: "s-1" },
		});
	});
});

describe("listPendingTimeSuggestions", () => {
	it("reads only the owner's pending, unexpired suggestions in the organization, without automatic ones on fixed bid projects", async () => {
		mocks.timeSuggestion.findMany.mockResolvedValue([]);

		await listPendingTimeSuggestions({ ...owner, now: NOW });

		expect(mocks.timeSuggestion.findMany.mock.calls[0][0].where).toEqual({
			organizationId: "org-1",
			userId: "user-1",
			status: "PENDING",
			expiresAt: { gt: NOW },
			NOT: {
				automatic: true,
				project: { billingModel: { in: ["FIXED_BID"] } },
			},
		});
	});
});

describe("dismissTimeSuggestion", () => {
	it("moves only the owner's PENDING suggestion, so a repeat changes nothing", async () => {
		mocks.timeSuggestion.updateMany.mockResolvedValueOnce({ count: 1 });
		mocks.timeSuggestion.updateMany.mockResolvedValueOnce({ count: 0 });

		await expect(
			dismissTimeSuggestion({ id: "s-1", userId: "user-1" }),
		).resolves.toBe(true);
		await expect(
			dismissTimeSuggestion({ id: "s-1", userId: "user-1" }),
		).resolves.toBe(false);
		expect(mocks.timeSuggestion.updateMany).toHaveBeenCalledWith({
			where: { id: "s-1", userId: "user-1", status: "PENDING" },
			data: { status: "DISMISSED" },
		});
	});
});

describe("confirmTimeSuggestionAsEntry", () => {
	const values = {
		projectId: "project-a",
		workDate: "2026-11-03",
		timezone: "UTC",
		durationMinutes: 60,
		startAt: null,
		stopAt: null,
		activity: "TESTING" as const,
		billable: true,
		description: "Testing",
		storyId: null,
		storyIdentifier: null,
		storyTitle: null,
		startStopRequired: false,
		userNameSnapshot: "Ada Example",
	};
	const entryRow = {
		id: "entry-1",
		organizationId: "org-1",
		projectId: "project-a",
		workDate: new Date("2026-11-03T00:00:00.000Z"),
		timezone: "UTC",
		durationMinutes: 60,
		startAt: null,
		stopAt: null,
		activity: "TESTING",
		billable: true,
		description: "Testing",
		storyId: null,
		storyIdentifier: null,
		storyTitle: null,
		startStopRequired: false,
		createdAt: NOW,
		updatedAt: NOW,
		project: { name: "Project A" },
	};

	it("claims the PENDING suggestion and creates one entry linked to it", async () => {
		mocks.timeSuggestion.updateMany.mockResolvedValue({ count: 1 });
		mocks.timeEntry.create.mockResolvedValue(entryRow);

		const outcome = await confirmTimeSuggestionAsEntry({
			suggestionId: "s-1",
			...owner,
			values,
		});

		expect(outcome.status).toBe("created");
		expect(mocks.timeSuggestion.updateMany).toHaveBeenCalledWith({
			where: {
				id: "s-1",
				organizationId: "org-1",
				userId: "user-1",
				status: "PENDING",
			},
			data: { status: "CONFIRMED" },
		});
		expect(mocks.timeEntry.create.mock.calls[0][0].data).toMatchObject({
			sourceSuggestionId: "s-1",
			userId: "user-1",
			organizationId: "org-1",
		});
		expect(mocks.timeSuggestion.update).toHaveBeenCalledWith({
			where: { id: "s-1" },
			data: { confirmedEntryId: "entry-1" },
		});
	});

	it("returns the entry a concurrent confirm created when it loses the race", async () => {
		mocks.timeSuggestion.updateMany.mockResolvedValue({ count: 0 });
		mocks.timeEntry.findFirst.mockResolvedValue(entryRow);

		const outcome = await confirmTimeSuggestionAsEntry({
			suggestionId: "s-1",
			...owner,
			values,
		});

		expect(outcome).toMatchObject({
			status: "existing",
			entry: { id: "entry-1", workDate: "2026-11-03" },
		});
		expect(mocks.timeEntry.create).not.toHaveBeenCalled();
		expect(mocks.timeEntry.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { sourceSuggestionId: "s-1", userId: "user-1" },
			}),
		);
	});

	it("reports a suggestion that is not pending and has no entry", async () => {
		mocks.timeSuggestion.updateMany.mockResolvedValue({ count: 0 });
		mocks.timeEntry.findFirst.mockResolvedValue(null);

		await expect(
			confirmTimeSuggestionAsEntry({
				suggestionId: "s-1",
				...owner,
				values,
			}),
		).resolves.toEqual({ status: "not_pending" });
		expect(mocks.timeEntry.create).not.toHaveBeenCalled();
	});
});
