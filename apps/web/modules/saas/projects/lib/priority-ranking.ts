import type {
	FeatureDraftingStage,
	StorySource,
	StoryPriority,
	UserStory,
} from "./stories/types";

/**
 * Ranking for the Roadmap "Priority" layout.
 *
 * The order is produced here, deterministically, from signals already present
 * on the loaded work items. The LLM annotates the result with a rationale but
 * never reorders it — so an AI outage costs the prose, not the ranking.
 *
 * Pure: no React, no I/O, no clock of its own (callers pass `now`), which keeps
 * the whole thing testable and keeps the layout switch free of a round-trip.
 */

const MS_PER_DAY = 86_400_000;

/**
 * Priority is a band, not a weight. Each priority occupies its own block of
 * `PRIORITY_BAND` points and the combined signal score is clamped below one
 * band, so signals reorder work *within* a priority and can never lift a P2
 * above a P0 — a list that did would just read as broken to whoever set the
 * priorities. Adding a signal therefore cannot silently break the guarantee.
 */
export const PRIORITY_BAND = 100;

const PRIORITY_BAND_INDEX: Record<StoryPriority, number> = {
	P0_CRITICAL: 3,
	P1_HIGH: 2,
	P2_MEDIUM: 1,
	P3_LOW: 0,
};

/** Every weight in one place: a re-weighting is a one-line diff plus a test. */
export const PRIORITY_WEIGHTS = {
	blocked: 25,
	agePerDay: 0.5,
	ageCap: 20,
	perOpenDecision: 6,
	openDecisionCap: 18,
	proposalLinked: 8,
} as const;

/** Ready-to-work beats not-yet-specified. Terminal stages are filtered out of
 * the roadmap upstream, so their weight only matters for completeness. */
const STAGE_SCORE: Record<FeatureDraftingStage, number> = {
	PLACEHOLDER: 0,
	ACTIVE_ANALYSIS: 5,
	SANITY_CHECK: 5,
	DRAFT: 15,
	PUBLISHED: 15,
	DECLINED: 5,
	CLOSED: 5,
};

/** The minimum a work item must expose to be ranked. */
export type PriorityRankInput = {
	id: string;
	priority: StoryPriority;
	blocked: boolean;
	createdAt: Date;
	draftingStage: FeatureDraftingStage;
	source: StorySource;
	/** Shared manual rank; null when the item has never been hand-placed. */
	priorityOrder: number | null;
	openDecisions: number;
	/** Mirrors the work item's status being final — see spec D4. */
	isComplete: boolean;
};

export type RankedStory<T extends PriorityRankInput = PriorityRankInput> = T & {
	score: number;
};

/**
 * How urgent an item is *within* its priority. Always in `[0, PRIORITY_BAND)`
 * — the final clamp is what makes the banding structural rather than a
 * property of whichever weights happen to be configured.
 */
export function scoreSignals(item: PriorityRankInput, now: number): number {
	const ageDays = Math.max(0, (now - item.createdAt.getTime()) / MS_PER_DAY);

	const total =
		(item.blocked ? PRIORITY_WEIGHTS.blocked : 0) +
		Math.min(
			ageDays * PRIORITY_WEIGHTS.agePerDay,
			PRIORITY_WEIGHTS.ageCap,
		) +
		Math.min(
			item.openDecisions * PRIORITY_WEIGHTS.perOpenDecision,
			PRIORITY_WEIGHTS.openDecisionCap,
		) +
		STAGE_SCORE[item.draftingStage] +
		(item.source === "approved_proposal"
			? PRIORITY_WEIGHTS.proposalLinked
			: 0);

	return Math.min(total, PRIORITY_BAND - 1);
}

export function scoreStory(item: PriorityRankInput, now: number): number {
	return (
		PRIORITY_BAND_INDEX[item.priority] * PRIORITY_BAND +
		scoreSignals(item, now)
	);
}

/**
 * Completed items sink to the bottom; hand-pinned items lead in their pinned
 * order; everything else flows by score. The `id` tiebreak (locale-free, like
 * `compareStoriesBy`) makes the order stable across reloads — the list is
 * navigated by position, so it must not shuffle between visits.
 */
export function comparePriorityRank(a: RankedStory, b: RankedStory): number {
	if (a.isComplete !== b.isComplete) {
		return a.isComplete ? 1 : -1;
	}

	const aPin = a.priorityOrder ?? Number.POSITIVE_INFINITY;
	const bPin = b.priorityOrder ?? Number.POSITIVE_INFINITY;
	if (aPin !== bPin) {
		return aPin - bPin;
	}

	if (a.score !== b.score) {
		return b.score - a.score;
	}

	return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function rankStories<T extends PriorityRankInput>(
	items: readonly T[],
	now: number,
): RankedStory<T>[] {
	return items
		.map((item) => ({ ...item, score: scoreStory(item, now) }))
		.sort(comparePriorityRank);
}

/**
 * The card's "all tickets have equal priority signals" case: with nothing to
 * separate them, the computed order is arbitrary and the view says so rather
 * than implying a judgement it didn't make. Pinned and completed items are
 * excluded — they are already ordered by something other than score.
 */
export function hasNoRankingSignal(ranked: readonly RankedStory[]): boolean {
	const scored = ranked.filter(
		(item) => item.priorityOrder === null && !item.isComplete,
	);
	if (scored.length < 2) {
		return false;
	}
	return scored.every((item) => item.score === scored[0].score);
}

/** Any item the user has hand-placed — drives the "Reset to AI order" control. */
export function hasManualOrder(items: readonly PriorityRankInput[]): boolean {
	return items.some((item) => item.priorityOrder !== null);
}

export function toPriorityRankInput(
	story: UserStory,
	options: { isComplete: boolean; openDecisions: number },
): PriorityRankInput & { story: UserStory } {
	return {
		story,
		id: story.id,
		priority: story.priority,
		blocked: story.blocked ?? false,
		createdAt: story.createdAt,
		draftingStage: story.draftingStage,
		source: story.source,
		priorityOrder: story.priorityOrder ?? null,
		openDecisions: options.openDecisions,
		isComplete: options.isComplete,
	};
}
