/**
 * Reading `auth.ts` as text, in BOUNDED slices.
 *
 * Shared by `invite-reconciliation-wiring.test.ts` and
 * `seed-session-organization-wiring.test.ts`, which assert WHERE a call is
 * mounted in `auth.ts` by reading its source rather than by booting it:
 * `auth.ts` builds the Better Auth instance at module load with dozens of
 * side-effecting dependencies, so running it inside a Vitest worker is fragile
 * and slow by precedent.
 *
 * `member-offboarding-wiring.test.ts` keeps its own variant, which closes over
 * the source instead of taking it as a parameter. It is untouched by the change
 * that created this module, and rewriting its call sites to adopt this
 * signature is churn in a file that had no reason to move. Worth folding in
 * next time that file is opened for its own reasons — until then, a change to
 * the slicing rule has to be made in two places, and this is the one that says so.
 *
 * The bound is the point of the helper, for the reason
 * `member-offboarding-wiring.test.ts` records: an earlier version sliced from
 * the start marker to the end of the file, which made "the call is inside this
 * hook" pass even when the call had merely been moved somewhere after it. A
 * negative control caught it; the assertion had been vacuous in exactly the
 * direction that matters.
 *
 * `end` is required to be STRICTLY after `start`, not merely non-negative. For
 * every input these suites reach the two are the same assertion —
 * `indexOf(endMarker, start + startMarker.length)` returns either -1, which
 * both forms reject, or a position already `startMarker.length` past `start`.
 * What the strict form adds is the invariant the slice rests on, stated rather
 * than inferred: an end at or before the start would hand back an empty string,
 * which satisfies every negative assertion made against it for the wrong
 * reason. Only a degenerate empty start marker can reach that, and this way it
 * fails loudly instead of silently.
 */

import { expect } from "vitest";

/**
 * The source between `startMarker` and the first occurrence of `endMarker`
 * after it. Both markers are required to exist, so a rename surfaces as a clear
 * assertion message instead of a vacuous pass.
 */
export function sliceBetween(
	source: string,
	startMarker: string,
	endMarker: string,
): string {
	const start = source.indexOf(startMarker);
	expect(
		start,
		`expected to find "${startMarker}" in auth.ts`,
	).toBeGreaterThanOrEqual(0);
	const end = source.indexOf(endMarker, start + startMarker.length);
	expect(
		end,
		`expected to find "${endMarker}" after "${startMarker}" in auth.ts`,
	).toBeGreaterThan(start);
	return source.slice(start, end);
}

/** The `databaseHooks: { ... }` block (up to the sibling `hooks:` key). */
export function databaseHooksBlock(source: string): string {
	return sliceBetween(source, "databaseHooks: {", "hooks: {");
}
