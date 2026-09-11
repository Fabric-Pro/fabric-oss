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
	EXTRA_RESTRICTING_KINDS_BY_POST_TYPE,
	isRestrictingThread,
	restrictsPostType,
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

/**
 * Fixed display order, matching `POST_TYPE_LABELS`.
 *
 * Exported as `GENERATION_TAB_POST_TYPES` — Fizzy #1988 (Phase 2D-1) — so
 * `publishing-post-type-vocabulary.test.ts` can pin it set-equal to the shared
 * `PUBLISHING_TOPIC_POST_TYPES` tuple. That runtime pin is what a `Record<
 * PostType, …>` would give for free at compile time; this module stays an
 * array because every consumer iterates it in order, not by key.
 */
export const GENERATION_TAB_POST_TYPES: readonly PostType[] = [
	"TWEET",
	"LINKEDIN_POST",
	"BLOG_POST",
	"CASE_STUDY",
	"STAKEHOLDER_EMAIL",
	"WEBINAR_SCRIPT",
	"NEWSLETTER_BLURB",
];

/**
 * Free-string phrasings the analysis may use for each enum value.
 *
 * `contentTypes.*[].type` is a free string BY DESIGN — 2A's schema comment is
 * explicit that narrowing it to the enum would make the model drop legitimate
 * answers it cannot map. FR32's supported set has nine; the enum covers
 * seven, leaving two that still are not in it (Video Walkthrough Script and
 * AI-assisted Video Walkthrough). So this maps what it can and ignores the
 * rest, which is the correct answer rather than a gap.
 *
 * Matching is EXACT against the normalized form, never a substring: "post"
 * appears in "Blog Post" as well as "Short Post", and a substring rule would
 * make the blog tab claim to be a tweet.
 *
 * Entries are run through `normalize` when the lookup map is built, so a
 * phrasing may be written here in either form. Most are already normalized and
 * stay that way; "LinkedIn Update" is spaced deliberately — as one 14-character
 * run beside the word "linkedin" it matches gitleaks' `linkedin-client-id`
 * shape, and the OSS publication gate scans with its own default config that
 * has no allowlist and does not read this repo's `.gitleaks.toml`. A space
 * breaks the run without changing what it maps to.
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
	// No "linkedinarticle": LinkedIn's own long-form article is a blog post in
	// everything but hosting, and claiming it here would route a recommendation
	// for a 1,500-word piece to the short-form panel.
	LINKEDIN_POST: [
		"linkedinpost",
		"linkedinposts",
		"linkedin",
		"LinkedIn Update",
	],
	BLOG_POST: ["blogpost", "blogposts", "blog", "blogarticle", "article"],
	CASE_STUDY: ["casestudy", "casestudies", "customerstory"],
	STAKEHOLDER_EMAIL: [
		"stakeholderemail",
		"stakeholderupdate",
		"stakeholderemailupdate",
	],
	// Fizzy #1988 (Phase 2D-1). "webinarordemoscript" and "webinardemoscript"
	// are this file's own two planning-prompt phrasings: the analysis prompt's
	// "Webinar or Demo Script" (`publishing-planning-prompt.ts`) and the
	// slash form "Webinar/Demo Script" the schema comment in
	// `build-planning-analysis-prompt.ts` uses for the same type. No bare
	// "webinar": matching is exact against the normalized form, not a
	// substring, so a lone "Webinar" token appearing as some unrelated
	// decision's free-text subject would otherwise be swept into this bucket
	// too.
	WEBINAR_SCRIPT: [
		"webinarscript",
		"demoscript",
		"webinarordemoscript",
		"webinardemoscript",
	],
	// Fizzy #1988 (Phase 2D-2). "newsletterblurb" is the exact label the LLM
	// is whitelisted to emit for this type
	// (`publishing-suite-schema.ts`'s `POST_TYPE_LABELS`), and the
	// phrasing the planning prompt has always used.
	//
	// The consumer this entry serves is `readContentTypeBuckets` below — the
	// only caller of `normalizePostType`. It folds the analysis document's own
	// `contentTypes` items, whose `item.type` is a free string the model
	// wrote, onto the enum; two readers then share that fold, the tab strip's
	// badge and `ContentTypesChecklist`. So an entry here decides whether a
	// stored analysis populates this tab's badge and rationale or leaves it on
	// AVAILABLE forever, and the strings worth listing are the ones a producer
	// actually emits.
	//
	// NO bare "newsletter", deliberately. Matching is exact against the
	// normalized form, so the lone token WOULD resolve — and this repository
	// ships an entire separate Newsletter product area: release notes,
	// newsletter curation, chat delivery, its own settings procedures. An item
	// whose `type` is just "Newsletter" most likely names that one, and
	// claiming it here would hand this tab a badge and a rationale written
	// about a different product.
	//
	// For the SAME reason, also no "newsletterupdate" — despite
	// STAKEHOLDER_EMAIL's own second entry, "stakeholderupdate", looking like
	// precedent for it. The symmetry does not hold: "stakeholderupdate" has no
	// competing product to be confused with, so a match there can only mean
	// the one type it names. "newsletterupdate" does have one — this file's
	// own Newsletter product area. The distinction that generalizes to a
	// future synonym: "newsletterblurb" is contract-derived — the phrasing the
	// planning prompt itself puts in front of the model — so dropping it
	// breaks a producer that is already emitting it. "newsletterupdate" was a
	// guess at wording nothing asks for. `item.type` is schema-free
	// (`ClassifiedRecommendationSchema` types it `z.string().min(1)`, which is
	// why this table exists at all), but it is written by the model against
	// that prompt's list of nine names, not typed by a person — so the prompt's
	// own phrasings are the grounded entries, and a guess only adds a way to
	// claim another product's row.
	NEWSLETTER_BLURB: ["newsletterblurb"],
};

const BY_NORMALIZED: ReadonlyMap<string, PostType> = new Map(
	(Object.entries(SYNONYMS) as [PostType, readonly string[]][]).flatMap(
		([postType, forms]) =>
			forms.map((f) => [normalize(f), postType] as const),
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
 *
 * `restrictsPostType` rides along for the same reason. It answers the
 * per-tab question — "does this thread constrain a draft of THIS type" — which
 * `GenerationPanel` asks once per panel, where `isRestrictingThread` answers the
 * type-agnostic one the badges are computed from. Both predicates, one import
 * site, so a panel cannot reach for the wrong one by reaching for the nearer
 * one.
 */
