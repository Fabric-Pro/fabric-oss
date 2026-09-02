/**
 * Generation tab states for the Topic Item Page (Fizzy #1853, Phase 2B-1).
 *
 * Pure — no React, no network, no `@repo/database` — so every state can be
 * driven directly in a test rather than coaxed out of a rendered component.
 *
 * Two questions live here, and they are deliberately separate:
 *
 *  1. WHAT STATE is each content type in (FR3/FR4)? Four exclusive values, one
 *     badge.
 *  2. Does it ALSO need attention? An independent flag, because the four states
 *     are exclusive and `GENERATED` outranks the cautious one — so without this
 *     a tab would stop warning about an unresolved approval the moment a draft
 *     existed, which is exactly backwards: the state exists so a user can see a
 *     problem on a tab they have NOT opened.
 */

import {
	isRestrictingThread,
	SAFETY_CRITICAL_KINDS,
} from "@repo/utils/publishing-restrictions";
import type { PlanningAnalysisDocument } from "./planning-analysis-content";
import type { PostType } from "./topic-shared";

/**
 * The four states the card enumerates.
 *
 * "Deferred / Needs Confirmation" is ONE state in the card's own list, which is
 * why the analysis's `needsConfirmation` and `deferred` buckets collapse into
 * `NEEDS_CONFIRMATION` here rather than becoming a fifth value.
 */
export type GenerationTabState =
	| "GENERATED"
	| "NEEDS_CONFIRMATION"
	| "RECOMMENDED"
	| "AVAILABLE";

export interface GenerationTabInfo {
	postType: PostType;
	state: GenerationTabState;
	/**
	 * Rendered as a secondary marker beside the primary badge, and appended to
	 * the trigger's accessible name. Independent of `state` on purpose — see the
	 * module doc.
	 */
	needsAttention: boolean;
	/** The analysis's own words about this type, for the panel (FR6/FR7). */
	rationale: string | null;
	/** Which bucket the rationale came from, so the panel can say which. */
	bucket: AnalysisBucket | null;
}

type AnalysisBucket = "recommended" | "needsConfirmation" | "deferred";

/** Fixed display order, matching `POST_TYPE_LABELS`. */
const POST_TYPES: readonly PostType[] = [
	"TWEET",
	"BLOG_POST",
	"CASE_STUDY",
	"STAKEHOLDER_EMAIL",
];

/**
 * Free-string phrasings the analysis may use for each enum value.
 *
 * `contentTypes.*[].type` is a free string BY DESIGN — 2A's schema comment is
 * explicit that narrowing it to the enum would make the model drop three of its
 * eight legitimate answers (Webinar/Demo Script, Video Walkthrough Script,
 * Newsletter Blurb are not in the enum). So this maps what it can and ignores
 * the rest, which is the correct answer rather than a gap.
 *
 * Matching is EXACT against the normalized form, never a substring: "post"
 * appears in "Blog Post" as well as "Short Post", and a substring rule would
 * make the blog tab claim to be a tweet.
 */
const SYNONYMS: Record<PostType, readonly string[]> = {
	TWEET: [
		"tweet",
		"tweets",
		"shortpost",
		"shortposts",
		"shortposttweet",
		"tweetshortpost",
		"socialpost",
		"xpost",
		"xtwitterpost",
	],
	BLOG_POST: ["blogpost", "blogposts", "blog", "blogarticle", "article"],
	CASE_STUDY: ["casestudy", "casestudies", "customerstory"],
	STAKEHOLDER_EMAIL: [
		"stakeholderemail",
		"stakeholderupdate",
		"stakeholderemailupdate",
	],
};

const BY_NORMALIZED: ReadonlyMap<string, PostType> = new Map(
	(Object.entries(SYNONYMS) as [PostType, readonly string[]][]).flatMap(
		([postType, forms]) => forms.map((f) => [f, postType] as const),
	),
);

