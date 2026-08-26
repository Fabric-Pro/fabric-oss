import { normalizeForComparison } from "@repo/utils/normalize-for-comparison";

/**
 * True when the AI-proposed content is a normalized no-op against the current
 * document baseline. Uses the same canonical comparator the save layer uses to
 * decide "no real change", so client, server, and save layer all agree — an
 * actionable Confirm affordance is never presented for content that would save
 * as a no-op.
 */
export function isNoOpProposedContent(
	proposedContent: string | null | undefined,
	baseline: string,
): boolean {
	return (
		normalizeForComparison(proposedContent ?? "") ===
		normalizeForComparison(baseline)
	);
}

/**
 * True when a markdown extraction produced the empty string while the document
 * baseline is non-empty.
 *
 * As of Fizzy #1987, `getEditorMarkdownForSave` returns `null` (not `""`) on
 * internal failure — callers must guard for `null` themselves before ever
 * reaching this helper, since `null` means "could not serialize, refuse to
 * save" and is not a legitimate value to compare here. This helper instead
 * covers the remaining case where the extraction genuinely succeeded and
 * produced `""` (e.g. the user deleted everything) against a non-empty
 * baseline — a legitimate read that would still wipe the document and bump
 * the version if saved unguarded. A confirm/accept path must never persist
 * this either.
 */
export function isEmptyExtractionAgainstBaseline(
	extracted: string,
	baseline: string,
): boolean {
	return extracted === "" && baseline !== "";
}
