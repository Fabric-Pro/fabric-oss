import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The unified analysis version sequence (`listAnalysisTimeline`).
 *
 * Unit-level with a mocked `db`, matching `publishing-drafts.test.ts`: this
 * exercises the PROJECTION — how `seq` is assigned, how `sourceAnalysisVersion`
 * is remapped onto the unified scale, and how the page is cut — not real
 * Postgres semantics. It runs in the regular no-Postgres suite.
 *
 * The case the whole change exists for is `reproduces the reported "Version 1 ·
 * AI v6"` below: six AI runs then one hand save must read as v7, not v1.
 *
 * Two invariants are asserted deliberately rather than incidentally:
 *
 *   - the STORED numbers ride alongside `seq` untouched, because they are the
 *     write tokens (`expectedVersion`, `sourceAnalysisVersion`) and a
 *     projection that overwrote them would silently break the save path's
 *     compare-and-set;
 *   - `seq` is assigned oldest-first, so a later append cannot shift a number
 *     already shown.
 */

const { analysisFindMany, revisionFindMany } = vi.hoisted(() => ({
	analysisFindMany: vi.fn(),
	revisionFindMany: vi.fn(),
}));

vi.mock("../prisma/client", () => ({
	db: {
		publishingTopicPlanningAnalysis: { findMany: analysisFindMany },
		publishingTopicAnalysisRevision: { findMany: revisionFindMany },
	},
	Prisma: {},
}));

import { listAnalysisTimeline } from "../prisma/queries/projects/publishing-analysis-timeline";

const SCOPE = { topicId: "topic-1", projectId: "project-1" };

/** Minutes past a fixed epoch, so ordering in a test reads at a glance. */
function at(minutes: number): Date {
	return new Date(Date.UTC(2026, 8, 1, 0, minutes, 0));
}

function aiRow(version: number, minutes: number, status = "READY") {
	return {
		id: `analysis-${version}`,
		version,
		status,
		createdAt: at(minutes),
		requestedBy: { id: "u1", name: "Ada" },
	};
}

function revisionRow(
	version: number,
	minutes: number,
	sourceAnalysisVersion: number,
) {
	return {
		id: `revision-${version}`,
		version,
		sourceAnalysisVersion,
		changeSummary: null,
		createdAt: at(minutes),
		author: { id: "u2", name: "Grace" },
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	analysisFindMany.mockResolvedValue([]);
	revisionFindMany.mockResolvedValue([]);
});

