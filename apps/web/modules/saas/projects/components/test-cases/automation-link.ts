/**
 * Pure rules for the automation link (ref + spec file + CI/report URL). No React
 * here so the editor, the row affordance and the tests all share one definition.
 */

import type { AutomationStatus } from "./constants";

/**
 * The status that follows a ref edit.
 *
 * The write path treats a non-empty ref as proof the case IS automated, but only
 * when the caller leaves `automationStatus` out — an explicit status always wins.
 * The editor submits the whole form, status included, so the flip has to happen
 * here for the saved case to match both the form and what a caller that omitted
 * the status would have got.
 *
 * Only the empty → non-empty transition flips. Once a ref is present, further
 * edits leave the status alone, so a reader who deliberately picks PLANNED while
 * a ref is on file keeps it. Clearing the ref likewise leaves the status alone:
 * status is intent, and silently downgrading it would be a surprising side
 * effect of emptying a text field (the automation stat stays honest regardless —
 * it counts refs, not the enum).
 */
export function statusAfterRefEdit(
	current: AutomationStatus,
	previousRef: string,
	nextRef: string,
): AutomationStatus {
	const wasLinked = previousRef.trim().length > 0;
	const isLinked = nextRef.trim().length > 0;
	return !wasLinked && isLinked ? "AUTOMATED" : current;
}

/**
 * A ref, once trimmed, is what "this case is linked to automation" means. Typed
 * as a predicate so a caller that guards on it can go on to render the ref.
 */
export function hasAutomationRef(
	ref: string | null | undefined,
): ref is string {
	return Boolean(ref?.trim());
}

/**
 * Whether a case counts as automated for display.
 *
 * Deliberately the SAME conjunction the server's `automatedWithRefCount` uses
 * (AUTOMATED *and* a ref on file), because the row badge and the Automation %
 * are two renderings of one fact. Keying the badge on the ref alone would let a
 * case the reader explicitly marked NOT_AUTOMATED — but whose stale ref is still
 * on file — wear an "Automated" badge that the percentage refuses to count.
 */
export function isAutomatedWithRef(
	status: AutomationStatus,
	ref: string | null | undefined,
): ref is string {
	return status === "AUTOMATED" && hasAutomationRef(ref);
}

/**
 * Whether a CI/report URL is safe to both save and render as a link.
 *
 * Mirrors the http(s) restriction the input schema enforces, so the editor can
 * reject a bad value inline instead of round-tripping to a server error — and so
 * a legacy row that predates that rule is never rendered as a clickable href.
 */
export function isLinkableAutomationUrl(value: string): boolean {
	const trimmed = value.trim();
	if (!trimmed) {
		return false;
	}
	try {
		const { protocol } = new URL(trimmed);
		return protocol === "http:" || protocol === "https:";
	} catch {
		return false;
	}
}
