// Deep import from the dedicated file (not the @repo/database barrel) so this
// client module doesn't pull the Prisma client graph (pg, dns, adapter-pg)
// into the browser bundle. The function itself is a pure regex helper.
import { normalizeStoryIdentifierQuery } from "@repo/database/prisma/queries/projects/normalize-story-identifier-query";
import { storySemanticActivityAt } from "@repo/database/prisma/queries/projects/story-semantic-activity";
import {
	getMaturationStatus,
	MATURATION_STATUS_OPTIONS,
	type MaturationStatus,
	type StoryKind,
	type StoryPriority,
	type StorySize,
	type StorySource,
	type UserStory,
} from "./stories/types";

export type { StorySize, StorySource };

// Story sizes (T-shirt) offered in the Size filter, smallest → largest.
export const FILTERABLE_SIZES: StorySize[] = ["XS", "S", "M", "L", "XL"];

export const STORY_SIZE_LABELS: Record<StorySize, string> = {
	XS: "XS",
	S: "S",
	M: "M",
	L: "L",
	XL: "XL",
};

// Fabric supports exactly two work-item types — Feature and Bug. "User Story"
// was retired entirely (the StoryKind enum no longer has USER_STORY; legacy
// rows were migrated to FEATURE), so both the Type filter and the label map
// carry only the two live kinds.
export const FILTERABLE_KINDS: StoryKind[] = ["FEATURE", "BUG"];

export const STORY_KIND_LABELS: Record<StoryKind, string> = {
	FEATURE: "Feature",
	BUG: "Bug",
};

export type SyncFilter = "synced" | "unsynced";

export const FILTERABLE_SYNC_STATUSES: SyncFilter[] = ["synced", "unsynced"];

export const FILTERABLE_SOURCES: StorySource[] = [
	"manual",
	"jira",
	"azure_devops",
	"fizzy",
	"gitlab",
	"linear",
	"github",
	"ai_update",
	"approved_proposal",
	"custom_agent",
	"slack",
];

export const STORY_SOURCE_LABELS: Record<StorySource, string> = {
	manual: "Manual Entry",
	jira: "Jira",
	azure_devops: "Azure DevOps",
	fizzy: "Fizzy",
	gitlab: "GitLab",
	linear: "Linear",
	github: "GitHub",
	ai_update: "AI Update",
	approved_proposal: "Approved Proposal",
	custom_agent: "Custom Agent",
	slack: "Slack",
};

export type RecencyWindowDays = 7 | 30 | 90;

export const RECENCY_WINDOW_OPTIONS: RecencyWindowDays[] = [7, 30, 90];

export type RoadmapFilters = {
	q: string;
	kind: StoryKind[];
	priority: StoryPriority[];
	stage: MaturationStatus[];
	sync: SyncFilter[];
	source: StorySource[];
	size: StorySize[];
	tags: string[];
	tagsLogic: "AND" | "OR";
	createdFrom: string | null;
	createdTo: string | null;
	updatedFrom: string | null;
	updatedTo: string | null;
	syncedFrom: string | null;
	syncedTo: string | null;
	missingAc: boolean;
	missingDesc: boolean;
	/** Show only stories that are part of at least one PENDING duplicate link.
	 * Applied in StoriesRoadmap (where the duplicate-scan data is in scope), not
	 * in `applyRoadmapFilters` — see the note there. */
	duplicatesOnly: boolean;
	/** Show only bugs the AI triage flagged as needing more info
	 * (`story.needsMoreInfo`; always false for features). */
	needsMoreInfo: boolean;
	/** Show only work items flagged as blocked (`story.blocked`). */
	blocked: boolean;
	/** Show ONLY hidden (drafting stage CLOSED) items — the "Hidden" flag.
	 * Closed items are normally excluded; this flag includes AND narrows to
	 * them. The component opts the closed subset back into the visible list. */
	hiddenOnly: boolean;
	recentlyApproved: RecencyWindowDays | null;
	recentlyChanged: RecencyWindowDays | null;
	recentlyAdded: RecencyWindowDays | null;
};

