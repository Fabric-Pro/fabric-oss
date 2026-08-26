import {
	claimPublishingEmailDelivery,
	confirmPublishingEmailDelivery,
	PUBLISHING_EMAIL_PROVIDER_DEDUPE_WINDOW_MS,
	recordPublishingEmailFailure,
} from "@repo/database";
import { sendEmail } from "@repo/mail";

export type EmailDeliveryOutcome =
	| "SENT"
	| "ALREADY_TERMINAL"
	| "HELD"
	| "TENANT_CHANGED"
	| "FAILED";

/**
 * Deliver the topics-ready email to ONE recipient: claim, send, confirm.
 *
 * The ordering is the design. The claim is taken BEFORE the provider call so two overlapping
 * attempts cannot both send — and it is a conditional update rather than a read, because a
 * Temporal start-to-close timeout does not stop the attempt that timed out. The confirmation is
 * written AFTER, fenced on the same token, so an attempt whose lease expired mid-flight cannot
 * mark delivered a message the succeeding attempt actually sent.
 *
 * What that ordering does NOT close, stated plainly rather than waved away: an attempt that has
 * handed the message to the provider and dies before confirming leaves a claim that expires and
 * is re-taken, and the next attempt re-sends. That window is one lease wide, not one write wide.
 * `idempotencyKey` is what collapses the duplicate at the provider, and it is the reason this
 * function passes one on every send.
 *
 * Every token-fenced write below is reached ONLY through the narrowed CLAIMED branch, and that is
 * the invariant to preserve rather than a happy accident of the control flow.
 * `confirmPublishingEmailDelivery` and `recordPublishingEmailFailure` THROW on a falsy token,
 * because Prisma drops an `undefined` where-predicate instead of matching nothing: an absent token
 * would WIDEN the fence to whichever attempt currently owns the row rather than miss. This module
 * is the activity boundary where JSON-deserialized input meets those functions, so a future edit
 * that threads a token in from `input` — or that hoists one of these calls above the
 * `claim.outcome !== "CLAIMED"` return — is the edit that reopens it.
 *
 * The caller supplies `url` already absolute. This is an off-app message, so it cannot use the
 * context-relative link the bell stores — there is no workspace base for a mail client to
 * prepend.
 */
