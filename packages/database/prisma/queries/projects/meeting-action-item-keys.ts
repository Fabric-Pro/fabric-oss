/**
 * Stable identity for a meeting action item, and the normalization it is built
 * on (#1902).
 *
 * Why this exists: `extractMeetingInsightsActivity` replaces a transcript's
 * action items with `deleteMany` + `createMany` on every extraction run, so
 * `ProjectMeetingActionItem.id` is NOT stable across re-extraction. A link table
 * holding that id as a foreign key would lose every user-curated link the next
 * time `MEETING_INSIGHTS_VERSION` is bumped (which re-extracts every meeting in
 * every project). Links therefore key on the item's normalized text instead.
 *
 * Lives in @repo/database because both @repo/temporal (the matching activity)
 * and @repo/api (the link procedures) depend on it, while neither depends on the
 * other — the same reason `buildDetectionText` / `hashDetectionText` live in
 * `duplicate-detection.ts`. Pure `node:crypto`, no DB or AI imports, so it stays
 * trivially unit-testable.
 */
import { createHash } from "node:crypto";

/**
 * Bumping this invalidates every stored item key at once, forcing a fresh match
 * run — the same escape hatch `DETECTION_VERSION` gives the duplicate scanner.
 * Existing links survive in the database but stop resolving to a visible action
 * item until the next matching run rewrites them.
 */
export const ACTION_ITEM_LINK_VERSION = 1;

/**
 * Canonical form of an action item's text.
 *
 * Deliberately identical to the rule `buildActionItemRows` uses to carry manual
 * completion across a re-extraction. If these two ever diverge, a re-extraction
 * would preserve an item's checkmark while silently dropping its links — so the
 * extraction activity imports THIS function rather than keeping its own copy.
 */
export function normalizeItemText(text: string): string {
	return text.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * The link table's half-key for one action item: sha256 over the
 * version-prefixed normalized text. Two items whose texts differ only in
 * whitespace or case share a key; any real rewording produces a new one (and
 * therefore reads as a different item, which is the accepted trade-off — see
 * the spec's D1).
 */
export function computeActionItemKey(text: string): string {
	return createHash("sha256")
		.update(`v${ACTION_ITEM_LINK_VERSION}\n${normalizeItemText(text)}`)
		.digest("hex");
}