export const EMPTY_ROADMAP_FILTERS: RoadmapFilters = {
	q: "",
	kind: [],
	priority: [],
	stage: [],
	sync: [],
	source: [],
	size: [],
	tags: [],
	tagsLogic: "OR",
	createdFrom: null,
	createdTo: null,
	updatedFrom: null,
	updatedTo: null,
	syncedFrom: null,
	syncedTo: null,
	missingAc: false,
	missingDesc: false,
	duplicatesOnly: false,
	needsMoreInfo: false,
	blocked: false,
	hiddenOnly: false,
	recentlyApproved: null,
	recentlyChanged: null,
	recentlyAdded: null,
};

// Maturation V2 stages users can pick in the Stage filter dropdown.
export const FILTERABLE_STAGES: MaturationStatus[] = MATURATION_STATUS_OPTIONS;

export const FILTERABLE_PRIORITIES: StoryPriority[] = [
	"P0_CRITICAL",
	"P1_HIGH",
	"P2_MEDIUM",
	"P3_LOW",
];

export function hasActiveRoadmapFilters(filters: RoadmapFilters): boolean {
	return (
		filters.q.trim().length > 0 ||
		filters.kind.length > 0 ||
		filters.priority.length > 0 ||
		filters.stage.length > 0 ||
		filters.sync.length > 0 ||
		filters.source.length > 0 ||
		filters.size.length > 0 ||
		filters.tags.length > 0 ||
		filters.createdFrom !== null ||
		filters.createdTo !== null ||
		filters.updatedFrom !== null ||
		filters.updatedTo !== null ||
		filters.syncedFrom !== null ||
		filters.syncedTo !== null ||
		filters.missingAc ||
		filters.missingDesc ||
		filters.duplicatesOnly ||
		filters.needsMoreInfo ||
		filters.blocked ||
		filters.hiddenOnly ||
		filters.recentlyApproved !== null ||
		filters.recentlyChanged !== null ||
		filters.recentlyAdded !== null
	);
}

/**
 * Counts how many filter *groups* (dimensions) are currently active. Used for
 * the consolidated "Filters" button badge — search (`q`) and sort are surfaced
 * in the bar itself, so they are intentionally excluded here. Each multi-select
 * dimension counts once regardless of how many values are selected; each date
 * range counts once if either bound is set; each flag/recency counts once.
 */
export function activeFilterGroupCount(filters: RoadmapFilters): number {
	let n = 0;
	if (filters.kind.length > 0) {
		n++;
	}
	if (filters.priority.length > 0) {
		n++;
	}
	if (filters.stage.length > 0) {
		n++;
	}
	if (filters.sync.length > 0) {
		n++;
	}
	if (filters.source.length > 0) {
		n++;
	}
	if (filters.size.length > 0) {
		n++;
	}
	if (filters.tags.length > 0) {
		n++;
	}
	if (filters.createdFrom || filters.createdTo) {
		n++;
	}
	if (filters.updatedFrom || filters.updatedTo) {
		n++;
	}
	if (filters.syncedFrom || filters.syncedTo) {
		n++;
	}
	if (filters.missingDesc) {
		n++;
	}
	if (filters.missingAc) {
		n++;
	}
	if (filters.duplicatesOnly) {
		n++;
	}
	if (filters.needsMoreInfo) {
		n++;
	}
	if (filters.blocked) {
		n++;
	}
	if (filters.hiddenOnly) {
		n++;
	}
	if (filters.recentlyApproved !== null) {
		n++;
	}
	if (filters.recentlyAdded !== null) {
		n++;
	}
	if (filters.recentlyChanged !== null) {
		n++;
	}
	return n;
}

/**
 * Counts active filters that live under the "More filters" disclosure —
 * everything except the primary Type / Priority / Stage facets, which are
 * always shown inline. Drives the "More filters" badge so a collapsed
 * disclosure still signals that hidden filters are active.
 */
export function activeMoreFilterCount(filters: RoadmapFilters): number {
	let n = 0;
	if (filters.sync.length > 0) {
		n++;
	}
	if (filters.source.length > 0) {
		n++;
	}
	if (filters.size.length > 0) {
		n++;
	}
	if (filters.tags.length > 0) {
		n++;
	}
	if (filters.createdFrom || filters.createdTo) {
		n++;
	}
	if (filters.updatedFrom || filters.updatedTo) {
		n++;
	}
	if (filters.syncedFrom || filters.syncedTo) {
		n++;
	}
	if (filters.missingDesc) {
		n++;
	}
	if (filters.missingAc) {
		n++;
	}
	if (filters.duplicatesOnly) {
		n++;
	}
	if (filters.needsMoreInfo) {
		n++;
	}
	if (filters.blocked) {
		n++;
	}
	if (filters.hiddenOnly) {
		n++;
	}
	if (filters.recentlyApproved !== null) {
		n++;
	}
	if (filters.recentlyAdded !== null) {
		n++;
	}
	if (filters.recentlyChanged !== null) {
		n++;
	}
	return n;
}

