/**
 * The daily Proposal export cleanup (Fizzy #2946): lists only the
 * `proposal-exports/` prefix of the project contexts bucket, deletes what is
 * older than the 24-hour retention window plus one hour of margin for an
 * upload in flight, keeps everything newer, follows every listing page, and
 * stops at its per-run deletion budget.
 *
 * Mocked: `@repo/storage` (listing and batch delete), `@repo/config` (the
 * bucket name), `@repo/logs` and `@temporalio/activity` (the heartbeat). The
 * clock is pinned so ages are exact.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	listObjects: vi.fn(),
	deleteObjects: vi.fn(),
	loggerInfo: vi.fn(),
	heartbeat: vi.fn(),
}));

vi.mock("@repo/storage", () => ({
	listObjects: mocks.listObjects,
	deleteObjects: mocks.deleteObjects,
}));
vi.mock("@repo/config", () => ({
	config: {
		storage: {
			bucketNames: { projectContexts: "example-project-contexts" },
		},
	},
}));
vi.mock("@repo/logs", () => ({
	logger: {
		info: mocks.loggerInfo,
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));
vi.mock("@temporalio/activity", () => ({
	heartbeat: mocks.heartbeat,
	Context: {
		current: () => {
			throw new Error("not in an activity");
		},
	},
}));

import { cleanupExpiredProposalExportsActivity } from "../cleanup-exports";

const NOW = new Date("2026-10-15T12:00:00.000Z");
const HOUR = 3_600_000;
/** Retention (24 h) plus the margin (1 h). */
const CUTOFF = new Date(NOW.getTime() - 25 * HOUR);

function aged(key: string, ageMs: number) {
	return {
		key: `proposal-exports/project-example-1/${key}`,
		lastModified: new Date(NOW.getTime() - ageMs),
		size: 1024,
	};
}

function page(
	objects: ReturnType<typeof aged>[],
	nextContinuationToken?: string,
) {
	return { objects, nextContinuationToken };
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(NOW);
	for (const mock of Object.values(mocks)) {
		mock.mockReset();
	}
	mocks.listObjects.mockResolvedValue(page([]));
	mocks.deleteObjects.mockImplementation(async (keys: string[]) => ({
		deleted: keys.length,
		errors: [],
	}));
});

afterEach(() => {
	vi.useRealTimers();
});

