import {
	activateCycleNotificationLifecycle,
	assertPublishingCycleTenant,
	completeCycleNotificationOutcome,
	db,
	deferPublishingEmailDeliveries,
	deliverPublishingTopicsReadyInApp,
	getEnabledRecipientsForCategory,
	getPublishingSuiteSettings,
	getRecipientsWithEmailFlagEnabled,
	lockPublishingProjectRow,
	type PublishingDeliverySkipReason,
	readCycleNotificationState,
	readPublishingDeliveryStates,
	reauthorizePublishingRecipient,
	recordPublishingDeliverySkip,
	resolvePublishingEligibleRecipients,
	selectRelevantRecipientIds,
	terminalizeExistingDeliveriesAsSkipped,
	writeCycleNotificationOutcome,
} from "@repo/database";
import { isMailConfigured } from "@repo/mail";
import { getBaseUrl } from "@repo/utils";
import { ApplicationFailure } from "@temporalio/common";
import { deliverPublishingTopicsReadyEmail } from "./deliver-topics-ready-email";

/**
 * The channels this activity delivers on, in the order it walks them.
 *
 * What this array couples is the CLOSING side, and only that: both exits that terminalize
 * "everything still open" iterate it, so a channel listed here is terminalized by construction and
 * the two closing paths cannot drift apart from each other. It does NOT drive creation — the loops
 * that create obligations name "IN_APP" and "EMAIL" directly, because each builds a different
 * payload and there is nothing to share.
 *
 * So the coupling is one-way, and the asymmetry is only safe in one direction. Adding a channel
 * here terminalizes rows that no loop creates, which is a no-op. A creating loop for a channel
 * MISSING from this array would strand every row it writes under a closed cycle — the exact defect
 * the closing loops exist to prevent. Add the channel here first, then write its creating loop.
 */
const CHANNELS = ["IN_APP", "EMAIL"] as const;

/**
 * How many emails ONE attempt of this activity may send.
 *
 * A COUNT rather than a wall-clock deadline, and the sibling mechanism is why. The drain
 * (PUBLISHING_DRAIN_MAX_BATCHES) does the same job — claim, send, confirm, per row, converging
 * across runs — and bounds itself by count; a deadline here would be a second, differently shaped
 * answer to the same question inside one module. A count also states the convergence guarantee a
 * deadline cannot: the retry budget is finite, so "a roster of 5x this number converges" is
 * arithmetic, where a deadline makes the reachable roster depend on production latency. And the
 * adaptivity a deadline appears to buy is largely illusory, because @repo/mail sets no client-side
 * timeout on the provider call — one hung send defeats either shape.
 *
 * DERIVED FROM THE ACTIVITY'S TIME BUDGET, the same way the drain's number was. The proxy's
 * startToCloseTimeout is 1 minute (the notifyPublishingTopicsReady proxy in
 * publishing-suggestion-generation-workflow.ts — named by symbol, because a line reference rots).
 * Reserve about 15 s for the in-app loop, the two accounting reads and the closing transaction,
 * leaving roughly 45 s for the email walk. Per recipient this path costs one authorization read,
 * one claim transaction, one provider call and one confirm — and THE PROVIDER CALL IS THE ONLY TERM
 * THAT IS NOT LOCAL, so it is the term that decides:
 *
 *   250 ms/send -> 6.3 s, about 7x inside the email budget
 *   500 ms/send -> 12.5 s, about 3.6x
 *   1 s/send    -> 25 s, about 1.8x — THE TRIGGER TO CUT THIS NUMBER, not to raise the timeout,
 *                  because that timeout is one of the three numbers the email lease is sized
 *                  against (see PUBLISHING_EMAIL_LEASE_MS).
 *
 * WHAT THE CEILING COSTS, stated rather than left to be discovered: this number x maximumAttempts
 * (5) is the largest email roster one cycle can finish. Above it the cycle is left READY / PENDING
 * after retry exhaustion, which is the residue parent §9.7 designates for 1C-2d's sweep — REPORTED
 * as ABANDONED, not lost. It is a HIGHER effective ceiling than the unbounded walk it replaces,
 * which spent each attempt re-walking recipients the previous one had already sent.
 *
 * IT DOES NOT BOUND THE IN-APP LOOP, deliberately. That path costs one authorization read and one
 * delivery transaction, both local, with no provider call and no lease — at ~30 ms per recipient the
 * whole ceiling above is under 4 s, so it is not the term that decides and a second cap would exist
 * only for symmetry. The condition that would change that is worth naming, because the two loops
 * share ONE 60 s budget: if the in-app walk ever becomes slow enough to matter, it starves the
 * bounded email walk and the derivation above quietly stops holding.
 */
export const PUBLISHING_NOTIFY_MAX_EMAILS_PER_ATTEMPT = 25;

/**
 * Rollback signal for the closing transaction, and nothing else — private to this module, never
 * exported, never allowed to escape the closure that throws it.
 *
 * A lost compare-and-swap has to unwind the row closure that was committed alongside it, and the
 * only way to abort a Prisma interactive transaction is to throw out of its callback. So the verdict
 * is turned into a throw INSIDE the transaction and turned back into the activity's own
 * ApplicationFailure immediately outside it. A distinct class rather than a string or a flag, so the
 * catch can tell "we lost the swap" apart from any real database error thrown by the same block —
 * which must keep propagating unchanged.
 */
class OutcomeSwapLost extends Error {}

export type NotifyPublishingTopicsReadyInput = {
	cycleId: string;
	tenant: {
		projectId: string;
		organizationId: string | null;
		userId: string | null;
	};
};

/**
 * Plain function core, so Task 11's recovery entry point can re-drive one cycle without a workflow
 * and without re-running publishingSuggestionWorkflow (which would regenerate topics). It uses no
 * Temporal Context, deliberately.
 *
 * Three failure boundaries, and this function is not one of the absorbing ones. An activity that
 * catches everything and resolves looks robust and is strictly worse: it converts a retryable
 * transient fault into a permanent silent loss, because the only mechanism that would have retried
 * is the one it suppressed.
 *
 *   - PER RECIPIENT — catch and continue. One recipient's failure must not deny the rest.
 *   - ACROSS RECIPIENTS, at the end — reject if any row it owes is left unconfirmed. This is what
 *     earns the retry.
 *   - AT THE WORKFLOW (Task 10) — absorb. Retry exhaustion stops there, and the cycle's outcome is
 *     unaffected.
 */