const FILTERABLE_SOURCE_SET: ReadonlySet<string> = new Set(FILTERABLE_SOURCES);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseFromDate(value: string | null): Date | null {
	if (!value || !DATE_RE.test(value)) {
		return null;
	}
	const d = new Date(`${value}T00:00:00`);
	return Number.isNaN(d.getTime()) ? null : d;
}

function parseToDate(value: string | null): Date | null {
	if (!value || !DATE_RE.test(value)) {
		return null;
	}
	const d = new Date(`${value}T23:59:59.999`);
	return Number.isNaN(d.getTime()) ? null : d;
}

function isBlank(value: string | null | undefined): boolean {
	return value === null || value === undefined || value.trim().length === 0;
}

function recencyCutoff(days: number): Date {
	return new Date(Date.now() - days * 86_400_000);
}

/**
 * Normalizes `story.source` for the filter:
 *  - Uppercase Prisma enums (`"JIRA"`) are lowercased so a missed
 *    `transformStory()` upstream doesn't silently empty the roadmap.
 *  - Null / undefined / empty / **any unknown value** (typos, retired
 *    enum values from old deploys, etc.) collapses to `"manual"`. This
 *    matches the schema default, which means legacy NULL rows appear
 *    under the "Manual entry" filter chip. A separate "Unknown" bucket
 *    was considered and rejected — it exposes a state most users
 *    shouldn't see, and the schema default already makes NULL
 *    impossible for newly-written rows. The unknown-string collapse is
 *    silent on purpose: noisy logging from a hot render path is worse
 *    than the rare data-quality miss. If such a miss surfaces in bug
 *    reports the right next step is observability at the write
 *    boundary, not here.
 */
export function normalizeStorySource(
	value: string | null | undefined,
): StorySource {
	if (!value) {
		return "manual";
	}
	const lower = value.toLowerCase();
	return FILTERABLE_SOURCE_SET.has(lower) ? (lower as StorySource) : "manual";
}

type SearchToken = { raw: string; normalized: string };

/**
 * Split the search into whitespace-delimited tokens. Callers require EVERY
 * token to appear (as a substring) somewhere in the story's searchable text,
 * which makes multi-word search order-independent — "login oauth" and "oauth
 * login" both match "Add OAuth login" — and is a strict superset of the old
 * exact-contiguous-phrase match, so nothing that matched before disappears.
 * Each token also carries its identifier-normalized form, so a `B-011` token
 * still finds a new plain-numeric `11` row. An all-whitespace query trims to
 * "" → no tokens → no search filter.
 */
function buildSearchTokens(query: string): SearchToken[] {
	const needle = query.trim().toLowerCase();
	if (!needle) {
		return [];
	}
	return needle
		.split(/\s+/)
		.filter(Boolean)
		.map((token) => {
			const normalized = normalizeStoryIdentifierQuery(token);
			return {
				raw: token,
				normalized: normalized !== token ? normalized : "",
			};
		});
}

/** AND across tokens (order-independent); each token matches its raw form OR
 * its identifier-normalized form (`B-011` → `011`). */
function matchesEveryToken(haystack: string, tokens: SearchToken[]): boolean {
	return tokens.every(
		(token) =>
			haystack.includes(token.raw) ||
			(token.normalized.length > 0 &&
				haystack.includes(token.normalized)),
	);
}

/**
 * Split search results into the ones the query reaches BY NAME and the ones it
 * only reaches through body prose (Fizzy #1937 follow-up).
 *
 * Relevance ranking sorts a title hit above a description hit but still lists
 * every description hit, so a query whose words are common in prose returns a
 * long tail of rows that only mention them in passing. The roadmap uses this
 * split to show the name matches and collapse the rest behind a count.
 *
 * "By name" is title, identifier and externalId — the fields that identify a
 * work item. The source label ("Jira", "Manual Entry") is deliberately NOT a
 * name field: matching every Jira row on "jira" is precisely the noise being
 * collapsed. The token model is `applyRoadmapFilters`' own, so the split and
 * the filter can never disagree about WHY a row is in the list.
 *
 * With no query every story is a name match and `bodyOnly` is empty, so a
 * caller that forgets to guard on an empty query narrows nothing.
 */
