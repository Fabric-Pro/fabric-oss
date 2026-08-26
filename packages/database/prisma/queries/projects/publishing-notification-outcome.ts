import { db, type Prisma } from "../../client";

/**
 * The cycle-level notification outcome (§9.7). Nine values, each of which earns its place by
 * having a reader who does something different:
 *
 *   NOT_APPLICABLE      never entered the lifecycle — the column default. Monitoring's exclusion.
 *   PENDING             entered, unresolved. NEVER an alert by itself: a healthy attempt sits
 *                       here for its whole duration. Stale work is the alert, and its detection
 *                       is slice-scoped — an age bound in 1C-2b/2c, ABANDONED from 1C-2d.
 *   ABANDONED           unresolved past the point where the step could still be running. THE
 *                       alert. No writer until 1C-2d.
 *   SENT                every owed row terminal, at least one confirmed delivered.
 *   NO_RECIPIENTS       both candidate sets empty. Explicitly not an incident.
 *   CANCELLED           obligations existed and none may be delivered.
 *   DISABLED            the project-level kill switch is off.
 *   MAIL_NOT_CONFIGURED email candidates existed and the key was absent. No writer until 1C-2c.
 *   RESOLUTION_FAILED   a recipient-resolution read threw. Kept distinct from NO_RECIPIENTS so an
 *                       outage cannot look like a quiet week.
 *
 * The value set is enforced twice — here by the type, and in the database by a CHECK constraint,
 * because a free-text status column drifts and a hand-written UPDATE bypasses the type.
 */
export type PublishingNotificationOutcome =
	| "NOT_APPLICABLE"
	| "PENDING"
	| "ABANDONED"
	| "SENT"
	| "NO_RECIPIENTS"
	| "CANCELLED"
	| "DISABLED"
	| "MAIL_NOT_CONFIGURED"
	| "RESOLUTION_FAILED";

/**
 * The outcomes a transition writer may produce. NOT_APPLICABLE is the default and is never
 * written; PENDING is written only by activation, which is a different guard.
 *
 * Deliberate exception to the name: RESOLUTION_FAILED is included here even though it is
 * non-terminal (see NON_TERMINAL below) — a transition writer legitimately produces it, stamping
 * it before the activity rejects so a later successful attempt can supersede it. Do not read this
 * type name as a promise that every value it admits is terminal.
 */
export type PublishingNotificationTerminalWrite = Exclude<
	PublishingNotificationOutcome,
	"NOT_APPLICABLE" | "PENDING"
>;

/**
 * Non-terminal states. A transition may overwrite these and nothing else — which is what stops a
 * late attempt from clobbering SENT or ABANDONED. RESOLUTION_FAILED is here deliberately: it is
 * stamped before the activity rejects, expecting a later success to supersede it.
 */
const NON_TERMINAL: PublishingNotificationOutcome[] = [
	"PENDING",
	"RESOLUTION_FAILED",
];

/**
 * Is a cycle's outcome TERMINAL — a final answer that stands, that no later
 * attempt may overwrite, and after which no further attempt will run?
 *
 * ONE definition, exported, because two derivations of the same predicate in one
 * codebase will disagree and the comment will side with the wrong one. Both
 * readers use this: `completeCycleNotificationOutcome` below, to decide whether a
 * lost swap means "someone already answered" or "the write was impossible", and
 * the ledger's creation fence in publishing-notification-delivery.ts, to refuse
 * to create a row under a cycle that is already closed.
 *
 * NOT_APPLICABLE is excluded deliberately: it is the column default, meaning the
 * cycle never entered the lifecycle at all, which is the opposite of a final
 * answer. RESOLUTION_FAILED is excluded because it is stamped expecting a later
 * attempt to supersede it (see NON_TERMINAL).
 *
 * Takes a `string` rather than the union because its callers read the column
 * straight off Prisma, where it is declared `String`.
 */
export function isTerminalNotificationOutcome(outcome: string): boolean {
	return (
		outcome !== "NOT_APPLICABLE" &&
		!NON_TERMINAL.includes(outcome as PublishingNotificationOutcome)
	);
}

