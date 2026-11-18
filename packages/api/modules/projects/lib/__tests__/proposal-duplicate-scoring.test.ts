/**
 * Pure scoring for duplicate detection against the Proposal Inbox: the
 * shared similarity bar, ranking, per-item caps, and the rule that an item
 * is never its own duplicate.
 */

import { CANDIDATE_COSINE_THRESHOLD } from "@repo/database";
import { describe, expect, it, vi } from "vitest";

// The real pure detection helpers, without the rest of the package.
vi.mock("@repo/database", async () =>
	vi.importActual(
		"@repo/database/prisma/queries/projects/duplicate-detection",
	),
);

import {
	buildDuplicateFlags,
	confidentTickets,
	judgeBand,
	MAX_FLAG_MATCHES_PER_ITEM,
	MAX_VERIFIED_INBOX_ITEMS,
	PROPOSAL_DUPLICATE_THRESHOLD,
	rankSimilar,
} from "../proposal-duplicate-scoring";

/** A unit vector at `similarity` cosine from [1, 0]. */
const at = (similarity: number) => [
	similarity,
	Math.sqrt(1 - similarity * similarity),
];

describe("rankSimilar", () => {
	it("uses the roadmap duplicate scan's own similarity bar", () => {
		expect(PROPOSAL_DUPLICATE_THRESHOLD).toBe(CANDIDATE_COSINE_THRESHOLD);
	});

	it("keeps candidates at or above the bar, strongest first, up to the limit", () => {
		const ranked = rankSimilar(
			[1, 0],
			[
				{ id: "below", embedding: at(0.69) },
				{ id: "near", embedding: at(0.75) },
				{ id: "top", embedding: at(0.95) },
				{ id: "mid", embedding: at(0.8) },
			],
			2,
		);

		expect(ranked.map((r) => r.candidate.id)).toEqual(["top", "mid"]);
		expect(ranked[0]?.similarity).toBeCloseTo(0.95, 5);
	});

	it("includes a candidate exactly at the bar", () => {
		// [0.6, 0.8] is a unit vector, so its cosine with [1, 0] is exactly 0.6.
		const ranked = rankSimilar(
			[1, 0],
			[{ id: "at", embedding: [0.6, 0.8] }],
			5,
			0.6,
		);

		expect(ranked).toHaveLength(1);
	});

	it("scores a vector of another dimension as no match", () => {
		expect(
			rankSimilar(
				[1, 0],
				[{ id: "other-model", embedding: [1, 0, 0] }],
				5,
			),
		).toEqual([]);
	});
});

describe("buildDuplicateFlags", () => {
	const ticket = (similarity: number) => ({
		storyId: "story-1",
		identifier: "F-12",
		title: "Export throttling",
		similarity,
	});
	const item = (
		proposalId: string,
		changeIndex: number,
		similarity: number,
		storyMatches: ReturnType<typeof ticket>[] = [],
	) => ({
		proposalId,
		changeIndex,
		title: `${proposalId} item ${changeIndex}`,
		embedding: at(similarity),
		storyMatches,
	});

	it("flags an item against its ticket shortlist, siblings and other proposals, never itself", () => {
		const flags = buildDuplicateFlags({
			items: [
				item("open", 0, 1, [ticket(0.9)]),
				item("open", 1, 0.99),
				item("other", 3, 0.95),
			],
		});

		const first = flags.find(
			(flag) => flag.proposalId === "open" && flag.changeIndex === 0,
		);
		expect(first?.matches.map((m) => m.kind)).toEqual([
			"proposal_item",
			"proposal_item",
			"story",
		]);
		expect(first?.matches[0]).toEqual({
			kind: "proposal_item",
			proposalId: "open",
			matchChangeIndex: 1,
			title: "open item 1",
			similarity: expect.closeTo(0.99, 5),
		});
		expect(first?.matches[2]).toEqual({
			kind: "story",
			storyId: "story-1",
			identifier: "F-12",
			title: "Export throttling",
			similarity: expect.closeTo(0.9, 5),
		});
		for (const flag of flags) {
			expect(
				flag.matches.some(
					(m) =>
						m.kind === "proposal_item" &&
						m.proposalId === flag.proposalId &&
						m.matchChangeIndex === flag.changeIndex,
				),
			).toBe(false);
		}
	});

	it("caps the matches per item across tickets and inbox items", () => {
		const flags = buildDuplicateFlags({
			items: [
				item("open", 0, 1, [ticket(0.6), ticket(0.55)]),
				...[0.99, 0.98, 0.97].map((s, i) => item("other", i, s)),
			],
		});

		expect(flags[0]?.matches).toHaveLength(MAX_FLAG_MATCHES_PER_ITEM);
		expect(flags[0]?.matches.map((m) => m.kind)).toEqual([
			"proposal_item",
			"proposal_item",
			"proposal_item",
		]);
	});

	it("leaves out items with nothing at or above the bar", () => {
		const flags = buildDuplicateFlags({
			items: [item("open", 0, 1), item("other", 0, 0.5)],
		});

		expect(flags).toEqual([]);
	});
});

describe("ticket shortlist split", () => {
	const shortlist = (...similarities: number[]) =>
		similarities.map((similarity) => ({ similarity }));

	it("shows the tickets at or above the bar without a judge", () => {
		expect(confidentTickets(shortlist(0.9, 0.7, 0.69, 0.55))).toEqual(
			shortlist(0.9, 0.7),
		);
	});

	it("sends items whose best ticket is under the bar to the judge, strongest first", () => {
		expect(
			judgeBand([
				shortlist(0.55),
				shortlist(0.8, 0.6),
				[],
				shortlist(0.65, 0.51),
				shortlist(0.6),
			]),
		).toEqual([3, 4, 0]);
	});

	it("caps the judged items per call", () => {
		const many = Array.from({ length: 12 }, (_, i) =>
			shortlist(0.51 + i / 100),
		);

		const band = judgeBand(many);

		expect(band).toHaveLength(MAX_VERIFIED_INBOX_ITEMS);
		expect(band[0]).toBe(11);
	});
});
