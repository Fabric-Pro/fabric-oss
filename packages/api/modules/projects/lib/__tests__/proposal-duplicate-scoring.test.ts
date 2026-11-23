/**
 * Pure scoring for duplicate detection against the Proposal Inbox: the
 * roadmap scan's candidate rule for a manual entry and for inbox items
 * (its proximity relaxation included, with no floor of the inbox's own),
 * ranking, per-item caps, the rule that an item is never its own duplicate,
 * and the verifier's stored verdicts deciding which candidates are shown,
 * a pair that keeps failing waiting without keeping its item waiting, and a
 * flagged pair staying a candidate after its score drops under the bar.
 */

import {
	CANDIDATE_COSINE_THRESHOLD,
	type DetectionItem,
	INBOX_VERIFY_BACKOFF_MS,
	INBOX_VERIFY_FAILURE_LIMIT,
	PROXIMITY_RELAXATION,
	scoreDetectionPair,
} from "@repo/database";
import { describe, expect, it, vi } from "vitest";

// The real pure detection helpers, without the rest of the package.
vi.mock("@repo/database", async () => ({
	...(await vi.importActual<Record<string, unknown>>(
		"@repo/database/prisma/queries/projects/duplicate-detection",
	)),
	...(await vi.importActual<Record<string, unknown>>(
		"@repo/database/prisma/queries/projects/proposal-item-duplicate-pairs",
	)),
}));

import {
	buildDuplicateFlags,
	type CandidateMatch,
	candidateMatches,
	type ProposalDuplicateMatch,
	rankCandidates,
	type ScoredInboxItem,
	type ScoredTicket,
	settleCandidates,
} from "../proposal-duplicate-scoring";

/** A unit vector at `similarity` cosine from [1, 0]. */
const at = (similarity: number) => [
	similarity,
	Math.sqrt(1 - similarity * similarity),
];

describe("rankCandidates", () => {
	const entry = (extra: Partial<DetectionItem> = {}): DetectionItem => ({
		storyId: "manual-entry",
		embedding: [1, 0],
		...extra,
	});
	const candidate = (
		id: string,
		embedding: number[],
		extra: Partial<DetectionItem> = {},
	) => ({ id, detection: { storyId: id, embedding, ...extra } });

	it("keeps plain candidates at or above the bar by cosine, strongest first, up to the limit", () => {
		const ranked = rankCandidates(
			entry(),
			[
				candidate("below", at(0.69)),
				candidate("near", at(0.75)),
				candidate("top", at(0.95)),
				candidate("mid", at(0.8)),
			],
			2,
		);

		expect(ranked.map((r) => r.candidate.id)).toEqual(["top", "mid"]);
		expect(ranked[0]?.found).toEqual({
			score: expect.closeTo(0.95, 5),
			proximate: false,
			focusKind: null,
		});
	});

	it("matches a feature on its Scope section when the documents read apart", () => {
		const ranked = rankCandidates(
			entry({ focusVectors: { scope: [1, 0] } }),
			[candidate("scope", at(0.5), { focusVectors: { scope: [1, 0] } })],
			5,
		);

		// 0.75 × 1 + 0.25 × 0.5 = 0.875, on the threshold's scale.
		expect(ranked).toEqual([
			{
				candidate: expect.objectContaining({ id: "scope" }),
				found: {
					score: expect.closeTo(0.7 + (0.255 * 0.3) / 0.38, 10),
					proximate: false,
					focusKind: "scope",
				},
			},
		]);
	});

	it("keeps out a feature whose document reads alike but whose Scope does not", () => {
		expect(
			rankCandidates(
				entry({ focusVectors: { scope: [1, 0] } }),
				[
					candidate("alike", at(0.95), {
						focusVectors: { scope: [0, 1] },
					}),
				],
				5,
			),
		).toEqual([]);
	});

	it("relaxes the bar for a candidate created close to the entry, as the roadmap scan does", () => {
		const createdAt = new Date("2026-11-02T09:00:00.000Z");
		const relaxed = CANDIDATE_COSINE_THRESHOLD - PROXIMITY_RELAXATION / 2;
		const under = CANDIDATE_COSINE_THRESHOLD - PROXIMITY_RELAXATION * 2;

		const ranked = rankCandidates(
			entry({ createdAt }),
			[
				candidate("relaxed", at(relaxed), { createdAt }),
				candidate("under", at(under), { createdAt }),
			],
			5,
		);

		expect(ranked).toEqual([
			{
				candidate: expect.objectContaining({ id: "relaxed" }),
				found: {
					score: expect.closeTo(relaxed, 5),
					proximate: true,
					focusKind: null,
				},
			},
		]);
	});

	it("keeps a feature the relaxed Scope bar selects, with the rule's own score", () => {
		const createdAt = new Date("2026-11-02T09:00:00.000Z");
		// 0.75 × 0.645 + 0.25 × 0.5 = 0.609: over the relaxed Scope bar, and
		// calibrated to about 0.685, between the relaxed bar and 0.70.
		const first = entry({ createdAt, focusVectors: { scope: [1, 0] } });
		const near = candidate("near", at(0.5), {
			createdAt,
			focusVectors: { scope: at(0.645) },
		});
		const rule = scoreDetectionPair(first, near.detection);

		expect(rule.score).toBeGreaterThanOrEqual(rule.threshold);
		expect(rule.score).toBeLessThan(CANDIDATE_COSINE_THRESHOLD);
		expect(rankCandidates(first, [near], 5)).toEqual([
			{
				candidate: near,
				found: {
					score: rule.score,
					proximate: true,
					focusKind: "scope",
				},
			},
		]);
	});

	it("scores a vector of another dimension as no match", () => {
		expect(
			rankCandidates(entry(), [candidate("other-model", [1, 0, 0])], 5),
		).toEqual([]);
	});
});

