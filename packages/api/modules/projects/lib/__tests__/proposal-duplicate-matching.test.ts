/**
 * Embedding side of the Proposal Inbox duplicate flags: one batched corpus
 * request for every unresolved inbox item, tickets from the routing
 * shortlist (under the duplicate bar only when the routing judge confirms
 * them), and a direct embedding when the Roadmap has no tickets.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	listItems: vi.fn(),
	loadCorpus: vi.fn(),
	embed: vi.fn(),
	resolveModels: vi.fn(),
	judge: vi.fn(),
	warn: vi.fn(),
}));

vi.mock("@repo/database", async () => ({
	...(await vi.importActual<Record<string, unknown>>(
		"@repo/database/prisma/queries/projects/duplicate-detection",
	)),
	listUnresolvedPendingProposalItems: mocks.listItems,
	routingConfidenceThreshold: () => 0.8,
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: mocks.warn, error: vi.fn() },
}));

vi.mock("@repo/rag", () => ({ generateEmbeddings: mocks.embed }));

vi.mock("@repo/temporal/backlog-routing-core", async () => {
	const linkCore = await vi.importActual<
		typeof import("../../../../../temporal/src/lib/action-item-link-core")
	>("../../../../../temporal/src/lib/action-item-link-core");
	return {
		loadRoutingCorpus: mocks.loadCorpus,
		resolveRoutingModels: mocks.resolveModels,
		judgeRoutingItem: mocks.judge,
		// The real shortlist rule, over the corpus the test hands in.
		routingShortlist: (
			embedding: number[],
			corpus: {
				candidateVectors: {
					id: string;
					identifier: string;
					embedding: number[];
				}[];
				storyById: Map<string, { id: string; title: string }>;
			},
		) =>
			linkCore
				.selectCandidates(embedding, corpus.candidateVectors)
				.map((scored) => ({
					storyId: scored.storyId,
					identifier: scored.identifier,
					title: corpus.storyById.get(scored.storyId)?.title ?? "",
					similarity: scored.similarity,
				})),
	};
});

import {
	detectInboxDuplicates,
	findProposalInboxMatches,
	MAX_INBOX_ITEMS_SCANNED,
	manualEntryCorpusTexts,
} from "../proposal-duplicate-matching";

const item = (proposalId: string, changeIndex: number, title: string) => ({
	proposalId,
	changeIndex,
	source: "TEAMS_CHANNEL",
	proposalSummary: `Summary of ${proposalId}`,
	title,
	description: "",
});

const scope = {
	projectId: "project-1",
	userId: "user-1",
	organizationId: "org-1",
};

const detect = (judgeSignal = new AbortController().signal) =>
	detectInboxDuplicates({
		...scope,
		maxStaleEmbeds: 200,
		logPrefix: "[T]",
		judgeSignal,
	});

/** A ready corpus with one ticket at the given vector. */
const readyCorpus = (
	itemEmbeddings: number[][],
	ticketEmbedding: number[],
) => ({
	kind: "ready",
	itemEmbeddings,
	candidateVectors: [
		{ id: "story-1", identifier: "F-12", embedding: ticketEmbedding },
	],
	storyById: new Map([["story-1", { id: "story-1", title: "Dark theme" }]]),
	textByStoryId: new Map(),
	skippedStale: 0,
});

/** A unit vector at `similarity` cosine from [1, 0]. */
const at = (similarity: number) => [
	similarity,
	Math.sqrt(1 - similarity * similarity),
];

const MODELS = { judge: { model: "example-judge" }, decisionModel: null };

const TARGET = {
	storyId: "story-1",
	identifier: "F-12",
	title: "Dark theme",
	similarity: 0.6,
};

beforeEach(() => {
	vi.resetAllMocks();
	mocks.listItems.mockResolvedValue([
		item("open", 0, "Queue exports"),
		item("open", 2, "Dark mode"),
		item("other", 1, "Export queue"),
	]);
	mocks.resolveModels.mockResolvedValue(MODELS);
});

