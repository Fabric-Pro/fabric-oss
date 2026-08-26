/**
 * Regression test for the citation ratchet fix in `generateSummaryActivity`.
 *
 * Property under test: project-level enrichment (decisions/roadmap/repos) is
 * folded on the run's LAST fold, so its citations survive into the stored
 * references even across a many-batch run. Before the fix it was folded on the
 * FIRST fold; the registry is pruned to the newest digest's markers after every
 * fold, so in a multi-batch run those citations were ratcheted away and only the
 * final context batch's sources (in Fabric-Main, all meeting transcripts) were
 * left — the "only meetings appear as sources" bug.
 *
 * The fold is mocked to cite ONLY its own fold's markers (dropping carried
 * ones) — the worst-case ratchet — so a decision reference can only survive if
 * it was folded on the final batch.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const foldMock = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("@repo/ai/lib/context-summarization/summarize-project-context", () => ({
	foldContextBatch: foldMock.fn,
	SYSTEM_GUIDANCE: "SYS",
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@temporalio/activity", () => ({ heartbeat: vi.fn() }));

const db = vi.hoisted(() => ({
	getLatestCompletedContextSummary: vi.fn(),
	getContextSummaryCheckpoint: vi.fn(),
	getPromptByKey: vi.fn(),
	listAcceptedDecisionsForSummary: vi.fn(),
	listRoadmapItemsForSummary: vi.fn(),
	listCodeReposForSummary: vi.fn(),
	fetchProjectContextBatch: vi.fn(),
	countRawContextRows: vi.fn(),
	checkpointContextSummaryProgress: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	...db,
	CODE_REPO_SOURCE_TYPE: "CODE_REPO",
	DECISION_SOURCE_TYPE: "DECISION",
	ROADMAP_SOURCE_TYPE: "ROADMAP",
	CONTEXT_SUMMARY_ENGINE_VERSION: 2,
	DEFAULT_SOURCE_SELECTION: {
		context: true,
		decisions: true,
		roadmap: true,
		codeRepo: true,
	},
	SOURCE_SELECTION_KEYS: ["context", "decisions", "roadmap", "codeRepo"],
	estimateTokensFromChars: (n: number) => Math.ceil(n / 4),
	parseSourceSelection: (v: unknown) =>
		v ?? {
			context: true,
			decisions: true,
			roadmap: true,
			codeRepo: true,
		},
	parseSummaryReferences: (v: unknown) => (Array.isArray(v) ? v : []),
	parseSummaryStats: () => null,
}));

import { generateSummaryActivity } from "../generate-summary";

function contextRow(id: string, at: string) {
	return {
		id,
		type: "MEETING_TRANSCRIPT",
		content: `transcript ${id}`,
		createdAt: new Date(at),
		label: `Meeting ${id}`,
	};
}

// The worst-case ratchet: each fold cites ONLY the markers it was handed this
// batch (its context sources + any enrichment), never re-citing carried ones.
type Marked = { marker: string };
type FoldArgs = {
	batchSources: Marked[];
	decisions: Marked[];
	roadmapItems: Marked[];
	codeRepos: Marked[];
};
function citeOwnMarkersOnly() {
	foldMock.fn.mockImplementation(async (input: FoldArgs) => {
		const own = [
			...input.batchSources.map((s) => s.marker),
			...input.decisions.map((d) => d.marker),
			...input.roadmapItems.map((r) => r.marker),
			...input.codeRepos.map((r) => r.marker),
		];
		return {
			content: `digest ${own.map((m) => `[${m}]`).join("")}`,
			citedMarkers: own,
			model: "test-model",
			usage: {
				inputTokens: 10,
				outputTokens: 5,
				totalTokens: 15,
				costMicroUsd: 100,
			},
		};
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	db.getLatestCompletedContextSummary.mockResolvedValue(null); // FULL rebuild
	db.getContextSummaryCheckpoint.mockResolvedValue(null); // not resuming
	db.getPromptByKey.mockResolvedValue(null);
	db.listRoadmapItemsForSummary.mockResolvedValue([]);
	db.listCodeReposForSummary.mockResolvedValue([]);
	db.checkpointContextSummaryProgress.mockResolvedValue(undefined);
	db.countRawContextRows.mockResolvedValue(2);
	citeOwnMarkersOnly();
});

const RUN = {
	summaryId: "sum-1",
	projectId: "proj-1",
	projectName: "Proj",
	tenancy: { userId: "u1", organizationId: null },
	snapshotThrough: "2026-07-10T00:00:00.000Z",
};

describe("generateSummaryActivity — enrichment folds on the last batch", () => {
	it("keeps the decision reference across a two-batch run", async () => {
		db.listAcceptedDecisionsForSummary.mockResolvedValue([
			{
				id: "dec-1",
				title: "Use Postgres",
				decision: "PG only",
				rationale: "integrity",
				decisionDate: new Date("2026-06-01T00:00:00.000Z"),
			},
		]);
		db.fetchProjectContextBatch
			.mockResolvedValueOnce({
				sources: [contextRow("ctx-1", "2026-07-01T00:00:00.000Z")],
				hasMore: true,
				lastCreatedAt: new Date("2026-07-01T00:00:00.000Z"),
				lastId: "ctx-1",
			})
			.mockResolvedValueOnce({
				sources: [contextRow("ctx-2", "2026-07-02T00:00:00.000Z")],
				hasMore: false,
				lastCreatedAt: new Date("2026-07-02T00:00:00.000Z"),
				lastId: "ctx-2",
			});

		const result = await generateSummaryActivity(RUN);

		// Two context folds ran.
		expect(foldMock.fn).toHaveBeenCalledTimes(2);
		// Enrichment is folded on the LAST fold, not the first.
		expect(foldMock.fn.mock.calls[0][0].includeProjectSources).toBe(false);
		expect(foldMock.fn.mock.calls[0][0].decisions).toHaveLength(0);
		expect(foldMock.fn.mock.calls[1][0].includeProjectSources).toBe(true);
		expect(foldMock.fn.mock.calls[1][0].decisions).toHaveLength(1);

		// The decision reference survives into the stored references despite the
		// worst-case ratchet — this is exactly what regressed before the fix.
		const decisionRef = result.references.find(
			(r) => r.sourceType === "DECISION",
		);
		expect(decisionRef).toBeDefined();
		expect(decisionRef?.sourceId).toBe("dec-1");
	});

	it("still summarizes an enrichment-only run with no raw context", async () => {
		db.listAcceptedDecisionsForSummary.mockResolvedValue([
			{
				id: "dec-1",
				title: "Use Postgres",
				decision: "PG only",
				rationale: "integrity",
				decisionDate: new Date("2026-06-01T00:00:00.000Z"),
			},
		]);
		db.fetchProjectContextBatch.mockResolvedValueOnce({
			sources: [],
			hasMore: false,
			lastCreatedAt: null,
			lastId: null,
		});

		const result = await generateSummaryActivity(RUN);

		expect(foldMock.fn).toHaveBeenCalledTimes(1);
		expect(foldMock.fn.mock.calls[0][0].includeProjectSources).toBe(true);
		expect(result.references.some((r) => r.sourceType === "DECISION")).toBe(
			true,
		);
	});

	it("folds enrichment into the final allowed batch when the MAX_BATCHES cap is hit", async () => {
		db.listAcceptedDecisionsForSummary.mockResolvedValue([
			{
				id: "dec-1",
				title: "Use Postgres",
				decision: "PG only",
				rationale: "integrity",
				decisionDate: new Date("2026-06-01T00:00:00.000Z"),
			},
		]);
		// Every batch reports more remains, so the natural last fold (!hasMore)
		// never arrives — the run is stopped only by the MAX_BATCHES cap. This is
		// the case where enrichment used to be silently dropped.
		let n = 0;
		db.fetchProjectContextBatch.mockImplementation(async () => {
			n += 1;
			return {
				sources: [contextRow(`ctx-${n}`, "2026-07-01T00:00:00.000Z")],
				hasMore: true,
				lastCreatedAt: new Date("2026-07-01T00:00:00.000Z"),
				lastId: `ctx-${n}`,
			};
		});

		const result = await generateSummaryActivity(RUN);

		// The cap stopped the run (incomplete coverage), but enrichment still made it in.
		expect(result.stats.incompleteCoverage).toBe(true);
		expect(result.references.some((r) => r.sourceType === "DECISION")).toBe(
			true,
		);
	});

	it("keeps the prior digest when the final (enrichment) fold returns empty", async () => {
		db.listAcceptedDecisionsForSummary.mockResolvedValue([
			{
				id: "dec-1",
				title: "Use Postgres",
				decision: "PG only",
				rationale: "integrity",
				decisionDate: new Date("2026-06-01T00:00:00.000Z"),
			},
		]);
		db.fetchProjectContextBatch
			.mockResolvedValueOnce({
				sources: [contextRow("ctx-1", "2026-07-01T00:00:00.000Z")],
				hasMore: true,
				lastCreatedAt: new Date("2026-07-01T00:00:00.000Z"),
				lastId: "ctx-1",
			})
			.mockResolvedValueOnce({
				sources: [contextRow("ctx-2", "2026-07-02T00:00:00.000Z")],
				hasMore: false,
				lastCreatedAt: new Date("2026-07-02T00:00:00.000Z"),
				lastId: "ctx-2",
			});

		// Fold 1 (context) builds a digest; fold 2 (the last/enrichment fold) returns
		// EMPTY — the flaky model response that used to wipe the whole summary.
		const usage = {
			inputTokens: 1,
			outputTokens: 1,
			totalTokens: 2,
			costMicroUsd: 1,
		};
		foldMock.fn
			.mockResolvedValueOnce({
				content: "digest [S1]",
				citedMarkers: ["S1"],
				model: "m",
				usage,
			})
			.mockResolvedValueOnce({
				content: "   ",
				citedMarkers: [],
				model: "m",
				usage,
			});

		const result = await generateSummaryActivity(RUN);

		// The empty final fold did NOT wipe the digest or the surviving references.
		expect(result.content).toBe("digest [S1]");
		expect(result.references.some((r) => r.sourceId === "ctx-1")).toBe(
			true,
		);
	});
});
