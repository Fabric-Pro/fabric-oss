import type { ReviewBaseline } from "./data";
import { reviewFingerprint } from "./fingerprints";
import { escapeHtml, reviewPage, storyCard, verdictTiles } from "./page";
import type { SprintReviewCache } from "./sprint-cache";

/** The name a person field holds: an identity, or a plain string some fields store. */
function personName(
	person: SprintReviewCache["assignedItems"][number]["engineer"] | undefined,
): string | null {
	return typeof person === "string" ? person : (person?.uniqueName ?? null);
}

function sourceLink(id: number, sourceUrl: string, title: string) {
	const url =
		/^https:\/\/dev\.azure\.com\/[A-Za-z0-9-]+\/[^/?#]+\/_workitems\/edit\/[1-9]\d*$/.test(
			sourceUrl,
		)
			? sourceUrl
			: null;
	const label = escapeHtml(`#${id} ${title}`);
	return url
		? `<a href="${escapeHtml(url)}" rel="noopener noreferrer">${label}</a>`
		: label;
}

type ItemSource = Pick<
	SprintReviewCache["stories"][number]["sourceDetails"],
	"requirements" | "comments"
>;

const parentResolutionLabels: Record<
	SprintReviewCache["assignedItems"][number]["parentResolution"],
	string
> = {
	direct_story: "Selected story",
	parent_followed: "Parent story selected",
	parent_type_excluded: "Parent type outside selection",
	parent_source_excluded: "Parent expansion disabled for this type",
	no_parent: "No parent story",
};

function itemChangeReasons(
	before: ItemSource,
	after: ItemSource,
	label: string,
) {
	const reasons: string[] = [];
	const fields = [
		...new Set([
			...Object.keys(before.requirements),
			...Object.keys(after.requirements),
		]),
	].sort();
	for (const field of fields) {
		if (before.requirements[field] !== after.requirements[field]) {
			reasons.push(`${label} requirements changed: ${field}`);
		}
	}
	const key = (comment: ItemSource["comments"][number]) =>
		`${comment.itemId}:${comment.id}`;
	const prior = new Map(
		before.comments.map((comment) => [key(comment), comment]),
	);
	const current = new Set(after.comments.map(key));
	for (const comment of after.comments) {
		const old = prior.get(key(comment));
		if (old?.fingerprint === comment.fingerprint) {
			continue;
		}
		const action = comment.isDeleted ? "deleted" : old ? "edited" : "added";
		reasons.push(`${label} comment ${comment.id} ${action}`);
	}
	for (const comment of before.comments) {
		if (!current.has(key(comment))) {
			reasons.push(`${label} comment ${comment.id} deleted`);
		}
	}
	return reasons;
}