describe("detectInboxDuplicates", () => {
	it("embeds every inbox item in the corpus request and flags each against tickets and the others", async () => {
		mocks.loadCorpus.mockResolvedValue(
			readyCorpus(
				[
					[1, 0],
					[0, 1],
					[1, 0],
				],
				[0, 1],
			),
		);

		const flags = await detect();

		expect(mocks.listItems).toHaveBeenCalledWith({
			projectId: "project-1",
			maxItems: MAX_INBOX_ITEMS_SCANNED,
		});
		expect(mocks.loadCorpus).toHaveBeenCalledTimes(1);
		expect(mocks.loadCorpus).toHaveBeenCalledWith(
			expect.objectContaining({
				itemTexts: ["Queue exports", "Dark mode", "Export queue"],
				maxStaleEmbeds: 200,
			}),
		);
		expect(mocks.embed).not.toHaveBeenCalled();
		expect(flags).toEqual([
			{
				proposalId: "open",
				changeIndex: 0,
				matches: [
					{
						kind: "proposal_item",
						proposalId: "other",
						matchChangeIndex: 1,
						title: "Export queue",
						similarity: 1,
					},
				],
			},
			{
				proposalId: "open",
				changeIndex: 2,
				matches: [
					{
						kind: "story",
						storyId: "story-1",
						identifier: "F-12",
						title: "Dark theme",
						similarity: 1,
					},
				],
			},
			{
				proposalId: "other",
				changeIndex: 1,
				matches: [
					{
						kind: "proposal_item",
						proposalId: "open",
						matchChangeIndex: 0,
						title: "Queue exports",
						similarity: 1,
					},
				],
			},
		]);
	});

	it("flags a 0.6 ticket when the routing judge says enrich", async () => {
		mocks.listItems.mockResolvedValue([item("open", 0, "Export as CSV")]);
		mocks.loadCorpus.mockResolvedValue(readyCorpus([at(0.6)], [1, 0]));
		mocks.judge.mockResolvedValue({
			kind: "enrich",
			confidence: 0.9,
			reasoning: null,
			target: TARGET,
			alternatives: [TARGET],
		});

		const flags = await detect();

		expect(mocks.judge).toHaveBeenCalledTimes(1);
		expect(mocks.judge).toHaveBeenCalledWith(
			expect.objectContaining({
				itemText: "Export as CSV",
				judge: MODELS.judge,
				decisionModel: MODELS.decisionModel,
				threshold: 0.8,
				userId: "user-1",
				organizationId: "org-1",
				projectId: "project-1",
				abortSignal: expect.any(AbortSignal),
			}),
		);
		expect(flags).toEqual([
			{
				proposalId: "open",
				changeIndex: 0,
				matches: [{ kind: "story", ...TARGET }],
			},
		]);
	});

	it("does not flag a 0.6 ticket when the routing judge says create", async () => {
		mocks.listItems.mockResolvedValue([item("open", 0, "Export as CSV")]);
		mocks.loadCorpus.mockResolvedValue(readyCorpus([at(0.6)], [1, 0]));
		mocks.judge.mockResolvedValue({
			kind: "create",
			confidence: 0.7,
			reasoning: null,
			alternatives: [TARGET],
		});

		await expect(detect()).resolves.toEqual([]);
		expect(mocks.judge).toHaveBeenCalledTimes(1);
	});

	it("flags a 0.75 ticket without asking the judge", async () => {
		mocks.listItems.mockResolvedValue([item("open", 0, "Export as CSV")]);
		mocks.loadCorpus.mockResolvedValue(readyCorpus([at(0.75)], [1, 0]));

		const flags = await detect();

		expect(mocks.resolveModels).not.toHaveBeenCalled();
		expect(mocks.judge).not.toHaveBeenCalled();
		expect(flags[0]?.matches).toEqual([
			expect.objectContaining({
				kind: "story",
				identifier: "F-12",
				similarity: expect.closeTo(0.75, 5),
			}),
		]);
	});

	it("judges at most eight band items, strongest first, in one stage", async () => {
		const band = [0.52, 0.69, 0.55, 0.61, 0.66, 0.58, 0.63, 0.6, 0.67];
		mocks.listItems.mockResolvedValue(
			band.map((_, index) => item(`p-${index}`, 0, `Item ${index}`)),
		);
		mocks.loadCorpus.mockResolvedValue(readyCorpus(band.map(at), [1, 0]));
		mocks.judge.mockResolvedValue({
			kind: "create",
			confidence: 0.7,
			reasoning: null,
			alternatives: [],
		});

		await detect();

		expect(mocks.resolveModels).toHaveBeenCalledTimes(1);
		expect(mocks.judge).toHaveBeenCalledTimes(8);
		const judged = mocks.judge.mock.calls.map(
			([params]: [{ itemEmbedding: number[] }]) =>
				params.itemEmbedding[0],
		);
		expect(judged).toEqual([...band].sort((a, b) => b - a).slice(0, 8));
	});

	it("returns the flags at or above the bar when the judge stage aborts", async () => {
		mocks.listItems.mockResolvedValue([
			item("open", 0, "Export as CSV"),
			item("other", 0, "Dark mode"),
		]);
		// The first item's ticket is in the band (0.6), the second's over the
		// bar (0.8); the two items are orthogonal, so they never match.
		mocks.loadCorpus.mockResolvedValue(
			readyCorpus([[0.6, -0.8], at(0.8)], [1, 0]),
		);
		const judgeStage = new AbortController();
		mocks.judge.mockImplementation(() => {
			judgeStage.abort();
			return new Promise(() => {});
		});

		const flags = await detect(judgeStage.signal);

		expect(mocks.judge).toHaveBeenCalledTimes(1);
		expect(flags).toEqual([
			{
				proposalId: "other",
				changeIndex: 0,
				matches: [
					expect.objectContaining({
						kind: "story",
						similarity: expect.closeTo(0.8, 5),
					}),
				],
			},
		]);
		expect(mocks.warn).toHaveBeenCalledWith("[T] judge stage incomplete", {
			projectId: "project-1",
			items: 1,
			failed: 0,
			unfinished: 1,
		});
	});

	it("keeps the flags at or above the bar when the judge model cannot be resolved", async () => {
		mocks.listItems.mockResolvedValue([
			item("open", 0, "Export as CSV"),
			item("other", 0, "Dark mode"),
		]);
		mocks.loadCorpus.mockResolvedValue(
			readyCorpus([[0.6, -0.8], at(0.8)], [1, 0]),
		);
		mocks.resolveModels.mockRejectedValue(new Error("no judge model"));

		const flags = await detect();

		expect(mocks.judge).not.toHaveBeenCalled();
		expect(flags.map((flag) => flag.proposalId)).toEqual(["other"]);
		expect(mocks.warn).toHaveBeenCalledWith("[T] judge stage skipped", {
			projectId: "project-1",
			items: 1,
			aborted: false,
		});
	});

	it("embeds the items directly when the Roadmap has no tickets", async () => {
		mocks.loadCorpus.mockResolvedValue({ kind: "empty" });
		mocks.embed.mockResolvedValue({
			embeddings: [
				[1, 0],
				[0, 1],
				[1, 0],
			],
			model: "example-embedding-model",
		});

		const flags = await detect();

		expect(mocks.embed).toHaveBeenCalledTimes(1);
		expect(mocks.embed.mock.calls[0]?.[0]).toEqual([
			"Queue exports",
			"Dark mode",
			"Export queue",
		]);
		expect(flags.map((f) => [f.proposalId, f.changeIndex])).toEqual([
			["open", 0],
			["other", 1],
		]);
	});

	it("loads no corpus for an empty inbox", async () => {
		mocks.listItems.mockResolvedValue([]);

		await expect(detect()).resolves.toEqual([]);
		expect(mocks.loadCorpus).not.toHaveBeenCalled();
		expect(mocks.embed).not.toHaveBeenCalled();
	});
});