/**
 * ENTRY guard: NOT_APPLICABLE -> PENDING.
 *
 * Fenced on its OWN expected value, not on the terminality predicate — a guard written for
 * movement within a state machine rejects the write that enters it, and applying the transition
 * rule here would affect zero rows for every new cycle and leave live work permanently classified
 * NOT_APPLICABLE.
 *
 * Two writers call this, and they call THIS rather than hand-writing the predicate twice:
 * persistCycleTerminal (in the transaction that sets READY) and notifyPublishingTopicsReady
 * (repairing a cycle an older worker committed at the default during a rolling deploy). No third
 * caller exists, and no other path may move a row out of NOT_APPLICABLE.
 *
 * THIS WRITE IS THE STALENESS CLOCK. `notificationOutcomeAt` is stamped HERE,
 * and the 1C-2d reconciliation sweep reads exactly it: a cycle is stale when it
 * is still PENDING and this timestamp is older than the suggestion workflow's
 * execution timeout.
 *
 * WHAT THE SLICE ESTABLISHES — and at this commit only the first half of it
 * exists, which is why this is phrased as a rule rather than as an inventory.
 * When 1C-2d-2a is complete the column has exactly TWO writers: this one, and a
 * bounded enrolment pass in
 * `packages/database/prisma/queries/projects/publishing-notification-reconcile.ts`,
 * which the sweep task adds. That second writer exists because of THIS one's
 * absence: a worker on a build predating the column activates a cycle without
 * stamping it, so the pass adopts such a row ONCE, at GREATEST(`updatedAt`, its
 * own database clock) (Decision 31). It writes only where this column is NULL,
 * so it can never move a clock this writer set. Until that file lands, this is
 * the only writer there is.
 *
 * It is an explicit column rather than `updatedAt` because `updatedAt` is
 * stamped by ANY writer of this model, which makes it an activation clock only
 * for as long as an inventory of every writer stays complete. An inventory is a
 * thing that goes stale; a column nothing else writes does not.
 *
 * THE GUARANTEE IS ONE WRITER, NOT A TRUSTWORTHY CLOCK. The value below is
 * `input.now ?? new Date()` — this worker's own clock, client-side, with no
 * floor under it. The GREATEST floor that the backfill and the enrolment pass
 * apply is for statements that have no writer-supplied value and must derive one
 * from `updatedAt`, where the error is unbounded; it is not a property of the
 * column and it does not apply here.
 *
 * What covers the residual on this path is that the error is BOUNDED BY THE
 * SKEW, not that the skew has to clear some threshold. The sweep terminalizes
 * where `notificationOutcomeAt < now() - <execution timeout>`, so a worker
 * running X behind the database moves a cycle's abandonment deadline X earlier
 * — which puts cycles in the final X of their window at risk for ANY X, not
 * only for X past the bound. That is acceptable because such a cycle is already
 * within X of the execution timeout that would have ended it anyway: the write
 * can be early, and it can only be early by as much as the host's clock is
 * wrong. An earlier revision of this comment claimed a worker would have to run
 * more than the whole bound behind before this could bite. That is a stronger
 * claim than the predicate supports, and it is the kind of overstatement that
 * makes a reader stop checking.
 *
 * `now` is an override for tests and for a caller that already holds the
 * activation instant. NEITHER production caller passes it — persistCycleTerminal
 * (`publishing-suite.ts`) and notifyPublishingTopicsReady
 * (`packages/temporal/.../notify-topics-ready.ts`) both omit it — so a caller
 * that starts passing one is choosing a different clock, and should say why.
 *
 * So: if you are adding a writer of this column, you are changing when the
 * ABANDONED alert fires.
 *
 * Returns whether THIS call performed the transition. `false` is the correct answer for a second
 * attempt, not a failure.
 *
 * Takes a client so the persist path can pass its transaction: activation in the SAME transaction
 * as READY is what makes a cycle visible even when the notification step never runs at all.
 */
export async function activateCycleNotificationLifecycle(
	client: Prisma.TransactionClient,
	input: { cycleId: string; projectId: string; now?: Date },
): Promise<boolean> {
	const { count } = await client.publishingSuggestionCycle.updateMany({
		where: {
			id: input.cycleId,
			projectId: input.projectId,
			notificationOutcome: "NOT_APPLICABLE",
		},
		data: {
			notificationOutcome: "PENDING",
			notificationOutcomeAt: input.now ?? new Date(),
		},
	});
	return count > 0;
}

/**
 * The column is declared `String` at the Prisma level (see the module doc-comment: a free-text
 * status column drifts, so the CHECK constraint is the enforcement and the type here is trusted
 * to match it) — narrowed to the nine-value union for callers, instead of leaking a bare `string`
 * that would let a typo slip past every comparison downstream.
 */
type CycleNotificationState = {
	status: string;
	notificationOutcome: PublishingNotificationOutcome;
	notificationOutcomeVersion: number;
};

export async function readCycleNotificationState(
	input: {
		cycleId: string;
		projectId: string;
	},
	client: Prisma.TransactionClient = db,
): Promise<CycleNotificationState | null> {
	return client.publishingSuggestionCycle.findFirst({
		where: { id: input.cycleId, projectId: input.projectId },
		select: {
			status: true,
			notificationOutcome: true,
			notificationOutcomeVersion: true,
		},
	}) as Promise<CycleNotificationState | null>;
}