describe("cleanupExpiredProposalExportsActivity", () => {
	it("lists only the proposal-exports prefix of the project contexts bucket", async () => {
		await cleanupExpiredProposalExportsActivity();

		expect(mocks.listObjects).toHaveBeenCalledTimes(1);
		expect(mocks.listObjects).toHaveBeenCalledWith({
			bucket: "example-project-contexts",
			prefix: "proposal-exports/",
			maxKeys: 1000,
			continuationToken: undefined,
		});
	});

	it("deletes exports older than the retention window plus the margin, and keeps newer ones", async () => {
		mocks.listObjects.mockResolvedValueOnce(
			page([
				aged("fresh.pdf", 10 * 60_000),
				aged("a-day-old.pdf", 24 * HOUR + 60_000),
				aged("inside-the-margin.docx", 24.5 * HOUR),
				aged("exactly-at-the-cutoff.pdf", 25 * HOUR),
				aged("just-past-the-cutoff.pdf", 25 * HOUR + 1_000),
				aged("two-days-old.docx", 48 * HOUR),
			]),
		);

		const result = await cleanupExpiredProposalExportsActivity();

		expect(mocks.deleteObjects).toHaveBeenCalledTimes(1);
		expect(mocks.deleteObjects).toHaveBeenCalledWith(
			[
				"proposal-exports/project-example-1/just-past-the-cutoff.pdf",
				"proposal-exports/project-example-1/two-days-old.docx",
			],
			{ bucket: "example-project-contexts" },
		);
		expect(result).toEqual({
			scanned: 6,
			deleted: 2,
			errorCount: 0,
			pages: 1,
			hitDeletionCap: false,
			cutoffAt: CUTOFF.toISOString(),
		});
	});

	it("deletes nothing when nothing has aged out", async () => {
		mocks.listObjects.mockResolvedValueOnce(
			page([aged("fresh.pdf", HOUR), aged("older.pdf", 20 * HOUR)]),
		);

		const result = await cleanupExpiredProposalExportsActivity();

		expect(mocks.deleteObjects).not.toHaveBeenCalled();
		expect(result).toMatchObject({ scanned: 2, deleted: 0, errorCount: 0 });
	});

	it("follows continuation tokens and sums deletions and errors across pages", async () => {
		mocks.listObjects
			.mockResolvedValueOnce(
				page(
					[aged("one.pdf", 30 * HOUR), aged("two.pdf", 30 * HOUR)],
					"token-2",
				),
			)
			.mockResolvedValueOnce(
				page(
					[aged("three.pdf", 30 * HOUR), aged("fresh.pdf", HOUR)],
					"token-3",
				),
			)
			.mockResolvedValueOnce(page([aged("four.docx", 30 * HOUR)]));
		mocks.deleteObjects
			.mockResolvedValueOnce({
				deleted: 1,
				errors: [{ key: "proposal-exports/project-example-1/two.pdf" }],
			})
			.mockResolvedValueOnce({ deleted: 1, errors: [] })
			.mockResolvedValueOnce({ deleted: 1, errors: [] });

		const result = await cleanupExpiredProposalExportsActivity();

		expect(mocks.listObjects.mock.calls.map((call) => call[0])).toEqual([
			expect.objectContaining({
				prefix: "proposal-exports/",
				continuationToken: undefined,
			}),
			expect.objectContaining({
				prefix: "proposal-exports/",
				continuationToken: "token-2",
			}),
			expect.objectContaining({
				prefix: "proposal-exports/",
				continuationToken: "token-3",
			}),
		]);
		expect(result).toMatchObject({
			scanned: 5,
			deleted: 3,
			errorCount: 1,
			pages: 3,
			hitDeletionCap: false,
		});
	});

	it("stops at the deletion cap and does not list further pages", async () => {
		const expired = Array.from({ length: 5_001 }, (_, i) =>
			aged(`export-${i}.pdf`, 30 * HOUR),
		);
		mocks.listObjects.mockResolvedValueOnce(page(expired, "token-2"));

		const result = await cleanupExpiredProposalExportsActivity();

		expect(mocks.deleteObjects).toHaveBeenCalledTimes(1);
		const keys = mocks.deleteObjects.mock.calls[0]?.[0] as string[];
		expect(keys).toHaveLength(5_000);
		expect(keys[0]).toBe("proposal-exports/project-example-1/export-0.pdf");
		expect(mocks.listObjects).toHaveBeenCalledTimes(1);
		expect(result).toMatchObject({
			scanned: 5_001,
			deleted: 5_000,
			hitDeletionCap: true,
			pages: 1,
		});
	});

	it("spends the deletion cap across pages", async () => {
		mocks.listObjects
			.mockResolvedValueOnce(
				page(
					Array.from({ length: 4_999 }, (_, i) =>
						aged(`first-${i}.pdf`, 30 * HOUR),
					),
					"token-2",
				),
			)
			.mockResolvedValueOnce(
				page(
					[
						aged("second-0.pdf", 30 * HOUR),
						aged("second-1.pdf", 30 * HOUR),
					],
					"token-3",
				),
			);

		const result = await cleanupExpiredProposalExportsActivity();

		expect(mocks.deleteObjects.mock.calls[1]?.[0]).toEqual([
			"proposal-exports/project-example-1/second-0.pdf",
		]);
		expect(mocks.listObjects).toHaveBeenCalledTimes(2);
		expect(result).toMatchObject({
			deleted: 5_000,
			hitDeletionCap: true,
			pages: 2,
		});
	});

	it("logs the run's totals, never a key", async () => {
		mocks.listObjects.mockResolvedValueOnce(
			page([aged("old.pdf", 30 * HOUR)]),
		);

		await cleanupExpiredProposalExportsActivity();

		expect(mocks.loggerInfo).toHaveBeenCalledTimes(1);
		const [fields] = mocks.loggerInfo.mock.calls[0] ?? [];
		expect(fields).toMatchObject({
			event: "proposal_exports.cleanup.completed",
			scanned: 1,
			deleted: 1,
		});
		expect(JSON.stringify(fields)).not.toContain("old.pdf");
	});
});
