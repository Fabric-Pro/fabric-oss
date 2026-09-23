/**
 * `openExclusiveBackgroundJob` — the check-and-open behind the FR54 "one PM
 * story sync at a time" guard.
 *
 * The capability gate reads "nothing running" without holding it, so two
 * near-simultaneous requests can both pass it. This pins what closes that
 * window: the lock is taken inside the transaction BEFORE the live-run read,
 * a live run means no row is opened, and a miss opens the row in the same
 * transaction.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const executeRawMock = vi.fn();
const findFirstMock = vi.fn();
const createMock = vi.fn();
const transactionMock = vi.fn();

vi.mock("../prisma/client", () => {
	const tx = {
		$executeRaw: (...args: unknown[]) => executeRawMock(...args),
		backgroundJob: {
			findFirst: (args: unknown) => findFirstMock(args),
			create: (args: unknown) => createMock(args),
		},
	};
	return {
		db: {
			$transaction: (
				fn: (tx: unknown) => Promise<unknown>,
				options: unknown,
			) => {
				transactionMock(options);
				return fn(tx);
			},
		},
		Prisma: {},
	};
});

import { openExclusiveBackgroundJob } from "../prisma/queries/background-jobs";

const LIVE_SINCE = new Date("2026-09-23T11:20:00.000Z");

const ARGS = {
	lockKey: "pm-story-sync:project-1",
	liveSince: LIVE_SINCE,
	job: {
		kind: "PM_STORY_SYNC" as const,
		title: "Pull from project management",
		projectId: "project-1",
		userId: "user-1",
		organizationId: "org-1",
		workflowId: "story-sync-project-1-1",
		sourceType: "pmStoryPull",
		sourceId: "project-1",
	},
};

function rawSql(callIndex: number): string {
	const [strings] = executeRawMock.mock.calls[callIndex] as [
		TemplateStringsArray,
		...unknown[],
	];
	return strings.join("?");
}

beforeEach(() => {
	vi.clearAllMocks();
	executeRawMock.mockResolvedValue(1);
	findFirstMock.mockResolvedValue(null);
	createMock.mockResolvedValue({ id: "job-new" });
});

describe("openExclusiveBackgroundJob", () => {
	it("takes the key's advisory lock before reading, in the (int4, int4) space", async () => {
		await openExclusiveBackgroundJob(ARGS);

		expect(rawSql(0)).toMatch(/pg_advisory_xact_lock\(\?::int, \?::int\)/);
		expect(executeRawMock.mock.invocationCallOrder[0]).toBeLessThan(
			findFirstMock.mock.invocationCallOrder[0],
		);
		expect(transactionMock).toHaveBeenCalledWith(
			expect.objectContaining({ timeout: expect.any(Number) }),
		);
	});

	it("reads only a RUNNING row of the same kind and project heartbeated since the cutoff", async () => {
		await openExclusiveBackgroundJob(ARGS);

		expect(findFirstMock).toHaveBeenCalledWith({
			where: {
				projectId: "project-1",
				kind: "PM_STORY_SYNC",
				status: "RUNNING",
				heartbeatAt: { gte: LIVE_SINCE },
			},
			orderBy: { createdAt: "desc" },
			select: { workflowId: true, sourceType: true, createdAt: true },
		});
	});

	it("opens nothing and returns the live run when one holds the project", async () => {
		const active = {
			workflowId: "story-sync-live",
			sourceType: "pmStoryPush",
			createdAt: new Date("2026-09-23T11:58:00.000Z"),
		};
		findFirstMock.mockResolvedValue(active);

		await expect(openExclusiveBackgroundJob(ARGS)).resolves.toEqual({
			opened: false,
			active,
		});
		expect(createMock).not.toHaveBeenCalled();
	});

	it("opens the caller's row in the same transaction when nothing is live", async () => {
		await expect(openExclusiveBackgroundJob(ARGS)).resolves.toEqual({
			opened: true,
			id: "job-new",
		});
		expect(createMock).toHaveBeenCalledWith({
			data: expect.objectContaining({
				kind: "PM_STORY_SYNC",
				projectId: "project-1",
				userId: "user-1",
				organizationId: "org-1",
				workflowId: "story-sync-project-1-1",
				sourceType: "pmStoryPull",
				sourceId: "project-1",
			}),
			select: { id: true },
		});
	});

	it("propagates a database failure instead of opening unguarded", async () => {
		executeRawMock.mockRejectedValue(new Error("connection lost"));

		await expect(openExclusiveBackgroundJob(ARGS)).rejects.toThrow(
			"connection lost",
		);
		expect(createMock).not.toHaveBeenCalled();
	});
});
