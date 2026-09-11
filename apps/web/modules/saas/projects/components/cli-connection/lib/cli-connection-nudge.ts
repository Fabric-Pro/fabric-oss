/**
 * The one rule that decides whether the CLI-connection prompt renders
 * (Fizzy #2457, R3 / R23), and the funnel event names the prompt emits (R25).
 *
 * A plain function of its argument rather than a hook, for the reason the
 * closest analogous banner gives in `@saas/shared/lib/anthropic-capability`:
 * the component and its test read the same rule, so they cannot disagree about
 * when the prompt appears. Pure module — no React, no side effects.
 */

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
	 * The checklist item behind `promptEligible` completes when a coding tool
	 * actually REACHES Fabric — the evidence is resolved from reach records and
	 * a still-live credential, never from the key tables — so minting a key
	 * moves no readiness answer at all. Without this input the prompt would sit
	 * there through the next refetch, telling someone who has just issued a key
	 * that nobody has connected a coding tool and offering to mint another one.
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
