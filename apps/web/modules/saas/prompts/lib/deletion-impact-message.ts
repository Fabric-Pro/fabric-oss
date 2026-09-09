/**
 * What a prompt deletion says — before it happens, and after (Fizzy #2328).
 *
 * The shared confirmation dialog takes a plain `string` message (`ConfirmOptions`
 * in `@saas/shared/components/ConfirmationAlertProvider`), so the impact has to
 * be prose by the time the dialog opens. Widening that type would change a
 * component every destructive action in the product depends on, to render one
 * sentence (KTD6) — so the formatting lives here and the dialog stays as it is.
 *
 * The pre-flight impact and the deletion's own result carry the SAME field
 * names on purpose (`PlatformWidePromptDeletionImpact` and
 * `PromptDeletionResult` in `packages/database`), so one vocabulary describes
 * both and an operator can compare "what we said" against "what happened" when
 * a binding was written in between (R15).
 *
 * Two rules the copy must keep:
 *
 *  - An impact that could not be read is reported as UNKNOWN, never as zero.
 *    See `docs/solutions/design-patterns/a-surface-must-not-report-absence-it-did-not-verify.md`
 *    — the whole reason the impact query is platform-wide in the first place.
 *  - No organization and no person is ever named, only counted (R6).
 *
 * A third rule joins them with Fizzy #2403: a failure whose CAUSE is known is
 * described by that cause, not as an impact nobody could determine. There is
 * exactly one such cause today — a request that resolved no workspace — and it
 * is not the check failing to answer, it is the deletion's own answer arriving
 * early (R8). It still claims no absence: it says nothing about how many
 * bindings exist.
 *
 * Nor does it promise one. That condition was measured ONCE, before the dialog
 * opened, and nothing re-measures it while the dialog is up: the session's
 * workspace alignment can land a moment later, at which point Delete succeeds
 * and removes exactly what a promise of "nothing will be removed" said it would
 * not. So the sentence states the CONDITION — refused *while* the workspace is
 * missing — and carries the same unverified-impact hedge its sibling does. The
 * neighbouring rule about never reporting an unread impact as zero is this same
 * discipline applied to figures; a guarantee about an irreversible action is the
 * one claim this file must never make on a fact it cannot re-check.
 *
 * The user-facing word for a tenant is "workspace", never "organization" —
 * the vocabulary rule `MISSING_ORGANIZATION_CONTEXT_ERROR_CODE` documents in
 * `missing-organization-context.ts`.
 * The pre-#2403 sentences below are the exception, and they stay as they are:
 * their wording is pinned byte-for-byte by the rule above and by the tests that
 * enforce it, so it is changed deliberately or not at all.
 */

/**
 * The quantities both the pre-flight impact and the completed deletion report.
 *
 * Structural rather than imported from `@repo/database`: these three surfaces
 * receive them over oRPC, and the shape is the contract.
 */
export type PromptDeletionFigures = {
	/** How many prompt rows carry the key and go together (R14). */
	promptRowCount: number;
	/** Bindings of every target type, in every tenant. */
	bindingCount: number;
	/** Distinct organizations losing at least one binding. */
	organizationCount: number;
	/** Distinct PEOPLE losing a personal override — not override rows. */
	personalOverrideUserCount: number;
	/** Already humanized for display, de-duplicated and sorted. */
	documentTypeLabels: string[];
};

/**
 * What the live region says while the platform-wide impact is being read.
 *
 * The menu closes on the click and the dialog only opens once the sentence is
 * ready, so without this the wait is silent for anyone not watching the
 * overflow trigger go busy (KTD6).
 */
export const PROMPT_IMPACT_PENDING_ANNOUNCEMENT =
	"Checking what deleting this system prompt would remove across the platform.";

/**
 * The label on the safe action offered beside Delete when the request resolved
 * no workspace (R15).
 *
 * Here rather than at the hook that wires it up, for the same reason the
 * announcement above is: the sentence that says reloading restores the
 * workspace and the button that performs it are one offer, so they are written
 * next to each other. Two files would let them drift into promising different
 * things — including the drift that matters most, one of them appearing for a
 * viewer reloading cannot help. Which viewers those are is the hook's question,
 * not this module's: `reloadRestoresWorkspace` below is how it answers, and it
 * governs the clause and the button together.
 */
export const PROMPT_DELETION_RELOAD_ACTION_LABEL = "Reload the page";

function plural(count: number, one: string, many: string): string {
	return `${count} ${count === 1 ? one : many}`;
}