describe("listAnalysisTimeline", () => {
	it("scopes both reads to { topicId, projectId }", async () => {
		await listAnalysisTimeline(SCOPE);

		expect(analysisFindMany.mock.calls[0][0].where).toEqual(SCOPE);
		expect(revisionFindMany.mock.calls[0][0].where).toEqual(SCOPE);
	});

	it("never selects the large columns — no body, no content", async () => {
		await listAnalysisTimeline(SCOPE);

		expect(analysisFindMany.mock.calls[0][0].select).not.toHaveProperty(
			"content",
		);
		expect(revisionFindMany.mock.calls[0][0].select).not.toHaveProperty(
			"body",
		);
	});

	it('reproduces the reported "Version 1 · AI v6" as a single v7', async () => {
		// THE CASE THIS CHANGE EXISTS FOR. Six AI runs, then the first hand
		// save: it must be v7, and the six runs behind it must be v1..v6 —
		// which is what a projection gives and what allocating the next number
		// across both tables would not.
		analysisFindMany.mockResolvedValue([
			aiRow(1, 1),
			aiRow(2, 2),
			aiRow(3, 3),
			aiRow(4, 4),
			aiRow(5, 5),
			aiRow(6, 6),
		]);
		revisionFindMany.mockResolvedValue([revisionRow(1, 7, 6)]);

		const { entries } = await listAnalysisTimeline(SCOPE);

		// Newest first, like the drawer.
		expect(entries.map((e) => e.seq)).toEqual([7, 6, 5, 4, 3, 2, 1]);
		expect(entries[0]).toMatchObject({
			kind: "revision",
			seq: 7,
			revisionVersion: 1,
			sourceAnalysisVersion: 6,
			sourceSeq: 6,
		});
	});

	it("keeps the STORED numbers alongside seq — they are the write tokens", async () => {
		analysisFindMany.mockResolvedValue([aiRow(1, 1), aiRow(2, 2)]);
		revisionFindMany.mockResolvedValue([revisionRow(1, 3, 2)]);

		const { entries } = await listAnalysisTimeline(SCOPE);
		const revision = entries.find((e) => e.kind === "revision");

		// seq is 3, but expectedVersion must still be sent as 1 and the restore
		// payload's sourceAnalysisVersion as 2. A projection that overwrote
		// either would break the save path's compare-and-set.
		expect(revision).toMatchObject({
			seq: 3,
			revisionVersion: 1,
			sourceAnalysisVersion: 2,
		});
	});

	it("remaps sourceAnalysisVersion onto the unified scale when a revision is interleaved", async () => {
		// A1, A2, R1, A3 → A3 sits at seq 4 while its stored version is 3. A
		// revision naming stored source 3 must display "from v4", not "from v3".
		analysisFindMany.mockResolvedValue([
			aiRow(1, 1),
			aiRow(2, 2),
			aiRow(3, 4),
		]);
		revisionFindMany.mockResolvedValue([
			revisionRow(1, 3, 2),
			revisionRow(2, 5, 3),
		]);

		const { entries } = await listAnalysisTimeline(SCOPE);
		const bySeq = new Map(entries.map((e) => [e.seq, e]));

		expect(bySeq.get(4)).toMatchObject({
			kind: "ai_run",
			analysisVersion: 3,
		});
		expect(bySeq.get(5)).toMatchObject({
			kind: "revision",
			sourceAnalysisVersion: 3,
			sourceSeq: 4,
		});
		// The earlier revision was seeded from stored A2, which sits at seq 2.
		expect(bySeq.get(3)).toMatchObject({
			sourceAnalysisVersion: 2,
			sourceSeq: 2,
		});
	});

	it("counts FAILED and GENERATING attempts, and says which they were", async () => {
		// Every attempt takes a stored version at start, so the AI scale already
		// counts failures. Skipping them here would renumber the AI side
		// downward on screen — the complaint this projection removes.
		analysisFindMany.mockResolvedValue([
			aiRow(1, 1, "READY"),
			aiRow(2, 2, "FAILED"),
			aiRow(3, 3, "GENERATING"),
		]);

		const { entries } = await listAnalysisTimeline(SCOPE);

		expect(entries.map((e) => e.seq)).toEqual([3, 2, 1]);
		expect(entries.map((e) => (e as { status: string }).status)).toEqual([
			"GENERATING",
			"FAILED",
			"READY",
		]);
	});

	it("gives sourceSeq null rather than a wrong number when the referenced analysis is absent", async () => {
		analysisFindMany.mockResolvedValue([aiRow(1, 1)]);
		revisionFindMany.mockResolvedValue([revisionRow(1, 2, 99)]);

		const { entries } = await listAnalysisTimeline(SCOPE);

		expect(entries[0]).toMatchObject({
			sourceAnalysisVersion: 99,
			sourceSeq: null,
		});
	});

	it("breaks a shared timestamp AI-first, deterministically", async () => {
		// Same instant for both. An AI run logically precedes a revision seeded
		// from it, and without a fixed tiebreak `seq` would flap per request.
		analysisFindMany.mockResolvedValue([aiRow(1, 5)]);
		revisionFindMany.mockResolvedValue([revisionRow(1, 5, 1)]);

		const { entries } = await listAnalysisTimeline(SCOPE);

		expect(entries.map((e) => ({ kind: e.kind, seq: e.seq }))).toEqual([
			{ kind: "revision", seq: 2 },
			{ kind: "ai_run", seq: 1 },
		]);
	});

	it("pages newest-first and hands back a cursor strictly above the next page", async () => {
		analysisFindMany.mockResolvedValue([
			aiRow(1, 1),
			aiRow(2, 2),
			aiRow(3, 3),
			aiRow(4, 4),
		]);

		const first = await listAnalysisTimeline({ ...SCOPE, limit: 2 });
		expect(first.entries.map((e) => e.seq)).toEqual([4, 3]);
		expect(first.nextCursor).toBe(3);

		const second = await listAnalysisTimeline({
			...SCOPE,
			limit: 2,
			cursor: first.nextCursor,
		});
		// Strictly below the cursor — no entry repeats at the boundary.
		expect(second.entries.map((e) => e.seq)).toEqual([2, 1]);
		expect(second.nextCursor).toBeNull();
	});

	it("returns an empty page for a cursor past the start, never an error", async () => {
		analysisFindMany.mockResolvedValue([aiRow(1, 1)]);

		const { entries, nextCursor } = await listAnalysisTimeline({
			...SCOPE,
			cursor: 1,
		});

		expect(entries).toEqual([]);
		expect(nextCursor).toBeNull();
	});

	it("clamps an oversized limit rather than trusting the caller", async () => {
		analysisFindMany.mockResolvedValue(
			Array.from({ length: 120 }, (_, i) => aiRow(i + 1, i + 1)),
		);

		const { entries } = await listAnalysisTimeline({
			...SCOPE,
			limit: 5000,
		});

		expect(entries).toHaveLength(100);
	});

	it("returns nothing for a topic with no analysis and no revisions", async () => {
		const { entries, nextCursor } = await listAnalysisTimeline(SCOPE);

		expect(entries).toEqual([]);
		expect(nextCursor).toBeNull();
	});
});
