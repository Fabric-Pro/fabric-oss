import { beforeEach, describe, expect, it, vi } from "vitest";

// Bare unit test: Context.current() throws "Activity context not initialized"
// outside a real Temporal activity execution, so collectTranscripts's
// `Context.current().heartbeat()` needs Context mocked (mirrors
// collect-stories.test.ts / fetch-ado-states-heartbeat.test.ts).
vi.mock("@temporalio/activity", () => ({
	Context: { current: () => ({ heartbeat: vi.fn() }) },
}));

interface FakeTranscriptRow {
	id: string;
	summary: string | null;
	syncedAt: Date;
	insightsExtractedAt: Date | null;
	projectId: string;
	organizationId: string | null;
}

interface FakeWhere {
	projectId: string;
	project: { organizationId: string | null };
	OR: Array<
		| { syncedAt: { gte: Date; lte: Date } }
		| { insightsExtractedAt: { gte: Date; lte: Date } }
	>;
}

// vi.mock factories are hoisted above all other top-level code, so the mock's
// backing state/fn must be created via vi.hoisted (see collect-stories.test.ts).
const { seededRowsRef, findManyMock } = vi.hoisted(() => {
	const seededRowsRef: { current: FakeTranscriptRow[] } = { current: [] };

	/**
	 * Mirrors ProjectMeetingTranscript.findMany — note the window filters on
	 * `syncedAt` OR `insightsExtractedAt` (N4: this model has no `createdAt`
	 * column, and a transcript reprocessed inside the window must be collected
	 * even if it originally synced outside it — mirrors the cost-guard's OR).
	 */
	const findManyMock = vi.fn(
		(args: { where: FakeWhere; take: number; orderBy: unknown }) => {
			const { where, take } = args;
			const inRange = (date: Date, range: { gte: Date; lte: Date }) =>
				date.getTime() >= range.gte.getTime() &&
				date.getTime() <= range.lte.getTime();

			const matches = seededRowsRef.current.filter((row) => {
				if (row.projectId !== where.projectId) {
					return false;
				}
				if (row.organizationId !== where.project.organizationId) {
					return false;
				}
				return where.OR.some((clause) => {
					if ("syncedAt" in clause) {
						return inRange(row.syncedAt, clause.syncedAt);
					}
					if ("insightsExtractedAt" in clause) {
						return (
							row.insightsExtractedAt !== null &&
							inRange(
								row.insightsExtractedAt,
								clause.insightsExtractedAt,
							)
						);
					}
					return false;
				});
			});

			const sorted = [...matches].sort(
				(a, b) => b.syncedAt.getTime() - a.syncedAt.getTime(),
			);
			return Promise.resolve(
				sorted.slice(0, take).map((r) => ({
					id: r.id,
					summary: r.summary,
					syncedAt: r.syncedAt,
					insightsExtractedAt: r.insightsExtractedAt,
				})),
			);
		},
	);

	return { seededRowsRef, findManyMock };
});

vi.mock("@repo/database", async () => {
	const actual =
		await vi.importActual<typeof import("@repo/database")>(
			"@repo/database",
		);
	return {
		...actual,
		db: { projectMeetingTranscript: { findMany: findManyMock } },
	};
});

import { collectTranscripts } from "../collect-transcripts";

const WINDOW_START = "2026-07-01T00:00:00.000Z";
const WINDOW_END = "2026-07-08T00:00:00.000Z";
const IN_WINDOW = new Date("2026-07-04T12:00:00.000Z");

function row(
	overrides: Partial<FakeTranscriptRow> & Pick<FakeTranscriptRow, "id">,
): FakeTranscriptRow {
	return {
		summary: "A real, substantive meeting summary.",
		syncedAt: IN_WINDOW,
		insightsExtractedAt: null,
		projectId: "proj-a",
		organizationId: "org-a",
		...overrides,
	};
}

function baseInput() {
	return {
		projectId: "proj-a",
		organizationId: "org-a",
		userId: null,
		windowStart: WINDOW_START,
		windowEnd: WINDOW_END,
	};
}

beforeEach(() => {
	seededRowsRef.current = [];
	findManyMock.mockClear();
});

describe("collectTranscripts", () => {
	it("excludes transcripts with a null or whitespace-only summary from qualifyingCount", async () => {
		seededRowsRef.current = [
			row({ id: "t-1", summary: null }),
			row({ id: "t-2", summary: "   " }),
			row({ id: "t-3", summary: "Real summary content" }),
		];

		const result = await collectTranscripts(baseInput());

		expect(result.qualifyingCount).toBe(1);
	});

	it("newestQualifyingIso reflects a recent insightsExtractedAt over an older syncedAt (late-summary freshness)", async () => {
		const oldSync = new Date("2026-07-01T00:00:00.000Z"); // in-window, but old
		const recentInsights = new Date("2026-07-07T00:00:00.000Z"); // newer, in-window
		seededRowsRef.current = [
			row({
				id: "t-1",
				summary: "Insights landed long after the sync.",
				syncedAt: oldSync,
				insightsExtractedAt: recentInsights,
			}),
		];

		const result = await collectTranscripts(baseInput());

		expect(result.qualifyingCount).toBe(1);
		expect(result.newestQualifyingIso).toBe(recentInsights.toISOString());
	});

	it("N4: collects a transcript whose syncedAt is OUTSIDE the window but insightsExtractedAt is INSIDE it (mirrors the cost-guard's OR)", async () => {
		const oldSyncOutsideWindow = new Date("2026-01-01T00:00:00.000Z"); // well before WINDOW_START
		const recentInsightsInsideWindow = new Date("2026-07-05T00:00:00.000Z"); // inside window
		seededRowsRef.current = [
			row({
				id: "t-late-reprocess",
				summary: "Reprocessed long after the original sync.",
				syncedAt: oldSyncOutsideWindow,
				insightsExtractedAt: recentInsightsInsideWindow,
			}),
		];

		const result = await collectTranscripts(baseInput());

		// The row must be COLLECTED (not just counted by the cost-guard) —
		// a syncedAt-only window would drop it entirely, which is exactly the
		// daily INSUFFICIENT_CONTEXT loop N4 fixes.
		expect(result.count).toBe(1);
		expect(result.items.map((i) => i.id)).toEqual(["t-late-reprocess"]);
		expect(result.qualifyingCount).toBe(1);
		expect(result.newestQualifyingIso).toBe(
			recentInsightsInsideWindow.toISOString(),
		);
	});
});
