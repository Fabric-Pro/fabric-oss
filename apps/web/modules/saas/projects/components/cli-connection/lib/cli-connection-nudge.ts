/**
 * Every decision the CLI-connection prompt makes (Fizzy #2457, R3 / R23), and
 * the funnel event names it emits (R25).
 *
 * Plain functions of their arguments rather than hooks, for the reason the
 * closest analogous banner gives in `@saas/shared/lib/anthropic-capability`:
 * the component and its test read the same rule, so they cannot disagree about
 * when the prompt appears. Pure module — no React, no side effects.
 *
 * It began as the one show/hide rule and has taken in the prompt's second offer
 * — asking a teammate to connect — on the same terms. Whether that control
 * appears, whether a fan-out needs confirming, and what the result may claim are
 * all decisions, and a decision that lives in a component is a decision its test
 * cannot reach and a sibling surface will quietly re-implement.
 */

import { ORPCError } from "@orpc/client";
import { LARGE_GROUP_THRESHOLD as GROUP_MENTION_LARGE_THRESHOLD } from "@saas/projects/lib/group-mention-confirm";

/**
 * The readiness payload's CLI block, narrowed to the ONE field this rule reads.
 *
 * The narrowing is the point. `cliConnection` also carries
 * `organizationConnected`, `viewerCanCreateKey` and `viewerDismissed`, and all
 * three are CONTEXT — the server has already folded them, along with the
 * rollout gate, the resolved checklist item, the project's status and the
 * two-of-eight threshold, into `promptEligible`. Re-deriving the answer from
 * the parts here would be a second implementation of a decision that is
 * authoritative in exactly one place, free to drift from it, and — since there
 * is no client-side permission hook in this codebase — free to be wrong about
 * the viewer's role while type-checking perfectly.
 *
 * Declared here rather than inferred from the provider so the rule states the
 * whole of its own input: a field added to the payload tomorrow cannot quietly
 * widen what this rule depends on. Not exported — it is reachable through
 * `CliConnectionNudgeInputs`, and a second name for it in a caller would be a
 * second place to widen.
 */
type CliConnectionPromptState = {
	/** The server's whole answer. Every other field on the block is context. */
	promptEligible: boolean;
};

/** Everything the show/hide decision is allowed to look at. */
export type CliConnectionNudgeInputs = {
	/**
	 * The payload's CLI block, or `undefined` while readiness has not answered
	 * — loading, errored, disabled, or mounted outside the readiness provider.
	 */
	cliConnection: CliConnectionPromptState | undefined;
	/**
	 * Whether an onboarding surface has claimed the project view since this
	 * mount (R23). Sticky by the time it reaches here: a surface closing does
	 * not clear it, so finishing a tour cannot make the prompt pop in under the
	 * reader mid-session.
	 */
	onboardingClaimed: boolean;
	/**
	 * Whether this viewer has dismissed the prompt during this session.
	 *
	 * Distinct from the payload's `viewerDismissed`, which is the SERVER's
	 * record and only comes back true on the next readiness read. This is the
	 * optimistic half, and it exists so the surface disappears on the click
	 * rather than a round trip later.
	 */
	dismissed: boolean;
	/**
	 * Whether this viewer issued a key during this project view — from EITHER
	 * surface, the prompt or the checklist row.
	 *
	 * A suppression of its own, because nothing on the server will suppress it.
	 * The checklist item behind `promptEligible` completes when something
	 * actually REACHES Fabric over MCP — the evidence is resolved from reach
	 * records and
	 * a still-live credential, never from the key tables — so minting a key
	 * moves no readiness answer at all. Without this input the prompt would sit
	 * there through the next refetch, telling someone who has just issued a key
	 * that nothing has reached Fabric over MCP and offering to mint another one.
	 *
	 * "Either surface" is the whole reason it is not the prompt's own state.
	 * Both surfaces mount their own copy of the issuing view, so a flag held by
	 * the prompt is invisible to a key minted from the row beside it — and the
	 * row is the surface a reader who has opened the checklist is most likely
	 * to use. The fact therefore lives on the readiness context both descend
	 * from, and both write it.
	 *
	 * Scoped to the project view and deliberately not persisted. Issuing a key
	 * is not connecting: the reader may still have a configuration block to
	 * paste, so the offer belongs back on the next project view, and the
	 * "API Key for CLI" checklist row keeps it reachable in between.
	 */
	keyIssued: boolean;
};

