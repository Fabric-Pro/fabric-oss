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
 * How a restricting thread is named to a person, and to the model.
 *
 * `subject` is the specific thing awaiting approval ("Acme Corp", "the latency
 * chart"); the kind is the fallback when a question was raised without one.
 * Both readers need the same string: the tab lists it under "unresolved before
 * drafting", and the prompt lists it under "not approved for use".
 */
export function restrictionLabel(thread: RestrictionThreadRoot): string {
	const subject = thread.root.subject?.trim();
	if (subject) {
		return subject;
	}
	return humanizeDecisionKind(thread.root.decisionKind ?? "");
}

/** `CUSTOMER_NAME` → `Customer name`. */
export function humanizeDecisionKind(kind: string): string {
	if (!kind) {
		return "An unresolved approval";
	}
	const words = kind.toLowerCase().split("_").filter(Boolean).join(" ");
	return words.charAt(0).toUpperCase() + words.slice(1);
}