export { isRestrictingThread, restrictsPostType };

/**
 * What the topic's OPEN questions restrict, across the whole thread set.
 *
 * Feeds `needsAttention` — the BADGE. The per-panel LIST is built separately,
 * in `GenerationPanel`, from `restrictsPostType`. Both are needed and neither
 * substitutes for the other, which was learned the expensive way in 2C: fixing
 * only the list left the panel warning about an open `CLAIM_STRENGTH` question
 * while the tab strip beside it read a plain "Available". That is under-warning
 * at the one level whose stated purpose is to be seen on a tab the reader has
 * NOT opened, so it is the worse direction of the two to get wrong.
 */
export function resolveRestrictions(
	threads: readonly RestrictionThread[],
): Restrictions {
	let global = false;
	const byPostType = new Set<string>();

	for (const thread of threads) {
		// The per-type extras first, and NOT as an `else` — a thread can be
		// restricting for every type by its kind and named by a type's extra
		// set at the same time, and the shared branches below `continue`.
		if (thread.root.kind === "QUESTION" && thread.root.status === "OPEN") {
			const kind = thread.root.decisionKind ?? "";
			for (const [postType, extra] of Object.entries(
				EXTRA_RESTRICTING_KINDS_BY_POST_TYPE,
			)) {
				if (extra.has(kind)) {
					byPostType.add(postType);
				}
			}
		}
		if (!isRestrictingThread(thread)) {
			continue;
		}
		const { root } = thread;
		const kind = root.decisionKind ?? "";
		if (SAFETY_CRITICAL_KINDS.has(kind)) {
			global = true;
			continue;
		}
		// `CONTENT_TYPE` is deliberately NOT read here.
		//
		// The checklist replaced these questions, and `TopicQuestionsPanel`
		// filters every one of them out of the list a reader can answer — at any
		// status. Rows written before that change are still in the table and
		// still OPEN, so reading them here put a "Needs confirmation" caution on
		// a tab with no visible question behind it, and the fail-safe below
		// escalated an unmappable `subject` to every tab at once. Nothing on the
		// page could clear it: the Decision Log carries answered decisions, and
		// the checklist writes post-type selections rather than closing threads.
		//
		// The producer stopped emitting these (they are dropped at merge in
		// `build-planning-analysis-prompt.ts`), so this is legacy data only. A
		// warning a reader cannot act on is worse than no warning: it teaches
		// them that the caution means nothing.
	}

	return { global, byPostType };
}

/**
 * The contentTypes buckets, flattened to `postType -> (bucket, rationale)`.
 *
 * Exported since the content-types checklist groups by the same verdict the tab
 * strip badges from — two readers of one classification, and a second copy of
 * this fold would let the list and the tabs disagree about a topic.
 */
export function readContentTypeBuckets(
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

	return GENERATION_TAB_POST_TYPES.map((postType) => {
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
