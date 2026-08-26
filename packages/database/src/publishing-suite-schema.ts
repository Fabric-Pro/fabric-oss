import { createHash } from "node:crypto";
import { z } from "zod";
import type { FunctionTag } from "../prisma/generated/client";
import { PublishingTopicPostType } from "../prisma/generated/client";
import { FUNCTION_TAG_VALUES, isFunctionTag } from "./function-tags";

export const SUGGESTION_WINDOW_DAYS = 180;
export const PER_SOURCE_CAP = 200;
export const MIN_DOC_CONTENT_CHARS = 200; // M5: a DocumentVersion qualifies only if content ≥ this (rejects no-op/cosmetic edits)

export type SourceKey =
	| "stories"
	| "documents"
	| "transcripts"
	| "pullRequests"
	| "releases";

export const SOURCE_KEYS: readonly SourceKey[] = [
	"stories",
	"documents",
	"transcripts",
	"pullRequests",
	"releases",
];

export type SourceCoverage = Partial<Record<SourceKey, string>>; // ISO timestamps
export type SourceFailures = Partial<Record<SourceKey, string>>; // reason per failed source

export const TopicProvenanceSchema = z.object({
	repoPrs: z
		.array(
			z.object({ repoFullName: z.string(), prNumber: z.number().int() }),
		)
		.optional(),
	storyIds: z.array(z.string()).optional(),
	featureVersionIds: z.array(z.string()).optional(),
	transcriptIds: z.array(z.string()).optional(),
	docIds: z.array(z.string()).optional(),
});
export type TopicProvenance = z.infer<typeof TopicProvenanceSchema>;

/** The four human-readable post-type labels the LLM emits (whitelisted, fail-closed). */
export const POST_TYPE_LABELS = [
	"Tweet",
	"Blog Post",
	"Case Study",
	"Stakeholder Email",
] as const;
export type PostTypeLabel = (typeof POST_TYPE_LABELS)[number];

// `PUBLISHING_TOPIC_POST_TYPES` is defined in `./publishing-post-types`, the
// CLIENT-SAFE module the settings form deep-imports, so the value vocabulary
// has exactly one definition. `POST_TYPE_LABELS` above stays here: it is the
// vocabulary the LLM EMITS and is whitelisted fail-closed, which is a
// different job that happens to use the same four words. The two are pinned
// against each other by `publishing-post-types.test.ts`.

const POST_TYPE_LABEL_TO_ENUM: Record<PostTypeLabel, PublishingTopicPostType> =
	{
		Tweet: PublishingTopicPostType.TWEET,
		"Blog Post": PublishingTopicPostType.BLOG_POST,
		"Case Study": PublishingTopicPostType.CASE_STUDY,
		"Stakeholder Email": PublishingTopicPostType.STAKEHOLDER_EMAIL,
	};

export function postTypeLabelToEnum(
	label: PostTypeLabel,
): PublishingTopicPostType {
	return POST_TYPE_LABEL_TO_ENUM[label];
}

const POST_TYPE_ENUM_TO_LABEL = Object.fromEntries(
	Object.entries(POST_TYPE_LABEL_TO_ENUM).map(([label, value]) => [
		value,
		label,
	]),
) as Record<PublishingTopicPostType, PostTypeLabel>;

/**
 * The reverse direction: stored enum value → the human label.
 *
 * Needed wherever an enum value is shown to a person or to a model. A prompt
 * that says `STAKEHOLDER_EMAIL` is asking the model to reason about an
 * identifier rather than about a kind of writing.
 *
 * Derived from `POST_TYPE_LABEL_TO_ENUM` rather than written out a second
 * time, so the two directions cannot disagree: adding a post type to one map
 * adds it to both.
 *
 * Returns `null` for anything unmapped rather than falling back to the raw
 * value — a caller that receives null can decide to omit the item, whereas a
 * raw-constant fallback would put `SOME_NEW_TYPE` in front of a user or a model
 * and look deliberate.
 */
export function postTypeEnumToLabel(value: string): PostTypeLabel | null {
	return POST_TYPE_ENUM_TO_LABEL[value as PublishingTopicPostType] ?? null;
}

const POST_TYPE_LABEL_SET = new Set<string>(POST_TYPE_LABELS);

export type PostTypeRecommendation = {
	type: PostTypeLabel;
	theme: string;
	rationale: string;
};

const THEME_MAX = 120;
const RATIONALE_MAX = 240;
const ANGLE_MAX = 60; // FR9/10: short free-text topic-angle label (prompt asks ≤~4 words)
export const SUBJECT_MAX = 120; // FR9/10 multiplication: canonical subject line (a touch longer than the angle label)
export const MULTIPLICATION_CAP = 2; // FR9/10 multiplication: max angle-records per subject per cycle (D3)

/**
 * Tolerant per-element normalization of the model's role-aware enrichment (I4).
 * Loose raw input in → validated, deduped, length-capped output. Unknown
 * function tags and unknown post-type rows are DROPPED (never fatal). Also
 * derives `suggestedPostTypes` (labels) from the surviving recommendations so
 * the flat chip array can never disagree with the enriched list.
 */
