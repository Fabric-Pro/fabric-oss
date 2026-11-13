import { vi } from "vitest";

vi.mock("@repo/database", () => ({}));
vi.mock("../embedding", () => ({ generateQueryEmbedding: vi.fn() }));
vi.mock("./summary-injection", () => ({ applyContextSummary: vi.fn() }));
vi.mock("./search-hits", () => ({
	searchProjectContextHits: vi.fn(),
	hydrateProjectContextHits: vi.fn(),
}));
vi.mock("../reranking/select-project-contexts", () => ({
	selectProjectContexts: vi.fn(),
}));

import { describe, expect, it } from "vitest";
import { chunkPool, mergeAdjacent, rankedPool } from "./ranked-pool";
import { formatContextsForPrompt, type RetrievedContext } from "./retrieval";

const source = (
	id: string,
	contents: string[],
): RetrievedContext & {
	matchedPassages: NonNullable<RetrievedContext["matchedPassages"]>;
} => ({
	id,
	type: "TEXT",
	content: `WHOLE ${id}`,
	score: 0.5,
	matchedPassages: contents.map((content, chunkIndex) => ({
		content,
		chunkIndex,
		score: 1 - chunkIndex / 100,
	})),
});

describe("ranked passage pool (ported evaluation rules)", () => {
	it("truncates globally by comparable retrieval score", () => {
		const a = source("a", ["a0", "a1"]);
		const b = source("b", ["b0", "b1"]);
		a.matchedPassages[0].score = 0.1;
		b.matchedPassages[0].score = 0.9;
		const pool = chunkPool([a, b], 2);
		expect(pool.rawCandidates).toBe(4);
		expect(pool.chunks.map((p) => p.content)).toEqual(["a1", "b1"]);
	});
	it("uses rerank order, ceil(K/2) cap, spillover and chunk-order rendering", () => {
		const contexts = [
			source("a", ["A0", "A1", "A2"]),
			source("b", ["B0", "B1"]),
			source("c", ["C0"]),
		];
		const scores: Record<string, number> = {
			A0: 0.7,
			A1: 0.8,
			A2: 0.9,
			B0: 0.3,
			B1: 0.4,
			C0: 0.2,
		};
		const ranked = chunkPool(contexts, 50).chunks.map((p) => ({
			...p,
			rerankedScore: scores[p.content],
		}));
		const kept = rankedPool(contexts, ranked, 3);
		expect(kept.keptChunks).toBe(3);
		expect(kept.keptSources).toBe(2);
		expect(kept.context).not.toContain("A0");
		expect(kept.context).not.toContain("B0");
		expect(kept.context).toContain("B1");
		expect(kept.context.indexOf("A1")).toBeLessThan(
			kept.context.indexOf("A2"),
		);
		const capped = rankedPool(contexts, ranked, 4);
		expect(capped.keptChunks).toBe(4);
		expect(capped.context).toContain("B0");
		expect(capped.context).not.toContain("A0");
	});
	it("matches the evaluation rankedPool text for a synthetic fixture with source metadata", () => {
		const a = {
			...source("a", ["A0", "A1", "A2"]),
			sourceTitle: "Design",
			sourceType: "Specification",
			aiInstructions: "Use these requirements.",
			metadata: { roleTag: "API" },
		};
		const b = {
			...source("b", ["B0", "B1"]),
			filename: "notes.md",
			type: "FILE",
			score: 0.7,
		};
		const chunks = chunkPool([a, b], 50).chunks.map((p) => ({
			...p,
			rerankedScore: (
				{ A0: 0.1, A1: 0.8, A2: 0.9, B0: 0.2, B1: 1 } as Record<
					string,
					number
				>
			)[p.content],
		}));
		// Golden text from the evaluated passage selector on this synthetic fixture.
		expect(rankedPool([a, b], chunks, 3).context).toBe(
			'<project_context>\nThe following context was retrieved from the project\'s knowledge base. Use this information to inform your response.\n\nIt is a similarity-ranked SAMPLE, not a complete or date-ordered listing: retrieval has\nno date dimension, so absence from this set is not evidence that a document does not\nexist, and the newest item here is not necessarily the most recent one on record\n(Fizzy #2473). For "what happened on <date>" questions, use a date-filtered tool.\n\n--- notes.md (FILE, relevance: 70.0%) ---\nB1\n\n--- API: Design (Specification, TEXT, relevance: 50.0%) ---\n> Source guidance: Use these requirements.\nA1\n\nA2\n</project_context>',
		);
	});
	it("does not substitute or truncate whole documents", () => {
		const c = source("a", ["X".repeat(50000)]);
		const result = rankedPool(
			[c],
			chunkPool([c], 50).chunks.map((p) => ({ ...p, rerankedScore: 1 })),
			20,
		);
		expect(result.context).toContain("X".repeat(50000));
		expect(result.context).not.toContain("WHOLE a");
	});
	it("preserves unpositioned chunks in selection order after positioned chunks", () => {
		const c = source("a", []);
		const chunks = [
			{
				id: "p0",
				sourceId: "a",
				content: "UNKNOWN FIRST",
				score: 1,
				rerankedScore: 1,
			},
			{
				id: "p1",
				sourceId: "a",
				content: "POSITIONED",
				chunkIndex: 1,
				score: 1,
				rerankedScore: 0.9,
			},
			{
				id: "p2",
				sourceId: "a",
				content: "UNKNOWN LAST",
				score: 1,
				rerankedScore: 0.8,
			},
		];
		expect(rankedPool([c], chunks, 6).context).toContain(
			"POSITIONED\n\nUNKNOWN FIRST\n\nUNKNOWN LAST",
		);
	});
	it("rejects a selected chunk without a source", () => {
		expect(() =>
			rankedPool(
				[],
				[
					{
						id: "p",
						sourceId: "missing",
						content: "text",
						score: 1,
						rerankedScore: 1,
					},
				],
				20,
			),
		).toThrow("RANKED_SOURCE_MISSING");
	});
});