describe("findProposalInboxMatches", () => {
	const entries = [
		{ item: item("p-1", 0, "Queue exports"), text: "Queue exports" },
		{ item: item("p-2", 3, "Dark mode"), text: "Dark mode" },
	];

	it("reads the entry's and the items' vectors from the corpus batch", async () => {
		const matches = await findProposalInboxMatches({
			...scope,
			itemText: "Rate limit exports",
			entries,
			corpus: {
				kind: "ready",
				itemEmbeddings: [
					[1, 0],
					[1, 0],
					[0, 1],
				],
			},
		});

		const texts = manualEntryCorpusTexts("Rate limit exports", entries);
		expect(texts).toEqual([
			"Rate limit exports",
			"Queue exports",
			"Dark mode",
		]);
		expect(mocks.embed).not.toHaveBeenCalled();
		expect(matches).toEqual([
			{
				proposalId: "p-1",
				changeIndex: 0,
				title: "Queue exports",
				summary: "Summary of p-1",
				source: "TEAMS_CHANNEL",
				similarity: 1,
			},
		]);
	});

	it("embeds nothing when the inbox has no items", async () => {
		await expect(
			findProposalInboxMatches({
				...scope,
				itemText: "Rate limit exports",
				entries: [],
				corpus: { kind: "empty" },
			}),
		).resolves.toEqual([]);
		expect(mocks.embed).not.toHaveBeenCalled();
	});
});
