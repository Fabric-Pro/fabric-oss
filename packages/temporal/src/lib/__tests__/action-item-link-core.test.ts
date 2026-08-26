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
