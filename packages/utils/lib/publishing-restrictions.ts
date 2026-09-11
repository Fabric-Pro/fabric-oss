/**
 * Which of a publishing topic's open questions constrain what a draft may say
 * (Fizzy #1853).
 *
 * Lives in `@repo/utils` because TWO very different places must agree on it:
 * the Topic Item Page's generation tab, which tells the reader "these are still
 * unapproved, so a draft will generalize rather than assert them", and the
 * Temporal activity, which puts that same list into the prompt's locked clauses
 * as the things the model must write around.
 *
 * If those two lists ever diverged, the page would promise one thing and the
 * generator would do another — and the disagreement would be invisible, because
 * a generalized draft and an over-cautious one look identical to a reader who
 * cannot see the prompt. One definition, imported by both.
 */

/**
 * Decision kinds whose unresolved state constrains any generated content.
 *
 * An unapproved customer name, asset, metric, internal UI capture or AI
 * likeness is not a question about one content type — it is a fact the draft
 * must not assert, whichever type is being written.
 */
export const SAFETY_CRITICAL_KINDS: ReadonlySet<string> = new Set([
	"CUSTOMER_NAME",
	"ASSET_APPROVAL",
	"METRICS_APPROVAL",
	"INTERNAL_UI",
	"VIDEO_WALKTHROUGH",
]);

/** The shape of a decision thread this predicate reads. */
export interface RestrictionThreadRoot {
	root: {
		kind: string;
		status: string;
		decisionKind: string | null;
		subject: string | null;
	};
}

/**
 * Whether ONE thread restricts what a draft may assert.
 *
 * A per-thread predicate, and it must stay one. An earlier version of the panel
 * filtered on the AGGREGATED "is anything restricted" flag — a property of the
 * whole thread set — so the moment any safety-critical question existed, every
 * open thread passed the filter, including the authorship questions the list
 * exists to keep out. Every fixture in the suite happened to use a single
 * decision kind, which is the one arrangement where the buggy predicate and the
 * correct one agree.
 *
 * Only `OPEN` `QUESTION` roots count. An answered decision is not a restriction
 * — counting one would make the warning permanent and teach its reader to
 * ignore it — and an `AI_UPDATE` is a note, not a question.
 */
export function isRestrictingThread(thread: RestrictionThreadRoot): boolean {
	const { root } = thread;
	if (root.kind !== "QUESTION" || root.status !== "OPEN") {
		return false;
	}
	const kind = root.decisionKind ?? "";
	// `CONTENT_TYPE` is deliberately NOT restricting any more.
	//
	// The inline checklist replaced these questions, and the questions panel
	// filters every one of them out of the list a reader can answer, at any
	// status. Rows written before that change are still in the table and still
	// OPEN — so counting them here put a "Needs confirmation" caution on a tab
	// and an "unresolved before drafting" line in its panel, with no visible
	// question anywhere behind either, and nothing on the page able to clear
	// it: the Decision Log carries answered decisions, and the checklist writes
	// post-type selections rather than closing threads. The generation prompt
	// reads the same predicate, so the model was being told to write around an
	// approval nobody could grant.
	//
	// Removed here rather than at the two call sites because both readers —
	// the tab badge and the per-panel list — resolve through this one
	// predicate, and fixing only the badge would have left the list saying it.
	return SAFETY_CRITICAL_KINDS.has(kind);
}

