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
 * `figures` is `null` when the impact could not be read — a failed request, or
 * a response that carried nothing. That case says so in as many words and still
 * offers to continue: a hard block is the dead end this ticket exists to
 * remove (R7).
 */
export function formatSystemPromptDeletionConfirmation({
	name,
	figures,
}: {
	name: string;
	figures: PromptDeletionFigures | null | undefined;
}): string {
	const opening = `Delete the system prompt "${name}"?`;

	if (!figures) {
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
