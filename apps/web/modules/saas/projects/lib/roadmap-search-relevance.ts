import { partitionByNameMatch } from "./roadmap-filters";
import type { UserStory } from "./stories/types";

/**
 * Title-weighted relevance ranking for roadmap search (Fizzy #1937).
 *
 * While a search query is active the roadmap re-ranks matches by relevance,
 * replacing the active sort; clearing the query drops back to it. The scoring
 * mirrors `applyRoadmapFilters`' token model — whitespace tokens, AND-matched
 * there, scored per-field here so the two never disagree about WHAT matched.
 *
 * Weights are plain constants, not config: they encode one product judgement
 * (a title hit is worth roughly four body hits) that is pinned by unit tests.
 * Tune them in this file and re-run those tests, not through settings.
 */
const WEIGHTS = {
	/** The canonical name users search by — the strongest signal. */
	title: 4,
	/** The ticket number (`F-123`, `B-011`): specific but not prose. */
	identifier: 3,
	/** Body text: weakest of the weighted fields, still above zero. */
	description: 1,
	/** Extra credit when the FULL query appears contiguously in the title —
	 * an exact-title search should beat a story that merely holds each word. */
	titlePhraseBonus: 2,
} as const;

export type StoryRelevanceFields = Pick<
	UserStory,
	"title" | "identifier" | "description"
>;

function tokenize(query: string): string[] {
	return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * Score one story against one query. Higher is more relevant; 0 means nothing
 * matched (the story can only be in the result set via a non-scored field like
 * externalId or the source label, which `applyRoadmapFilters` matches but
 * relevance deliberately does not rank up).
 */
export function scoreStoryAgainstQuery(
	query: string,
): (story: StoryRelevanceFields) => number {
	const tokens = tokenize(query);
	const phrase = query.trim().toLowerCase();
	return (story) => {
		if (tokens.length === 0) {
			return 0;
		}
		const title = story.title.toLowerCase();
		const identifier = story.identifier.toLowerCase();
		const description = (story.description ?? "").toLowerCase();
		let score = 0;
		for (const token of tokens) {
			if (title.includes(token)) {
				score += WEIGHTS.title;
			} else if (identifier.includes(token)) {
				score += WEIGHTS.identifier;
			} else if (description.includes(token)) {
				score += WEIGHTS.description;
			}
		}
		if (tokens.length > 1 && title.includes(phrase)) {
			score += WEIGHTS.titlePhraseBonus;
		}
		return score;
	};
}

/**
 * Comparator ranking stories by query relevance, descending. Ties fall back to
 * `fallbackCompare` when provided (the UC tie rule: equal relevance keeps the
 * existing sort order), otherwise preserve input order via stable sort.
 */
export function compareStoriesByRelevance(
	query: string,
	fallbackCompare?: (a: UserStory, b: UserStory) => number,
): (a: UserStory, b: UserStory) => number {
	const score = scoreStoryAgainstQuery(query);
	return (a, b) => {
		const delta = score(b) - score(a);
		if (delta !== 0) {
			return delta;
		}
		return fallbackCompare ? fallbackCompare(a, b) : 0;
	};
}

/**
 * Relative match strength per story, as a percentage of the best-scoring
 * result in the current result set (best = 100). Raw scores mean nothing to a
 * user — keyword scores are small integers, embedding scores are cosine
 * similarities — but "how strong is THIS hit compared to the top hit" is
 * honest in both modes. Stories with no score, and a best score of zero, get
 * no entry.
 */
export function computeMatchPercentById(
	stories: ReadonlyArray<{ id: string }>,
	scoreById: Map<string, number>,
): Map<string, number> {
	let max = 0;
	for (const story of stories) {
		max = Math.max(max, scoreById.get(story.id) ?? 0);
	}
	const out = new Map<string, number>();
	if (max <= 0) {
		return out;
	}
	for (const story of stories) {
		const score = scoreById.get(story.id);
		if (score !== undefined && score > 0) {
			out.set(story.id, Math.max(1, Math.round((score / max) * 100)));
		}
	}
	return out;
}

/**
 * Narrow a keyword-ranked result list to the work items the query reaches by
 * NAME, collapsing the body-only tail behind a count (Fizzy #1937 follow-up).
 *
 * Ranking alone reorders; it never shortens. A query whose words are common in
 * descriptions still lists every row that mentions them in passing, which is
 * the "multiple unrelated results" the roadmap was reported for. Narrowing to
 * name matches is what actually shortens the list.
 *
 * Two rules keep it from ever hiding the answer. When NOTHING matches by name
 * the full list is returned untouched, so a body-text search never faces an
 * empty roadmap. And the collapsed rows are counted, not dropped — the caller
 * reveals them on demand, the same bargain the hidden-item count already makes.
 *
 * Callers pass a list already ranked by relevance; both returned partitions
 * keep that order.
 *
 * `narrowed` reports whether name-gating is in effect at all, which is not the
 * same question as whether anything was collapsed. Companion lists — the hidden
 * matches beside the roadmap — read it so their count is gated on exactly the
 * runs where the visible list is, and can never promise more rows than
 * revealing them produces.
 */
export function narrowToNameMatches(
	ranked: UserStory[],
	query: string,
): { stories: UserStory[]; collapsedCount: number; narrowed: boolean } {
	if (query.trim().length === 0) {
		return { stories: ranked, collapsedCount: 0, narrowed: false };
	}
	const { nameMatches, bodyOnly } = partitionByNameMatch(ranked, query);
	if (nameMatches.length === 0) {
		return { stories: ranked, collapsedCount: 0, narrowed: false };
	}
	return {
		stories: nameMatches,
		collapsedCount: bodyOnly.length,
		narrowed: true,
	};
}