/**
 * Decision kinds that restrict ONE post type, on top of the shared set.
 *
 * `isRestrictingThread` answers "does this constrain EVERY content type", and
 * that is the right question for a Tweet: a tweet that cannot yet claim a
 * number simply does not mention it. It is the wrong question for a Case Study,
 * which is the most approval-sensitive format we generate — it names a
 * customer's situation, leans on a measured result and describes the work in
 * detail, so "is this result strong enough to claim?" (`CLAIM_STRENGTH`), "who
 * is this written for?" (`AUDIENCE_SCOPE`) and "how much of the implementation
 * may we describe?" (`CODEBASE_DETAIL`) each decide what the piece is allowed
 * to say. Left out, a case study asserts exactly the things still awaiting a
 * decision.
 *
 * A Stakeholder Email restricts on TWO of those three. `AUDIENCE_SCOPE` decides
 * the whole shape of the message — an email to leadership, to a client sponsor
 * and to the delivery team say different things about the same work, and one
 * addressed before that is settled is the format most likely to reach the wrong
 * reader, because it is ADDRESSED and usually sent without a second pair of
 * eyes. `CLAIM_STRENGTH` decides whether the "why it matters" paragraph may
 * assert a result or has to describe one.
 *
 * `CODEBASE_DETAIL` is deliberately NOT in the email's set, and the omission is
 * the point rather than an oversight. An email to a sponsor is not where a
 * codebase detail leaks: the format's own rules already push it toward business
 * value over implementation, and the disclosure rule in the locked clauses
 * covers the residue. Listing it anyway would put a third entry under "open
 * questions that constrain this type" on nearly every technical topic, for a
 * risk this format does not run — and a warning that fires where it does not
 * apply is how a reader learns to skip the two that do.
 *
 * ADDITIVE, deliberately — not a widening of `SAFETY_CRITICAL_KINDS`. Moving
 * `CLAIM_STRENGTH` into the shared set would make one open claim question
 * caution the Tweet and Blog Post tabs too, and a warning that fires on formats
 * it does not apply to is the kind a reader learns to dismiss. A kind belongs in
 * the shared set only when an unresolved answer would be a false assertion in
 * ANY format; everything else belongs to the type it actually constrains.
 */
export const EXTRA_RESTRICTING_KINDS_BY_POST_TYPE: Readonly<
	Record<string, ReadonlySet<string>>
> = {
	CASE_STUDY: new Set([
		"CLAIM_STRENGTH",
		"AUDIENCE_SCOPE",
		"CODEBASE_DETAIL",
	]),
	STAKEHOLDER_EMAIL: new Set(["AUDIENCE_SCOPE", "CLAIM_STRENGTH"]),
	// A script carries a Supporting Details block with problem, solution and
	// evidence, so an unresolved "is this strong enough to claim?" is live the
	// same way it is for a Case Study; it states its recommended audience
	// explicitly, the way a Stakeholder Email is addressed; and the PO prompt
	// has its own technical-depth dial ("match technical depth to the
	// recommended audience"), which is exactly what CODEBASE_DETAIL governs.
	// All three, the same set the Case Study uses.
	WEBINAR_SCRIPT: new Set([
		"CLAIM_STRENGTH",
		"AUDIENCE_SCOPE",
		"CODEBASE_DETAIL",
	]),
	// The SAME pair as the Stakeholder Email, and for the same reason: both are
	// audience-scoped distribution formats whose characteristic harm is a claim
	// made to the wrong readership. A newsletter travels further than the person
	// who asked for one expects, so AUDIENCE_SCOPE decides the whole framing,
	// and CLAIM_STRENGTH decides whether the first sentence — the only one a
	// skimming reader is guaranteed to read — may assert a result.
	//
	// CODEBASE_DETAIL is deliberately EXCLUDED, and this is where the type parts
	// company with the Webinar Script above. A blurb has no implementation-depth
	// dial to turn: it is one headline and a paragraph or two, and the
	// disclosure rule in its locked clauses covers the residue. Listing it
	// anyway would put a third entry under "open questions that constrain this
	// type" on nearly every technical topic, for a risk this format does not
	// run — and a warning that fires where it does not apply is how a reader
	// learns to skip the two that do.
	NEWSLETTER_BLURB: new Set(["AUDIENCE_SCOPE", "CLAIM_STRENGTH"]),
};

