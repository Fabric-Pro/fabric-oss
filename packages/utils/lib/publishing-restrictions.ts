/**
 * Which of a publishing topic's unresolved questions constrain what a draft may say
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
 * Whether a decision root's STATUS still counts as unresolved.
 *
 * `OPEN`, or `POSSIBLY_RESOLVED` — the value `reconcileTopicQuestions` writes
 * for a root that was still `OPEN` (nobody had answered it) when a regenerated
 * analysis stopped raising it. The writer's own docblock calls those two "the
 * only two statuses this feature ever leaves a root in that are still awaiting
 * a person". A soft-closed question is not an answered one.
 *
 * The STATUS half only. Each reader keeps its own KIND filter — the drafting
 * restrictions use `SAFETY_CRITICAL_KINDS` plus a type's extras, while the
 * Summary & Questions badge and the topic assistant count every question except
 * `CONTENT_TYPE` — and folding a kind rule in here would silently drop
 * questions from whichever reader it does not fit.
 */
export function isUnresolvedDecisionStatus(status: string): boolean {
	return status === "OPEN" || status === "POSSIBLY_RESOLVED";
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
 * Only an UNRESOLVED `QUESTION` root counts — `OPEN` or `POSSIBLY_RESOLVED`
 * (`isUnresolvedDecisionStatus`). A soft-closed question is not an answered
 * one: nobody answered it, a regeneration merely stopped asking. An answered
 * decision is not a restriction — counting one would make the warning
 * permanent and teach its reader to ignore it — and an `AI_UPDATE` is a note,
 * not a question.
 */
export function isRestrictingThread(thread: RestrictionThreadRoot): boolean {
	const { root } = thread;
	if (root.kind !== "QUESTION" || !isUnresolvedDecisionStatus(root.status)) {
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
 * this one — then the per-type set, behind the same unresolved-`QUESTION` gate
 * (`isUnresolvedDecisionStatus`) and for the same reasons: an answered decision
 * is not a restriction, and an `AI_UPDATE` is a note rather than a question.
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
	if (root.kind !== "QUESTION" || !isUnresolvedDecisionStatus(root.status)) {
		return false;
	}
	const extra = EXTRA_RESTRICTING_KINDS_BY_POST_TYPE[postType];
	if (!extra) {
		return false;
	}
	return extra.has(root.decisionKind ?? "");
}

/** One reply as `settledDecision` reads it — a structural subset of a stored decision entry. */
export interface SettledDecisionReply {
	id: string;
	createdAt: Date;
	status: string;
	authorType: string;
	content: string | null;
}

/**
 * A decision thread as `settledDecision` reads it.
 *
 * Structural, like `RestrictionThreadRoot`: `@repo/utils` is the leaf package
 * `@repo/database` and `@repo/temporal` sit on and must not import either.
 * `summary` is declared only so the docblock below can say why it is NOT read.
 */
export interface SettledDecisionThread extends RestrictionThreadRoot {
	root: RestrictionThreadRoot["root"] & { summary?: string | null };
	replies: readonly SettledDecisionReply[];
}

/** A decision a project member settled, as the drafting prompts receive it. */
export interface SettledDecision {
	subject: string | null;
	decisionKind: string;
	answer: string;
}

/**
 * The decision a PERSON settled on this thread, or `null`.
 *
 * Who authors each half: the SUBJECT is model-authored (the planning analysis
 * named it); the ANSWER is the member's own recorded reply. Nothing else is
 * allowed to stand in for the answer.
 *
 * Non-null only when all of these hold:
 *
 * - the root is a `QUESTION`, and its status is exactly `RESOLVED` — an
 *   allow-list. `POSSIBLY_RESOLVED` is excluded because the reconciler writes
 *   it for questions nobody answered ("still awaiting a person", in the
 *   writer's own words); `REJECTED`, `FORMATTING_ONLY` and `OPEN` are not
 *   settled by a person either.
 * - some reply is authored by a `USER`, has status `RESOLVED`, and carries
 *   non-blank content. The reply STATUS matters: `answerTopicQuestion` and
 *   `amendTopicQuestionAnswer` write `RESOLVED`, while `setTopicQuestionAssignees`
 *   appends an assignment note as a `USER` reply with status `OPEN` — and can
 *   do so on a root that is already `RESOLVED`, so "the newest USER reply" can
 *   be a note rather than the answer.
 *
 * "Newest" is `createdAt` descending, then `id` descending — the same total
 * order `amendTopicQuestionAnswer` uses, because two amendments can share a
 * millisecond. The helper sorts; it does not trust arrival order. A blank
 * newest reply returns `null` rather than falling back to an older one: a
 * newer blank answer means the older one was superseded, and presenting a
 * superseded answer as settled is the failure this helper must not cause. The
 * write procedures now refuse a whitespace-only answer at the input boundary,
 * so a blank reply reaching here can only be a historical row.
 *
 * There is NO fallback to `root.summary`. For a question root that field holds
 * the model's own question text (`reconcileTopicQuestions` writes
 * `summary: question.question`), so falling back to it presented the model's
 * question as the member's answer. A `RESOLVED` root with no qualifying reply
 * yields nothing.
 */
export function settledDecision(
	thread: SettledDecisionThread,
): SettledDecision | null {
	const { root } = thread;
	if (root.kind !== "QUESTION" || root.status !== "RESOLVED") {
		return null;
	}
	const newestFirst = [...thread.replies].sort((a, b) => {
		const byTime = b.createdAt.getTime() - a.createdAt.getTime();
		if (byTime !== 0) {
			return byTime;
		}
		return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
	});
	for (const reply of newestFirst) {
		if (reply.authorType !== "USER" || reply.status !== "RESOLVED") {
			continue;
		}
		// The newest USER/RESOLVED reply decides the outcome outright: a blank
		// one returns null here rather than letting the loop continue to an
		// older reply (see docblock above).
		const answer = reply.content?.trim();
		if (!answer) {
			return null;
		}
		return {
			subject: root.subject,
			decisionKind: root.decisionKind ?? "OTHER",
			answer,
		};
	}
	return null;
}

/**
 * Name ONE decision thread, from its subject and its kind.
 *
 * The one computation of a decision's display label. `restrictionLabel`
 * (same module), `buildShortPostVariables` (the shared prompt variable
 * builder, which seven content types call), and the generation tab
 * (`GenerationTabs.tsx`) all delegate here as of this commit — one function,
 * three callers, and a test per caller. Before this function existed, the
 * three formulas disagreed on three inputs: a blank subject, an interior
 * line break, and the unclassified-kind fallback wording.
 *
 * `toSingleLineSubject` rather than `.trim()`, because it also collapses an
 * interior newline. A subject is model-authored and unbounded on one of its two
 * producing paths, so a multiline one is not a contrived input.
 */
export function decisionLabel(
	subject: string | null | undefined,
	decisionKind: string | null | undefined,
): string {
	const single = toSingleLineSubject(subject ?? "");
	if (single) {
		return single;
	}
	return humanizeDecisionKind(decisionKind ?? "");
}

/**
 * How a restricting thread is named to the model.
 *
 * A thin wrapper over `decisionLabel`, the one computation of a decision's
 * display label, which the shared prompt variable builder
 * (`buildShortPostVariables`) and the generation tab also call.
 */
export function restrictionLabel(thread: RestrictionThreadRoot): string {
	return decisionLabel(thread.root.subject, thread.root.decisionKind);
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
 * This helper's direct callers are `decisionLabel` above, `renderSubjectBullet`
 * below, every `build-*-prompt.ts` that folds a subject before filtering an
 * empty one out or rendering it as a locked-clause bullet, and the topic item
 * page's assistant context (`TopicItemPage.tsx`). Indirectly, through
 * `decisionLabel`, they also include `restrictionLabel`,
 * `buildShortPostVariables` (the shared prompt variable builder), and the
 * generation tab. `build-linkedin-post-prompt.ts` renders a locked-clause
 * bullet too, but only INDIRECTLY, by calling `build-short-post-prompt.ts`'s
 * `buildShortPostLockedClauses` rather than defining its own. There the
 * subject lands OUTSIDE any source-data fence — the locked clauses are the
 * one region a quoted source block must never reach — so an interior newline
 * does not wrap a bullet, it opens a new line at column zero inside the
 * section the model is told overrides everything above it. A model-authored
 * string that happens to carry a line break is enough — on the unbounded
 * path there is no length floor to clear either; nothing has to be forged
 * and no marker guessed.
 *
 * The fold matters most where a model reads the raw text directly: every
 * `build-*-prompt.ts` locked clause, and — since `TopicItemPage.tsx` started
 * calling this too — the topic assistant's open-questions context, which
 * `useCopilotReadable` hands the model as data, not markup. The generation
 * tab renders a label as `<li>{r.label}</li>`, and HTML collapses the
 * newline visually there — so folding a multiline subject changes the
 * stored and compared string, not what a reader of the tab sees.
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
	// `"OTHER"` is not a kind a reader recognises — it is what every
	// generate-*.ts activity substitutes for a null `decisionKind` when it
	// builds the answered-decisions payload. Rendered literally, `- Other:
	// <answer>` reads as a decision about something named "Other", which
	// names nothing. That payload is ANSWERED decisions rendered under a
	// "Confirmed decisions" heading that calls them settled, so the fallback
	// must read as true of a settled decision — "unclassified", never
	// "unresolved". The open-thread paths — the locked clauses through
	// `restrictionLabel`, and the generation tab — only ever see threads that
	// `isRestrictingThread` or `restrictsPostType` admitted, and `"OTHER"` is
	// in neither allowlist, so they do not reach this branch today; the
	// wording is state-neutral so it stays true if an allowlist change ever
	// lets it.
	if (!kind || kind === "OTHER") {
		return "An unclassified decision";
	}
	const words = kind.toLowerCase().split("_").filter(Boolean).join(" ");
	return words.charAt(0).toUpperCase() + words.slice(1);
}
