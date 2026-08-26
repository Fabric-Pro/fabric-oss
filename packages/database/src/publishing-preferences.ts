/**
 * Publishing Suite — the preferences fingerprint (Phase 1C-1b, spec § 7.1).
 *
 * A cycle records the preferences it ran with, so a later dispatch can tell
 * whether the settings that shaped a run have changed since. That comparison is
 * what buys a project exactly ONE reprocessing run after an edit — and what
 * stops a preference change from burying content forever.
 *
 * WHY THE HAZARD IS REAL, not theoretical: the generation workflow advances
 * `sourceCoverage` to the collection BOUNDARY, not to the newest collected item.
 * Narrowing `lookbackDays`, letting one cycle succeed, then widening it again
 * leaves everything in the skipped span permanently below the F7 freshness gate.
 * The window and the watermark are decoupled, so any setting that shapes
 * collection can bury content it did not collect.
 *
 * PURE. No Prisma, no I/O — it is imported by an activity and by a query module,
 * and it must stay cheap enough to call on every dispatch.
 */

import { createHash } from "node:crypto";
// The per-item rule lives in the CLIENT-SAFE module beside the bounds, because
// the settings form applies it too and cannot import this file (`node:crypto`).
// Three call sites, one function: form, oRPC boundary, and the snapshot below.
import { normalizePreferenceLabel } from "./publishing-post-types";
import { SUGGESTION_WINDOW_DAYS } from "./publishing-suite-schema";

export const MIN_LOOKBACK_DAYS = 1;
export const MAX_LOOKBACK_DAYS = 365;

// The preference bounds live in `./publishing-post-types`, which is
// client-safe (its only Prisma reference is `import type`, which the
// compiler erases) so the settings FORM can deep-import the very numbers
// this module's consumers validate against. Defining them here would have
// put them behind `node:crypto` and forced the web layer to hand-copy them.

/**
 * What a settings row offers. The four preference fields are OPTIONAL because
 * they do not exist yet — slice C-2 adds the columns, and when it does this
 * module needs no edit. Their absent form and their empty form normalize
 * identically, so an unconfigured project's hash does not move when C-2 ships.
 */
export interface PublishingPreferencesSource {
	lookbackDays?: number | null;
	preferredThemes?: readonly string[] | null;
	excludedKeywords?: readonly string[] | null;
	preferredPostTypes?: readonly string[] | null;
	strategicPriorities?: string | null;
}

/** The canonical form: only MEANING survives, never formatting. */
export interface PublishingPreferencesSnapshot {
	/** The EFFECTIVE window in days — never null, always already clamped. */
	lookbackDays: number;
	preferredThemes: string[];
	excludedKeywords: string[];
	preferredPostTypes: string[];
	strategicPriorities: string | null;
}

/**
 * `normalizePreferenceLabel` plus case folding — the keyword form, for lists whose
 * consumer MATCHES case-insensitively. Folding here is not a tidiness
 * preference: the exclusion filter lowercases before it compares, so two
 * spellings differing only in case genuinely produce the same run.
 */
function normalizeKeyword(value: unknown): string {
	return normalizePreferenceLabel(value).toLowerCase();
}

/**
 * Apply a per-element rule, drop blanks, dedupe, SORT.
 *
 * Sorting is safe only because the snapshot is what the consumer reads: C-2
 * renders the prompt clause from these arrays and C-3 filters from them, so the
 * order the hash sees is the order that runs. Sorting a list the consumer read
 * in a DIFFERENT order would be the same lie as folding case on a field the
 * consumer treats as case-sensitive.
 */
function normalizeList(
	value: unknown,
	normalize: (item: unknown) => string,
): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const seen = new Set<string>();
	for (const item of value) {
		const normalized = normalize(item);
		if (normalized) {
			seen.add(normalized);
		}
	}
	return [...seen].sort();
}

/**
 * The EFFECTIVE collection window, mirroring the workflow's own resolution
 * exactly (`publishing-suggestion-generation-workflow.ts`): absent or
 * non-finite falls back to the default, then clamp to 1..365.
 *
 * These two must agree. If the workflow's clamp changes and this does not, the
 * hash would report "unchanged" for a run whose window actually moved — the
 * recovery run would never fire and the content would stay buried. That is the
 * failure this whole module exists to prevent, so it is worth restating: the
 * hash is only as honest as its agreement with the code it describes.
 */
export function clampLookbackDays(value: number | null | undefined): number {
	if (value == null || !Number.isFinite(value)) {
		return SUGGESTION_WINDOW_DAYS;
	}
	return Math.min(MAX_LOOKBACK_DAYS, Math.max(MIN_LOOKBACK_DAYS, value));
}

export function buildPublishingPreferencesSnapshot(
	source: PublishingPreferencesSource,
): PublishingPreferencesSnapshot {
	return {
		lookbackDays: clampLookbackDays(source.lookbackDays),
		preferredThemes: normalizeList(
			source.preferredThemes,
			normalizePreferenceLabel,
		),
		excludedKeywords: normalizeList(
			source.excludedKeywords,
			normalizeKeyword,
		),
		preferredPostTypes: normalizeList(
			source.preferredPostTypes,
			normalizePreferenceLabel,
		),
		// TRIM ONLY. This is free-form prompt guidance, reproduced as written —
		// its line structure and its capitalisation are part of the instruction,
		// so collapsing either would let a real edit hash as unchanged and the
		// run under the new guidance would never happen.
		strategicPriorities:
			typeof source.strategicPriorities === "string"
				? source.strategicPriorities.trim() || null
				: null,
	};
}

/**
 * Stable 40-hex digest of the canonical snapshot.
 *
 * POSITIONAL, not key-ordered: a JSON object's key order is a property of how
 * it was built, and a future refactor that reorders the literal would silently
 * re-hash every project in the fleet — one recovery run each, for nothing. A
 * fixed array has no such degree of freedom.
 *
 * A NEW FIELD MUST BE APPENDED, never inserted. Inserting shifts every later
 * slot and invalidates every stored hash; appending only moves the hash for
 * projects that actually set the new field.
 */
export function computePublishingPreferencesHash(
	snapshot: PublishingPreferencesSnapshot,
): string {
	const canonical = JSON.stringify([
		snapshot.lookbackDays,
		snapshot.preferredThemes,
		snapshot.excludedKeywords,
		snapshot.preferredPostTypes,
		snapshot.strategicPriorities,
	]);
	return createHash("sha256").update(canonical).digest("hex").slice(0, 40);
}