/**
 * Whether ONE thread restricts what a draft of `postType` may assert.
 *
 * The shared predicate first — a kind that constrains every format constrains
 * this one — then the per-type set, behind the same `OPEN` `QUESTION` gate and
 * for the same reasons: an answered decision is not a restriction, and an
 * `AI_UPDATE` is a note rather than a question.
 *
 * `postType` is a plain `string`, NOT the `PublishingTopicPostType` Prisma enum,
 * and must stay that way. `@repo/utils` declares zero `@repo/*` dependencies —
 * it is the leaf package that both `@repo/database` and `@repo/temporal` sit on
 * top of — so importing that enum, even type-only, would make `@repo/database`
 * an unlisted dependency of this package (a `pnpm knip` failure, and knip is a
 * required CI gate) and create a workspace dependency cycle. The same reason is
 * why `SAFETY_CRITICAL_KINDS` holds strings and `RestrictionThreadRoot` is
 * declared structurally. Callers that hold the enum pass an enum value
 * unchanged; the looseness costs them nothing and buys this module its place at
 * the bottom of the graph.
 */
export function restrictsPostType(
	thread: RestrictionThreadRoot,
	postType: string,
): boolean {
	if (isRestrictingThread(thread)) {
		return true;
	}
	const { root } = thread;
	if (root.kind !== "QUESTION" || root.status !== "OPEN") {
		return false;
	}
	const extra = EXTRA_RESTRICTING_KINDS_BY_POST_TYPE[postType];
	if (!extra) {
		return false;
	}
	return extra.has(root.decisionKind ?? "");
}

/**
 * How a restricting thread is named to the model.
 *
 * `subject` is the specific thing awaiting approval ("Acme Corp", "the latency
 * chart") — model-authored, never typed by a project member (see
 * `toSingleLineSubject` below for the two producing paths); the kind is the
 * fallback when a question was raised without one. This is the prompt's own
 * computation, used where the prompt lists a thread under "not approved for
 * use". The generation tab is a SEPARATE reader: it computes its own
 * "unresolved before drafting" label locally rather than calling this
 * function, and the two are not guaranteed to produce the same string (see
 * `toSingleLineSubject` below for the known divergences).
 */
export function restrictionLabel(thread: RestrictionThreadRoot): string {
	const subject = toSingleLineSubject(thread.root.subject ?? "");
	if (subject) {
		return subject;
	}
	return humanizeDecisionKind(thread.root.decisionKind ?? "");
}