/**
 * Whether the CLI-connection prompt should render.
 *
 * True only when every one of these holds:
 *
 * 1. There is a payload. An absent one means "we do not know yet", never "this
 *    viewer qualifies" — a readiness read that has not landed, has failed, or
 *    is disabled must not put a prompt on the page. Fails closed, because the
 *    cost of guessing wrong is showing an offer to create an API key to
 *    someone whose permission to create one has not been established.
 * 2. Nothing else is claiming the view (R23). The prompt is the lowest-
 *    priority surface on this page: onboarding is teaching the reader how the
 *    product works, and interrupting that to sell them a CLI is the definition
 *    of stacked.
 * 3. This viewer has not just dismissed it.
 * 4. This viewer has not just issued a key from it. The server's answer does
 *    not change when they do — the item completes on a tool reaching Fabric,
 *    not on a key existing — so the prompt has to stand itself down.
 * 5. The server says the prompt is eligible.
 *
 * Note what it deliberately does NOT do: consult `organizationConnected` or
 * `viewerCanCreateKey`. Those look like they would make the rule more careful
 * and would in fact make it wrong — `promptEligible` is false in strictly more
 * situations than they cover (an archived project, an item marked not
 * applicable, an in-force personal snooze, the rollout gate off, fewer than two
 * context items), and an AND of the two visible fields would let every one of
 * those through the moment someone "simplified" the server's answer away.
 */
export function shouldShowCliConnectionNudge(
	inputs: CliConnectionNudgeInputs,
): boolean {
	if (!inputs.cliConnection) {
		return false;
	}

	if (inputs.onboardingClaimed) {
		return false;
	}

	if (inputs.dismissed) {
		return false;
	}

	if (inputs.keyIssued) {
		return false;
	}

	return inputs.cliConnection.promptEligible === true;
}

/* -------------------------------------------------------------------------- */
/* Asking teammates to connect (Fizzy #2457)                                   */
/*                                                                             */
/* The prompt's second offer: the reader who cannot or will not open a terminal */
/* passes the job to whoever on the project would. These are the rules that     */
/* decide whether that offer appears, whether it needs confirming, and what the */
/* result is allowed to claim — all pure, all beside the show/hide rule, so the */
/* component holds no second copy of any of them.                              */
/* -------------------------------------------------------------------------- */

/** Everything the "offer to ask" decision is allowed to look at. */
export type CliConnectionAskInputs = {
	/**
	 * Whether the prompt itself is on screen. The ask hangs off the prompt and
	 * has no life of its own — a control offering to forward an explanation
	 * nobody is being shown is an orphan.
	 */
	promptVisible: boolean;
	/**
	 * How many people are on this project's roster besides the viewer.
	 *
	 * Zero while the roster has not answered — loading, errored, or refused
	 * because this viewer may not read the member list. All of those mean the
	 * same thing here: nobody this surface can name, so nothing to offer. It
	 * fails closed for the reason the show/hide rule does, and the cost of
	 * guessing wrong is a control that opens a picker with nothing in it.
	 *
	 * Roster members, never organization members. A function tag is held on a
	 * project in this data model and the handler expands tags within the
	 * project roster, so both routes into the picker reach the same set and one
	 * count gates both.
	 */
	askableTeammateCount: number;
};

/**
 * Whether the prompt should offer to ask a teammate.
 *
 * Deliberately not folded into {@link shouldShowCliConnectionNudge}: the prompt
 * still has a job when the viewer is alone on the project — it explains the gap
 * and offers the key — and gating the whole prompt on having company would
 * suppress the explanation to keep back a control.
 */
export function shouldOfferCliConnectionAsk(
	inputs: CliConnectionAskInputs,
): boolean {
	return inputs.promptVisible && inputs.askableTeammateCount > 0;
}

