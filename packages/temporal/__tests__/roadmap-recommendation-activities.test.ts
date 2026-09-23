/**
 * Roadmap recommendation activities (Fizzy #2208).
 *
 *   - gather: grounds the batch in RAG + the live Roadmap + the description,
 *     and reports `insufficient` only when all three are empty;
 *   - persist: idempotent on the workflow run (through the locked
 *     once-per-run create), keeps Feature creates only (stripping every
 *     accept-time shortcut), collapses duplicate titles, keys every change,
 *     writes no row for an empty batch (FR40), and stamps the metadata the
 *     inbox and FR43 read.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks } = vi.hoisted(() => ({
	mocks: {
		retrieveProjectRagContext: vi.fn(),
		fetchBacklogSnapshot: vi.fn(),
		projectFindUnique: vi.fn(),
		createBatchOnce: vi.fn(),
	},
}));

vi.mock("@repo/database", async () => {
	const { normalizeBacklogTitle } = await vi.importActual<
		typeof import("../../database/utils")
	>("../../database/utils");
	return {
		db: { project: { findUnique: mocks.projectFindUnique } },
		createRoadmapRecommendationBatchOnce: mocks.createBatchOnce,
		normalizeBacklogTitle,
	};
});

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../src/activities/backlog-context/fetch-context", () => ({
	retrieveProjectRagContext: mocks.retrieveProjectRagContext,
}));

vi.mock("../src/activities/backlog-context/fetch-backlog-snapshot", () => ({
	fetchBacklogSnapshot: mocks.fetchBacklogSnapshot,
}));

vi.mock("../src/activities/backlog-context/analyze-context", () => ({
	ROADMAP_RECOMMEND_PROMPT_VERSION: "roadmap-recommend/v1",
}));

import type { ChangeProposal } from "../src/activities/backlog-context/analyze-context";
import {
	gatherRoadmapRecommendationContext,
	persistRoadmapRecommendations,
} from "../src/activities/roadmap-recommendation";

type Change = ChangeProposal["changes"][number];

function change(title: string, extra: Partial<Change> = {}): Change {
	return {
		type: "feature",
		action: "create",
		title: { to: title },
		reasoning: "grounded in the brief",
		sourceContext: "rag_context",
		...extra,
	} as Change;
}

function proposal(changes: Change[]): ChangeProposal {
	return {
		summary: "",
		contextSummary: "Grounded in the product brief.",
		changes,
	} as ChangeProposal;
}

const STATS = { ragChunkCount: 3, roadmapItemCount: 2, descriptionChars: 40 };

function persist(changes: Change[]) {
	return persistRoadmapRecommendations({
		projectId: "p1",
		userId: "u1",
		organizationId: "org-1",
		entryPoint: "MATURE_ROADMAP",
		requestedAt: "2026-09-23T10:00:00.000Z",
		workflowId: "roadmap-recommendation-p1",
		runId: "run-1",
		proposal: proposal(changes),
		stats: STATS,
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.createBatchOnce.mockImplementation(
		async (args: { changeCount: number }) => ({
			id: "batch-1",
			changeCount: args.changeCount,
			created: true,
		}),
	);
});

describe("gatherRoadmapRecommendationContext", () => {
	function seed(opts: {
		chunks: number;
		stories: number;
		description: string | null;
	}) {
		mocks.retrieveProjectRagContext.mockResolvedValue({
			success: true,
			formattedContext: opts.chunks > 0 ? "RAG: brokers need status" : "",
			chunkCount: opts.chunks,
		});
		mocks.fetchBacklogSnapshot.mockResolvedValue({
			epics: [],
			orphanFeatures: [],
			orphanStories: Array.from({ length: opts.stories }, (_, i) => ({
				id: `s${i}`,
				identifier: `F-00${i}`,
				title: `Item ${i}`,
				description: null,
				externalId: null,
				externalUrl: null,
			})),
		});
		mocks.projectFindUnique.mockResolvedValue({
			description: opts.description,
		});
	}

	it("returns the Roadmap, the grounding stats and the description inside the context", async () => {
		seed({ chunks: 2, stories: 1, description: "A lending portal." });
		const result = await gatherRoadmapRecommendationContext({
			projectId: "p1",
			userId: "u1",
			organizationId: "org-1",
		});
		expect(mocks.retrieveProjectRagContext).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "p1",
				userId: "u1",
				organizationId: "org-1",
				topK: 20,
			}),
		);
		expect(result.stats).toEqual({
			ragChunkCount: 2,
			roadmapItemCount: 1,
			descriptionChars: "A lending portal.".length,
		});
		expect(result.existingBacklog.stories[0]).toMatchObject({
			id: "s0",
			title: "Item 0",
		});
		expect(result.fetchedContext.ragContext).toContain("A lending portal.");
		expect(result.fetchedContext.ragContext).toContain("RAG: brokers");
		expect(result.insufficient).toBe(false);
	});

	it.each([
		{ chunks: 0, stories: 0, description: null, insufficient: true },
		{
			chunks: 0,
			stories: 0,
			description: "x".repeat(249),
			insufficient: true,
		},
		{
			chunks: 0,
			stories: 0,
			description: "x".repeat(250),
			insufficient: false,
		},
		{ chunks: 1, stories: 0, description: null, insufficient: false },
		{ chunks: 0, stories: 1, description: null, insufficient: false },
	])(
		"insufficient=$insufficient for chunks=$chunks stories=$stories",
		async ({ insufficient, ...opts }) => {
			seed(opts);
			const result = await gatherRoadmapRecommendationContext({
				projectId: "p1",
				userId: "u1",
			});
			expect(result.insufficient).toBe(insufficient);
		},
	);
});

describe("persistRoadmapRecommendations", () => {
	it("returns the existing batch for the same workflow run without writing again", async () => {
		mocks.createBatchOnce.mockResolvedValue({
			id: "batch-prev",
			changeCount: 27,
			created: false,
		});
		const result = await persist([change("Saved searches")]);
		expect(result).toEqual({
			outcome: "GENERATED",
			proposalId: "batch-prev",
			changeCount: 27,
		});
		expect(mocks.createBatchOnce).toHaveBeenCalledWith(
			expect.objectContaining({
				workflowRunId: "run-1",
				projectId: "p1",
			}),
		);
	});

	it("keeps the first of two candidates whose titles normalize alike", async () => {
		await persist([
			change("Saved searches", { reasoning: "first" }),
			change("Audit log"),
			change("  saved SEARCHES ", { reasoning: "second" }),
		]);
		const args = mocks.createBatchOnce.mock.calls[0]?.[0];
		expect(args.changeCount).toBe(2);
		expect(args.summary).toBe(
			"2 features recommended from project context",
		);
		expect(
			args.proposal.changes.map(
				(c: Change) => `${c.title.to}/${c.reasoning}`,
			),
		).toEqual(["Saved searches/first", "Audit log/grounded in the brief"]);
	});

	it("keys every kept change by run and position, overriding a model-supplied key", async () => {
		await persist([
			change("Saved searches", { sourceChangeKey: "model:0" }),
			change("Crash on save", { type: "bug" }),
			change("Audit log"),
		]);
		const args = mocks.createBatchOnce.mock.calls[0]?.[0];
		expect(
			args.proposal.changes.map((c: Change) => c.sourceChangeKey),
		).toEqual(["run-1:0", "run-1:1"]);
	});

	it("keeps Feature creates only and strips the accept-time shortcuts", async () => {
		await persist([
			change("Saved searches", {
				sourceRef: "AA-01",
				predrafted: true,
				kindOverride: "BUG",
				deliveryTrack: "SPIKE",
			}),
			change("Crash on save", { type: "bug" }),
			change("Payments", { type: "epic" } as Partial<Change>),
			change("Rename login", { action: "update", existingId: "s1" }),
		]);
		const args = mocks.createBatchOnce.mock.calls[0]?.[0];
		expect(args.changeCount).toBe(1);
		expect(args.proposal.changes).toHaveLength(1);
		const [kept] = args.proposal.changes;
		expect(kept.title.to).toBe("Saved searches");
		expect(kept.sourceContext).toBe("multiple");
		// The one field added back: an index-resolution key, not a shortcut.
		expect(kept.sourceChangeKey).toBe("run-1:0");
		for (const field of [
			"sourceRef",
			"predrafted",
			"kindOverride",
			"deliveryTrack",
		]) {
			expect(kept).not.toHaveProperty(field);
		}
	});

	it("writes no row when nothing survives the filter (FR40)", async () => {
		const result = await persist([
			change("Crash on save", { type: "bug" }),
		]);
		expect(result).toEqual({
			outcome: "NO_RECOMMENDATIONS",
			proposalId: null,
			changeCount: 0,
		});
		expect(mocks.createBatchOnce).not.toHaveBeenCalled();
	});

	it("stamps the batch metadata, with syncToPM false (FR43)", async () => {
		const result = await persist([
			change("Saved searches"),
			change("Audit log"),
		]);
		expect(result).toEqual({
			outcome: "GENERATED",
			proposalId: "batch-1",
			changeCount: 2,
		});
		const args = mocks.createBatchOnce.mock.calls[0]?.[0];
		expect(args).toMatchObject({
			projectId: "p1",
			workflowRunId: "run-1",
			summary: "2 features recommended from project context",
			changeCount: 2,
			userId: "u1",
			organizationId: "org-1",
		});
		expect(args.sourceMetadata).toEqual({
			entryPoint: "MATURE_ROADMAP",
			requestedByUserId: "u1",
			requestedAt: "2026-09-23T10:00:00.000Z",
			workflowId: "roadmap-recommendation-p1",
			workflowRunId: "run-1",
			generation: {
				generator: "analyzeContextAndPropose/recommend",
				promptVersion: "roadmap-recommend/v1",
				flagKey: "ROADMAP_RECOMMENDATIONS",
			},
			contextSummary: "Grounded in the product brief.",
			contextSources: STATS,
			syncToPM: false,
		});
	});
});
