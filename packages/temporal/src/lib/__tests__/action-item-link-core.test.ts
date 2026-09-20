import { describe, expect, it } from "vitest";
import {
	buildMatchPrompt,
	CANDIDATE_FLOOR,
	classifyMatch,
	DEFAULT_MIN_CONFIDENCE,
	MAX_CANDIDATES_PER_ITEM,
	resolveMinConfidence,
	selectCandidates,
} from "../action-item-link-core";

const vec = (x: number, y: number) => [x, y];

describe("selectCandidates", () => {
	it("keeps a story above the cosine floor and drops one below it", () => {
		const result = selectCandidates(vec(1, 0), [
			{ id: "s1", identifier: "F-1", embedding: vec(1, 0) },
			{ id: "s2", identifier: "F-2", embedding: vec(0, 1) },
		]);
		expect(result.map((r) => r.storyId)).toEqual(["s1"]);
	});

	it("returns strongest first and caps the list", () => {
		const stories = Array.from({ length: 12 }, (_, i) => ({
			id: `s${i}`,
			identifier: `F-${i}`,
			embedding: vec(1, i / 100),
		}));
		const result = selectCandidates(vec(1, 0), stories);
		expect(result).toHaveLength(MAX_CANDIDATES_PER_ITEM);
		for (let i = 1; i < result.length; i++) {
			expect(result[i - 1].similarity).toBeGreaterThanOrEqual(
				result[i].similarity,
			);
		}
	});

	it("returns nothing when every story is below the floor", () => {
		expect(
			selectCandidates(vec(1, 0), [
				{ id: "s1", identifier: "F-1", embedding: vec(0, 1) },
			]),
		).toEqual([]);
		expect(CANDIDATE_FLOOR).toBe(0.5);
	});

	it("returns nothing for an empty backlog", () => {
		expect(selectCandidates(vec(1, 0), [])).toEqual([]);
	});

	it("ignores a story whose vector has a different dimension", () => {
		// cosineSimilarity returns 0 on a length mismatch, which is below the
		// floor — a model change mid-run must not produce a garbage match.
		expect(
			selectCandidates(vec(1, 0), [
				{ id: "s1", identifier: "F-1", embedding: [1, 0, 0] },
			]),
		).toEqual([]);
	});

	it("carries the identifier through, since the verifier answers by identifier", () => {
		const [candidate] = selectCandidates(vec(1, 0), [
			{ id: "story_cuid", identifier: "F-42", embedding: vec(1, 0) },
		]);
		expect(candidate).toMatchObject({
			storyId: "story_cuid",
			identifier: "F-42",
		});
	});
});

describe("resolveMinConfidence", () => {
	it("falls back to the default when unset", () => {
		expect(resolveMinConfidence({})).toBe(DEFAULT_MIN_CONFIDENCE);
		expect(DEFAULT_MIN_CONFIDENCE).toBe(0.7);
	});

	it("reads a tunable override", () => {
		expect(
			resolveMinConfidence({
				MEETING_ACTION_ITEM_LINK_MIN_CONFIDENCE: "0.85",
			}),
		).toBe(0.85);
	});

	it("ignores a non-numeric override", () => {
		expect(
			resolveMinConfidence({
				MEETING_ACTION_ITEM_LINK_MIN_CONFIDENCE: "nope",
			}),
		).toBe(DEFAULT_MIN_CONFIDENCE);
	});

	it("ignores an out-of-range override rather than disabling the threshold", () => {
		// 0 would link everything the verifier glanced at; >1 would link nothing.
		// Both are far more likely to be a typo than an intent.
		expect(
			resolveMinConfidence({
				MEETING_ACTION_ITEM_LINK_MIN_CONFIDENCE: "0",
			}),
		).toBe(DEFAULT_MIN_CONFIDENCE);
		expect(
			resolveMinConfidence({
				MEETING_ACTION_ITEM_LINK_MIN_CONFIDENCE: "2",
			}),
		).toBe(DEFAULT_MIN_CONFIDENCE);
		expect(
			resolveMinConfidence({
				MEETING_ACTION_ITEM_LINK_MIN_CONFIDENCE: "-0.5",
			}),
		).toBe(DEFAULT_MIN_CONFIDENCE);
	});

	it("accepts the boundary value 1", () => {
		expect(
			resolveMinConfidence({
				MEETING_ACTION_ITEM_LINK_MIN_CONFIDENCE: "1",
			}),
		).toBe(1);
	});
});