/**
 * The recipient count above which this repository stops and asks.
 *
 * Imported, not restated: `@saas/projects/lib/group-mention-confirm` holds the
 * same ten for the comment surface's group mentions and now exports it for
 * exactly this reason. One product rule about how many people may be notified
 * without a second look, not two numbers that happen to agree today and are
 * free to drift apart tomorrow.
 *
 * Aliased back to this file's own name rather than imported bare: every doc
 * comment below still reads `LARGE_ASK_THRESHOLD`, and the ask has nothing to
 * do with group mentions — the shared identity of the two thresholds is an
 * implementation fact, not something this file's readers need to see through.
 */
const LARGE_ASK_THRESHOLD = GROUP_MENTION_LARGE_THRESHOLD;

/** The shape of a composed ask, as the picker holds it before sending. */
export type CliConnectionAskSelection = {
	/** Teammates named one by one. The viewer can see and count these. */
	userIds: readonly string[];
	/** Function tags to expand into their holders ON THIS PROJECT. */
	functionTags: readonly string[];
};

/**
 * Whether this ask should be confirmed before it is sent.
 *
 * True when a function tag is named AT ALL, or when more than
 * {@link LARGE_ASK_THRESHOLD} people were named by hand. Those two arms look
 * inconsistent — one tag holder trips the confirm where ten named people do not
 * — and the inconsistency is the point: the confirm exists for fan-out the
 * sender cannot see, and a list of checkboxes is one they can.
 *
 * ## Why this is not `evaluateLargeGroupConfirm`
 *
 * The comment surface's helper answers the same question from two things this
 * picker does not have: comment text to scan for `@@` tokens, and a
 * tag-to-count map fetched from `functionTags.groupMemberCounts`. Reaching for
 * that map here would buy a number that cannot be shown honestly:
 *
 *  1. It counts the tag's holders on the roster — before the asker is dropped
 *     and before anyone who cannot mint an API key is filtered out. Printing it
 *     as "this will ask N people" overstates the fan-out, which is the exact
 *     habit this ticket is correcting everywhere else in the copy.
 *  2. It is gated on the function-tags flag and returns `{}` when that flag is
 *     off, while `requestCliConnection` expands tags whatever that flag says.
 *     A confirm reading zero for a tag that reaches forty people would go
 *     missing precisely where it matters.
 *  3. It is a round trip before every send, to produce (1).
 *
 * So the confirm is raised on the SHAPE of the ask, which the client knows for
 * certain, and the true number is reported afterwards from the response's
 * `recipientCount` — the count the server resolved, the only one that was ever
 * accurate.
 */
export function askNeedsConfirmation(
	selection: CliConnectionAskSelection,
	threshold: number = LARGE_ASK_THRESHOLD,
): boolean {
	if (selection.functionTags.length > 0) {
		return true;
	}
	return selection.userIds.length > threshold;
}

/**
 * The most explicit ids one ask may name (Fizzy #2457 follow-up).
 *
 * Mirrors `MAX_RECIPIENTS` in
 * `packages/api/modules/projects/procedures/readiness/request-cli-connection.ts`,
 * which bounds `userIds` at the schema itself and separately refuses the whole
 * call when the RESOLVED recipient list — explicit ids plus tag expansion,
 * unioned — exceeds it. This constant guards only the half of that limit the
 * picker can see before sending: a hand-picked, tag-free selection resolves to
 * exactly the ids checked, so stopping the count here at the client's own
 * boundary keeps a pure explicit-id ask from ever reaching the server only to
 * be refused.
 *
 * Restated rather than imported, and necessarily so rather than by omission:
 * the server file this mirrors pulls in `@repo/database`'s Prisma client and
 * `@repo/permissions`, neither fit to reach a browser bundle, and it is not
 * this ticket's file to change regardless. The server's own cap remains
 * authoritative — see `summarizeCliConnectionAsk`'s over-cap branch below for
 * what happens on the arm this cannot guard, or if the two numbers are ever
 * allowed to drift: a real request still meets a distinguishable refusal
 * rather than a silent partial success.
 */
export const MAX_HAND_PICKED_RECIPIENTS = 50;