const detection = (
	storyId: string,
	embedding: number[],
	extra: Partial<DetectionItem> = {},
): DetectionItem => ({ storyId, embedding, ...extra });

const inboxItem = (
	proposalId: string,
	changeIndex: number,
	embedding: number[],
	extra: Partial<DetectionItem> = {},
): ScoredInboxItem => ({
	proposalId,
	changeIndex,
	title: `${proposalId} item ${changeIndex}`,
	detection: detection(`${proposalId}:${changeIndex}`, embedding, extra),
	verdictHash: `hash-${proposalId}-${changeIndex}`,
});

const ticket = (
	embedding: number[],
	extra: Partial<DetectionItem> = {},
): ScoredTicket => ({
	storyId: "story-1",
	identifier: "F-12",
	title: "Export throttling",
	detection: detection("story-1", embedding, extra),
	verdictHash: "hash-story-1",
});

const matchesOf = (candidates: CandidateMatch[] | undefined) =>
	(candidates ?? []).map((candidate) => candidate.match);

describe("candidateMatches", () => {
	it("matches tickets and other inbox items at or above the bar, never the item itself", () => {
		const [first, second] = candidateMatches({
			items: [
				inboxItem("open", 0, [1, 0]),
				inboxItem("other", 3, at(0.9)),
			],
			tickets: [ticket(at(0.75))],
			verdicts: [],
		});

		expect(matchesOf(first)).toEqual([
			{
				kind: "proposal_item",
				proposalId: "other",
				matchChangeIndex: 3,
				title: "other item 3",
				similarity: expect.closeTo(0.9, 5),
			},
			{
				kind: "story",
				storyId: "story-1",
				identifier: "F-12",
				title: "Export throttling",
				similarity: expect.closeTo(0.75, 5),
			},
		]);
		expect(
			matchesOf(second).some(
				(match) =>
					match.kind === "proposal_item" &&
					match.proposalId === "other",
			),
		).toBe(false);
	});

	it("carries the pair to verify and both sides' verdict hashes", () => {
		const [first] = candidateMatches({
			items: [inboxItem("open", 0, [1, 0])],
			tickets: [ticket(at(0.75))],
			verdicts: [],
		});

		expect(first?.[0]).toEqual({
			match: expect.objectContaining({ storyId: "story-1" }),
			pair: {
				item: { proposalId: "open", changeIndex: 0 },
				counterpart: { kind: "story", storyId: "story-1" },
				similarity: expect.closeTo(0.75, 5),
				proximate: false,
				focusKind: null,
			},
			hashes: { item: "hash-open-0", counterpart: "hash-story-1" },
		});
	});

	it("leaves out a ticket under the bar", () => {
		const [matches] = candidateMatches({
			items: [inboxItem("open", 0, [1, 0])],
			tickets: [ticket(at(0.69))],
			verdicts: [],
		});

		expect(matches).toEqual([]);
	});

	it("matches two features on their Scope sections when their documents read apart", () => {
		const [matches] = candidateMatches({
			items: [
				inboxItem("open", 0, [1, 0], {
					focusVectors: { scope: [1, 0] },
				}),
			],
			tickets: [ticket(at(0.5), { focusVectors: { scope: [1, 0] } })],
			verdicts: [],
		});

		expect(matches).toHaveLength(1);
		// 0.75 × 1 + 0.25 × 0.5 = 0.875, on the threshold's scale.
		expect(matches?.[0]?.match.similarity).toBeCloseTo(
			0.7 + (0.255 * 0.3) / 0.38,
			10,
		);
		expect(matches?.[0]?.pair.focusKind).toBe("scope");
	});

	it("keeps out two features whose documents read alike but whose Scope sections do not", () => {
		const [matches] = candidateMatches({
			items: [
				inboxItem("open", 0, [1, 0], {
					focusVectors: { scope: [1, 0] },
				}),
			],
			tickets: [ticket(at(0.95), { focusVectors: { scope: [0, 1] } })],
			verdicts: [],
		});

		expect(matches).toEqual([]);
	});

	it("selects what the relaxed bar selects for items created close together, and nothing under it", () => {
		const createdAt = new Date("2026-11-02T09:00:00.000Z");
		const relaxed = CANDIDATE_COSINE_THRESHOLD - PROXIMITY_RELAXATION / 2;
		const under = CANDIDATE_COSINE_THRESHOLD - PROXIMITY_RELAXATION * 2;

		const [againstTicket] = candidateMatches({
			items: [inboxItem("open", 0, [1, 0], { createdAt })],
			tickets: [ticket(at(relaxed), { createdAt })],
			verdicts: [],
		});
		const [againstItem] = candidateMatches({
			items: [
				inboxItem("open", 0, [1, 0], { createdAt }),
				inboxItem("other", 0, at(under), { createdAt }),
			],
			tickets: [],
			verdicts: [],
		});

		expect(againstTicket?.map((c) => c.pair.proximate)).toEqual([true]);
		expect(againstTicket?.[0]?.match.similarity).toBeCloseTo(relaxed, 5);
		expect(againstItem).toEqual([]);
	});
});

