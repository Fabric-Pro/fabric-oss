import { describe, expect, it } from "vitest";
import {
	type PriorityRankInput,
	PRIORITY_BAND,
	PRIORITY_WEIGHTS,
	comparePriorityRank,
	hasManualOrder,
	hasNoRankingSignal,
	rankStories,
	scoreSignals,
	scoreStory,
} from "../priority-ranking";

const NOW = new Date("2026-07-20T12:00:00Z").getTime();

function item(overrides: Partial<PriorityRankInput> = {}): PriorityRankInput {
	return {
		id: "s1",
		priority: "P2_MEDIUM",
		blocked: false,
		createdAt: new Date(NOW),
		draftingStage: "ACTIVE_ANALYSIS",
		source: "manual",
		priorityOrder: null,
		openDecisions: 0,
		isComplete: false,
		...overrides,
	};
}

const daysAgo = (days: number) => new Date(NOW - days * 86_400_000);

describe("scoreStory", () => {
	it("ranks the four priorities in descending order", () => {
		const scores = (
			["P0_CRITICAL", "P1_HIGH", "P2_MEDIUM", "P3_LOW"] as const
		).map((priority) => scoreStory(item({ priority }), NOW));

		expect(scores).toEqual([...scores].sort((a, b) => b - a));
		expect(new Set(scores).size).toBe(4);
	});

	it("raises the score of a blocked item by exactly the blocked weight", () => {
		const base = scoreStory(item(), NOW);

		expect(scoreStory(item({ blocked: true }), NOW) - base).toBe(
			PRIORITY_WEIGHTS.blocked,
		);
	});

	it("raises the score with age", () => {
		const fresh = scoreStory(item(), NOW);
		const old = scoreStory(item({ createdAt: daysAgo(10) }), NOW);

		expect(old).toBeGreaterThan(fresh);
		expect(old - fresh).toBeCloseTo(10 * PRIORITY_WEIGHTS.agePerDay);
	});

	it("raises the score with each open decision", () => {
		const base = scoreStory(item(), NOW);

		expect(scoreStory(item({ openDecisions: 2 }), NOW) - base).toBe(
			2 * PRIORITY_WEIGHTS.perOpenDecision,
		);
	});

	it("rewards a drafted item and penalises a placeholder", () => {
		const draft = scoreStory(item({ draftingStage: "DRAFT" }), NOW);
		const neutral = scoreStory(item(), NOW);
		const placeholder = scoreStory(
			item({ draftingStage: "PLACEHOLDER" }),
			NOW,
		);

		expect(draft).toBeGreaterThan(neutral);
		expect(placeholder).toBeLessThan(neutral);
	});

	it("rewards an item created from an approved proposal", () => {
		const base = scoreStory(item(), NOW);

		expect(
			scoreStory(item({ source: "approved_proposal" }), NOW) - base,
		).toBe(PRIORITY_WEIGHTS.proposalLinked);
	});

	it("treats a future createdAt as zero age rather than a negative bonus", () => {
		expect(scoreStory(item({ createdAt: daysAgo(-30) }), NOW)).toBe(
			scoreStory(item(), NOW),
		);
	});
});

describe("score caps keep secondary signals below a priority step", () => {
	it("never lets an ancient P3 outrank a fresh P1", () => {
		const ancient = scoreStory(
			item({ priority: "P3_LOW", createdAt: daysAgo(730) }),
			NOW,
		);
		const fresh = scoreStory(item({ priority: "P1_HIGH" }), NOW);

		expect(ancient).toBeLessThan(fresh);
	});

	it("caps the age contribution", () => {
		const capped = scoreStory(item({ createdAt: daysAgo(365) }), NOW);
		const alsoCapped = scoreStory(item({ createdAt: daysAgo(3650) }), NOW);

		expect(capped).toBe(alsoCapped);
		expect(capped - scoreStory(item(), NOW)).toBe(PRIORITY_WEIGHTS.ageCap);
	});

	it("caps the open-decision contribution", () => {
		const capped = scoreStory(item({ openDecisions: 50 }), NOW);

		expect(capped - scoreStory(item(), NOW)).toBe(
			PRIORITY_WEIGHTS.openDecisionCap,
		);
	});

	it("never lets a fully-loaded item outrank a bare item one priority above", () => {
		const maxedOut = (priority: PriorityRankInput["priority"]) =>
			item({
				priority,
				blocked: true,
				createdAt: daysAgo(3650),
				openDecisions: 50,
				draftingStage: "PUBLISHED",
				source: "approved_proposal",
			});

		const ladder = [
			"P3_LOW",
			"P2_MEDIUM",
			"P1_HIGH",
			"P0_CRITICAL",
		] as const;

		for (let i = 0; i < ladder.length - 1; i++) {
			expect(scoreStory(maxedOut(ladder[i]), NOW)).toBeLessThan(
				scoreStory(item({ priority: ladder[i + 1] }), NOW),
			);
		}
	});

	it("keeps the signal score inside one band, whatever the inputs", () => {
		const extreme = item({
			blocked: true,
			createdAt: daysAgo(100_000),
			openDecisions: 10_000,
			draftingStage: "PUBLISHED",
			source: "approved_proposal",
		});

		expect(scoreSignals(extreme, NOW)).toBeLessThan(PRIORITY_BAND);
		expect(scoreSignals(item({ draftingStage: "PLACEHOLDER" }), NOW)).toBe(
			0,
		);
	});
});