/** What `projects.readiness.requestCliConnection` reports back. */
export type CliConnectionAskResult = {
	/** Notification rows actually written. */
	notifiedCount: number;
	/** People the ask resolved to and tried to reach. */
	recipientCount: number;
	/** Roster members dropped because they cannot mint an API key. */
	ineligibleCount: number;
	/**
	 * Recipients the fan-out tried to write and could not — the database
	 * refused, or the write threw for any other reason.
	 *
	 * Disjoint from the quiet remainder below: `recipientCount - notifiedCount`
	 * used to be reported as one thing ("already asked, or muted"), and a write
	 * failure is neither. Someone in THIS bucket was reached by nobody — no
	 * unread ask, no muted category, no row at all — and telling them apart is
	 * the entire reason the handler counts it separately (see
	 * `CliConnectionRequestedResult` in `notification-service.ts`).
	 */
	failedCount: number;
};

/** A result sentence and the register it should be said in. */
export type CliConnectionAskSummary = {
	/**
	 * `success` only when something was actually delivered. An ask that reached
	 * nobody is not a failure — nothing went wrong — but reporting it in the
	 * green register would be the interface telling the sender their team had
	 * been asked when it had not.
	 */
	tone: "success" | "info";
	message: string;
};

/** "1 teammate" / "3 teammates", so every sentence below reads at any count. */
function teammates(count: number): string {
	return count === 1 ? "1 teammate" : `${count} teammates`;
}

/**
 * A recipient whose write threw, phrased so it is never confused with one who
 * was reached and chose not to act. "Try asking again" is honest here in a way
 * it is not for the over-cap refusal below: a transient write failure can
 * succeed on a second attempt, where a tag that resolves to sixty people
 * resolves to sixty people every time.
 */
function writeFailedSentence(failedCount: number): string {
	return `The notification failed to send to ${teammates(failedCount)} — try asking again, or reach out directly.`;
}

/**
 * Say what actually happened, from the four counts the handler separates.
 *
 * The handler returns four numbers rather than one because a single "asked N"
 * cannot tell apart the ways an ask shrinks, and the sender needs each of them:
 *
 *  - `recipientCount - notifiedCount - failedCount` — the QUIET remainder:
 *    people this reached who got no new notification because an ask of theirs
 *    is already sitting unread (the server de-duplicates so a second ask
 *    cannot nag), or they have silenced this category. Neither is a delivery,
 *    and neither is a problem.
 *  - `failedCount` — people the fan-out tried to write to and could not: the
 *    database refused the row, or the write threw for any other reason. This
 *    is NOT the quiet remainder above, and folding it in there would be
 *    exactly the overstatement this feature exists to correct: it would tell
 *    the sender that a colleague nobody reached had "already" been asked, and
 *    the sender would not follow up on somebody who needs following up on
 *    more than anyone else counted here.
 *  - `ineligibleCount` — people who were named or tagged and cannot mint an API
 *    key, so they were never written to at all. Handing them the job would hand
 *    them something they cannot do.
 *
 * Nothing here says "notified" of anybody outside `notifiedCount`, and nothing
 * claims a message was read. `notifiedCount` is rows written; that is the
 * whole of what this surface knows, so it is the whole of what it says. Every
 * phrase below is built with {@link teammates} so it reads correctly whether
 * the count behind it is one or many.
 */