export async function deliverPublishingTopicsReadyEmail(input: {
	cycleId: string;
	tenant: {
		projectId: string;
		organizationId: string | null;
		userId: string | null;
	};
	recipientUserId: string;
	recipientEmail: string;
	projectName: string;
	topicCount: number;
	url: string;
}): Promise<EmailDeliveryOutcome> {
	const claim = await claimPublishingEmailDelivery({
		cycleId: input.cycleId,
		tenant: input.tenant,
		recipientUserId: input.recipientUserId,
	});
	if (claim.outcome !== "CLAIMED") {
		// Every non-claim verdict maps straight through, including HELD — which is NOT terminal.
		// The caller must keep a held row counted as unconfirmed, or a live attempt's obligation
		// is reported as discharged by the attempt that did not get it.
		return claim.outcome;
	}

	// From the claim itself, never from a read taken before it: the claim's transaction held the
	// project lock while it read this value and overwrote it, so it cannot be stale. A pre-claim
	// read can be arbitrarily old, because a timed-out attempt keeps running.
	const previous = claim.previousAttemptAt;
	if (
		previous !== null &&
		Date.now() - previous.getTime() >
			PUBLISHING_EMAIL_PROVIDER_DEDUPE_WINDOW_MS
	) {
		// PROCEED, and say so. This row was attempted longer ago than the provider retains its
		// idempotency key, so if that earlier attempt was in fact accepted, this send produces a
		// second copy. Refusing would be the wrong trade and not ours to make here: the product
		// decision recorded in the spec ranks a possible duplicate above a possible silent drop,
		// because a duplicate is noise and a dropped notification is invisible to everyone.
		//
		// What refusing WOULD be right for is a human re-drive, and that is where the refusal
		// lives (redrive-publishing-notification.ts, --force-stale). Here the only defensible
		// action is to leave evidence, so a duplicate that reaches a recipient can be explained
		// afterwards instead of being a mystery. Reaching this line at all means an attempt was
		// delayed by more than a day — a worker outage, or a re-drive that was forced — so it is
		// worth a warning on its own.
		//
		// TWO LAYERS, and this one does not decide. Recorded here because it reads like an
		// unguarded duplicate path and has been raised as one: the script decides, this executes.
		// A person reaching this branch has already been refused once by the script's
		// dedupe-horizon guard and has answered it with --force-stale, so the consent exists one
		// layer up. Refusing again here would make that flag a switch that changes nothing, and
		// would trade a warned, consented duplicate for a permanent silent drop — nothing queries
		// for it (`PENDING` is explicitly never an alert by itself, and 1C-2d's reconciliation
		// sweep does not exist yet). The remaining route is a workflow attempt that stalled past a
		// day and resumed, which the script cannot see; the same trade applies to it, and the
		// warning is what makes it explicable.
		console.warn(
			"[publishing-suggestion/deliverPublishingTopicsReadyEmail] re-sending past the provider dedupe window",
			{
				projectId: input.tenant.projectId,
				cycleId: input.cycleId,
				recipientUserId: input.recipientUserId,
				lastAttemptAt: previous.toISOString(),
			},
		);
	}

	let ok: boolean;
	try {
		ok = await sendEmail({
			to: input.recipientEmail,
			templateId: "publishingTopicsReady",
			idempotencyKey: `publishing-${input.cycleId}-${input.recipientUserId}`,
			context: {
				projectName: input.projectName,
				topicCount: input.topicCount,
				url: input.url,
			},
		});
	} catch (error) {
		// sendEmail is documented to return false rather than throw (send.ts's catch returns
		// false for a render failure and a provider failure alike). This does not rely on that:
		// an uncaught throw here is the crashed-attempt case PUBLISHING_EMAIL_LEASE_MS describes —
		// it leaves the row SENDING, unconfirmed, under a lease that is a margin, not a guarantee.
		// For this specific case the margin holds: a later attempt of this same workflow does no
		// provider work of its own before reaching this row — a rejecting attempt returns in
		// milliseconds rather than walking the roster — so it lands far inside the lease, sees the
		// row still held, and rejects rather than re-taking it. Catching converts an ambiguous
		// outcome into a known one, which is what makes it recoverable at once instead of waiting
		// out the lease.
		await recordPublishingEmailFailure({
			cycleId: input.cycleId,
			recipientUserId: input.recipientUserId,
			claimToken: claim.claimToken,
			reason: "PROVIDER_ERROR",
			errorMessage:
				error instanceof Error ? error.message : String(error),
		});
		// The RECORDED | LOST return above is not read, and that is a deliberate asymmetry with
		// confirmPublishingEmailDelivery's LOST, which IS surfaced (as ALREADY_TERMINAL) rather
		// than folded into FAILED. Here a LOST — this attempt's lease expired and a newer attempt
		// took the row, or the row was cancelled mid-flight — is reported exactly like a genuine
		// send failure: both return FAILED. So FAILED can mean either "the send failed" or "this
		// attempt no longer owns the row", and the caller cannot tell which from the return value
		// alone. That is safe because it errs toward retrying rather than toward silently
		// stopping: the caller retries a row it may no longer hold, that retry's own claim reads
		// the row's actual state (e.g. SKIPPED), and it answers ALREADY_TERMINAL — the attempt
		// self-corrects one claim later. Task 8 builds a retry loop directly on this return value,
		// which is why the asymmetry is written down here instead of left for a future review to
		// rediscover.
		return "FAILED";
	}

	if (!ok) {
		// A classification, never the provider's own body: `reason` is a column operators read,
		// and a raw response is how an address or a subject line ends up in it. PROVIDER_REJECTED
		// rather than PROVIDER_ERROR because the union's two members exist to tell "returned
		// false" apart from "threw", and only the throw carries text worth preserving.
		await recordPublishingEmailFailure({
			cycleId: input.cycleId,
			recipientUserId: input.recipientUserId,
			claimToken: claim.claimToken,
			reason: "PROVIDER_REJECTED",
		});
		// Same LOST-folds-into-FAILED asymmetry as the catch block above — see its comment.
		return "FAILED";
	}

	const confirmed = await confirmPublishingEmailDelivery({
		cycleId: input.cycleId,
		recipientUserId: input.recipientUserId,
		claimToken: claim.claimToken,
	});
	if (confirmed === "LOST") {
		// The message was sent, but this attempt no longer owns the row — its lease expired and a
		// newer attempt took it, or the obligation was cancelled mid-flight. Reporting SENT would
		// be a claim about a row this attempt does not own; ALREADY_TERMINAL is the honest answer
		// and tells the caller to stop acting on this recipient.
		return "ALREADY_TERMINAL";
	}
	return "SENT";
}
