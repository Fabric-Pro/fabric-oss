import { describe, expect, it } from "vitest";
import {
	type AnalysisSource,
	candidatesFor,
	chunkAnswers,
	estimateAnalysis,
	pickWinner,
	profileByType,
	profileSource,
	proposalRow,
	rankChunks,
	type ScoredCandidate,
	sampleSources,
	scoreRetrieval,
	type TypeProfile,
} from "../tuning";

const backlog = (id: string): AnalysisSource => ({
	id,
	contentType: "backlog",
	kind: "backlog",
	mimeType: "text/markdown",
	filename: `${id}.md`,
	text: ["# Backlog", "- EX-1 Login", "- EX-2 Logout", "- EX-3 Reset"].join(
		"\n",
	),
});

describe("profiling", () => {
	it("is deterministic and groups by type", () => {
		const sources = ["b", "a", "c", "e", "d", "f"].map(backlog);
		const first = sources.map(profileSource);
		const second = sources.map(profileSource);
		expect(first).toEqual(second);
		expect(first[0]).toMatchObject({ headings: 1, profile: "items" });
		const [type] = profileByType(first);
		expect(type).toMatchObject({
			contentType: "backlog",
			sources: 6,
			defaultProfile: "items",
			measurable: true,
		});
	});

	it("marks a type with fewer than five sources as not measurable", () => {
		const [type] = profileByType(
			["a", "b"].map(backlog).map(profileSource),
		);
		expect(type?.measurable).toBe(false);
		const row = proposalRow({ type: type as TypeProfile, scored: [] });
		expect(row.reason).toBe("not enough content to measure");
		expect(row.proposed).toBe("items");
	});

	it("samples evenly and the same way every time", () => {
		const items = Array.from({ length: 50 }, (_, i) => ({
			id: `s${100 + i}`,
		}));
		const a = sampleSources(items, 10);
		expect(a).toHaveLength(10);
		expect(sampleSources([...items].reverse(), 10)).toEqual(a);
	});

	it("bounds the cost estimate", () => {
		const estimate = estimateAnalysis(
			profileByType(
				["a", "b", "c", "d", "e"].map(backlog).map(profileSource),
			),
			3,
		);
		expect(estimate.sampledSources).toBe(5);
		expect(estimate.questions).toBe(20);
		expect(estimate.embeddingCalls).toBeGreaterThan(estimate.questions);
	});
});

describe("candidates", () => {
	it("measures only the current setting", () => {
		const [type] = profileByType(
			["a", "b", "c", "d", "e"].map(backlog).map(profileSource),
		);
		expect(
			candidatesFor(type as TypeProfile, { profile: "prose" }, "MEASURE"),
		).toHaveLength(1);
		const tune = candidatesFor(
			type as TypeProfile,
			{ profile: "prose" },
			"TUNE",
		);
		expect(tune.length).toBeGreaterThanOrEqual(2);
		expect(tune.length).toBeLessThanOrEqual(4);
		expect(tune[0]?.current).toBe(true);
	});
});

describe("scoring", () => {
	const q = {
		sourceId: "s1",
		question: "Who signs off the release?",
		answer: "QA signs off the release on Friday",
	};

	it("matches answers by passage and by source", () => {
		expect(
			chunkAnswers(
				{
					sourceId: "s1",
					text: "Notes. QA signs off the release on Friday.",
				},
				q,
			),
		).toBe(true);
		expect(
			chunkAnswers(
				{ sourceId: "s2", text: "QA signs off the release on Friday" },
				q,
			),
		).toBe(false);
	});

	it("computes recall@k and MRR on a fixed question set", () => {
		const hit = { sourceId: "s1", text: q.answer, score: 0.9 };
		const miss = { sourceId: "s1", text: "unrelated", score: 0.95 };
		const score = scoreRetrieval([
			{ question: q, ranked: [hit] },
			{ question: q, ranked: [miss, hit] },
			{ question: q, ranked: [miss] },
		]);
		expect(score.recallAtK).toBeCloseTo(2 / 3);
		expect(score.mrr).toBeCloseTo((1 + 0.5) / 3);
	});

	it("ranks by cosine with the project's top K and threshold", () => {
		const ranked = rankChunks(
			[1, 0],
			[
				{ sourceId: "a", text: "a", embedding: [1, 0] },
				{ sourceId: "b", text: "b", embedding: [0, 1] },
				{ sourceId: "c", text: "c", embedding: [0.9, 0.1] },
			],
			5,
			0.3,
		);
		expect(ranked.map((r) => r.sourceId)).toEqual(["a", "c"]);
	});

	it("picks the cheapest candidate within 5% of the best recall, ties to current", () => {
		const scored = (
			key: string,
			recall: number,
			chunks: number,
			current = false,
		): ScoredCandidate => ({
			candidate: { key, profile: "items", current },
			score: { questions: 20, recallAtK: recall, mrr: recall },
			chunks,
			embeddingTokens: chunks * 100,
		});
		expect(
			pickWinner([
				scored("current", 0.6, 50, true),
				scored("big", 0.9, 40),
				scored("small", 0.87, 30),
			])?.candidate.key,
		).toBe("small");
		expect(
			pickWinner([
				scored("current", 0.8, 30, true),
				scored("other", 0.8, 30),
			])?.candidate.key,
		).toBe("current");
	});
});