/**
 * TRANSITION guard: applies only AFTER activation.
 *
 * Two conditions, and both are load-bearing:
 *   1. terminality — only PENDING and RESOLUTION_FAILED may be overwritten, so a late attempt
 *      cannot downgrade SENT (or, from 1C-2d, ABANDONED);
 *   2. a version compare-and-swap — ordering among the non-terminal writers, so two writers racing
 *      on a PENDING cycle cannot both win and the loser learns it lost.
 *
 * The version is a SHARED lifecycle version, not any one writer's attempt number. The column has
 * several writers drawing attempt numbers from unrelated sequences, and a guard keyed to one
 * writer's private numbering is not a guard.
 *
 * Returns whether this call won.
 *
 * Takes an optional client for the SAME REASON activateCycleNotificationLifecycle takes one — not
 * in the same way, since that function's client is required and positional-first. The shared reason
 * is what matters: a completing caller has ledger writes that are only justified BY this outcome,
 * and they must commit or roll back together with it.
 */
export async function writeCycleNotificationOutcome(
	input: {
		cycleId: string;
		projectId: string;
		outcome: PublishingNotificationTerminalWrite;
		observedVersion: number;
	},
	client: Prisma.TransactionClient = db,
): Promise<boolean> {
	const { count } = await client.publishingSuggestionCycle.updateMany({
		where: {
			id: input.cycleId,
			projectId: input.projectId,
			notificationOutcome: { in: NON_TERMINAL },
			notificationOutcomeVersion: input.observedVersion,
		},
		data: {
			notificationOutcome: input.outcome,
			notificationOutcomeVersion: input.observedVersion + 1,
		},
	});
	return count > 0;
}

/**
 * The completing caller's decision on a lost compare-and-swap, in one place.
 *
 *   WROTE            this call won and the cycle is terminal.
 *   ALREADY_TERMINAL another writer terminalized it. Its answer stands; clobbering it is exactly
 *                    what the terminality predicate exists to prevent, and the caller has nothing
 *                    left to do.
 *   LOST             the cycle is still non-terminal, which given who writes this column means a
 *                    NEWER attempt stamped RESOLUTION_FAILED. The caller MUST NOT retry against the
 *                    current version: losing the swap means the world moved underneath it, so its
 *                    conclusion is stale by construction. A stale attempt that computed an empty
 *                    candidate set would otherwise overwrite a live outage signal with a terminal
 *                    NO_RECIPIENTS — ending retries and reporting a quiet week over a failing read.
 *                    The caller rejects, and a fresh attempt re-resolves.
 *
 * ALREADY_TERMINAL is classified POSITIVELY — the row must exist and carry a genuine terminal
 * value — rather than by negating the non-terminal check. A negated check puts two very different
 * cases in the ALREADY_TERMINAL bucket by accident: a missing row (`!now`, e.g. a cross-tenant
 * `projectId` that doesn't own this cycle — the exact mistake the projectId predicate exists to
 * catch) and a cycle still at NOT_APPLICABLE (never activated — not in NON_TERMINAL, but not a
 * terminal answer either). Both would tell the caller "someone already handled it" when in truth
 * nothing did, silently dropping the outcome. Routing both to LOST is safe, and safe means
 * different things for the two cases — say which:
 *
 *   NOT_APPLICABLE  a retry GENUINELY RECOVERS. LOST makes the caller reject, and the activity's
 *                   own first step repairs NOT_APPLICABLE -> PENDING, so the next attempt gets
 *                   past this point and completes.
 *   missing row     a retry does NOT recover. A cascade-deleted cycle (or a projectId that does
 *                   not own this cycle) reads `null` on every attempt, so the caller rejects until
 *                   the retry policy is exhausted. That is still the better trade than the silent
 *                   success it replaces — the cycle is genuinely unresolvable and the failure is
 *                   visible — but it is a bounded loop, not a recovery, and the retry policy is
 *                   what bounds it.
 */
export async function completeCycleNotificationOutcome(
	input: {
		cycleId: string;
		projectId: string;
		outcome: PublishingNotificationTerminalWrite;
		observedVersion: number;
	},
	client: Prisma.TransactionClient = db,
): Promise<"WROTE" | "ALREADY_TERMINAL" | "LOST"> {
	if (await writeCycleNotificationOutcome(input, client)) {
		return "WROTE";
	}
	const now = await readCycleNotificationState(
		{
			cycleId: input.cycleId,
			projectId: input.projectId,
		},
		client,
	);
	const isGenuineTerminal =
		now !== null && isTerminalNotificationOutcome(now.notificationOutcome);
	return isGenuineTerminal ? "ALREADY_TERMINAL" : "LOST";
}