export function summarizeCliConnectionAsk(
	result: CliConnectionAskResult,
): CliConnectionAskSummary {
	const { notifiedCount, recipientCount, ineligibleCount, failedCount } =
		result;
	// Defensive: the handler cannot write more rows than it had recipients, and
	// a negative remainder would print a sentence nobody could parse.
	const quiet = Math.max(0, recipientCount - notifiedCount - failedCount);
	const ineligibleNote =
		ineligibleCount > 0
			? ` Left out ${teammates(ineligibleCount)} who cannot create an API key.`
			: "";

	if (notifiedCount > 0) {
		const quietNote =
			quiet > 0
				? ` No new notification went to ${teammates(quiet)} — an unread ask was already waiting, or these notifications are muted.`
				: "";
		const failedNote =
			failedCount > 0 ? ` ${writeFailedSentence(failedCount)}` : "";
		return {
			tone: "success",
			message: `Asked ${teammates(notifiedCount)} to connect a coding tool.${quietNote}${failedNote}${ineligibleNote}`,
		};
	}

	if (recipientCount > 0) {
		// Nobody was notified, but the reason is not the same for everyone left
		// in `recipientCount` — see the doc comment above. `quiet` and
		// `failedCount` are reported as separate sentences rather than folded
		// into one, because "already waiting, or muted" is false for anyone in
		// the second group.
		const quietSentence =
			quiet > 0
				? `No new notification went out — an unread ask was already waiting for ${teammates(quiet)}, or these notifications are muted.`
				: "";
		const failedSentence =
			failedCount > 0
				? quiet > 0
					? `The notification also failed to send to ${teammates(failedCount)} — try asking again, or reach out directly.`
					: `Nobody was notified. ${writeFailedSentence(failedCount)}`
				: "";
		const body = [quietSentence, failedSentence].filter(Boolean).join(" ");
		return {
			tone: "info",
			message: `${body}${ineligibleNote}`,
		};
	}

	if (ineligibleCount > 0) {
		return {
			tone: "info",
			message: `Nobody was asked — ${teammates(ineligibleCount)} matched, and cannot create an API key.`,
		};
	}

	return {
		tone: "info",
		message:
			"Nobody was asked — nobody else on this project matched what you chose.",
	};
}

/* -------------------------------------------------------------------------- */
/* The over-cap refusal (Fizzy #2457 follow-up)                                */
/*                                                                             */
/* `requestCliConnection` refuses the WHOLE call above its recipient cap       */
/* rather than truncating it — see the procedure's own doc comment — and       */
/* names the refusal `TOO_MANY_RECIPIENTS` in its `ORPCError` `data` so a       */
/* client can act on it instead of retrying something that fails identically   */
/* forever. Matching lives here, beside the ask's other decisions, for the     */
/* same reason `summarizeCliConnectionAsk` does: the component and its test    */
/* read the same rule.                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The code the server's over-cap `ORPCError` carries in `data.code`.
 *
 * A string, not a number, and matched exactly for that reason: the two
 * numbers this refusal carries (below) are read off the error itself, never
 * duplicated here, but the code NAMING the refusal is part of the wire
 * contract between this client and that procedure the same way any other
 * `ORPCError` code is — restating it is how every other code in this
 * repository's client is matched.
 */
const TOO_MANY_RECIPIENTS_CODE = "TOO_MANY_RECIPIENTS";

/** What matching the over-cap refusal tells the caller. */
export type CliConnectionAskRefusal =
	| {
			kind: "tooManyRecipients";
			/**
			 * The size this ask actually resolved to. Told to the reader because
			 * they could not have known it before sending — a function tag's
			 * true size is never visible to the picker, see
			 * `askNeedsConfirmation`'s doc comment — so the first time anyone
			 * learns it is here.
			 */
			recipientCount: number;
			/**
			 * The server's own cap, read off THIS refusal rather than held as a
			 * constant in this file. `MAX_HAND_PICKED_RECIPIENTS` above mirrors
			 * the same number for the client-side guard it drives, and mirroring
			 * it a second time here — in the sentence the reader actually sees —
			 * is exactly the stale-copy risk that guard's doc comment accepts for
			 * a DIFFERENT reason (there is no request to read it off). Here there
			 * is a request, so there is no excuse: this number is always the
			 * server's own answer, however it moves.
			 */
			maxRecipients: number;
	  }
	| { kind: "other" };

/**
 * Tell the over-cap refusal apart from every other way sending an ask can
 * fail.
 *
 * Matched on `error.data.code`, never on `error.message`: the message is
 * product copy the server is free to reword, and a client that parsed prose
 * out of it would break silently the next time somebody improved a sentence.
 * Anything that is not exactly this refusal — a validation error, a dropped
 * connection, an outsider named — falls through to `{ kind: "other" }`, which
 * the caller answers with the ordinary `SEND_ERROR` copy.
 */
