import type { AdoReviewBaselinePage } from "@repo/database";
import { z } from "zod";
import { ADO_REVIEW_MAX_STORIES } from "../../../lib/ado-story-review-config";
import {
	observationSchema,
	reviewFingerprint,
	sourceDetailsSchema,
	storyReviewSchema,
} from "./fingerprints";
import { escapeHtml, renderSprintStoryReview } from "./render";
import { sprintReviewCacheSchema } from "./sprint-cache";

export {
	observation,
	reviewFingerprint,
	sourceDetails,
	sourceFingerprint,
	storyReviewSchema,
} from "./fingerprints";

const hash = z.string().regex(/^[a-f0-9]{64}$/);

export const directReviewCacheSchema = z
	.object({
		version: z.literal(1),
		userId: z.string().min(1).max(128),
		organizationId: z.string().min(1).max(128),
		projectId: z.string().min(1).max(128),
		workflowId: z.string().min(1).max(128),
		nodeId: z.string().min(1).max(128),
		selectionFingerprint: hash,
		evaluatorFingerprint: hash,
		requirementsAsOf: z.string().datetime(),
		stories: z
			.array(
				z
					.object({
						id: z.number().int().positive(),
						sourceFingerprint: hash,
						sourceDetails: sourceDetailsSchema,
						observation: observationSchema,
						review: storyReviewSchema,
					})
					.strict(),
			)
			.max(ADO_REVIEW_MAX_STORIES),
	})
	.strict()
	.refine(
		(cache) =>
			new Set(cache.stories.map((story) => story.id)).size ===
				cache.stories.length &&
			cache.stories.every(
				(story) =>
					story.id === story.review.id &&
					story.sourceFingerprint ===
						reviewFingerprint(story.sourceDetails),
			) &&
			JSON.stringify(cache).length <= 600_000,
	);

export const reviewCacheSchema = z.discriminatedUnion("version", [
	directReviewCacheSchema,
	sprintReviewCacheSchema,
]);
export type ReviewCache = z.infer<typeof reviewCacheSchema>;
export type StoryReview = z.infer<typeof storyReviewSchema>;
export type ReviewBinding = Pick<
	ReviewCache,
	| "userId"
	| "organizationId"
	| "projectId"
	| "workflowId"
	| "nodeId"
	| "selectionFingerprint"
>;

export interface ReviewBaseline {
	cache: ReviewCache | undefined;
	status: "available" | "missing" | "incomplete";
	executionId: string | undefined;
	rejectedCandidates: number;
	hasMore: boolean;
}

function compareWatermarks(left: string, right: string): number {
	const seconds =
		Math.floor(Date.parse(left) / 1_000) -
		Math.floor(Date.parse(right) / 1_000);
	if (seconds) {
		return seconds;
	}
	const fraction = (value: string) =>
		(value.match(/\.(\d+)Z$/)?.[1] ?? "").replace(/0+$/, "");
	const a = fraction(left);
	const b = fraction(right);
	return a < b ? -1 : a > b ? 1 : 0;
}