/**
 * Collapse a model-authored subject onto ONE line.
 *
 * The subject is not free text a project member types. It is model-authored
 * on TWO paths:
 *
 * 1. A recommended question's `recommendedQuestions[].subject`, capped at 160
 *    characters by the Zod schema the model's output must satisfy
 *    (`build-planning-analysis-prompt.ts`).
 * 2. A DERIVED `ASSET_APPROVAL` question, whose subject is a classified
 *    asset's `type` (`ClassifiedRecommendationSchema`,
 *    `build-planning-analysis-prompt.ts`), which carries a minimum length
 *    and NO maximum. `ASSET_APPROVAL` is in `SAFETY_CRITICAL_KINDS`, so this
 *    unbounded path restricts every content type.
 *
 * Both are persisted with `authorType: "AGENT"` when the analysis is
 * reconciled into the topic's decisions (`publishing-decisions.ts`). Nothing
 * downstream lets a member author or edit one: the answer API takes an
 * `answer`, never a `subject` (`answerTopicQuestion`,
 * `amendTopicQuestionAnswer`), and the revision procedure
 * (`saveAnalysisRevision`) edits the analysis document without
 * re-reconciling questions — but a REGENERATED analysis does refresh an
 * existing open question's subject, through `reconcileTopicQuestions`'
 * update branch, which `completePlanningAnalysis` runs on every completed
 * analysis. So the subject is model-authored for its entire life: at
 * creation, and at every later refresh. The realistic attack is not an
 * insider pressing a return key into a form — it is an indirect-injection
 * payload the model copies out of source material an analysis reads (a
 * document, a call transcript, a scraped page) into whichever of the two
 * fields it emits.
 *
 * This helper's callers are the prompt builders: `restrictionLabel` below,
 * and every `build-*-prompt.ts` that renders a subject as a locked-clause
 * bullet directly. `build-linkedin-post-prompt.ts` renders one too, but only
 * INDIRECTLY, by calling `build-short-post-prompt.ts`'s
 * `buildShortPostLockedClauses` rather than defining its own. There the
 * subject lands OUTSIDE any source-data fence — the locked clauses are the
 * one region a quoted source block must never reach — so an interior newline
 * does not wrap a bullet, it opens a new line at column zero inside the
 * section the model is told overrides everything above it. A model-authored
 * string that happens to carry a line break is enough — on the unbounded
 * path there is no length floor to clear either; nothing has to be forged
 * and no marker guessed.
 *
 * The generation tab is NOT one of this helper's callers, despite labeling
 * the same threads. It builds its own label locally
 * (`GenerationTabs.tsx`, `t.root.subject ?? humanizeKind(...)`), and the two
 * disagree: a whitespace-only subject renders blank in the tab but falls
 * back to the humanized decision kind (e.g. "Customer name") in the prompt;
 * a multiline subject's STORED value stays multiline going into that
 * comparison, though the tab actually renders it as `<li>{r.label}</li>` and
 * HTML collapses the newline visually, so a reader never sees the
 * difference there; and `decisionKind === "OTHER"` renders "An unresolved
 * approval" in the tab against "Other" in the prompt. That divergence is
 * real, is not fixed here, and is left for separate `apps/web` work with its
 * own render tests.
 *
 * The pattern below matches whitespace generally rather than the two obvious
 * line breaks, because it also has to catch the tab, the form feed, and
 * U+2028 / U+2029, which end a line for Markdown renderers and for a model
 * reading the text while remaining invisible in whatever UI renders the
 * subject back to a reader.
 */
export function toSingleLineSubject(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

/**
 * Render one approval subject as a QUOTED LABEL for a locked-clause bullet.
 *
 * The subject is the one piece of non-authored text these prompts render inside
 * the rules section itself, because its job is to name what the rules are about.
 * `toSingleLineSubject` stops it opening a new line among the rules, and — in
 * the writers that fence their own variables in a SOURCE DATA block (case
 * study, newsletter blurb, stakeholder email, webinar script; blog post,
 * short post and LinkedIn post have no such fence to forge)
 * — `neutralizeSourceDataMarkers` stops it forging one. Both are STRUCTURAL:
 * a subject that is already one line and carries no marker passes each
 * untouched and lands as a bullet indistinguishable from a rule.
 *
 * The quotation is what distinguishes them, so the one character that could
 * close it early is downgraded to an apostrophe. Not backslash-escaped: a model
 * reading Markdown is not a parser, and a visible straight quote inside the
 * label is exactly the ambiguity being removed.
 *
 * A fence is deliberately NOT used: the locked clauses are the one region a
 * quoted source block must never reach, because they instruct the model to
 * disregard what sits inside one.
 *
 * WHAT THIS DOES NOT DO. Quoting types a value; it does not prove a model will
 * refuse a quoted imperative. The guarantee here is representational - the
 * subject is presented as data and the block's own governing instruction is
 * preserved beside it. Whether a given provider then complies is a question
 * only provider-level evaluation answers, and nothing in this repository
 * measures it.
 */
export function renderSubjectBullet(subject: string): string {
	return `- "${toSingleLineSubject(subject).replaceAll('"', "'")}"`;
}

/** `CUSTOMER_NAME` → `Customer name`. */
export function humanizeDecisionKind(kind: string): string {
	if (!kind) {
		return "An unresolved approval";
	}
	const words = kind.toLowerCase().split("_").filter(Boolean).join(" ");
	return words.charAt(0).toUpperCase() + words.slice(1);
}
