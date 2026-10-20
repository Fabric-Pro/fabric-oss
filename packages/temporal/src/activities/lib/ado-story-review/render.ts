import type { ReviewBaseline } from "./data";
import { reviewFingerprint } from "./fingerprints";
import type { SprintReviewCache } from "./sprint-cache";

export function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, (character) => {
		switch (character) {
			case "&":
				return "&amp;";
			case "<":
				return "&lt;";
			case ">":
				return "&gt;";
			case '"':
				return "&quot;";
			case "'":
				return "&#39;";
			default:
				return character;
		}
	});
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
				`<li>${sourceLink(item.id, item.sourceUrl, item.workItemType)}: ${escapeHtml(item.state)} · ${escapeHtml(item.iterationPath)} · assigned: ${escapeHtml(item.assignedTo?.uniqueName ?? "unassigned")} · engineer: ${escapeHtml(typeof item.engineer === "string" ? item.engineer : (item.engineer?.uniqueName ?? "unassigned"))} · ${parentResolutionLabels[item.parentResolution]} · stories: ${item.storyIds.join(", ") || "none selected"}</li>`,
		)
		.join("");
	const rows = cache.stories
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
			return `<article><h2>${sourceLink(story.id, story.observation.sourceUrl, story.observation.title)}</h2><p>${escapeHtml(story.observation.state)} · assigned: ${escapeHtml(story.observation.assignedTo ?? "unassigned")} · ${escapeHtml(story.review.verdict)}</p><p>${escapeHtml(story.review.summary)}</p><ul>${story.review.issues.map((issue) => `<li>${escapeHtml(issue)}</li>`).join("")}</ul><p>Discovered from ${story.observation.discoverySources.map((source) => `#${source.assignedItemId} (${source.kind})`).join(", ")}</p><h3>Immediate context</h3><ul>${context}</ul></article>`;
		})
		.join("");
	const html = `<!doctype html><html><head><meta charset="utf-8"><title>Sprint story review</title></head><body><h1>Sprint story review</h1><p>${escapeHtml(headline)}</p><ul>${dailyChanges.map((change) => `<li>${escapeHtml(change)}</li>`).join("")}</ul><h2>Assigned sprint workload</h2><ul>${workload}</ul>${rows}</body></html>`;
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