describe("settleCandidates", () => {
	const [openCandidates = [], otherCandidates = []] = candidateMatches({
		items: [inboxItem("open", 0, [1, 0]), inboxItem("other", 3, at(0.9))],
		tickets: [ticket(at(0.75))],
		verdicts: [],
	});
	const candidates = [openCandidates, otherCandidates];
	const NOW = Date.parse("2026-11-20T12:00:00.000Z");
	const settle = (verdicts: Parameters<typeof settleCandidates>[1]) =>
		settleCandidates(candidates, verdicts, NOW);
	const ticketVerdict = (
		flagged: boolean | null,
		contentHash = "hash-open-0",
		failures: { failedAttempts: number; lastFailedAt: Date | null } = {
			failedAttempts: 0,
			lastFailedAt: null,
		},
	) => ({
		proposalId: "open",
		changeIndex: 0,
		counterpartKey: "story:story-1",
		contentHash,
		counterpartHash: "hash-story-1",
		flagged,
		...failures,
	});
	// "item:open:0" sorts before "item:other:3", so the pair is stored on
	// the open item, with its hash first, and the other item reads it with
	// the sides swapped.
	const itemVerdict = (flagged: boolean) => ({
		proposalId: "open",
		changeIndex: 0,
		counterpartKey: "item:other:3",
		contentHash: "hash-open-0",
		counterpartHash: "hash-other-3",
		flagged,
		failedAttempts: 0,
		lastFailedAt: null,
	});

	it("shows nothing and sends every candidate to the verifier before any verdict", () => {
		const settled = settle([]);

		expect(settled.matches).toEqual([[], []]);
		expect(settled.waiting).toEqual([true, true]);
		// The item pair once, from either side; the ticket pairs of both.
		expect(settled.unverified).toHaveLength(3);
		expect(
			settled.unverified.map((pair) => pair.counterpart.kind).sort(),
		).toEqual(["item", "story", "story"]);
	});

	it("shows a confirmed pair with the rule's score", () => {
		const settled = settle([ticketVerdict(true), itemVerdict(false)]);

		expect(settled.matches[0]).toEqual([
			{
				kind: "story",
				storyId: "story-1",
				identifier: "F-12",
				title: "Export throttling",
				similarity: expect.closeTo(0.75, 5),
			},
		]);
		expect(settled.waiting[0]).toBe(false);
	});

	it("shows no pair the verifier rejected, on either side of an item pair", () => {
		const settled = settle([ticketVerdict(false), itemVerdict(false)]);

		expect(settled.matches[0]).toEqual([]);
		expect(settled.matches[1]?.map((match) => match.kind)).toEqual([]);
		expect(settled.waiting[0]).toBe(false);
		expect(
			settled.unverified.every((pair) => pair.item.proposalId !== "open"),
		).toBe(true);
	});

	it("reads one verdict for both sides of an item pair", () => {
		const settled = settle([itemVerdict(true)]);

		expect(settled.matches[0]).toEqual([
			expect.objectContaining({
				kind: "proposal_item",
				proposalId: "other",
			}),
		]);
		expect(settled.matches[1]).toEqual([
			expect.objectContaining({
				kind: "proposal_item",
				proposalId: "open",
			}),
		]);
	});

	it("hides a flagged pair and verifies it again once a side's text changed", () => {
		const settled = settle([
			ticketVerdict(true, "hash-of-the-old-text"),
			itemVerdict(false),
		]);

		expect(settled.matches[0]).toEqual([]);
		expect(settled.waiting[0]).toBe(true);
		expect(settled.unverified).toContainEqual(
			expect.objectContaining({
				item: { proposalId: "open", changeIndex: 0 },
				counterpart: { kind: "story", storyId: "story-1" },
			}),
		);
	});

	describe("a pair whose verification keeps failing", () => {
		const failedJustNow = ticketVerdict(null, "hash-open-0", {
			failedAttempts: INBOX_VERIFY_FAILURE_LIMIT,
			lastFailedAt: new Date(NOW - 60_000),
		});
		const isTicketPair = (pair: { counterpart: { kind: string } }) =>
			pair.counterpart.kind === "story";

		it("shows nothing for it, does not keep its item waiting, and does not verify it while it waits", () => {
			const settled = settle([failedJustNow, itemVerdict(false)]);

			expect(settled.matches[0]).toEqual([]);
			expect(settled.waiting[0]).toBe(false);
			expect(
				settled.unverified.some(
					(pair) =>
						isTicketPair(pair) && pair.item.proposalId === "open",
				),
			).toBe(false);
		});

		it("verifies it again once the wait is over", () => {
			const settled = settle([
				ticketVerdict(null, "hash-open-0", {
					failedAttempts: INBOX_VERIFY_FAILURE_LIMIT,
					lastFailedAt: new Date(NOW - INBOX_VERIFY_BACKOFF_MS),
				}),
				itemVerdict(false),
			]);

			expect(settled.waiting[0]).toBe(true);
		});
	});
});

