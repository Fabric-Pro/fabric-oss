/**
 * Stale-scan watchdog query tests.
 *
 * `failStaleProjectScans` is the only thing that ever closes a scan whose
 * worker died, so the single question worth testing is which rows its predicate
 * reaches. Asserting the shape of the `where` it builds would pass even if that
 * predicate swept live runs, so the mocked `updateMany` here evaluates the
 * `where` it is handed against a fixture table the way Postgres would. The clock
 * is frozen because every one of those outcomes is a comparison against `now`.
 *
 * Run with: pnpm --filter @repo/database test __tests__/scan-watchdog.test.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { scanUpdateMany } = vi.hoisted(() => ({
	scanUpdateMany: vi.fn(),
}));

// `Prisma` is a type-only import in scan.ts, so an empty object suffices.
vi.mock("../prisma/client", () => ({
	db: {
		projectScan: {
			updateMany: (...args: unknown[]) => scanUpdateMany(...args),
		},
	},
	Prisma: {},
}));

import { failStaleProjectScans } from "../prisma/queries/projects/scan";

const NOW = new Date("2026-09-18T12:00:00.000Z");
const STALE_MINUTES = 90;

type ScanRow = {
	id: string;
	status: string;
	startedAt: Date | null;
};

type ScanWhere = {
	status: string;
	startedAt: { lt: Date };
};

/**
 * The fixture table, spanning every case the sweep has to get right at once.
 * Ages are relative to NOW with a 90-minute window, so the threshold is 10:30.
 */
const ROWS: ScanRow[] = [
	// Started four hours ago and never closed — the row this sweep exists for.
	{
		id: "dead",
		status: "RUNNING",
		startedAt: new Date("2026-09-18T08:00:00.000Z"),
	},
	// Half an hour in. A scan this young is simply still working.
	{
		id: "live",
		status: "RUNNING",
		startedAt: new Date("2026-09-18T11:30:00.000Z"),
	},
	// Marked RUNNING but never stamped with a start. Age unknown.
	{ id: "unknown-age", status: "RUNNING", startedAt: null },
	// Long finished. Already terminal; the sweep must not rewrite its verdict.
	{
		id: "finished",
		status: "COMPLETED",
		startedAt: new Date("2026-09-18T06:00:00.000Z"),
	},
];

/**
 * Apply the built `where` to one fixture row the way the database would.
 *
 * The null branch is the load-bearing part: `startedAt < threshold` evaluates to
 * NULL — never true — for a row with no `startedAt`, so such a row lies outside
 * the update's reach no matter how old it really is.
 */
function selectedBy(row: ScanRow, where: ScanWhere): boolean {
	// This matcher understands exactly two clauses. If the predicate ever grows a
	// third — an `OR` reaching for null startedAt, say — the silent outcome would
	// be a matcher that ignores it and keeps reporting the safe answer, so refuse
	// outright instead.
	const clauses = Object.keys(where).sort();
	if (clauses.join(",") !== "startedAt,status") {
		throw new Error(`unhandled where clauses: ${clauses.join(", ")}`);
	}
	if (row.status !== where.status) {
		return false;
	}
	if (row.startedAt === null) {
		return false;
	}
	return row.startedAt.getTime() < where.startedAt.lt.getTime();
}

let swept: string[] = [];

beforeEach(() => {
	vi.clearAllMocks();
	swept = [];
	scanUpdateMany.mockImplementation(
		async ({ where }: { where: ScanWhere }) => {
			swept = ROWS.filter((row) => selectedBy(row, where)).map(
				(row) => row.id,
			);
			return { count: swept.length };
		},
	);
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
});

afterEach(() => {
	vi.useRealTimers();
});

describe("failStaleProjectScans — which rows it reaches", () => {
	it("closes a RUNNING scan that started before the window and nothing else", async () => {
		const count = await failStaleProjectScans({
			staleMinutes: STALE_MINUTES,
		});

		expect(swept).toEqual(["dead"]);
		expect(count).toBe(1);
	});

	it("leaves a RUNNING scan still inside the window alone", async () => {
		await failStaleProjectScans({ staleMinutes: STALE_MINUTES });

		// Declaring this one dead would close a scan that is still working, and
		// nothing downstream could undo that verdict.
		expect(swept).not.toContain("live");
	});

	it("never sweeps a scan with no startedAt", async () => {
		await failStaleProjectScans({ staleMinutes: STALE_MINUTES });

		// An unknown age is not evidence of death — this row is unreachable at
		// any window, not merely outside this one.
		expect(swept).not.toContain("unknown-age");
		await failStaleProjectScans({ staleMinutes: 1 });
		expect(swept).not.toContain("unknown-age");
	});

	it("never rewrites a scan that already reached a terminal status", async () => {
		await failStaleProjectScans({ staleMinutes: STALE_MINUTES });

		expect(swept).not.toContain("finished");
	});

	it("measures the window from startedAt, on the frozen clock", async () => {
		await failStaleProjectScans({ staleMinutes: STALE_MINUTES });

		expect(scanUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					status: "RUNNING",
					startedAt: { lt: new Date("2026-09-18T10:30:00.000Z") },
				},
			}),
		);
	});
});

describe("failStaleProjectScans — what it writes", () => {
	it("terminalises the row with an explanation and a completion time", async () => {
		await failStaleProjectScans({ staleMinutes: STALE_MINUTES });

		const { data } = scanUpdateMany.mock.calls[0][0];
		expect(data.status).toBe("FAILED");
		expect(data.completedAt).toEqual(NOW);
		// Whoever opens the run needs to know it was closed by the watchdog and
		// not by the scanner reporting a real result.
		expect(data.error).toMatch(/timed out/i);
	});

	it("leaves durationMs untouched rather than inventing one", async () => {
		await failStaleProjectScans({ staleMinutes: STALE_MINUTES });

		// A bulk update cannot read each row's own startedAt, so any duration it
		// wrote would be the same wrong number for every row.
		const { data } = scanUpdateMany.mock.calls[0][0];
		expect(data).not.toHaveProperty("durationMs");
	});
});