/** Revalidate the complete caches and preserve watermark order within the bounded projection. */
export function selectReviewBaseline(
	page: AdoReviewBaselinePage,
	binding: ReviewBinding,
	requirementsAsOf: string,
	captureStartedAt: string,
	evaluatorFingerprint?: string,
	cacheVersion: 1 | 2 = 1,
): ReviewBaseline {
	const eligible: Array<{
		cache: ReviewCache;
		executionId: string;
		completedAt: number;
	}> = [];
	let rejectedCandidates = 0;
	for (const candidate of page.candidates) {
		const parsed = reviewCacheSchema.safeParse(candidate.cache);
		if (
			!parsed.success ||
			parsed.data.version !== cacheVersion ||
			parsed.data.requirementsAsOf.length > 64 ||
			!Number.isFinite(candidate.completedAt.getTime()) ||
			candidate.completedAt.getTime() > Date.parse(captureStartedAt) ||
			reviewFingerprint(binding) !==
				reviewFingerprint({
					userId: parsed.data.userId,
					organizationId: parsed.data.organizationId,
					projectId: parsed.data.projectId,
					workflowId: parsed.data.workflowId,
					nodeId: parsed.data.nodeId,
					selectionFingerprint: parsed.data.selectionFingerprint,
				}) ||
			(evaluatorFingerprint !== undefined &&
				parsed.data.evaluatorFingerprint !== evaluatorFingerprint) ||
			compareWatermarks(parsed.data.requirementsAsOf, requirementsAsOf) >
				0
		) {
			rejectedCandidates++;
			continue;
		}
		eligible.push({
			cache: parsed.data,
			executionId: candidate.id,
			completedAt: candidate.completedAt.getTime(),
		});
	}
	eligible.sort(
		(a, b) =>
			compareWatermarks(
				b.cache.requirementsAsOf,
				a.cache.requirementsAsOf,
			) ||
			b.completedAt - a.completedAt ||
			(a.executionId < b.executionId
				? 1
				: a.executionId > b.executionId
					? -1
					: 0),
	);
	const selected = eligible[0];
	return {
		cache: selected?.cache,
		status: selected
			? "available"
			: rejectedCandidates || page.hasMore
				? "incomplete"
				: "missing",
		executionId: selected?.executionId,
		rejectedCandidates,
		hasMore: page.hasMore,
	};
}

export function parseStoryReviews(text: string, ids: number[]): StoryReview[] {
	if (text.length > 300_000) {
		throw new Error("Review response exceeds limit");
	}
	const result = z
		.object({
			reviews: z.array(storyReviewSchema).max(ADO_REVIEW_MAX_STORIES),
		})
		.strict()
		.parse(JSON.parse(text));
	const expected = new Set(ids);
	if (
		result.reviews.length !== ids.length ||
		result.reviews.some((review) => !expected.delete(review.id))
	) {
		throw new Error("Review response does not match requested stories");
	}
	return result.reviews.sort((a, b) => a.id - b.id);
}