describe("classifyMatch", () => {
	it("requires both relates and the confidence threshold", () => {
		expect(classifyMatch({ relates: true, confidence: 0.8 }, 0.7)).toBe(
			true,
		);
		expect(classifyMatch({ relates: true, confidence: 0.7 }, 0.7)).toBe(
			true,
		);
		expect(classifyMatch({ relates: true, confidence: 0.69 }, 0.7)).toBe(
			false,
		);
	});

	it("never links a verdict that said no, however confident", () => {
		expect(classifyMatch({ relates: false, confidence: 0.99 }, 0.7)).toBe(
			false,
		);
	});
});

describe("buildMatchPrompt", () => {
	const candidates = [
		{
			identifier: "F-1",
			title: "Digest download",
			description: "Long body",
		},
		{ identifier: "F-2", title: "Agenda generation", description: null },
	];

	it("renders exactly the prompt it rendered before the rule text was extracted", () => {
		// A full-string pin, not a `toContain`: the rule paragraphs now live in
		// the exported MATCH_RULE_TEXT constant so the decision model can be
		// held to the same rule, and this is what proves that move (and any
		// later edit to the constant) did not change one byte of what the
		// language verifier is asked. The expected value was generated from the
		// helper as it stood BEFORE the extraction, so it is not a snapshot of
		// the current implementation.
		const prompt = buildMatchPrompt(
			{ text: "Ship the digest download", tentativeOwnerName: "Avery" },
			"Weekly sync",
			[
				{
					identifier: "F-1",
					title: "Digest download",
					description: "Let members download the transcript",
				},
				{
					identifier: "F-2",
					title: "Agenda generation",
					description: null,
				},
			],
		);

		expect(
			prompt,
		).toBe(`You are deciding whether a commitment made in a meeting refers to specific existing work items.

Meeting: Weekly sync
Tentative owner: Avery
Action item: Ship the digest download

Candidate work items:
1. F-1 — Digest download
   Let members download the transcript

2. F-2 — Agenda generation

For EACH candidate, decide whether the action item is about that specific work item — that is, whether doing the action item would advance, change, or resolve it.

Answer "relates": false when the action item merely touches the same area, the same feature family, or the same component. Shared subject matter is not a relationship. Only answer true when a reader would agree the action item is a follow-up ON that specific work item.

Give a confidence between 0 and 1 reflecting how certain you are, and one short sentence of reasoning. Return one verdict per candidate, using the candidate's identifier exactly as given.`);
	});

	it("includes the item text, the meeting subject, and every candidate", () => {
		const prompt = buildMatchPrompt(
			{ text: "Ship the digest download", tentativeOwnerName: "Alice" },
			"Weekly DSU",
			candidates,
		);
		expect(prompt).toContain("Ship the digest download");
		expect(prompt).toContain("Weekly DSU");
		expect(prompt).toContain("F-1");
		expect(prompt).toContain("F-2");
		expect(prompt).toContain("Alice");
	});

	it("tolerates a missing subject and owner", () => {
		const prompt = buildMatchPrompt(
			{ text: "Do the thing", tentativeOwnerName: null },
			null,
			candidates,
		);
		expect(prompt).toContain("Do the thing");
		expect(prompt).not.toContain("null");
	});

	it("tells the model that merely sharing a topic is not a match", () => {
		// The single highest-value instruction in the prompt: without it the
		// verifier links every action item to every ticket about the same area.
		const prompt = buildMatchPrompt(
			{ text: "Do the thing", tentativeOwnerName: null },
			null,
			candidates,
		);
		expect(prompt.toLowerCase()).toContain("same area");
	});
});