export function renderSprintStoryReview(
	cache: SprintReviewCache,
	baseline: ReviewBaseline,
	reviewed: number,
	analysis: ReviewBaseline,
) {
	const previous = baseline.cache?.version === 2 ? baseline.cache : undefined;
	const prior = new Map(previous?.stories.map((story) => [story.id, story]));
	const current = new Set(cache.stories.map((story) => story.id));
	const removedIds =
		previous?.stories
			.filter((story) => !current.has(story.id))
			.map((story) => story.id) ?? [];
	const addedIds = previous
		? cache.stories
				.filter((story) => !prior.has(story.id))
				.map((story) => story.id)
		: [];
	const changes = cache.stories.flatMap((story) => {
		const old = prior.get(story.id);
		if (!old) {
			return [];
		}
		const reasons = itemChangeReasons(
			old.sourceDetails,
			story.sourceDetails,
			"story",
		);
		const beforeItems = new Map(
			old.sourceDetails.contextItems.map((item) => [item.id, item]),
		);
		const afterItems = new Map(
			story.sourceDetails.contextItems.map((item) => [item.id, item]),
		);
		const contextIds = [
			...new Set([...beforeItems.keys(), ...afterItems.keys()]),
		].sort((a, b) => a - b);
		for (const itemId of contextIds) {
			const before = beforeItems.get(itemId);
			const after = afterItems.get(itemId);
			if (!before || !after) {
				reasons.push(
					`context #${itemId} ${before ? "removed" : "added"}`,
				);
			} else {
				if (before.workItemType !== after.workItemType) {
					reasons.push(
						`context #${itemId} type: ${before.workItemType} → ${after.workItemType}`,
					);
				}
				reasons.push(
					...itemChangeReasons(before, after, `context #${itemId}`),
				);
			}
		}
		if (
			reviewFingerprint(old.sourceDetails.edges) !==
			reviewFingerprint(story.sourceDetails.edges)
		) {
			reasons.push("child or Related relations changed");
		}
		if (
			reviewFingerprint(old.observation) !==
			reviewFingerprint(story.observation)
		) {
			reasons.push("story, context or discovery observations changed");
		}
		if (previous?.evaluatorFingerprint !== cache.evaluatorFingerprint) {
			reasons.push("review evaluator changed");
		}
		return reasons.length ? [{ id: story.id, reasons }] : [];
	});
	const workloadChanged = Boolean(
		previous &&
			reviewFingerprint(previous.assignedItems) !==
				reviewFingerprint(cache.assignedItems),
	);
	const dailyChanges = [
		...addedIds.map((id) => `#${id}: added to sprint story selection`),
		...changes.map(
			(change) => `#${change.id}: ${change.reasons.join("; ")}`,
		),
		...removedIds.map(
			(id) => `#${id}: removed from sprint story selection`,
		),
		...(workloadChanged
			? ["Assigned sprint workload observations changed."]
			: []),
	];
	const counts = {
		total: cache.stories.length,
		reviewed,
		reused: cache.stories.length - reviewed,
		removed: removedIds.length,
	};
	const interval = previous
		? `Changes since the scheduled capture at ${previous.requirementsAsOf}, through ${cache.requirementsAsOf}.`
		: baseline.status === "incomplete"
			? "Scheduled comparison is incomplete; no compatible valid sprint capture was found within the bounded lookup."
			: "Initial sprint baseline: no prior compatible scheduled capture.";
	const headline = `${counts.total} sprint stories: ${reviewed} reviewed, ${counts.reused} reused, ${counts.removed} removed. Requirements as of ${cache.requirementsAsOf}. ${interval} Comments are non-atomic current captures.${baseline.rejectedCandidates ? " Invalid stored comparison candidates were rejected." : ""}${analysis.status === "incomplete" ? " Prior AI judgment reuse is incomplete." : ""}`;
	const workload = cache.assignedItems
		.map(
			(item) =>
				`<tr><td>${sourceLink(item.id, item.sourceUrl, item.workItemType)}</td><td>${escapeHtml(item.state)}</td><td>${escapeHtml(item.iterationPath)}</td><td>${escapeHtml(item.assignedTo?.uniqueName ?? "unassigned")}</td><td>${escapeHtml(personName(item.engineer) ?? "unassigned")}</td><td>${parentResolutionLabels[item.parentResolution]}</td><td>${item.storyIds.join(", ") || "none selected"}</td></tr>`,
		)
		.join("");
	const assignedItems = new Map(
		cache.assignedItems.map((item) => [item.id, item]),
	);
	// A story is often picked through a person field other than AssignedTo
	// (an engineer field, say), so the card names whoever selected it.
	const assigneesOf = (story: (typeof cache.stories)[number]) => {
		const names = new Set<string>();
		if (story.observation.assignedTo) {
			names.add(story.observation.assignedTo);
		}
		for (const source of story.observation.discoverySources) {
			const item = assignedItems.get(source.assignedItemId);
			const name =
				personName(item?.engineer) ?? item?.assignedTo?.uniqueName;
			if (name) {
				names.add(name);
			}
		}
		return [...names].join(", ") || "unassigned";
	};
	const cards = cache.stories
		.map((story) => {
			const context = story.observation.contextItems
				.map((item) => {
					const roles = story.sourceDetails.edges
						.filter((edge) => edge.targetId === item.id)
						.map((edge) => edge.kind)
						.join(", ");
					return `<li>${escapeHtml(roles)}: ${sourceLink(item.id, item.sourceUrl, item.title)} · ${escapeHtml(item.workItemType)} · ${escapeHtml(item.state)}</li>`;
				})
				.join("");
			const discovered = story.observation.discoverySources
				.map((source) => `#${source.assignedItemId} (${source.kind})`)
				.join(", ");
			return storyCard({
				titleHtml: sourceLink(
					story.id,
					story.observation.sourceUrl,
					story.observation.title,
				),
				verdict: story.review.verdict,
				facts: [
					story.observation.state,
					`assigned: ${assigneesOf(story)}`,
					`from ${discovered}`,
				],
				summary: story.review.summary,
				issues: story.review.issues,
				moreHtml: `<details><summary>Immediate context (${story.observation.contextItems.length})</summary><ul>${context || "<li>None</li>"}</ul></details>`,
			});
		})
		.join("");
	const html = reviewPage({
		title: "Sprint story review",
		headline,
		tiles: [
			{ label: "Stories", value: counts.total },
			...verdictTiles(cache.stories.map((story) => story.review.verdict)),
			{ label: "Reviewed now", value: reviewed },
			{ label: "Reused", value: counts.reused },
		],
		changes: previous ? dailyChanges : null,
		sectionsHtml: `<section><p class="label">Stories</p><div class="cards">${cards || '<p class="empty">No stories in this selection.</p>'}</div></section><section><p class="label">Assigned sprint workload</p><div class="panel scroll"><table><thead><tr><th>Item</th><th>State</th><th>Iteration</th><th>Assigned</th><th>Engineer</th><th>Parent</th><th>Stories</th></tr></thead><tbody>${workload}</tbody></table></div></section>`,
	});
	if (html.length > 400_000) {
		throw new Error("Rendered story review exceeds output limit");
	}
	return {
		counts,
		comparison: {
			status: baseline.status,
			executionId: baseline.executionId,
			requirementsAsOf: previous?.requirementsAsOf,
			through: cache.requirementsAsOf,
			rejectedCandidates: baseline.rejectedCandidates,
			hasMore: baseline.hasMore,
		},
		removedIds,
		addedIds,
		changedIds: changes.map((change) => change.id),
		changes,
		dailyChanges,
		workloadChanged,
		workload: cache.assignedItems,
		summary: [headline, ...dailyChanges].join("\n"),
		html,
	};
}