export function renderStoryReview(
	cache: ReviewCache,
	baseline: ReviewBaseline,
	reviewed: number,
	analysis: ReviewBaseline,
) {
	if (cache.version === 2) {
		return renderSprintStoryReview(cache, baseline, reviewed, analysis);
	}
	const previous = baseline.cache?.version === 1 ? baseline.cache : undefined;
	const current = new Set(cache.stories.map((story) => story.id));
	const removed =
		previous?.stories
			.filter((story) => !current.has(story.id))
			.map((story) => story.id) ?? [];
	const prior = new Map(previous?.stories.map((story) => [story.id, story]));
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
		const requirementFields = [
			...new Set([
				...Object.keys(old.sourceDetails.requirements),
				...Object.keys(story.sourceDetails.requirements),
			]),
		]
			.sort()
			.filter(
				(field) =>
					old.sourceDetails.requirements[field] !==
					story.sourceDetails.requirements[field],
			);
		const oldComments = new Map(
			old.sourceDetails.comments.map((comment) => [comment.id, comment]),
		);
		const newComments = new Map(
			story.sourceDetails.comments.map((comment) => [
				comment.id,
				comment,
			]),
		);
		const comments: {
			added: number[];
			edited: number[];
			deleted: number[];
		} = {
			added: [],
			edited: [],
			deleted: [],
		};
		for (const comment of story.sourceDetails.comments) {
			const before = oldComments.get(comment.id);
			if (
				comment.isDeleted &&
				(!before?.isDeleted ||
					before.fingerprint !== comment.fingerprint)
			) {
				comments.deleted.push(comment.id);
			} else if (!before) {
				comments.added.push(comment.id);
			} else if (before.fingerprint !== comment.fingerprint) {
				comments.edited.push(comment.id);
			}
		}
		for (const before of old.sourceDetails.comments) {
			if (!newComments.has(before.id)) {
				comments.deleted.push(before.id);
			}
		}
		comments.deleted.sort((a, b) => a - b);
		const observedFields: Array<keyof typeof story.observation> = [
			"title",
			"state",
			"assignedTo",
			"workItemType",
		];
		const metadataFields = observedFields.filter(
			(field) => old.observation[field] !== story.observation[field],
		);
		const evaluatorChanged =
			previous?.evaluatorFingerprint !== cache.evaluatorFingerprint;
		if (
			!requirementFields.length &&
			!comments.added.length &&
			!comments.edited.length &&
			!comments.deleted.length &&
			!metadataFields.length &&
			!evaluatorChanged
		) {
			return [];
		}
		return [
			{
				id: story.id,
				before: old.observation,
				after: story.observation,
				requirementFields,
				comments,
				metadataFields,
				evaluatorChanged,
			},
		];
	});
	const changedIds = changes.map((change) => change.id);
	const counts = {
		total: cache.stories.length,
		reviewed,
		reused: cache.stories.length - reviewed,
		removed: removed.length,
	};
	const interval = previous
		? `Changes since the scheduled capture at ${previous.requirementsAsOf}, through ${cache.requirementsAsOf}.`
		: baseline.status === "incomplete"
			? "Scheduled comparison is incomplete: no valid prior capture was found within the bounded history lookup. Assignment changes are not inferred."
			: "Initial baseline: no prior scheduled capture. Assignment changes are not inferred.";
	const warning = baseline.rejectedCandidates
		? " Some stored baseline candidates were invalid or exceeded the transport limit."
		: "";
	const reuseWarning =
		analysis.status === "incomplete"
			? ` Prior AI judgment reuse is incomplete; ${reviewed} stories received fresh evaluations.`
			: "";
	const headline = `${counts.total} assigned stories: ${reviewed} reviewed, ${counts.reused} reused, ${counts.removed} removed. Requirements as of ${cache.requirementsAsOf}. ${interval}${warning}${reuseWarning} Comments are non-atomic captures.`;
	const reasons = changes.map((change) => {
		const parts: string[] = [];
		if (change.requirementFields.length) {
			parts.push(
				`requirements changed: ${change.requirementFields.join(", ")}`,
			);
		}
		const actions: Array<keyof typeof change.comments> = [
			"added",
			"edited",
			"deleted",
		];
		for (const action of actions) {
			const ids = change.comments[action];
			if (ids.length) {
				parts.push(`comments ${action}: ${ids.join(", ")}`);
			}
		}
		for (const field of change.metadataFields) {
			parts.push(
				`${field}: ${change.before[field] ?? "unassigned"} → ${change.after[field] ?? "unassigned"}`,
			);
		}
		if (change.evaluatorChanged) {
			parts.push("review evaluator changed");
		}
		return `#${change.id}: ${parts.join("; ")}`;
	});
	const dailyChanges = [
		...addedIds.map((id) => `#${id}: added to assignment`),
		...reasons,
		...removed.map((id) => `#${id}: removed from assignment`),
	];
	const summary = [headline, ...dailyChanges].join("\n");
	const rows = cache.stories
		.map(
			(story) =>
				`<article><h2>#${story.id} ${escapeHtml(story.observation.title)}</h2><p>${escapeHtml(story.observation.state)} · ${escapeHtml(story.review.verdict)}</p><p>${escapeHtml(story.review.summary)}</p><ul>${story.review.issues.map((issue) => `<li>${escapeHtml(issue)}</li>`).join("")}</ul></article>`,
		)
		.join("");
	const transitions = dailyChanges
		.map((change) => `<li>${escapeHtml(change)}</li>`)
		.join("");
	const html = `<!doctype html><html><head><meta charset="utf-8"><title>Story review</title></head><body><h1>Story review</h1><p>${escapeHtml(headline)}</p><ul>${transitions}</ul>${rows}</body></html>`;
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
		removedIds: removed,
		addedIds,
		changedIds,
		changes,
		dailyChanges,
		summary,
		html,
	};
}