describe("a pair the verifier flagged that the rule no longer selects", () => {
	// Flagged at a score over the bar; the rule now scores it at 0.6, as
	// when a side's section vectors were cached or dropped since.
	const items = [inboxItem("open", 0, [1, 0])];
	const tickets = [ticket(at(0.6))];
	const NOW = Date.parse("2026-11-20T12:00:00.000Z");
	const verdict = (flagged: boolean | null, contentHash = "hash-open-0") => ({
		proposalId: "open",
		changeIndex: 0,
		counterpartKey: "story:story-1",
		contentHash,
		counterpartHash: "hash-story-1",
		flagged,
		failedAttempts: 0,
		lastFailedAt: null,
	});

	it("stays a candidate and is shown, with the rule's current score, while its verdict holds", () => {
		const verdicts = [verdict(true)];
		const candidates = candidateMatches({ items, tickets, verdicts });

		const settled = settleCandidates(candidates, verdicts, NOW);

		expect(settled.matches[0]).toEqual([
			expect.objectContaining({
				kind: "story",
				storyId: "story-1",
				similarity: expect.closeTo(0.6, 5),
			}),
		]);
		expect(settled.waiting[0]).toBe(false);
		expect(settled.unverified).toEqual([]);
	});

	it("is verified again, and keeps its item checking, once a side's text changed", () => {
		const verdicts = [verdict(true, "hash-of-the-old-text")];
		const candidates = candidateMatches({ items, tickets, verdicts });

		const settled = settleCandidates(candidates, verdicts, NOW);

		expect(settled.matches[0]).toEqual([]);
		expect(settled.waiting[0]).toBe(true);
		expect(settled.unverified).toEqual([
			expect.objectContaining({
				item: { proposalId: "open", changeIndex: 0 },
				counterpart: { kind: "story", storyId: "story-1" },
				similarity: expect.closeTo(0.6, 5),
			}),
		]);
	});

	it("is no candidate once the verifier cleared it, or before it decided", () => {
		expect(
			candidateMatches({ items, tickets, verdicts: [verdict(false)] }),
		).toEqual([[]]);
		expect(
			candidateMatches({ items, tickets, verdicts: [verdict(null)] }),
		).toEqual([[]]);
	});

	it("stays a candidate from either side of an item pair", () => {
		// Stored on "item:open:0", which sorts first.
		const verdicts = [
			{
				...verdict(true),
				counterpartKey: "item:other:3",
				counterpartHash: "hash-other-3",
			},
		];

		const [open, other] = candidateMatches({
			items: [
				inboxItem("open", 0, [1, 0]),
				inboxItem("other", 3, at(0.6)),
			],
			tickets: [],
			verdicts,
		});

		expect(open?.map((candidate) => candidate.match.kind)).toEqual([
			"proposal_item",
		]);
		expect(other?.map((candidate) => candidate.match.kind)).toEqual([
			"proposal_item",
		]);
	});
});

describe("buildDuplicateFlags", () => {
	const story = (similarity: number): ProposalDuplicateMatch => ({
		kind: "story",
		storyId: `story-${similarity}`,
		identifier: "F-12",
		title: "Export throttling",
		similarity,
	});

	// A cap of three hid a confirmed roadmap match behind three inbox copies.
	it("orders each item's matches strongest first and keeps every one", () => {
		const flags = buildDuplicateFlags({
			items: [
				{
					proposalId: "open",
					changeIndex: 0,
					matches: [story(0.72), story(0.95), story(0.8), story(0.9)],
				},
			],
		});

		expect(flags[0]?.matches.map((match) => match.similarity)).toEqual([
			0.95, 0.9, 0.8, 0.72,
		]);
	});

	it("leaves out items with no match", () => {
		const flags = buildDuplicateFlags({
			items: [
				{ proposalId: "open", changeIndex: 0, matches: [] },
				{ proposalId: "other", changeIndex: 1, matches: [story(0.8)] },
			],
		});

		expect(flags.map((flag) => flag.proposalId)).toEqual(["other"]);
	});
});
