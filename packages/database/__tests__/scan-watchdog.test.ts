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
	projectId: string;
	status: string;
	startedAt: Date | null;
	createdAt: Date;
};

type ScanWhere = {
	projectId?: string;
	status: { in: string[] };
	OR: [
		{ startedAt: { lt: Date } },
		{ startedAt: null; createdAt: { lt: Date } },
	];
};

const LONG_AGO = new Date("2026-09-18T06:00:00.000Z");

/**
 * The fixture table, spanning every case the sweep has to get right at once.
 * Ages are relative to NOW with a 90-minute window, so the threshold is 10:30.
 */
const ROWS: ScanRow[] = [
	// Started four hours ago and never closed — the row this sweep exists for.
	{
		id: "dead",
		projectId: "project_a",
		status: "RUNNING",
		startedAt: new Date("2026-09-18T08:00:00.000Z"),
		createdAt: LONG_AGO,
	},
	// Half an hour in. A scan this young is simply still working.
	{
		id: "live",
		projectId: "project_a",
		status: "RUNNING",
		startedAt: new Date("2026-09-18T11:30:00.000Z"),
		createdAt: new Date("2026-09-18T11:29:00.000Z"),
	},
	// Queued five hours ago and never started — a failed `workflow.start`
	// leaves exactly this behind, and nothing else would ever close it.
	{
		id: "never-started",
		projectId: "project_a",
		status: "PENDING",
		startedAt: null,
		createdAt: new Date("2026-09-18T07:00:00.000Z"),
	},
	// Queued a minute ago. Not started yet, and not late either.
	{
		id: "just-queued",
		projectId: "project_a",
		status: "PENDING",
		startedAt: null,
		createdAt: new Date("2026-09-18T11:59:00.000Z"),
	},
	// Long finished. Already terminal; the sweep must not rewrite its verdict.
	{
		id: "finished",
		projectId: "project_a",
		status: "COMPLETED",
		startedAt: LONG_AGO,
		createdAt: LONG_AGO,
	},
	// Dead, but on another project — reachable only by the global sweep.
	{
		id: "dead-elsewhere",
		projectId: "project_b",
		status: "RUNNING",
		startedAt: new Date("2026-09-18T08:00:00.000Z"),
		createdAt: LONG_AGO,
	},
];

/**
 * Apply the built `where` to one fixture row the way the database would.
 *
 * The null branch is the load-bearing part: `startedAt < threshold` evaluates to
 * NULL — never true — for a row with no `startedAt`, so such a row is reached
 * only through the arm that measures it from `createdAt`.
 */
function selectedBy(row: ScanRow, where: ScanWhere): boolean {
	// This matcher understands exactly these clauses. If the predicate ever
	// grows another, the silent outcome would be a matcher that ignores it and
	// keeps reporting the safe answer, so refuse outright instead.
	const clauses = Object.keys(where)
		.filter((key) => key !== "projectId")
		.sort();
	if (clauses.join(",") !== "OR,status") {
		throw new Error(`unhandled where clauses: ${clauses.join(", ")}`);
	}
	if (where.projectId !== undefined && row.projectId !== where.projectId) {
		return false;
	}
	if (!where.status.in.includes(row.status)) {
		return false;
	}
	const [started, neverStarted] = where.OR;
	if (row.startedAt !== null) {
		return row.startedAt.getTime() < started.startedAt.lt.getTime();
	}
	return row.createdAt.getTime() < neverStarted.createdAt.lt.getTime();
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
	it("closes every in-flight scan past the window and nothing else", async () => {
		const count = await failStaleProjectScans({
			staleMinutes: STALE_MINUTES,
		});

		expect(swept).toEqual(["dead", "never-started", "dead-elsewhere"]);
		expect(count).toBe(3);
	});

	it("leaves a RUNNING scan still inside the window alone", async () => {
		await failStaleProjectScans({ staleMinutes: STALE_MINUTES });

		// Declaring this one dead would close a scan that is still working, and
		// nothing downstream could undo that verdict.
		expect(swept).not.toContain("live");
	});

	it("measures a scan that never started from when it was queued", async () => {
		await failStaleProjectScans({ staleMinutes: STALE_MINUTES });

		// Unreachable before: with no start time it had no clock at all, sat
		// "in flight" for good, and refused every later scan behind it. The
		// gate reads the same fallback, so the two agree on which rows are dead.
		expect(swept).toContain("never-started");
		expect(swept).not.toContain("just-queued");
	});

	it("never rewrites a scan that already reached a terminal status", async () => {
		await failStaleProjectScans({ staleMinutes: STALE_MINUTES });

		expect(swept).not.toContain("finished");
	});

	it("reaches only the named project when given one", async () => {
		// The trigger closes a stalled row before starting the scan that
		// replaces it. It must not close another project's rows on the way.
		await failStaleProjectScans({
			staleMinutes: STALE_MINUTES,
			projectId: "project_a",
		});

		expect(swept).toEqual(["dead", "never-started"]);
	});

	it("measures the window on the frozen clock", async () => {
		await failStaleProjectScans({ staleMinutes: STALE_MINUTES });

		const threshold = new Date("2026-09-18T10:30:00.000Z");
		expect(scanUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					status: { in: ["PENDING", "RUNNING"] },
					OR: [
						{ startedAt: { lt: threshold } },
						{ startedAt: null, createdAt: { lt: threshold } },
					],
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