const pair = (left: string, right: string) => [
	{ content: left, score: 1, chunkIndex: 0 },
	{ content: right, score: 1, chunkIndex: 1 },
];
for (const [left, right] of [
	["Use the API", "It returns"],
	["abcXYZ", "XYZdef"],
	["| Name | Value |", "| Note | Detail |"],
]) {
	it(`preserves adjacent text: ${left}`, () =>
		expect(mergeAdjacent(pair(left, right))).toBe(`${left}\n\n${right}`));
}
for (const size of [49, 50, 500, 501]) {
	it(`bounds overlap at ${size}`, () => {
		const overlap = `X${"o".repeat(size - 2)}Z`;
		const left = `LEFT${overlap}`;
		const right = `${overlap}RIGHT`;
		expect(mergeAdjacent(pair(left, right))).toBe(
			size >= 50 && size <= 500
				? `LEFT${overlap}RIGHT`
				: `${left}\n\n${right}`,
		);
	});
}
it("uses the project's overlap upper bound", () => {
	const overlap = `X${"o".repeat(98)}Z`;
	expect(mergeAdjacent(pair(`LEFT${overlap}`, `${overlap}RIGHT`), 80)).toBe(
		`LEFT${overlap}\n\n${overlap}RIGHT`,
	);
});
for (const indices of [
	[0, 2],
	[undefined, undefined],
]) {
	it(`does not merge nonadjacent or unpositioned chunks: ${indices}`, () => {
		const overlap = "O".repeat(50);
		expect(
			mergeAdjacent([
				{ content: `LEFT${overlap}`, score: 1, chunkIndex: indices[0] },
				{
					content: `${overlap}RIGHT`,
					score: 1,
					chunkIndex: indices[1],
				},
			]),
		).toBe(`LEFT${overlap}\n\n${overlap}RIGHT`);
	});
}
it("counts merged and joined adjacent pairs, excluding gaps", () => {
	const overlap = "O".repeat(50);
	const merged = { mergedPairs: 0, joinedPairs: 0 };
	mergeAdjacent(pair(`LEFT${overlap}`, `${overlap}RIGHT`), 500, merged);
	expect(merged).toEqual({ mergedPairs: 1, joinedPairs: 0 });
	const joined = { mergedPairs: 0, joinedPairs: 0 };
	mergeAdjacent(pair("Use the API", "It returns"), 500, joined);
	expect(joined).toEqual({ mergedPairs: 0, joinedPairs: 1 });
	const gap = { mergedPairs: 0, joinedPairs: 0 };
	mergeAdjacent(
		[
			{ content: `LEFT${overlap}`, score: 1, chunkIndex: 0 },
			{ content: `${overlap}RIGHT`, score: 1, chunkIndex: 2 },
		],
		500,
		gap,
	);
	expect(gap).toEqual({ mergedPairs: 0, joinedPairs: 0 });
});

for (const marker of [
	{ type: "PROJECT_SUMMARY" },
	{ type: "TEXT", metadata: { isSummary: true } },
]) {
	it(`preserves a whole summary outside pooling and the chunk quota (${JSON.stringify(marker)})`, () => {
		const summary = {
			...source("summary", ["SUMMARY CHUNK MUST NOT BE POOLED"]),
			content: "Complete project summary and reference legend.",
			...marker,
		};
		const a = source("a", ["A0", "A1", "A2"]);
		const b = source("b", ["B0", "B1"]);
		const contexts = [a, summary, b];
		const pool = chunkPool(contexts, 50);
		expect(pool.rawCandidates).toBe(5);
		expect(pool.chunks.map((p) => p.sourceId)).not.toContain("summary");
		const scores: Record<string, number> = {
			A0: 0.1,
			A1: 0.8,
			A2: 0.9,
			B0: 0.2,
			B1: 0.7,
		};
		const result = rankedPool(
			contexts,
			pool.chunks.map((p) => ({
				...p,
				rerankedScore: scores[p.content],
			})),
			3,
		);
		expect(result.keptChunks).toBe(3);
		expect(result.keptSources).toBe(2);
		expect(result.context).toBe(
			formatContextsForPrompt([
				summary,
				{ ...a, content: "A1\n\nA2" },
				{ ...b, content: "B1" },
			]),
		);
	});
}