describe("rankStories ordering", () => {
	it("orders by score descending", () => {
		const ranked = rankStories(
			[
				item({ id: "low", priority: "P3_LOW" }),
				item({ id: "crit", priority: "P0_CRITICAL" }),
				item({ id: "med", priority: "P2_MEDIUM" }),
			],
			NOW,
		);

		expect(ranked.map((r) => r.id)).toEqual(["crit", "med", "low"]);
	});

	it("sinks completed items below everything, whatever their score", () => {
		const ranked = rankStories(
			[
				item({ id: "done", priority: "P0_CRITICAL", isComplete: true }),
				item({ id: "open", priority: "P3_LOW" }),
			],
			NOW,
		);

		expect(ranked.map((r) => r.id)).toEqual(["open", "done"]);
	});

	it("keeps completed items in score order among themselves", () => {
		const ranked = rankStories(
			[
				item({ id: "doneLow", priority: "P3_LOW", isComplete: true }),
				item({
					id: "doneHigh",
					priority: "P0_CRITICAL",
					isComplete: true,
				}),
			],
			NOW,
		);

		expect(ranked.map((r) => r.id)).toEqual(["doneHigh", "doneLow"]);
	});

	it("places pinned items ahead of unpinned ones, in pinned order", () => {
		const ranked = rankStories(
			[
				item({ id: "unpinnedCritical", priority: "P0_CRITICAL" }),
				item({
					id: "pinnedSecond",
					priority: "P3_LOW",
					priorityOrder: 2,
				}),
				item({
					id: "pinnedFirst",
					priority: "P3_LOW",
					priorityOrder: 1,
				}),
			],
			NOW,
		);

		expect(ranked.map((r) => r.id)).toEqual([
			"pinnedFirst",
			"pinnedSecond",
			"unpinnedCritical",
		]);
	});

	it("does not let a pin lift a completed item above open work", () => {
		const ranked = rankStories(
			[
				item({ id: "open", priority: "P3_LOW" }),
				item({ id: "donePinned", priorityOrder: 1, isComplete: true }),
			],
			NOW,
		);

		expect(ranked.map((r) => r.id)).toEqual(["open", "donePinned"]);
	});

	it("is stable: any input permutation yields the same output order", () => {
		const items = [
			item({ id: "a", priority: "P1_HIGH" }),
			item({ id: "b", priority: "P1_HIGH" }),
			item({ id: "c", priority: "P1_HIGH" }),
			item({ id: "d", priority: "P0_CRITICAL" }),
			item({ id: "e", priority: "P3_LOW", isComplete: true }),
		];
		const expected = rankStories(items, NOW).map((r) => r.id);

		const permutations = [
			[...items].reverse(),
			[items[2], items[0], items[4], items[1], items[3]],
			[items[3], items[4], items[1], items[2], items[0]],
		];

		for (const permutation of permutations) {
			expect(rankStories(permutation, NOW).map((r) => r.id)).toEqual(
				expected,
			);
		}
	});

	it("breaks score ties on id", () => {
		const ranked = rankStories(
			[item({ id: "zeta" }), item({ id: "alpha" })],
			NOW,
		);

		expect(ranked.map((r) => r.id)).toEqual(["alpha", "zeta"]);
	});
});

describe("comparePriorityRank", () => {
	it("returns 0 only for the same item", () => {
		const a = { ...item({ id: "x" }), score: 10 };

		expect(comparePriorityRank(a, a)).toBe(0);
		expect(
			comparePriorityRank(a, { ...item({ id: "y" }), score: 10 }),
		).toBeLessThan(0);
	});
});

describe("hasNoRankingSignal", () => {
	it("is true when every unpinned open item scores the same", () => {
		expect(
			hasNoRankingSignal(
				rankStories([item({ id: "a" }), item({ id: "b" })], NOW),
			),
		).toBe(true);
	});

	it("is false as soon as one signal separates them", () => {
		expect(
			hasNoRankingSignal(
				rankStories(
					[item({ id: "a" }), item({ id: "b", blocked: true })],
					NOW,
				),
			),
		).toBe(false);
	});

	it("is false with fewer than two rankable items", () => {
		expect(hasNoRankingSignal(rankStories([item()], NOW))).toBe(false);
		expect(hasNoRankingSignal([])).toBe(false);
	});

	it("ignores pinned and completed items when deciding", () => {
		const ranked = rankStories(
			[
				item({ id: "a" }),
				item({ id: "b", priorityOrder: 1, blocked: true }),
				item({ id: "c", isComplete: true, priority: "P0_CRITICAL" }),
			],
			NOW,
		);

		// Only "a" is rankable, so there is nothing to compare it against.
		expect(hasNoRankingSignal(ranked)).toBe(false);
	});
});

describe("hasManualOrder", () => {
	it("detects a single pinned item", () => {
		expect(hasManualOrder([item(), item({ priorityOrder: 3 })])).toBe(true);
	});

	it("is false when nothing is pinned", () => {
		expect(hasManualOrder([item(), item()])).toBe(false);
		expect(hasManualOrder([])).toBe(false);
	});

	it("treats a pin of 0 as a real pin", () => {
		expect(hasManualOrder([item({ priorityOrder: 0 })])).toBe(true);
	});
});