export async function runPublishingTopicsReadyNotification(
	input: NotifyPublishingTopicsReadyInput,
): Promise<void> {
	const { cycleId, tenant } = input;

	const state = await readCycleNotificationState({
		cycleId,
		projectId: tenant.projectId,
	});
	if (!state || state.status !== "READY") {
		return; // nothing to notify about; the trigger is READY-only by construction
	}

	// REPAIR (§9.7 rule 4 part 1). During a rolling deployment a new workflow task can schedule
	// persistCycleTerminal onto an OLDER worker, which ignores the activation input and commits
	// READY at the column default. Treating that cycle as out of scope would be the silent miss
	// this column exists to prevent, so repair it before doing anything else — through the SAME
	// shared helper persistCycleTerminal calls, never a second hand-written predicate.
	//
	// Safe from here: this is a NEW activity type, unregistered on old workers, so it can only ever
	// execute on a worker that knows about it.
	if (state.notificationOutcome === "NOT_APPLICABLE") {
		await activateCycleNotificationLifecycle(db, {
			cycleId,
			projectId: tenant.projectId,
		});
	}

	const live = await readCycleNotificationState({
		cycleId,
		projectId: tenant.projectId,
	});
	if (!live) {
		return;
	}
	if (
		live.notificationOutcome !== "PENDING" &&
		live.notificationOutcome !== "RESOLUTION_FAILED"
	) {
		// A previous attempt already terminalized this cycle: its answer stands, and this attempt has
		// no completion of its own to make. It can still be looking at an obligation that attempt
		// did not close, and closing it is the only work left here — an unresolved ROW under a
		// resolved cycle is invisible to every mechanism that could still discharge it: no further
		// attempt gets past this line, and 1C-2d's sweep is CYCLE-level, so ABANDONED is defined
		// over cycles and never sees the row.
		//
		// This is a SECOND line of defence, not the first, and the distinction is worth keeping
		// straight. The route that used to produce such a row — a timed-out attempt still running,
		// whose failure recorder wrote FAILED after the winner had terminalized — is now closed at
		// the source: the closing transaction holds the project row FOR UPDATE and the delivery
		// module's creation fence re-reads the cycle's outcome under that same lock, so no creating
		// path can commit a non-terminal row under a cycle that is already closed. What can still
		// leave one behind is a terminal outcome written by something OTHER than the closing
		// transaction — 1C-2d's ABANDONED sweep, when it lands, terminalizes the CYCLE and knows
		// nothing about rows — or a close whose F5 ownership assertion no-oped. Both are exactly
		// what this branch exists for.
		//
		// A plain call, deliberately NOT the transactional close below: there is no outcome write to
		// be atomic with, because the outcome is already terminal and this attempt must not touch it.
		// It takes no project lock either, for the same reason — there is nothing here for a
		// concurrent delivery to race, since this call only ever moves rows to a terminal state.
		//
		// The branch cannot be reached at NOT_APPLICABLE — the repair above runs immediately before
		// this read and no writer ever moves the column back — so terminalizing here always means
		// "the cycle is genuinely closed", which is what CYCLE_CLOSED asserts.
		//
		// BOTH channels, for the reason the paragraph above gives about rows in general: an EMAIL
		// row left SENDING or FAILED under a closed cycle is invisible to exactly the same set of
		// mechanisms as an IN_APP one, and a SENDING row additionally holds a lease.
		for (const channel of CHANNELS) {
			await terminalizeExistingDeliveriesAsSkipped({
				cycleId,
				tenant,
				channel,
				reason: "CYCLE_CLOSED",
			});
		}
		return;
	}
	const version = live.notificationOutcomeVersion;

	// ONE completing exit for the whole activity, because there are six of them — three tenant-move
	// paths (the batch gate, the per-recipient re-authorization, the fence inside the delivery
	// transaction), the kill switch, an empty candidate set, and normal completion — and six
	// hand-written copies is how one of them ends up missing a step. Three steps, and all three are
	// mandatory on EVERY completing path:
	//
	//   1. TERMINALIZE what exists. The outcome this writes is terminal, so this is the last attempt
	//      that will ever look at the cycle: no further attempt runs, and 1C-2d's sweep is
	//      CYCLE-level (ABANDONED means an unresolved CYCLE), so a row left FAILED under a terminal
	//      cycle is invisible to every mechanism that could still resolve it. It terminalizes
	//      obligations that EXIST — a FAILED row left by an earlier attempt is not discharged by the
	//      kill switch going off — and creates none, because a new row would carry a tuple this
	//      attempt can no longer vouch for.
	//
	//   2. DERIVE `delivered` from ALL rows on BOTH channels, never from the current candidate set.
	//      `rows.some((row) => row.deliveredAt != null)` spans IN_APP and EMAIL alike: an email that
	//      reached someone is a delivery, and a cycle reporting "nobody was notified" over one would
	//      be false. The "never from the candidate set" half is the older rule and is unchanged — the
	//      candidate set answers "who is owed a notification NOW"; the cycle-level outcome states
	//      what actually happened to this cycle. A cycle that delivered to someone on an earlier
	//      attempt and has since lost every candidate is SENT — writing CANCELLED or NO_RECIPIENTS
	//      there tells an operator "nobody was notified" about a cycle with a real bell row in
	//      someone's tray, or a mail in their inbox. Reading it in one place is what stops the two
	//      answers drifting apart.
	//
	//   3. COMPARE-AND-SWAP the outcome, and reject if that swap is LOST. writeCycleNotificationOutcome
	//      can lose to a newer attempt, and an activity that ignores that result reports success while
	//      the cycle is still unresolved — a silent miss produced by the very guard that exists to
	//      prevent one. The concrete race: a timed-out first attempt is still running, a retry stamps
	//      RESOLUTION_FAILED at version 0, the first attempt then completes and loses its swap against
	//      the bumped version. The decision itself lives in completeCycleNotificationOutcome, where it
	//      can be tested by calling it with a stale version; what this adds is the rejection, which is
	//      what earns the Temporal retry.
	//
	// ALL THREE IN ONE TRANSACTION, and that is the load-bearing part. Step 1 closes obligations on
	// the authority of step 3's completion, so committing it before that authority is won inverts the
	// meaning of every row it touched: the kill-switch exit terminalizes a STILL-ELIGIBLE candidate's
	// row, loses the swap, and rejects — and when the switch goes back on, the retry recomputes that
	// person as a candidate, finds their row SKIPPED, reads it as discharged, and never notifies them
	// while the cycle resolves SENT. The same shape reaches the NO_RECIPIENTS and normal exits
	// whenever a non-candidate becomes a candidate again. (It was defensible while only the
	// tenant-move exits closed rows: a tenant move is not undone, so a row closed there is never owed
	// again. It is not defensible for a kill switch, a regained eligibility, or a re-enabled toggle.)
	// It also makes the ledger assert something false, since CYCLE_CLOSED means "the cycle reached a
	// terminal outcome with this obligation still open" and on the LOST path it reached none.
	//
	// Complete-then-terminalize is the other candidate ordering and is strictly worse: it leaves a
	// TERMINAL cycle with an open row whenever the second step fails, which is the stranded-obligation
	// defect itself, reintroduced as a failure mode. Atomicity is what removes the choice.
	//
	// TWO things vary between the callers, and both are load-bearing. The OUTCOME is what the cycle
	// is called. The REASON is what the ledger records against each obligation this exit closes, and
	// the ledger's three reasons only earn their place by staying tellable apart — TENANT_CHANGED
	// means the project moved or became ineligible, CYCLE_CLOSED means the cycle reached a terminal
	// outcome with this obligation still open. Collapsing them would make a kill-switch exit claim a
	// tenant transfer.
	//
	// TWO KINDS of outcome, and conflating them is how an outage becomes invisible.
	//
	//   fallback — what the cycle is called when NOTHING was ever delivered. `delivered` is
	//              derived from the rows, so a cycle that put a bell in someone's tray on an
	//              earlier attempt still reports SENT even if it has since lost every candidate.
	//   forced   — an outcome that stands REGARDLESS of what was delivered. MAIL_NOT_CONFIGURED is
	//              the only one today, and it has to be forced: the bell reaching everyone does
	//              not make a missing mail key stop being an outage, and a fallback would report
	//              SENT and hide it. This is the whole reason §9.7 gives the value a reader.
	const closeObligationsAndComplete = async (opts: {
		reason: PublishingDeliverySkipReason;
		outcome:
			| {
					kind: "fallback";
					value: "CANCELLED" | "NO_RECIPIENTS" | "DISABLED";
			  }
			| { kind: "forced"; value: "MAIL_NOT_CONFIGURED" };
	}): Promise<void> => {
		try {
			await db.$transaction(async (tx) => {
				// MUTUAL EXCLUSION with delivery, and the FIRST statement of this
				// transaction. Atomicity alone does not make this exit and a delivery
				// exclusive: a still-running overlapping attempt — a start-to-close
				// timeout does not stop the attempt that timed out — can commit a SENT
				// row and a real bell beside this transaction, for a cycle this one is
				// resolving as DISABLED. The delivery paths already take the project row
				// FOR UPDATE and re-read the cycle's outcome under it; this is the other
				// half of that pair, and without it their check is advisory.
				//
				// Lock order, unchanged by this addition and the reason it is safe:
				// project row FOR UPDATE, then the ledger, then the cycle row LAST —
				// the same order the delivery transaction, the failure recorder and
				// recordPublishingDeliverySkip all take, so the wait-for graph stays
				// acyclic. The cycle READS in between take no lock and do not enter it.
				await lockPublishingProjectRow(tx, tenant.projectId);
				// BOTH channels. A row left unresolved on either one is invisible to everything
				// that could still discharge it once this transaction writes a terminal outcome:
				// no further attempt runs, and 1C-2d's sweep is CYCLE-level.
				//
				// THE ONE HOLE in "a SENDING row is never silently discharged", written down
				// because nothing pins it. When `mailUsable` is false the unconfirmed accounting
				// below skips EMAIL entirely — that IS the MAIL_NOT_CONFIGURED outcome — but this
				// loop still terminalizes every EMAIL row and releases its lease. So a row left
				// SENDING by an attempt that DID have the mail key can be closed by a later
				// attempt that does not: a mid-flight send is recorded SKIPPED, and if it lands,
				// the ledger disagrees with the recipient's inbox. It needs the key present on one
				// worker revision and absent on another, so it is a deployment-skew window rather
				// than a steady state, and no notification is LOST by it — the bell is accounted
				// independently.
				//
				// The second half of that reason USED to be "and the email obligation was already
				// being dropped by this slice", which 1C-2d-3a made false: an email-only
				// obligation is now DEFERRED rather than dropped. It does not widen the hole,
				// because DEFERRED rows are excluded from the terminalizer's predicate
				// (terminalizeExistingDeliveriesAsSkipped) precisely so this loop cannot eat them.
				// SENDING rows are still closed here, and the window above is unchanged.
				// Closing the rows anyway is still the lesser evil: leaving them SENDING under a
				// terminal cycle strands both the obligation and its lease, which is the defect
				// this whole loop exists to prevent.
				for (const channel of CHANNELS) {
					await terminalizeExistingDeliveriesAsSkipped(
						{
							cycleId,
							tenant,
							channel,
							reason: opts.reason,
						},
						tx,
					);
				}
				const rows = await readPublishingDeliveryStates(
					{ cycleId },
					tx,
				);
				// Delivery on EITHER channel counts. An email that reached someone is a delivery,
				// and a cycle that reports "nobody was notified" over it would be false.
				const anyDelivered = rows.some(
					(row) => row.deliveredAt != null,
				);
				const verdict = await completeCycleNotificationOutcome(
					{
						cycleId,
						projectId: tenant.projectId,
						outcome:
							opts.outcome.kind === "forced"
								? opts.outcome.value
								: anyDelivered
									? "SENT"
									: opts.outcome.value,
						observedVersion: version,
					},
					tx,
				);
				if (verdict === "LOST") {
					// Thrown rather than returned, because the transaction has to ABORT: returning
					// the verdict past this point and rejecting outside would commit exactly the row
					// closure this attempt just failed to earn.
					throw new OutcomeSwapLost();
				}
			});
		} catch (error) {
			if (error instanceof OutcomeSwapLost) {
				throw ApplicationFailure.retryable(
					"lost the notification outcome compare-and-swap to a newer attempt",
					"PUBLISHING_NOTIFICATION_OUTCOME_RACE",
				);
			}
			throw error;
		}
	};

	// The tenant-move exit. TENANT_CHANGED is the verdict all three of its sources answer with, and
	// it stands for more than the literal reading of its name: the project moved tenant, OR it
	// became ineligible (archived / soft-deleted), OR the cycle does not belong to this project at
	// all. Caller behaviour is the same for all three — write nothing under a tuple this attempt can
	// no longer trust — so this exit deliberately does not distinguish them.
	const cancelForTenantMove = () =>
		closeObligationsAndComplete({
			reason: "TENANT_CHANGED",
			outcome: { kind: "fallback", value: "CANCELLED" },
		});

	// The project-level kill switch is re-read here rather than taken through workflow input: an
	// admin who switches it off while a cycle is generating should have that respected, and a
	// workflow input would freeze the value at start time.
	const settings = await getPublishingSuiteSettings(tenant.projectId);
	if (settings.notificationsEnabled === false) {
		// This exit returns BEFORE candidates are computed, so a row left over from an earlier
		// attempt can belong to someone who is still fully eligible. They are not owed a
		// notification — the feature is off — but FAILED claims the obligation is retryable, and
		// after this write nothing will ever retry it.
		await closeObligationsAndComplete({
			reason: "CYCLE_CLOSED",
			outcome: { kind: "fallback", value: "DISABLED" },
		});
		return;
	}

	// The batch tenant gate — a cheap fail-fast for the whole attempt, NOT a substitute for the
	// per-recipient check below and NOT the fence: a transfer between two recipients of the same
	// batch is precisely what it cannot see, and it takes no lock. The authoritative assertion is
	// the one inside each ledger-creating transaction.
	const gate = await assertPublishingCycleTenant({
		projectId: tenant.projectId,
		cycleTenant: {
			organizationId: tenant.organizationId,
			userId: tenant.userId,
		},
	});
	if (gate === "TENANT_CHANGED") {
		await cancelForTenantMove();
		return; // a tenant move will not resolve on retry, and retrying is how a stale tuple leaks
	}

	let eligible: string[] | null;
	let relevant: string[];
	try {
		eligible = await resolvePublishingEligibleRecipients({
			projectId: tenant.projectId,
		});
		relevant =
			eligible === null
				? []
				: await selectRelevantRecipientIds({
						projectId: tenant.projectId,
						cycleId,
						candidateUserIds: eligible,
					});
	} catch (error) {
		// Stamped BEFORE rejecting, not instead of rejecting. It has no ledger row to carry its
		// reason and would otherwise vanish into an unresolved outcome once retries are exhausted;
		// a later successful attempt supersedes it. Kept distinct from NO_RECIPIENTS so an outage
		// cannot look like a quiet week.
		//
		// This one write deliberately does NOT go through closeObligationsAndComplete — the
		// shared exit every COMPLETING path takes. It is best-effort by design, because this
		// path rejects regardless. Escalating a lost compare-and-swap here would replace a real
		// error with a bookkeeping one.
		//
		// Best-effort in the code as well as in the comment. The likely reason this write fails is
		// the reason the resolver just did — the same database — and letting its rejection propagate
		// would destroy the original cause and report a bookkeeping failure in its place, which is
		// the one thing the stamp exists to prevent. The stamp is a signal; the error is the truth.
		try {
			await writeCycleNotificationOutcome({
				cycleId,
				projectId: tenant.projectId,
				outcome: "RESOLUTION_FAILED",
				observedVersion: version,
			});
		} catch (stampError) {
			console.warn(
				"[publishing-suggestion/notifyPublishingTopicsReady] could not stamp RESOLUTION_FAILED",
				{
					projectId: tenant.projectId,
					cycleId,
					error:
						stampError instanceof Error
							? stampError.message
							: String(stampError),
				},
			);
		}
		throw error;
	}

	// One relevant set, then ONE CANDIDATE SET PER CHANNEL — derived from `relevant` in parallel,
	// never chained. Filtering the relevant set through the category toggle first would make
	// publishingSuggestions a master switch over email, which is the failure §9.2(c) names: every
	// combination except (bell off, email on) would still behave correctly, so it fails silently
	// and only for the users who chose exactly that configuration.
	//
	// Each is a BATCH SNAPSHOT and is not the last word on its toggle. It answers "who is opted in
	// right now" for the whole set at once; reauthorizePublishingRecipient re-reads the same
	// preference for each recipient immediately before their delivery, because an opt-out committed
	// after this line would otherwise be ignored for the rest of the attempt — and a timed-out
	// execution keeps running, so "the rest of the attempt" outlives the attempt boundary.
	const [inAppCandidates, emailCandidates] = await Promise.all([
		getEnabledRecipientsForCategory(relevant, "PUBLISHING").then((s) => [
			...s,
		]),
		getRecipientsWithEmailFlagEnabled(relevant, "publishingEmails").then(
			(s) => [...s],
		),
	]);

	// §9.6's split, and it is drawn on CANDIDACY rather than on what was delivered.
	//
	// The refinement that suggests itself — defer anyone whose bell has not actually
	// landed — is wrong here, and expensively so. A recipient in BOTH sets whose bell
	// failed transiently still has a LIVE in-app obligation: IN_APP is always accounted,
	// the activity rejects while it is unconfirmed, and Temporal retries. Deferring them
	// as well would create a second, slower obligation for someone the fast channel is
	// still actively retrying, and if both then land they get a bell AND an email for one
	// cycle — the duplicate §9.4 exists to prevent, manufactured by the mechanism meant to
	// prevent loss.
	//
	// A Set rather than `includes`: both of these are rosters, and this runs on the path
	// taken during an outage.
	const inAppCandidateSet = new Set(inAppCandidates);
	const emailOnlyCandidates = emailCandidates.filter(
		(id) => !inAppCandidateSet.has(id),
	);

	if (inAppCandidates.length === 0 && emailCandidates.length === 0) {
		// BOTH, not either. An early return on the in-app set alone would terminalize a cycle that
		// still owes email — the user with publishingSuggestions off and publishingEmails on is a
		// supported configuration, and it is the one this check would strand.
		//
		// NO_RECIPIENTS only when the ledger agrees nobody was ever told. "Both candidate sets are
		// empty" is a statement about NOW, and an earlier attempt may already have delivered before
		// its recipients lost eligibility — so the shared exit derives the outcome from the rows
		// rather than from the empty set that got us here.
		await closeObligationsAndComplete({
			reason: "CYCLE_CLOSED",
			outcome: { kind: "fallback", value: "NO_RECIPIENTS" },
		});
		return; // explicitly NOT an incident: check attribution and toggles
	}

	const [project, topicCount, organization, recipientEmails] =
		await Promise.all([
			db.project.findUnique({
				where: { id: tenant.projectId },
				select: { name: true },
			}),
			db.publishingTopic.count({
				where: { projectId: tenant.projectId, cycleId },
			}),
			// The workspace slug for the ABSOLUTE link. A bell link is context-relative because
			// resolveNotificationLink prepends the reader's own workspace base; a mail client has
			// no such resolver, so the address has to be complete when it leaves here.
			tenant.organizationId
				? db.organization.findUnique({
						where: { id: tenant.organizationId },
						select: { slug: true },
					})
				: Promise.resolve(null),
			emailCandidates.length > 0
				? db.user.findMany({
						where: { id: { in: emailCandidates } },
						select: { id: true, email: true },
					})
				: Promise.resolve([]),
		]);

	// `email` is NOT NULL on User today, so the `?? null` is not what makes an address absent: a
	// candidate MISSING from this result is. That is the case the branch below is built for, and it
	// is why the map is consulted with `get(...) ?? null` rather than indexed blindly.
	//
	// AN ASYMMETRY, tolerated rather than overlooked. The block above justifies re-reading each
	// recipient's TOGGLE immediately before their delivery, on the grounds that a timed-out
	// execution keeps running and an opt-out committed after the batch read would otherwise be
	// ignored for the rest of the attempt. Word for word, the same reasoning applies to the
	// ADDRESS — and it is deliberately not applied: this map is a batch snapshot taken before the
	// in-app loop and consulted after it.
	//
	// The consequence, stated so the next reader does not have to derive it: a recipient who
	// changes their address mid-attempt receives this mail at the OLD one. That is bounded by a
	// single activity attempt, and it costs the recipient a message at a stale address rather than
	// a notification they opted out of — the toggle case is a consent decision and this one is not,
	// which is why the two are worth treating differently. Re-reading per recipient would cost one
	// query each; batching it properly belongs with 1C-2d's reconciliation work, not here.
	const emailById = new Map(
		recipientEmails.map((row) => [row.id, row.email ?? null]),
	);
	// getBaseUrl() returns the env value verbatim and may end in "/", which would otherwise
	// produce a double slash — the same normalisation the report emailer documents.
	const baseUrl = getBaseUrl().replace(/\/+$/, "");
	const workspacePrefix = organization?.slug
		? `/app/${organization.slug}`
		: "/app";
	const topicsUrl = `${baseUrl}${workspacePrefix}/projects/${tenant.projectId}/publishing`;

	/**
	 * The per-recipient catch boundary, and NOTHING else inside it.
	 *
	 * A `try` wrapped around the whole loop body absorbs the branch logic too, so a TypeError in a
	 * comparison is logged as "this recipient could not be discharged" and is indistinguishable from
	 * a delivery that genuinely failed. Nothing is lost today — the unconfirmed count below re-arms
	 * the retry either way — but that is a property of the current shape, not of the `try`, and one
	 * refactor that moves a completing write into the loop turns it into an absorbed bug sitting on
	 * top of a terminal row.
	 *
	 * So each fallible CALL gets its own boundary, every branch runs outside one, and the log names
	 * the step: a throw is then attributed to the boundary it came from rather than to the
	 * recipient in general. Absorbing here denies nobody else their notification, and the ledger
	 * still says this one was not discharged.
	 *
	 * Ids only in the log — never a name, address or organization.
	 */
	const perRecipient = async <T>(
		step:
			| "reauthorize"
			| "record-skip"
			| "deliver"
			| "reauthorize-email"
			| "record-skip-email"
			| "deliver-email",
		channel: (typeof CHANNELS)[number],
		recipientUserId: string,
		call: () => Promise<T>,
	): Promise<{ ok: true; value: T } | { ok: false }> => {
		try {
			return { ok: true, value: await call() };
		} catch (error) {
			console.warn(
				"[publishing-suggestion/notifyPublishingTopicsReady] recipient left undischarged",
				{
					step,
					projectId: tenant.projectId,
					cycleId,
					recipientUserId,
					// The REAL channel, taken as a parameter rather than hardcoded. A hardcoded
					// "IN_APP" beside a step label of "deliver-email" is worse than no field at
					// all: it is an operator reading a log line that names the wrong channel while
					// looking confidently correct.
					channel,
					error:
						error instanceof Error ? error.message : String(error),
				},
			);
			return { ok: false };
		}
	};

	/**
	 * Who, of these candidates, this attempt still owes work on THIS channel.
	 *
	 * ONE PREDICATE, TWO CALL SITES, and that is the design rather than a tidy-up. It answers the
	 * cursor's question before the email loop ("is there work here this attempt can do") and the
	 * accounting's question after both loops ("must this attempt REJECT over this row"). Two
	 * hand-written copies is the shape that produces both failure modes at once: a cursor STRICTER
	 * than the accounting skips someone the accounting then counts outstanding, so the activity
	 * rejects forever over work it has refused to do; a cursor LOOSER than the accounting spends the
	 * per-attempt bound on recipients already discharged, which is the re-walk the bound exists to
	 * stop. A single function cannot disagree with itself.
	 *
	 * THE TWO QUESTIONS ARE NOT THE SAME QUESTION, and the `deferred` parameter is where they come
	 * apart. An earlier revision of this function had no such parameter, on the premise — written
	 * into this comment, which is how the same mistake was shipped in 1C-2d-3a — that the two agree
	 * on every state. They agree on every state but ONE, and the case
	 * "once the key returns, the in-band loop claims the deferred row and sends it" refuted it
	 * within a single run:
	 *
	 *   ACCOUNTING asks whether this attempt must reject over the row. For DEFERRED the answer is
	 *   no: the obligation has a durable carrier with its own trigger (§9.6), and rejecting would
	 *   burn the remaining attempts on work another mechanism owns.
	 *
	 *   THE CURSOR asks whether there is work here worth spending a slot on. For DEFERRED the answer
	 *   is YES whenever the key is back: DEFERRED has been a claimable status since 1C-2c, and
	 *   sending in band now is strictly better than waiting up to an hour for the drain's next tick.
	 *
	 * So the divergence is DECLARED at each call site rather than duplicated into a second
	 * predicate. Every other state still agrees, and the anti-drift property survives: there is one
	 * body, and exactly one line in it that the two callers read differently.
	 *
	 * Derived from the STATE MACHINE, never from `deliveredAt IS NULL`: a terminal SKIPPED row never
	 * gets a deliveredAt, and counting it would spin the activity until its budget was exhausted over
	 * work it must not do.
	 *
	 * Per channel, because a recipient can be owed on one and discharged on the other — a confirmed
	 * bell with an unconfirmed email still leaves work outstanding (§9.7's note on SENT being per
	 * ledger row OWED).
	 *
	 * `rows` is a PARAMETER rather than a closure capture, so each call site states which snapshot it
	 * is judging against: the cursor reads before the loop, the accounting re-reads after it. Sharing
	 * one read would make the accounting blind to everything the loop just wrote.
	 */
	const undischarged = (
		rows: {
			recipientUserId: string;
			channel: string;
			status: string;
			deliveredAt: Date | null;
		}[],
		channel: (typeof CHANNELS)[number],
		candidates: string[],
		deferred: "IS_WORK" | "IS_DISCHARGED",
	): string[] => {
		const byKey = new Map(
			rows.map((row) => [`${row.channel}:${row.recipientUserId}`, row]),
		);
		return candidates.filter((id) => {
			const row = byKey.get(`${channel}:${id}`);
			if (!row) {
				return true;
			}
			if (row.status === "SKIPPED") {
				// Terminal: we must not try, and we must not reject over it either.
				return false;
			}
			if (row.status === "DEFERRED") {
				// THE ONE STATE THE TWO CALLERS READ DIFFERENTLY, and the header says why the
				// divergence is real rather than an oversight. Each side below is the answer
				// to a different question about the same row.
				//
				// IS_WORK — the cursor. DEFERRED has been a claimable status since 1C-2c, and
				// this branch is only reached at all on an attempt that HAS the mail key (the
				// cursor runs under `mailUsable`). Claiming and sending in band now is strictly
				// better than leaving it for the drain's next tick, which is up to an hour
				// away. Handing it a slot of the per-attempt bound is the point, not a cost.
				//
				// IS_DISCHARGED — the accounting, per §9.6: "a DEFERRED row is a hand-off, not
				// a claim. The obligation has been moved to a durable carrier with its own
				// bounded lifecycle and its own trigger, so it is no longer this attempt's to
				// discharge."
				//
				// THE ACCOUNTING SIDE IS REACHABLE, BUT NARROWLY, and the route is worth
				// keeping written down because two drafts of it have been wrong. It is
				// unreachable on the attempt that WRITES the row — with no key, EMAIL is not
				// accounted at all. "A later attempt with the key" is necessary but NOT
				// sufficient: an attempt that defers and then completes closes the cycle
				// MAIL_NOT_CONFIGURED, and every later attempt exits on the already-terminal
				// branch without accounting anything.
				//
				// So the cycle has to still be LIVE, which means the deferring attempt must
				// have REJECTED — and the only thing that rejects it after the deferral is an
				// outstanding IN_APP obligation. The route is therefore: no key AND a bell that
				// failed, then a retry that has the key. On that retry the cursor above hands
				// the deferred row to the loop and it is usually sent, so the accounting's
				// exclusion fires only when that claim was REFUSED — held by a concurrent
				// drain, at the attempt bound, or past its own expiry. Counting it then would
				// reject, burn the remaining attempts on an obligation another mechanism owns,
				// and leave the cycle PENDING for the cycle sweep instead of closed.
				return deferred === "IS_WORK";
			}
			// SENDING is deliberately in NEITHER of the branches above. A held lease is
			// unconfirmed, and the case that drives it is what stops that exclusion widening
			// into one.
			// SENDING is UNCONFIRMED, and deliberately so: it means another live attempt holds the
			// claim, or this attempt's own send has not been confirmed. Treating it as discharged
			// would report success over a message nobody has established was sent. It is also what
			// keeps deliverPublishingTopicsReadyEmail's HELD counted — HELD leaves the row SENDING
			// under the attempt that owns it, and this one has discharged nothing.
			return row.status !== "SENT" || row.deliveredAt === null;
		});
	};

	let tenantMoved = false;
	for (const recipientUserId of inAppCandidates) {
		const authorized = await perRecipient(
			"reauthorize",
			"IN_APP",
			recipientUserId,
			() =>
				reauthorizePublishingRecipient({
					projectId: tenant.projectId,
					recipientUserId,
					cycleTenant: {
						organizationId: tenant.organizationId,
						userId: tenant.userId,
					},
					channel: "IN_APP",
				}),
		);
		if (!authorized.ok) {
			continue;
		}
		if (authorized.value === "TENANT_CHANGED") {
			tenantMoved = true;
			break; // handled below, and WITHOUT creating a row under the stale tuple
		}
		if (authorized.value === "RECIPIENT_UNAUTHORIZED") {
			// A ledger row is legitimate evidence that this specific person was deliberately not
			// notified — and it is terminal, so it does not keep the activity rejecting. The write
			// re-checks tenancy under its own lock, so a transfer landing between the authorization
			// answer and this row is caught here rather than written.
			const recorded = await perRecipient(
				"record-skip",
				"IN_APP",
				recipientUserId,
				() =>
					recordPublishingDeliverySkip({
						cycleId,
						tenant,
						recipientUserId,
						channel: "IN_APP",
						reason: "RECIPIENT_UNAUTHORIZED",
					}),
			);
			if (recorded.ok && recorded.value === "TENANT_CHANGED") {
				tenantMoved = true;
				break;
			}
			continue;
		}

		const result = await perRecipient(
			"deliver",
			"IN_APP",
			recipientUserId,
			() =>
				deliverPublishingTopicsReadyInApp({
					cycleId,
					tenant,
					recipientUserId,
					projectName: project?.name ?? "your project",
					topicCount,
				}),
		);
		if (result.ok && result.value === "TENANT_CHANGED") {
			// The fence inside the delivery transaction is the AUTHORITATIVE tenancy check — the
			// batch gate above is a fail-fast, and a transfer between two recipients of the same
			// batch is exactly what it cannot see. A tenant move will not resolve on retry, so stop
			// rather than spending the budget on it. No row is written here: see the tenant-moved
			// branch below.
			tenantMoved = true;
			break;
		}
	}

	// AFTER the in-app loop, and the position is the requirement rather than a detail: a mail
	// outage must not cost the channel that works (§9.6).
	//
	// The trigger is the EMAIL CANDIDATE SET, not the relevant set. A cycle where every relevant
	// person has publishingEmails off has no email to send, so a missing key is not a fault there.
	//
	// Checked BEFORE any claim, which is why the failure is recorded on the CYCLE and not the
	// ledger: with no claim there is no row for a `reason` to live on, and a missing key would
	// otherwise leave a READY cycle with zero email rows — indistinguishable from a step that
	// never ran. That indistinguishability is the outage this value exists to end.
	//
	// It is also what keeps the ledger honest about retryability. Without this gate the send goes
	// ahead, `sendEmail` throws inside its own try, returns false, and the delivery module
	// classifies that PROVIDER_REJECTED and writes FAILED — "try again" for something no retry can
	// fix, after burning a claim.
	//
	// NO LONGER TERMINAL-ONLY. 1C-2c shipped this gate dropping every email obligation, and said
	// why: parent §9.6's split — terminal for recipients who also got the bell, a DEFERRED row for
	// email-only ones — needed the reconciliation sweep that discharges those obligations, and a
	// mechanism that CREATES durable obligations must not ship ahead of the mechanism that
	// DISCHARGES them. That ordering has now been satisfied in the direction it required:
	// 1C-2d-2a/2b built expiry, lease reclamation, the at-bound discharges, the mail gate, the
	// drain, the claim and the send, and 1C-2d-3a flips this gate last.
	//
	// So the split is live. The block below defers the email-only set; the intersection set is
	// still dropped here, and its justification is unchanged — the bell reached them.
	//
	// IT SETS A FLAG AND DOES NOT CLOSE THE CYCLE. Closing here — the obvious shape, and the wrong
	// one — reaches the completing exit while IN_APP obligations may still be outstanding, and
	// that exit terminalizes every unresolved row on BOTH channels. A recipient whose bell
	// delivery failed transiently would have their FAILED row flipped to SKIPPED and the cycle
	// written terminal, so they get neither channel and nothing ever retries: a mail outage
	// costing the channel that works, which is the one thing §9.6 forbids. The in-app rejection
	// below must run FIRST, and it does.
	const mailUsable = emailCandidates.length === 0 || isMailConfigured();

	if (!mailUsable && emailOnlyCandidates.length > 0) {
		// THE ORDERING IS FORCED, not chosen. deferPublishingEmailDeliveries takes the same
		// creation fence the claim does, and that fence refuses on CYCLE_TERMINAL — so a
		// deferral attempted after closeObligationsAndComplete is silently not written, and
		// the cycle reports MAIL_NOT_CONFIGURED with nothing handed off. It must run HERE:
		// while the cycle is still live, on the attempt that DISCOVERS the outage, and
		// before the in-app rejection below.
		//
		// NOT WRAPPED IN perRecipient, and that is §9.6 verbatim: "If writing the deferral
		// fails, the activity rejects". That helper exists to stop one recipient's failure
		// costing the rest of the batch, which is right for a per-recipient send and wrong
		// for one set-wide statement — there is no rest of the batch, and swallowing the
		// error produces the single state the reject rule exists for: the obligation
		// undischarged AND unrecorded, under a cycle closed as though it had been handed
		// off.
		const deferred = await deferPublishingEmailDeliveries({
			cycleId,
			tenant,
			recipientUserIds: emailOnlyCandidates,
		});
		if (deferred.outcome === "TENANT_CHANGED") {
			// VOID, not deferred. There is no obligation to hand off under a tuple that no
			// longer owns the project, and the shared exit terminalizes what exists while
			// writing no new row — §9.2(d)'s requirement.
			await cancelForTenantMove();
			return;
		}
		if (deferred.outcome === "DEFERRED") {
			// One line per RUN carrying the count, not one per recipient — the same rule the
			// reconciliation passes follow, and for the same reason: an alert rule keyed on
			// this must not scale with the roster.
			//
			// `created` is what the database inserted, so a retry of an already-deferred
			// cycle logs 0 and stays distinguishable from a cycle that deferred nothing.
			//
			// console.*, NOT the logger from @repo/logs, because that is this file's idiom —
			// its two existing lines are console.warn. The neighbouring reconciliation
			// activities use logger and the divergence is real, but converting is a
			// mechanical change to shipped log lines and the tests that read them, and it
			// does not belong in a slice that inverts a behaviour.
			console.info(
				"[publishing-suggestion/notifyPublishingTopicsReady] deferred email-only obligations",
				{
					projectId: tenant.projectId,
					cycleId,
					emailOnlyCandidates: emailOnlyCandidates.length,
					created: deferred.created,
				},
			);
		}
		// CYCLE_TERMINAL falls through deliberately: another attempt has already closed this
		// cycle, so this one has no outcome to write either, and the shared exits below
		// reach the same place without a special case here.
	}

	// THE CURSOR, and it is the half that makes the bound SAFE rather than harmful. A cap on its own
	// leaves the remainder outstanding, the activity rejects, and the retry re-walks FROM THE
	// BEGINNING — spending its own budget re-claiming recipients the previous attempt already sent
	// before it reaches anyone new. Against a finite retry budget a roster only a little over the cap
	// would then never finish, which is strictly worse than the unbounded walk it replaced.
	//
	// The ledger is already the cursor and `undischarged` above is already the predicate — the SAME
	// one the accounting uses, which is what stops the two disagreeing about who is done. It reads
	// once, before the loop; the accounting re-reads afterwards because it has to see what this loop
	// wrote. Two queries per attempt on an indexed cycleId, the second taken only when there is email
	// work to consider at all.
	let emailAttemptList: string[] = [];
	let emailRemaining = 0;
	let emailAlreadyDischarged = 0;
	if (mailUsable && emailCandidates.length > 0) {
		const priorRows = await readPublishingDeliveryStates({ cycleId });
		// IS_WORK: a DEFERRED row is claimable, and reaching this line means the key is back —
		// sending it in band now beats waiting for the drain's next tick. This is the one state
		// where the cursor and the accounting below deliberately disagree.
		const workList = undischarged(
			priorRows,
			"EMAIL",
			emailCandidates,
			"IS_WORK",
		);
		emailAlreadyDischarged = emailCandidates.length - workList.length;
		emailAttemptList = workList.slice(
			0,
			PUBLISHING_NOTIFY_MAX_EMAILS_PER_ATTEMPT,
		);
		emailRemaining = workList.length - emailAttemptList.length;
	}

	if (emailRemaining > 0) {
		// REPORTED, not inferred — the drain's rule (`moreWorkRemains`), for the same reason: a bound
		// that truncates silently reads as "everything was covered" to anyone looking at the logs.
		// One line per RUN carrying counts, never one per recipient, so an alert keyed on it does not
		// scale with the roster.
		//
		// NOT an error, and the level says so. The rejection at the end of this attempt is the
		// mechanism working: the remainder has no ledger row, the accounting counts it for exactly
		// that reason, and the retry comes back for it having skipped everyone already discharged.
		//
		// Ids only — never a name, address or organization.
		console.info(
			"[publishing-suggestion/notifyPublishingTopicsReady] email walk bounded",
			{
				projectId: tenant.projectId,
				cycleId,
				emailCandidates: emailCandidates.length,
				alreadyDischarged: emailAlreadyDischarged,
				attempting: emailAttemptList.length,
				remaining: emailRemaining,
			},
		);
	}

	for (const recipientUserId of emailAttemptList) {
		if (tenantMoved) {
			break;
		}
		const authorized = await perRecipient(
			"reauthorize-email",
			"EMAIL",
			recipientUserId,
			() =>
				reauthorizePublishingRecipient({
					projectId: tenant.projectId,
					recipientUserId,
					cycleTenant: {
						organizationId: tenant.organizationId,
						userId: tenant.userId,
					},
					channel: "EMAIL",
				}),
		);
		if (!authorized.ok) {
			continue;
		}
		if (authorized.value === "TENANT_CHANGED") {
			tenantMoved = true;
			break;
		}

		const address = emailById.get(recipientUserId) ?? null;
		if (authorized.value === "RECIPIENT_UNAUTHORIZED" || address === null) {
			// Two different terminal facts, told apart in the ledger. NO_EMAIL_ADDRESS is not a
			// permission decision and is not retryable: no number of attempts creates an address.
			//
			// THE ADDRESS GUARD IS WEAKER THAN ITS TEST SUGGESTS, and the honest version is worth
			// having in the file rather than in a review. `User.email` is NOT NULL and
			// PublishingNotificationDelivery.recipientUserId is an FK to User with onDelete:
			// Cascade, so `address === null` is UNREACHABLE in production as the schema stands.
			// The only route to a missing map entry is an account deleted between the roster read
			// and the batch `user.findMany` — and in exactly that state the skip below writes a row
			// whose recipientUserId FK no longer resolves, so it throws, is absorbed by
			// `perRecipient`, and the recipient is retried anyway. The outcome the test asserts
			// (SKIPPED, terminal, not retried) is therefore not reachable on the only path that
			// reaches the branch.
			//
			// It STAYS, and not out of caution: it is what stops `to: null` reaching the provider
			// after a claim has been burnt, and it costs one map lookup. Read it as defence against
			// a future NULLABLE-EMAIL schema change rather than against a deleted account.
			//
			// The corollary matters more than the guard. NO_EMAIL_ADDRESS has NO LIVE WRITER, so
			// 1C-2d must not key a report, an alert or a reconciliation branch off it — a value
			// that never appears is indistinguishable from one whose writer regressed.
			//
			// AUTHORIZATION WINS THE TERNARY, and the order is load-bearing rather than
			// incidental. A recipient who is both unauthorized and addressless is two true facts
			// at once, and only one of them can be the `reason` an operator reads. Permission is
			// the operative one: an unauthorized recipient gets no mail whatever their address, so
			// NO_EMAIL_ADDRESS would report the incidental fact and bury the decision. It would
			// also be the ONLY way that value ever reached production (see above), which is
			// precisely the shape that would make 1C-2d's grouping-by-reason misleading.
			const recorded = await perRecipient(
				"record-skip-email",
				"EMAIL",
				recipientUserId,
				() =>
					recordPublishingDeliverySkip({
						cycleId,
						tenant,
						recipientUserId,
						channel: "EMAIL",
						// CANCELLATION IS AUTHORITATIVE, and on EMAIL that has a cost the in-app
						// channel does not pay. This write terminalizes an unresolved row on the
						// triple and releases its lease — so when THIS attempt finds a recipient
						// RECIPIENT_UNAUTHORIZED while an OLDER attempt holds the lease mid-send,
						// it flips SENDING -> SKIPPED and clears claimToken underneath it. There is
						// no double send: the older attempt's confirm is fenced on the token it no
						// longer owns, answers LOST, and is reported ALREADY_TERMINAL. But the
						// ledger then records SKIPPED / RECIPIENT_UNAUTHORIZED for a message that
						// WAS delivered. Inherent to making cancellation authoritative, and written
						// down because 1C-2d groups on `reason` and will read these rows.
						reason:
							authorized.value === "RECIPIENT_UNAUTHORIZED"
								? "RECIPIENT_UNAUTHORIZED"
								: "NO_EMAIL_ADDRESS",
					}),
			);
			if (recorded.ok && recorded.value === "TENANT_CHANGED") {
				tenantMoved = true;
				break;
			}
			continue;
		}

		const result = await perRecipient(
			"deliver-email",
			"EMAIL",
			recipientUserId,
			() =>
				deliverPublishingTopicsReadyEmail({
					cycleId,
					tenant,
					recipientUserId,
					recipientEmail: address,
					projectName: project?.name ?? "your project",
					topicCount,
					url: topicsUrl,
				}),
		);
		if (result.ok && result.value === "TENANT_CHANGED") {
			tenantMoved = true;
			break;
		}
	}

	if (tenantMoved) {
		// Cancelled obligations are TERMINAL and are not unconfirmed, so the activity completes
		// instead of rejecting. Recipients the loop never reached have no obligation to discharge:
		// no row was ever created for them, and creating one now would carry the stale tuple.
		await cancelForTenantMove();
		return;
	}

	// The accounting read, and it must be a FRESH one: the loops above wrote to this ledger, and
	// the cursor's pre-loop snapshot predates every row they created. `undischarged` above is the
	// predicate; this is its second call site.
	const rows = await readPublishingDeliveryStates({ cycleId });

	// EMAIL is accounted only when the channel was usable, and since 1C-2d-3a the reason has
	// changed even though the code has not. It used to be that a keyless attempt DROPPED the email
	// obligations, so there was nothing left to count. Now the email-only ones are DEFERRED and the
	// rest are still dropped — and neither is this attempt's to discharge: a deferral is a hand-off
	// to a carrier with its own trigger (§9.6), and no number of attempts creates an environment
	// variable. Counting either would reject forever over work no retry here can do.
	//
	// IN_APP is always accounted, which is what keeps a bell failure retryable through a mail
	// outage — and it is also what keeps the cycle alive long enough for a restored key to be
	// noticed in band, which is the only route by which the DEFERRED case in `undischarged` above
	// is reachable at all.
	//
	// ACCOUNTED AGAINST THE FULL CANDIDATE SET, never against the bounded list the email loop
	// actually walked, and that is what turns the per-attempt bound into a retry rather than a
	// silent truncation. Recipients the bound did not reach have NO ROW, `undischarged` reports
	// them for exactly that reason, and the rejection below is what brings the next attempt back
	// for them. Narrowing this to the walked list would make every bounded attempt look complete.
	const unconfirmed = [
		...undischarged(rows, "IN_APP", inAppCandidates, "IS_DISCHARGED"),
		...(mailUsable
			? undischarged(rows, "EMAIL", emailCandidates, "IS_DISCHARGED")
			: []),
	];

	if (unconfirmed.length > 0) {
		throw ApplicationFailure.retryable(
			`${unconfirmed.length} publishing notification recipient(s) unconfirmed`,
			"PUBLISHING_NOTIFICATION_UNCONFIRMED",
		);
	}

	// Every candidate is discharged, so the cycle can be closed — through the SAME exit every other
	// completing path uses, which is what keeps "delivered" meaning one thing in this file. The
	// terminalization it performs can only reach rows belonging to NON-candidates (every candidate
	// is SENT with a deliveredAt, or SKIPPED, and the filter excludes both), and it runs strictly
	// after the rejection above — terminalizing before that check would discharge the very rows
	// whose unconfirmed state is what earns the retry.
	//
	// Reached only once every obligation this attempt can still discharge IS discharged. The
	// forced outcome is correct here and was NOT correct at the gate: by this line the in-app
	// rejection above has already run, so nothing outstanding on the working channel is about to
	// be terminalized by a mail outage.
	await closeObligationsAndComplete({
		reason: "CYCLE_CLOSED",
		outcome: mailUsable
			? { kind: "fallback", value: "CANCELLED" }
			: { kind: "forced", value: "MAIL_NOT_CONFIGURED" },
	});
}

export async function notifyPublishingTopicsReady(
	input: NotifyPublishingTopicsReadyInput,
): Promise<void> {
	return runPublishingTopicsReadyNotification(input);
}