/** "a", "a and b", "a, b and c" — never an Oxford comma before "and". */
function joinWithAnd(items: string[]): string {
	if (items.length <= 1) {
		return items[0] ?? "";
	}
	return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * The confirmation for an ORG- or USER-scope deletion — unchanged from what the
 * listing surfaces have always said. Only a SYSTEM prompt gets an impact,
 * because only a SYSTEM prompt can be bound outside the tenant looking at it.
 */
export function formatPlainPromptDeletionConfirmation(name: string): string {
	return `Are you sure you want to delete "${name}"? This action cannot be undone.`;
}

/**
 * The confirmation for a SYSTEM-scope deletion.
 *
 * `figures` is `null` when there are none, and `unavailableReason` says why —
 * the classification the impact read hands back (Fizzy #2403). Two different
 * things arrive here as an absent impact and they are not told the same way:
 *
 *  - **A check that did not answer** (`"unknown"`): a timeout, an abort, a
 *    transport that died, a refusal for a cause this build cannot name. The
 *    impact is reported as undetermined and the deletion is still offered — a
 *    hard block is the dead end #2328 exists to remove (R7). This sentence is
 *    unchanged and stays unchanged: it is the one the recorded rule about
 *    unverified absence is written against.
 *  - **A deletion that will be refused** (`"missing-workspace"`): the request
 *    resolved no workspace, and the delete endpoint gates on exactly the
 *    condition the impact endpoint gated on, so proceeding cannot succeed *while
 *    that holds*. The check did not fail here; it reported the deletion's own
 *    outcome ahead of time, and saying "could not be determined" would blame the
 *    wrong thing and leave the operator hunting for a permission they already
 *    have (R8). What it must NOT do is turn that into a guarantee: the condition
 *    can lift while the dialog is open, so this branch keeps the sibling's hedge
 *    about what an impact nobody read might still remove.
 *
 * Delete is offered in BOTH cases (R10). The workspace case adds a safe action
 * beside it rather than taking the destructive one away — the hook attaches it,
 * because a synchronous string is all the shared dialog takes for a message.
 */
export function formatSystemPromptDeletionConfirmation({
	name,
	figures,
	unavailableReason,
	reloadRestoresWorkspace,
}: {
	name: string;
	figures: PromptDeletionFigures | null | undefined;
	/**
	 * Spelled out here rather than imported from the hook that classifies it:
	 * this module is words and nothing else, and reaching back into a React
	 * module to borrow a union would invert that. The duplication is
	 * load-bearing — a reason added upstream and not handled here is a type
	 * error at the call site instead of a new cause silently inheriting the
	 * "could not be determined" sentence.
	 */
	unavailableReason?: "missing-workspace" | "unknown" | null;
	/**
	 * Whether reloading would actually bring the workspace back FOR THIS VIEWER
	 * — the same answer that decides whether the dialog carries the reload
	 * button (`PROMPT_DELETION_RELOAD_ACTION_LABEL` above).
	 *
	 * Required, not optional-with-a-default: the recovery this clause offers is
	 * a no-op for a viewer who holds no membership in the workspace on screen
	 * (`ActiveOrganizationProvider` skips its alignment entirely for them, so
	 * the reload re-runs an effect that skips again), and only the caller knows
	 * which viewer it has. A default would answer that question here, where
	 * there is nothing to answer it with.
	 *
	 * Read only by the `missing-workspace` branch; no other sentence offers a
	 * remedy.
	 */
	reloadRestoresWorkspace: boolean;
}): string {
	const opening = `Delete the system prompt "${name}"?`;

	if (!figures) {
		if (unavailableReason === "missing-workspace") {
			// Names the cause and the CONDITION — never an outcome. "While the
			// workspace is missing" stays true whenever the workspace comes
			// back mid-dialog; "nothing will be removed", which this sentence
			// used to end on, becomes false at that moment, and it was the
			// reassurance an operator read before an irreversible action.
			//
			// The recovery clause appears only when reloading can actually
			// deliver it, and the hedge is the sibling branch's, word for word
			// in substance: nobody read this impact, so nothing may be claimed
			// about it in either direction.
			const recovery = reloadRestoresWorkspace
				? " — reloading the page restores it"
				: "";

			return `${opening} This request has no workspace to act in, so the deletion will be refused while the workspace is missing${recovery}. You can still choose Delete, but what it would remove was never read, so if the workspace is restored first this may remove bindings belonging to other organizations and people.`;
		}

		// Never "no bindings". Nothing was verified, so nothing is claimed.
		return `${opening} What this removes could not be determined — the platform-wide check did not complete, so this may still remove bindings belonging to other organizations and people. You can continue anyway; the deletion cannot be undone.`;
	}

	const rows =
		figures.promptRowCount === 1
			? "1 prompt row carries its key and will be removed"
			: `${figures.promptRowCount} prompt rows carry its key and all of them will be removed`;

	if (figures.bindingCount === 0) {
		return `${opening} ${rows}. There are no bindings, so no organization or person loses a default. This cannot be undone.`;
	}

	const affected = joinWithAnd([
		plural(figures.organizationCount, "organization", "organizations"),
		plural(
			figures.personalOverrideUserCount,
			"person holding a personal override",
			"people holding personal overrides",
		),
	]);

	const documentTypes = figures.documentTypeLabels.length
		? `, covering ${joinWithAnd(figures.documentTypeLabels)}`
		: "";

	return `${opening} ${rows}. That removes ${plural(
		figures.bindingCount,
		"binding",
		"bindings",
	)} in all, affecting ${affected}${documentTypes}. These figures are a snapshot taken just now, so a binding created while you read this is not in them. This cannot be undone.`;
}

/**
 * What to report once the deletion has committed (R15).
 *
 * Built from the figures the DELETION returned, never from the pre-flight
 * snapshot — a binding created while the operator read the dialog is removed by
 * the deletion and must appear here, even though the confirmation could not
 * have shown it.
 *
 * Returns `undefined` for an ORG or USER deletion, which removes nothing beyond
 * the tenant already looking at it and has no cross-tenant account to give.
 */
export function formatPromptDeletionOutcome(
	result:
		| ({
				scope?: string;
				retirementRecorded?: boolean;
		  } & Partial<PromptDeletionFigures>)
		| null
		| undefined,
): string | undefined {
	if (!result || result.scope !== "SYSTEM") {
		return undefined;
	}

	const removed = joinWithAnd([
		plural(result.promptRowCount ?? 0, "prompt row", "prompt rows"),
		plural(result.bindingCount ?? 0, "binding", "bindings"),
	]);

	const affected = joinWithAnd([
		plural(result.organizationCount ?? 0, "organization", "organizations"),
		plural(
			result.personalOverrideUserCount ?? 0,
			"person holding a personal override",
			"people holding personal overrides",
		),
	]);

	const retirement = result.retirementRecorded
		? " The key is recorded as retired, so a catalogue seed will not bring it back."
		: "";

	return `Removed ${removed}, affecting ${affected}.${retirement}`;
}
