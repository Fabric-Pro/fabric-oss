/**
 * Which project the scheduled sweep considers "last fetched".
 *
 * A project has one `TestPipelineSyncState` per (provider, pipeline), and the
 * sweep asks for the most recent one to decide whether the configured interval
 * has elapsed. `lastFetchedAt` is nullable — a source that has never fetched
 * successfully has no timestamp at all — and Postgres sorts NULLs FIRST under a
 * plain `DESC`. So `take: 1` handed back the never-fetched row, the sweep read
 * `lastFetchedAt: null`, and `isPipelineSyncDue` treats null as unconditionally
 * due.
 *
 * The effect was that one broken source made the WHOLE project due on every
 * tick, permanently, regardless of `pipelineSyncIntervalMinutes` — the exact
 * failure the query's own comment says the ordering exists to prevent.
 *
 * This asserts the ordering shape rather than the returned rows on purpose: the
 * bug lives entirely in SQL that a mocked client never executes, and the
 * plausible regression is someone "simplifying" the verbose orderBy back to
 * `"desc"`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { dbMock } = vi.hoisted(() => ({
	dbMock: { project: { findMany: vi.fn() } },
}));

vi.mock("../../../client", () => ({ db: dbMock }));

import { listProjectsDueForPipelineSync } from "../pipeline-results";

beforeEach(() => {
	vi.clearAllMocks();
	dbMock.project.findMany.mockResolvedValue([]);
});

/** The `select` clause the sweep issues, as Prisma received it. */
function selectClause(): Record<string, unknown> {
	return dbMock.project.findMany.mock.calls[0][0].select;
}

describe("listProjectsDueForPipelineSync", () => {
	it("asks for the most recent fetch with NULLs last, not first", async () => {
		await listProjectsDueForPipelineSync();

		const syncStates = selectClause().testPipelineSyncStates as {
			orderBy: { lastFetchedAt: unknown };
			take: number;
		};

		expect(syncStates.take).toBe(1);
		// Not the bare `"desc"` — that is NULLS FIRST in Postgres.
		expect(syncStates.orderBy.lastFetchedAt).toEqual({
			sort: "desc",
			nulls: "last",
		});
	});

	it("still takes exactly one sync state, so one stale source cannot win", async () => {
		await listProjectsDueForPipelineSync();

		const syncStates = selectClause().testPipelineSyncStates as {
			take: number;
			select: Record<string, boolean>;
		};

		// Reading every state and picking in Node would work too, but it drags
		// the whole cursor table per project on a sweep bounded at 500.
		expect(syncStates.take).toBe(1);
		expect(syncStates.select).toEqual({ lastFetchedAt: true });
	});
});