export function normalizeTopicEnrichment(raw: {
	relevantFunctionTags?: unknown;
	postTypeRecommendations?: unknown;
	angle?: unknown;
	subject?: unknown;
}): {
	relevantFunctionTags: FunctionTag[];
	postTypeRecommendations: PostTypeRecommendation[];
	suggestedPostTypes: PostTypeLabel[];
	angle?: string;
	subject?: string;
} {
	// I4 fail-open boundary: `raw` may be null/undefined at runtime (e.g. a
	// malformed LLM array element like `[null, {...}]`) even though the TS
	// signature forbids it. Degrade to an empty shape instead of throwing.
	const safeRaw =
		raw && typeof raw === "object"
			? (raw as {
					relevantFunctionTags?: unknown;
					postTypeRecommendations?: unknown;
					angle?: unknown;
					subject?: unknown;
				})
			: {};

	const rawTags = Array.isArray(safeRaw.relevantFunctionTags)
		? safeRaw.relevantFunctionTags
		: [];
	const relevantFunctionTags = [
		...new Set(
			rawTags.filter(
				(t): t is FunctionTag =>
					typeof t === "string" && isFunctionTag(t),
			),
		),
	];

	const rawRecs = Array.isArray(safeRaw.postTypeRecommendations)
		? safeRaw.postTypeRecommendations
		: [];
	const seen = new Set<PostTypeLabel>();
	const postTypeRecommendations: PostTypeRecommendation[] = [];
	for (const r of rawRecs) {
		if (typeof r !== "object" || r === null) {
			continue;
		}
		const type = (r as { type?: unknown }).type;
		if (typeof type !== "string" || !POST_TYPE_LABEL_SET.has(type)) {
			continue;
		}
		const label = type as PostTypeLabel;
		if (seen.has(label)) {
			continue; // dedupe by type, first wins
		}
		seen.add(label);
		const theme = (r as { theme?: unknown }).theme;
		const rationale = (r as { rationale?: unknown }).rationale;
		postTypeRecommendations.push({
			type: label,
			theme:
				typeof theme === "string"
					? theme.trim().slice(0, THEME_MAX)
					: "",
			rationale:
				typeof rationale === "string"
					? rationale.trim().slice(0, RATIONALE_MAX)
					: "",
		});
	}

	const angle =
		typeof safeRaw.angle === "string"
			? safeRaw.angle.trim().slice(0, ANGLE_MAX) || undefined
			: undefined;

	const subject =
		typeof safeRaw.subject === "string"
			? safeRaw.subject.trim().slice(0, SUBJECT_MAX) || undefined
			: undefined;

	return {
		relevantFunctionTags,
		postTypeRecommendations,
		suggestedPostTypes: postTypeRecommendations.map((r) => r.type),
		angle,
		subject,
	};
}

export const PublishingTopicSuggestionsSchema = z.object({
	topics: z.array(
		z.object({
			title: z.string().min(1).max(200),
			pitch: z.string().min(1).max(500),
			provenance: TopicProvenanceSchema,
			suggestedPostTypes: z
				.array(z.enum(POST_TYPE_LABELS))
				.max(4)
				.optional()
				.default([]),
			relevantFunctionTags: z
				.array(z.enum(FUNCTION_TAG_VALUES))
				.optional()
				.default([]),
			postTypeRecommendations: z
				.array(
					z.object({
						type: z.enum(POST_TYPE_LABELS),
						theme: z.string().max(THEME_MAX),
						rationale: z.string().max(RATIONALE_MAX),
					}),
				)
				.optional()
				.default([]),
			angle: z.string().max(ANGLE_MAX).optional(),
			subject: z.string().max(SUBJECT_MAX).optional(),
		}),
	),
});
export type PublishingTopicSuggestions = z.infer<
	typeof PublishingTopicSuggestionsSchema
>;

/** Project-scoped hash of a normalized string (lowercase, trimmed, inner whitespace collapsed). */
function projectScopedHash(projectId: string, value: string): string {
	const normalized = value.trim().toLowerCase().replace(/\s+/g, " ");
	return createHash("sha256")
		.update(`${projectId}${normalized}`)
		.digest("hex")
		.slice(0, 40);
}

/** Canonical dedupe key: project-scoped hash of the normalized TITLE. Uniqueness key. */
export function computeDedupeKey(projectId: string, subject: string): string {
	return projectScopedHash(projectId, subject);
}

/** Grouping identity: project-scoped hash of the normalized subject (or title when no subject). Never a uniqueness key. */
export function computeSubjectKey(
	projectId: string,
	subjectOrTitle: string,
): string {
	return projectScopedHash(projectId, subjectOrTitle);
}

/**
 * Sufficient if ANY single source clears its bar.
 * M5: `stories` is intentionally EXCLUDED in 1A — the schema has no durable "story
 * completed in-window" signal (FeatureVersion is a per-edit snapshot, not a transition
 * log), so story-completion is deferred to 1C. Stories are still collected as LLM
 * context; they just do not drive sufficiency. `counts.stories` is ignored here.
 */
export function evaluateSufficiency(
	counts: Record<SourceKey, number>,
): boolean {
	return (
		counts.pullRequests >= 3 ||
		counts.transcripts >= 1 ||
		counts.documents >= 2
	);
}