export function interpretCliConnectionAskError(
	error: unknown,
): CliConnectionAskRefusal {
	if (!(error instanceof ORPCError) || error.code !== "BAD_REQUEST") {
		return { kind: "other" };
	}

	const data = error.data;
	if (
		typeof data !== "object" ||
		data === null ||
		(data as { code?: unknown }).code !== TOO_MANY_RECIPIENTS_CODE
	) {
		return { kind: "other" };
	}

	const { recipientCount, maxRecipients } = data as {
		recipientCount?: unknown;
		maxRecipients?: unknown;
	};
	if (
		typeof recipientCount !== "number" ||
		typeof maxRecipients !== "number"
	) {
		return { kind: "other" };
	}

	return { kind: "tooManyRecipients", recipientCount, maxRecipients };
}

/**
 * The over-cap refusal, said plainly and with something to do about it.
 *
 * Never "try again" — retrying resolves the same tag to the same crowd every
 * time, which is exactly why the server refused it rather than truncating it.
 * Both numbers are the refusal's own; nothing here is a client guess.
 */
export function tooManyRecipientsMessage(
	recipientCount: number,
	maxRecipients: number,
): string {
	return `This ask reaches ${recipientCount} people, and one ask may reach at most ${maxRecipients} at once. Narrow the function tag, or pick fewer people.`;
}

/* -------------------------------------------------------------------------- */
/* Funnel events (R25)                                                         */
/*                                                                             */
/* R25 asks for four steps. Three are named here; the fourth — an organization  */
/* reaching MCP for the first time — is emitted by the runtime that writes the  */
/* record (`CLI_FIRST_REACH_EVENT` in `@saas/mcp/lib/record-cli-reach`).        */
/*                                                                             */
/* Step three, "a key was issued", has TWO names rather than one, because two   */
/* surfaces offer the key and the funnel has to tell them apart: the prompt     */
/* emits `cli.prompt.keyIssued`, the checklist row `cli.checklist.keyIssued`.   */
/* The origin is in the name, not in a property, so the two paths stay separable */
/* in a query without unpacking a payload.                                      */
/*                                                                             */
/* Names, not payload types, because the client transport (`useAnalytics`)      */
/* takes `Record<string, unknown>`. Pinning them in one place is what keeps the */
/* funnel joinable — and is why a fifth name added later belongs here too,      */
/* however local its emitting surface feels at the time.                        */
/* -------------------------------------------------------------------------- */

/**
 * The prompt was actually put on screen.
 *
 * Emitted where the decision to render is FINALLY made — after the rule above
 * has answered — and never where eligibility is computed. Eligibility resolves
 * true on every readiness read, including reads for a viewer whose prompt then
 * yields to an onboarding surface and never renders at all, so counting it
 * server-side would overcount impressions badly enough to make the funnel
 * meaningless.
 */
export const CLI_NUDGE_RENDERED_EVENT = "cli.prompt.rendered" as const;

/** The reader opened the issuing view from the prompt. */
export const CLI_NUDGE_OPENED_EVENT = "cli.prompt.opened" as const;

/** A key was issued from the view the PROMPT opened. */
export const CLI_NUDGE_KEY_ISSUED_EVENT = "cli.prompt.keyIssued" as const;

/**
 * A key was issued from the view the CHECKLIST ROW opened.
 *
 * The same step of the funnel as the constant above, reached by the other door.
 * Kept beside it rather than in the panel that emits it: the two are only
 * useful compared, and a name that lives next to its emitter is a name nobody
 * finds when they are counting the funnel.
 */
export const CLI_CHECKLIST_KEY_ISSUED_EVENT =
	"cli.checklist.keyIssued" as const;

/**
 * The reader opened the "ask a teammate" picker from the prompt.
 *
 * A second door out of the same impression, and the funnel has to tell the two
 * apart: `cli.prompt.opened` above is the reader taking the job themselves,
 * this is the reader passing it on. Both are the prompt working.
 */
export const CLI_NUDGE_ASK_OPENED_EVENT = "cli.prompt.askOpened" as const;

/**
 * An ask was sent from the prompt.
 *
 * Sent, not delivered, and deliberately not "N people were notified" — the
 * step this records is the reader finishing the action. What reached anybody is
 * the handler's answer, and it is reported to the reader rather than counted
 * here.
 */
export const CLI_NUDGE_ASK_SENT_EVENT = "cli.prompt.askSent" as const;
