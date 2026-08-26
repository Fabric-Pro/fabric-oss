/**
 * Classifies what a review decision (approve / reject) means for a
 * NewsletterSend row that is no longer `PENDING_APPROVAL` (Fizzy #2172).
 *
 * The approval gate's conditional `updateMany` is what actually prevents a
 * double-send, and it stays exactly as it is. What was wrong is the *reporting*:
 * every non-`PENDING_APPROVAL` status raised one blanket
 * `CONFLICT("This newsletter is no longer awaiting review")`, so a reviewer
 * clicking Approve on a stale row — after a colleague approved it, after their
 * own double-click, after the scheduled reclaim expired it — saw a red failure
 * for an outcome that was either already what they wanted or simply needed
 * explaining.
 *
 * Three answers instead of one:
 *
 *  - `proceed`      the row is reviewable; the caller runs its transition.
 *  - `satisfied`    the reviewer's INTENT is already the row's reality. An
 *                   idempotent no-op reported as success. The caller must NOT
 *                   re-run the transition or start any workflow.
 *  - `incompatible` the row genuinely cannot take this decision. Still a
 *                   CONFLICT, but the copy names the actual state so the client
 *                   can explain it and refresh the list.
 *
 * The tables are keyed on the ACTION as well as the status because the two are
 * mirror images: `APPROVED` satisfies an approve and blocks a reject; `REJECTED`
 * satisfies a reject and blocks an approve. One shared table would have to pick
 * a side and be wrong for the other.
 *
 * Pure and total: an unknown status returns the original generic message rather
 * than throwing, so a status added later degrades to today's behaviour.
 */

export type ReviewAction = "approve" | "reject";

export type ReviewOutcome =
	| { kind: "proceed" }
	/** Already the requested end state — report success, change nothing. */
	| { kind: "satisfied"; notice: string }
	/** Genuinely incompatible — CONFLICT, but say what the state actually is. */
	| { kind: "incompatible"; message: string };

type Verdict =
	| { kind: "satisfied"; text: string }
	| { kind: "incompatible"; text: string };

const satisfied = (text: string): Verdict => ({ kind: "satisfied", text });
const incompatible = (text: string): Verdict => ({
	kind: "incompatible",
	text,
});

/**
 * The message this module replaces. Retained verbatim as the fallback for a
 * status no table knows about: unrecognised input keeps today's behaviour
 * instead of inventing a claim about a state we cannot describe.
 */
const GENERIC = "This newsletter is no longer awaiting review.";

/**
 * Approving means "send this". APPROVED / SENT / PARTIAL all mean that decision
 * is already made and irreversible, so they satisfy the intent. PARTIAL is
 * included deliberately — the send happened; that some recipients failed is a
 * delivery problem the history panel reports, not a reason to re-approve.
 */
const APPROVE: Record<string, Verdict> = {
	APPROVED: satisfied(
		"This newsletter was already approved — it's on its way.",
	),
	SENT: satisfied("This newsletter has already been sent."),
	PARTIAL: satisfied(
		"This newsletter has already been sent, though some deliveries failed. See the send history for details.",
	),
	PENDING: incompatible("This newsletter is already being sent."),
	FAILED: incompatible(
		"This newsletter's send already failed. Generate a new one to try again.",
	),
	SKIPPED_EMPTY: incompatible(
		"This newsletter was skipped because it had nothing to report.",
	),
	REJECTED: incompatible(
		"This newsletter was already rejected, so it can no longer be approved.",
	),
	EXPIRED: incompatible(
		"This review expired and the draft was discarded. A new one will be prepared on the next cycle.",
	),
};

/**
 * Rejecting means "do not send this". REJECTED and EXPIRED both mean the draft
 * is already stopped — by a decision or by the stale-review reclaim — so they
 * satisfy the intent. SKIPPED_EMPTY is NOT satisfied: nothing was reviewed or
 * decided there, the system simply had nothing to send, and saying "already
 * rejected" would misreport what happened.
 */
const REJECT: Record<string, Verdict> = {
	REJECTED: satisfied("This newsletter was already rejected."),
	EXPIRED: satisfied(
		"This review had already expired — the draft was discarded.",
	),
	APPROVED: incompatible(
		"This newsletter was already approved and is being sent, so it can no longer be rejected.",
	),
	SENT: incompatible(
		"This newsletter has already been sent, so it can no longer be rejected.",
	),
	PARTIAL: incompatible(
		"This newsletter has already been sent, so it can no longer be rejected.",
	),
	PENDING: incompatible(
		"This newsletter is already being sent, so it can no longer be rejected.",
	),
	FAILED: incompatible(
		"This newsletter's send already failed, so there is nothing left to reject.",
	),
	SKIPPED_EMPTY: incompatible(
		"This newsletter was skipped because it had nothing to report.",
	),
};

/**
 * `Object.hasOwn`, never a bare index + `??`. `status` is a plain String column
 * with nothing constraining its contents, and a plain object literal inherits
 * from Object.prototype — so a stored "constructor" or "toString" would resolve
 * to a truthy FUNCTION, defeat the `??` fallback, and be returned where the type
 * promises a string. The sibling chat-delivery mapper carries the same guard for
 * the same reason.
 */
function lookup(table: Record<string, Verdict>, status: string): Verdict {
	return Object.hasOwn(table, status) ? table[status] : incompatible(GENERIC);
}

export function classifyReviewOutcome(
	action: ReviewAction,
	status: string,
): ReviewOutcome {
	if (status === "PENDING_APPROVAL") {
		return { kind: "proceed" };
	}
	const verdict = lookup(action === "approve" ? APPROVE : REJECT, status);
	return verdict.kind === "satisfied"
		? { kind: "satisfied", notice: verdict.text }
		: { kind: "incompatible", message: verdict.text };
}
