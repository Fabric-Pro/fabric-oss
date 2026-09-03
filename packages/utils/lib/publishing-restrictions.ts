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
 * must not assert, whichever type is being written. `CONTENT_TYPE` is handled
 * by the caller precisely because it IS type-specific.
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
	return SAFETY_CRITICAL_KINDS.has(kind) || kind === "CONTENT_TYPE";
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
 * How a restricting thread is named to a person, and to the model.
 *
 * `subject` is the specific thing awaiting approval ("Acme Corp", "the latency
 * chart"); the kind is the fallback when a question was raised without one.
 * Both readers need the same string: the tab lists it under "unresolved before
 * drafting", and the prompt lists it under "not approved for use".
 */
export function restrictionLabel(thread: RestrictionThreadRoot): string {
	const subject = toSingleLineSubject(thread.root.subject ?? "");
	if (subject) {
		return subject;
	}
	return humanizeDecisionKind(thread.root.decisionKind ?? "");
}

/**
 * Collapse a user-authored subject onto ONE line.
 *
 * A subject is free text typed by a project member, and both readers render it
 * as a single bullet: the "unresolved before drafting" list on the generation
 * tab, and the locked-clause block of every writer's prompt. In the prompt it
 * lands OUTSIDE any source-data fence — the locked clauses are the one region
 * a quoted source block must never reach — so an interior newline does not wrap
 * a bullet, it opens a new line at column zero inside the rules the model is
 * told override everything above it. That is the whole of the attack: nothing
 * has to be forged and no marker guessed, only a return key pressed in a field
 * the API accepts as an unconstrained string.
 *
 * The pattern matches whitespace generally rather than the two obvious line
 * breaks, because it also has to catch the tab, the form feed, and U+2028 /
 * U+2029, which end a line for Markdown renderers and for a model reading
 * the text while being invisible in every UI that shows the subject back to
 * the person who typed it.
 */
export function toSingleLineSubject(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

/** `CUSTOMER_NAME` → `Customer name`. */
export function humanizeDecisionKind(kind: string): string {
	if (!kind) {
		return "An unresolved approval";
	}
	const words = kind.toLowerCase().split("_").filter(Boolean).join(" ");
	return words.charAt(0).toUpperCase() + words.slice(1);
}
