/**
 * Daily Brief — Storyline Reducer
 *
 * Takes raw section data and clusters items by the userStory they touch.
 * Pure logic — no I/O. The LLM narrative generation (headline + prose)
 * happens in summarize-daily-brief; this module only returns the clusters.
 *
 * Scope: in-flight work only. Merged PRs (`pr_merged`) are intentionally
 * excluded — those are surfaced by `ReleaseNotesPanel` instead, partitioned
 * by deploy environment. This keeps Storylines and Release Notes orthogonal:
 * Storylines = "what's moving", Release Notes = "what shipped".
 */
import type {
	DailyBriefSections,
	GithubItem,
	StoryChangeItem,
	Storyline,
	StorylineRelatedItem,
	TaskChangeItem,
} from "@repo/database";

const MAX_CLUSTERS = 5;
const MIN_ITEMS_PER_CLUSTER = 2;

interface Cluster {
	storyCuid: string;
	storyIdentifier?: string;
	relatedItems: StorylineRelatedItem[];
}

function push(
	map: Map<string, Cluster>,
	storyCuid: string,
	storyIdentifier: string | undefined,
	item: StorylineRelatedItem,
) {
	let cluster = map.get(storyCuid);
	if (!cluster) {
		cluster = {
			storyCuid,
			storyIdentifier,
			relatedItems: [],
		};
		map.set(storyCuid, cluster);
	}
	cluster.relatedItems.push(item);
}

function toRelated(
	kind: StorylineRelatedItem["kind"],
	params: { refId: string; occurredAt: Date | string; title?: string },
): StorylineRelatedItem {
	return {
		kind,
		refId: params.refId,
		occurredAt:
			params.occurredAt instanceof Date
				? params.occurredAt
				: new Date(params.occurredAt),
		...(params.title ? { title: params.title } : {}),
	};
}

export function clusterActivityByStory(
	sections: DailyBriefSections,
): Array<Pick<Storyline, "storyCuid" | "storyIdentifier" | "relatedItems">> {
	const map = new Map<string, Cluster>();

	// Build an identifier → real-cuid lookup from story/task items first so
	// a GitHub PR mentioning "F-12" joins the same cluster as that story's
	// change events, instead of creating a parallel identifier-keyed bucket.
	const identifierToCuid = new Map<string, string>();
	for (const s of (sections.storyChanges ?? []) as StoryChangeItem[]) {
		if (s.storyIdentifier) {
			identifierToCuid.set(s.storyIdentifier, s.storyCuid);
		}
	}
	for (const t of (sections.taskChanges ?? []) as TaskChangeItem[]) {
		if (t.storyIdentifier && t.storyCuid) {
			identifierToCuid.set(t.storyIdentifier, t.storyCuid);
		}
	}

	for (const s of (sections.storyChanges ?? []) as StoryChangeItem[]) {
		push(
			map,
			s.storyCuid,
			s.storyIdentifier,
			toRelated("story_change", {
				refId: s.storyCuid,
				occurredAt: s.occurredAt,
				title: s.title,
			}),
		);
	}

	for (const t of (sections.taskChanges ?? []) as TaskChangeItem[]) {
		if (!t.storyCuid) {
			continue;
		}
		push(
			map,
			t.storyCuid,
			t.storyIdentifier,
			toRelated("task_change", {
				refId: t.taskCuid,
				occurredAt: t.occurredAt,
				title: t.title,
			}),
		);
	}

	// GitHub: match when PR title contains a story identifier like "F-12".
	// If we've seen a real cuid for that identifier in the story/task sections,
	// key the PR onto the real cuid so they merge into one cluster.
	//
	// Excludes pr_merged — merged PRs belong to the Release Notes panel
	// (partitioned by deploy environment). Storylines covers in-flight work:
	// pr_opened, pr_awaiting_review, pr_closed.
	const idRe = /\b([A-Z]+-\d+)\b/;
	for (const g of (sections.github ?? []) as GithubItem[]) {
		if (g.kind === "pr_merged") {
			continue;
		}
		const m = g.title.match(idRe);
		if (!m) {
			continue;
		}
		const storyIdentifier = m[1];
		const resolvedCuid = identifierToCuid.get(storyIdentifier);
		const key = resolvedCuid ?? storyIdentifier;
		push(
			map,
			key,
			storyIdentifier,
			toRelated("github", {
				refId: `pr-${g.prNumber}`,
				occurredAt: g.occurredAt,
				title: g.title,
			}),
		);
	}

	// Documents, meetings, and proposals don't carry a story link yet, so they
	// don't contribute to clusters.

	const clusters = Array.from(map.values()).filter(
		(c) => c.relatedItems.length >= MIN_ITEMS_PER_CLUSTER,
	);

	clusters.sort((a, b) => b.relatedItems.length - a.relatedItems.length);

	return clusters.slice(0, MAX_CLUSTERS).map((c) => ({
		storyCuid: c.storyCuid as string | undefined,
		storyIdentifier: c.storyIdentifier,
		relatedItems: c.relatedItems,
	}));
}