/** Lowercase and strip everything that is not a letter or digit. */
function normalize(text: string): string {
	return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * The enum value a free-string content type names, or null when this phase does
 * not own it.
 */
export function normalizePostType(free: string): PostType | null {
	const key = normalize(free);
	if (key === "") {
		return null;
	}
	return BY_NORMALIZED.get(key) ?? null;
}

/**
 * A decision thread as `listTopicDecisions` returns it.
 *
 * Declared structurally rather than imported, matching the convention
 * `TopicQuestionsPanel` documents: a "use client" module may import a TYPE from
 * the API layer but never a value, and this module is consumed by one.
 */
interface RestrictionThread {
	root: {
		kind: string;
		status: string;
		decisionKind: string | null;
		subject: string | null;
	};
}

export interface Restrictions {
	/** An unresolved approval that constrains EVERY content type. */
	global: boolean;
	/** Post types named by an unresolved CONTENT_TYPE question. */
	byPostType: ReadonlySet<string>;
}

/**
 * The restriction predicate and its safety-critical kinds live in
 * `@repo/utils/publishing-restrictions`, not here.
 *
 * Phase 2B-2 moved them: the Temporal activity that writes the prompt needs the
 * SAME list this tab shows, because the tab tells the reader "these will be
 * generalized rather than asserted" and the prompt is what makes that true. Two
 * copies would let the promise and the behaviour drift with nothing to catch it
 * — a generalized draft and an over-cautious one read identically.
 *
 * Re-exported so this module stays the one import site for everything about
 * generation tab state.
 */
export { isRestrictingThread };

/**
 * What the topic's OPEN questions restrict, across the whole thread set.
 */
export function resolveRestrictions(
	threads: readonly RestrictionThread[],
): Restrictions {
	let global = false;
	const byPostType = new Set<string>();

	for (const thread of threads) {
		if (!isRestrictingThread(thread)) {
			continue;
		}
		const { root } = thread;
		const kind = root.decisionKind ?? "";
		if (SAFETY_CRITICAL_KINDS.has(kind)) {
			global = true;
			continue;
		}
		if (kind === "CONTENT_TYPE") {
			const postType = root.subject
				? normalizePostType(root.subject)
				: null;
			if (postType) {
				byPostType.add(postType);
				continue;
			}
			// FAIL SAFE. `subject` is free text, so a valid decision about a
			// content type this table does not list — a phrasing the synonym
			// map has not seen — would otherwise resolve to null and be
			// DROPPED, silently turning an unresolved restriction into no
			// warning at all.
			//
			// Deliberately asymmetric with the BUCKET path below, which ignores
			// what it cannot map. There, an unmapped entry is usually a content
			// type this phase genuinely does not own (Webinar Script, Video
			// Walkthrough, Newsletter Blurb are not in the enum) and warning
			// about it on all four tabs would be noise. Here the question has
			// already been raised as an unresolved approval, so the cost of
			// over-warning is a visible caution and the cost of under-warning is
			// a draft that asserts something nobody approved.
			global = true;
		}
	}

	return { global, byPostType };
}

/** The contentTypes buckets, flattened to `postType -> (bucket, rationale)`. */
function readContentTypeBuckets(
	analysis: PlanningAnalysisDocument | null,
): Map<PostType, { bucket: AnalysisBucket; rationale: string }> {
	const out = new Map<
		PostType,
		{ bucket: AnalysisBucket; rationale: string }
	>();
	if (!analysis) {
		return out;
	}
	const section = analysis.buckets.find((b) => b.key === "contentTypes");
	if (!section) {
		return out;
	}

	// Cautious buckets are read LAST so they overwrite `recommended` on a
	// collision: an analysis is free to contradict itself, and a type it flagged
	// for approval must not be promoted with a star by the same document that
	// flagged it.
	const order: AnalysisBucket[] = [
		"recommended",
		"deferred",
		"needsConfirmation",
	];
	for (const bucketKey of order) {
		const bucket = section.buckets.find((b) => b.key === bucketKey);
		for (const item of bucket?.items ?? []) {
			const postType = normalizePostType(item.type);
			if (postType) {
				out.set(postType, {
					bucket: bucketKey,
					rationale: item.rationale,
				});
			}
		}
	}
	return out;
}

/**
 * Every content type's tab state, in fixed display order.
 *
 * `generatedPostTypes` is the set with a READY candidate OR a working draft —
 * a user who saved a body has content for that type whatever became of the
 * candidate it came from.
 *
 * Precedence is GENERATED > NEEDS_CONFIRMATION > RECOMMENDED > AVAILABLE.
 * `GENERATED` leads because it is a fact about what exists, and "does a draft
 * exist" is the first thing a reader scans a tab bar for. The caution it
 * outranks is preserved by `needsAttention` rather than lost.
 */
export function resolveGenerationTabStates(input: {
	analysis: PlanningAnalysisDocument | null;
	generatedPostTypes: readonly string[];
	restrictions: Restrictions;
}): GenerationTabInfo[] {
	const buckets = readContentTypeBuckets(input.analysis);
	const generated = new Set(input.generatedPostTypes);

	return POST_TYPES.map((postType) => {
		const entry = buckets.get(postType) ?? null;
		const cautious =
			entry?.bucket === "needsConfirmation" ||
			entry?.bucket === "deferred";

		const state: GenerationTabState = generated.has(postType)
			? "GENERATED"
			: cautious
				? "NEEDS_CONFIRMATION"
				: entry?.bucket === "recommended"
					? "RECOMMENDED"
					: "AVAILABLE";

		// A SUPERSET of what produced the primary state, not a different
		// question. Keying this on open questions alone would leave a hole
		// exactly where it was aimed: 2A's `resolveConfirmationQuestions` mints
		// questions from `needsConfirmation` and `requiresApproval` only —
		// `deferred` is deliberately excluded there as "a decision already taken
		// the other way" — so a GENERATED + deferred type would warn about
		// nothing at all.
		const needsAttention =
			cautious ||
			input.restrictions.global ||
			input.restrictions.byPostType.has(postType);

		return {
			postType,
			state,
			needsAttention,
			rationale: entry?.rationale ?? null,
			bucket: entry?.bucket ?? null,
		};
	});
}