export function partitionByNameMatch(
	stories: UserStory[],
	query: string,
): { nameMatches: UserStory[]; bodyOnly: UserStory[] } {
	const tokens = buildSearchTokens(query);
	if (tokens.length === 0) {
		return { nameMatches: [...stories], bodyOnly: [] };
	}
	const nameMatches: UserStory[] = [];
	const bodyOnly: UserStory[] = [];
	for (const story of stories) {
		const name = [story.title, story.identifier, story.externalId ?? ""]
			.join("\n")
			.toLowerCase();
		if (matchesEveryToken(name, tokens)) {
			nameMatches.push(story);
		} else {
			bodyOnly.push(story);
		}
	}
	return { nameMatches, bodyOnly };
}

export function applyRoadmapFilters(
	stories: UserStory[],
	filters: RoadmapFilters,
	options?: { allowClosedInStageFilter?: boolean },
): UserStory[] {
	const searchTokens = buildSearchTokens(filters.q);
	const kindFilter = filters.kind.length > 0 ? new Set(filters.kind) : null;
	const priorityFilter =
		filters.priority.length > 0 ? new Set(filters.priority) : null;
	const stageFilter =
		filters.stage.length > 0 ? new Set(filters.stage) : null;
	const syncFilter = filters.sync.length > 0 ? new Set(filters.sync) : null;
	const sourceFilter =
		filters.source.length > 0 ? new Set(filters.source) : null;
	const sizeFilter = filters.size.length > 0 ? new Set(filters.size) : null;
	const tagsFilter = filters.tags.length > 0 ? new Set(filters.tags) : null;
	const createdFrom = parseFromDate(filters.createdFrom);
	const createdTo = parseToDate(filters.createdTo);
	const updatedFrom = parseFromDate(filters.updatedFrom);
	const updatedTo = parseToDate(filters.updatedTo);
	const syncedFrom = parseFromDate(filters.syncedFrom);
	const syncedTo = parseToDate(filters.syncedTo);

	return stories.filter((story) => {
		if (kindFilter && !kindFilter.has(story.kind)) {
			return false;
		}
		if (priorityFilter && !priorityFilter.has(story.priority)) {
			return false;
		}
		if (stageFilter) {
			if (
				story.draftingStage === "CLOSED" &&
				!options?.allowClosedInStageFilter
			) {
				return false;
			}
			// Supports both Maturation V2 status matching and programmatic legacy drafting stage callers.
			if (
				!stageFilter.has(getMaturationStatus(story)) &&
				!stageFilter.has(story.draftingStage as any)
			) {
				return false;
			}
		}
		if (syncFilter) {
			// "Synced" = has a PM-tool link AND the latest push didn't fail.
			// CONFLICT and PENDING keep the story in "Synced" because the link
			// exists and the push is in flight; demoting them would make the
			// filter disagree with the StoryCard sync badge. FAILED demotes to
			// "Unsynced" so the filter reflects "currently aligned with the
			// PM tool".
			const status: SyncFilter =
				!story.externalId || story.lastPmSyncStatus === "FAILED"
					? "unsynced"
					: "synced";
			if (!syncFilter.has(status)) {
				return false;
			}
		}
		const normalizedSource = normalizeStorySource(story.source);
		if (sourceFilter && !sourceFilter.has(normalizedSource)) {
			return false;
		}
		if (sizeFilter && (!story.size || !sizeFilter.has(story.size))) {
			return false;
		}
		if (tagsFilter) {
			const storyTags = new Set(story.tags.map((t) => t.value));
			const selected = [...tagsFilter];
			const ok =
				filters.tagsLogic === "AND"
					? selected.every((t) => storyTags.has(t))
					: selected.some((t) => storyTags.has(t));
			if (!ok) {
				return false;
			}
		}
		if (searchTokens.length > 0) {
			const haystack = [
				story.title,
				story.identifier,
				story.externalId ?? "",
				story.description ?? "",
				STORY_SOURCE_LABELS[normalizedSource],
			]
				.join("\n")
				.toLowerCase();
			if (!matchesEveryToken(haystack, searchTokens)) {
				return false;
			}
		}
		if (createdFrom && story.createdAt < createdFrom) {
			return false;
		}
		if (createdTo && story.createdAt > createdTo) {
			return false;
		}
		// A date RANGE asks "where does this item sit in time", so it ranks a
		// never-edited item the same way its card and the sort do — by creation.
		// `recentlyChanged` below is a different question ("did someone change
		// this"), and there a missing edit event genuinely means no.
		if (updatedFrom || updatedTo) {
			const activityAt = storySemanticActivityAt(story);
			if (updatedFrom && activityAt < updatedFrom) {
				return false;
			}
			if (updatedTo && activityAt > updatedTo) {
				return false;
			}
		}
		// When every selected sync bucket is "unsynced", ignore the
		// sync-date range — unsynced rows have no sync date by definition,
		// so applying the range would silently empty the result. `.every()`
		// (rather than `length === 1 && [0] === "unsynced"`) handles the
		// `?sync=unsynced,unsynced` URL shape that nuqs' parseAsArrayOf
		// doesn't dedupe. With Synced / no bucket / both selected, the
		// range applies as before.
		const syncOnlyUnsynced =
			filters.sync.length > 0 &&
			filters.sync.every((s) => s === "unsynced");
		if ((syncedFrom || syncedTo) && !syncOnlyUnsynced) {
			if (!story.lastSyncedAt) {
				return false;
			}
			if (syncedFrom && story.lastSyncedAt < syncedFrom) {
				return false;
			}
			if (syncedTo && story.lastSyncedAt > syncedTo) {
				return false;
			}
		}
		if (filters.missingDesc && !isBlank(story.description)) {
			return false;
		}
		if (filters.missingAc && !isBlank(story.acceptanceCriteria)) {
			return false;
		}
		// AI bug-triage flag; always false for features (set at bug creation,
		// cleared by "Re-evaluate Bug"). The toggle therefore narrows to bugs
		// awaiting clarification.
		if (filters.needsMoreInfo && !story.needsMoreInfo) {
			return false;
		}
		// "Blocked" flag: narrow to work items explicitly marked blocked.
		if (filters.blocked && !story.blocked) {
			return false;
		}
		// "Hidden" flag: narrow to closed ("Hidden") items only.
		if (filters.hiddenOnly && story.draftingStage !== "CLOSED") {
			return false;
		}
		if (filters.recentlyApproved !== null) {
			if (story.draftingStage !== "PUBLISHED") {
				return false;
			}
			const stageTimestamp = story.draftingStageUpdatedAt;
			if (
				!stageTimestamp ||
				stageTimestamp < recencyCutoff(filters.recentlyApproved)
			) {
				return false;
			}
		}
		if (filters.recentlyChanged !== null) {
			if (
				!story.lastEditedAt ||
				story.lastEditedAt < recencyCutoff(filters.recentlyChanged)
			) {
				return false;
			}
		}
		if (filters.recentlyAdded !== null) {
			if (story.createdAt < recencyCutoff(filters.recentlyAdded)) {
				return false;
			}
		}
		return true;
	});
}

/**
 * Hidden matches — work items that are excluded from the default roadmap because
 * they are HIDDEN (drafting stage `CLOSED`, "completed or parked") yet still
 * satisfy the user's current search + filters. Powers the muted "N hidden also
 * match" count and the opt-in "Expand to include hidden" reveal, so users can
 * discover relevant parked work WITHOUT auto-revealing it or mutating their
 * filter state.
 *
 * Implementation: run the SAME filter predicate over just the closed subset
 * with `allowClosedInStageFilter: true`. `applyRoadmapFilters` excludes CLOSED
 * stories when an active stage filter is set unless `allowClosedInStageFilter`
 * is true, ensuring closed rows only match under the dedicated hidden query.
 * DECLINED rows are never included (the subset is CLOSED-only). The `duplicatesOnly`
 * facet is applied by the caller, where the client-only duplicate-scan data is in
 * scope — mirroring how `applyRoadmapFilters`'s callers handle it for the visible list.
 */
export function selectHiddenMatches(
	stories: UserStory[],
	filters: RoadmapFilters,
): UserStory[] {
	return applyRoadmapFilters(
		stories.filter((s) => s.draftingStage === "CLOSED"),
		filters,
		{ allowClosedInStageFilter: true },
	);
}
