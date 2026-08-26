/**
 * Structure-preservation guard utilities for AI work-item edits.
 *
 * Pure helpers shared by the structure-preserving update path
 * (`reanalyze-body-by-kind.ts`, wired into the AI Update / AI Backlog apply
 * pipeline) and available to the bug "Re-evaluate" flow. No I/O; the only
 * imports are pure string helpers from `@repo/utils/markdown-heading`.
 *
 * The contract these enforce: when AI re-writes an existing work item's body it
 * must PRESERVE the existing section structure and make only targeted edits. If
 * the model returns something that would destroy that structure (drop a bug's
 * canonical diagnostic sections, collapse the body, or return nothing), the
 * caller treats it as a fallback and keeps the existing body unchanged
 * ("safe-hold"). These functions are the detection + section-splice primitives
 * behind that policy.
 *
 * Two groups of rules live here and they are NOT interchangeable:
 *  - the SECTION-SIGNATURE rules inside `detectDestructiveRewrite`, which decide
 *    what to carry forward by matching heading names, and
 *  - the KIND-AGNOSTIC content floor (`detectContentFloorBreach`), which asks
 *    only whether content survived.
 * A path that deliberately reshapes a body into another kind's template — the
 * type-conversion regeneration, Fizzy #2048 — runs the second and never the
 * first. See `detectContentFloorBreach` for why.
 */

import {
	findSectionEndIdx,
	stripInlineDecoration,
} from "@repo/utils/markdown-heading";

/**
 * Canonical bug-card section headers (from the `bug_creation` prompt's OUTPUT
 * FORMAT). Used as the structural signature of a bug body — if an existing bug
 * had several of these and a rewrite drops ALL of them, the rewrite reformatted
 * the bug away from its bug structure (the exact regression this feature fixes).
 *
 * Matched case-insensitively, anywhere in a markdown heading line, so wording
 * drift ("Steps to Reproduce" vs "Steps To Reproduce") still counts.
 */
export const BUG_SIGNATURE_SECTIONS = [
	"Steps to Reproduce",
	"Expected Result",
	"Actual Result",
	"Environment",
	"Impact",
	"Root Cause",
] as const;

/**
 * Feature-only section headers that must NOT appear when re-writing a BUG. Their
 * presence in a rewritten bug is a cross-type reformat signal (bug → feature).
 */
export const FEATURE_ONLY_SECTIONS = [
	"Feature Narrative",
	"User Story",
	"Benefit Hypothesis",
] as const;

/** Count how many of `needles` appear as part of a markdown heading line. */
function countHeadingMatches(
	markdown: string,
	needles: readonly string[],
): number {
	if (!markdown) {
		return 0;
	}
	const headingLines = markdown
		.split("\n")
		.filter((line) => /^#{1,6}\s/.test(line.trim()))
		.map((line) => line.trim().toLowerCase());
	let count = 0;
	for (const needle of needles) {
		const n = needle.toLowerCase();
		if (headingLines.some((line) => line.includes(n))) {
			count++;
		}
	}
	return count;
}

/** True when `markdown` is empty or whitespace-only. */
function isBlank(markdown: string | null | undefined): boolean {
	return !markdown || markdown.trim().length === 0;
}

/**
 * The kind-agnostic half of `detectDestructiveRewrite`'s reason vocabulary:
 * neither of these two decides anything by matching section NAMES, which is why
 * they are the only rules the conversion path runs (`detectContentFloorBreach`).
 */
export type ContentFloorReason = "empty_output" | "body_collapsed";

export interface DestructiveRewriteResult {
	destructive: boolean;
	/** Short machine reason — surfaced in logs/audit, not shown to end users. */
	reason?:
		| ContentFloorReason
		| "bug_sections_dropped"
		| "feature_sections_dropped"
		| "cross_type_reformat";
}

export interface ContentFloorResult {
	belowFloor: boolean;
	/** Short machine reason — surfaced in logs/audit, not shown to end users. */
	reason?: ContentFloorReason;
}

/**
 * The KIND-AGNOSTIC content floor: did this rewrite empty or collapse the body?
 *
 * Split out of `detectDestructiveRewrite` for the type-conversion regeneration
 * path (Fizzy #2048). That path deliberately reshapes a body from one kind's
 * template into the other's, so the section-signature rules
 * (`bug_sections_dropped` / `feature_sections_dropped` / `cross_type_reformat`)
 * must not run over it — a bug body rewritten into feature shape drops every bug
 * section BY DESIGN, and running those rules there would refuse every legitimate
 * conversion. These two rules carry no such assumption: they only ask whether
 * content survived at all, which every unattended write still has to answer.
 *
 * `detectDestructiveRewrite` calls this first, so the two stay in lockstep and
 * there is one implementation of the floor rather than two that can drift.
 *
 * Same conservative shape as before the split:
 * - a blank candidate against prior content is `empty_output`;
 * - a blank prior body has nothing to lose, so nothing trips;
 * - a body over 600 chars rewritten below 45% of its length is `body_collapsed`
 *   (the floor avoids flagging short cards where legitimate tightening swings
 *   the ratio).
 */
export function detectContentFloorBreach({
	existing,
	candidate,
}: {
	existing: string | null | undefined;
	candidate: string | null | undefined;
}): ContentFloorResult {
	// An empty rewrite is always destructive when there was prior content.
	if (isBlank(candidate)) {
		return isBlank(existing)
			? { belowFloor: false }
			: { belowFloor: true, reason: "empty_output" };
	}
	if (isBlank(existing)) {
		// No prior content to preserve — nothing to destroy.
		return { belowFloor: false };
	}

	const existingText = existing as string;
	const candidateText = candidate as string;

	// Gross body collapse: a rewrite that drops below 45% of the original length
	// for a non-trivial body almost always lost content rather than making a
	// targeted edit. The 600-char floor avoids flagging short cards where a
	// legitimate tightening can swing the ratio.
	if (
		existingText.length > 600 &&
		candidateText.length < existingText.length * 0.45
	) {
		return { belowFloor: true, reason: "body_collapsed" };
	}

	return { belowFloor: false };
}

/**
 * Decide whether `candidate` is a destructive rewrite of `existing` for a work
 * item of `kind`. Conservative by design — it should fire only on clear
 * structure loss, never on legitimate targeted edits (which keep length roughly
 * stable and retain the section signature). Removing a single section (an
 * allowed, justified edit) does NOT trip it; dropping the entire structural
 * signature does.
 */
export function detectDestructiveRewrite({
	existing,
	candidate,
	kind,
}: {
	existing: string | null | undefined;
	candidate: string | null | undefined;
	kind: "BUG" | "FEATURE";
}): DestructiveRewriteResult {
	// Kind-agnostic rules first, exactly as they ran before they were extracted:
	// empty output, then gross collapse.
	const floor = detectContentFloorBreach({ existing, candidate });
	if (floor.belowFloor) {
		return { destructive: true, reason: floor.reason };
	}
	// The section rules below need BOTH sides. A blank on either side already
	// resolved above (blank candidate → empty_output unless the prior body was
	// blank too; blank prior body → nothing to destroy), so this preserves the
	// original short-circuit rather than adding one.
	if (isBlank(candidate) || isBlank(existing)) {
		return { destructive: false };
	}

	const existingText = existing as string;
	const candidateText = candidate as string;

	if (kind === "BUG") {
		// Bug → lost all of its diagnostic-section signature.
		const existingSig = countHeadingMatches(
			existingText,
			BUG_SIGNATURE_SECTIONS,
		);
		const candidateSig = countHeadingMatches(
			candidateText,
			BUG_SIGNATURE_SECTIONS,
		);
		if (existingSig >= 2 && candidateSig === 0) {
			return { destructive: true, reason: "bug_sections_dropped" };
		}
		// Bug → reformatted with feature-only sections.
		if (countHeadingMatches(candidateText, FEATURE_ONLY_SECTIONS) > 0) {
			return { destructive: true, reason: "cross_type_reformat" };
		}
	}

	if (kind === "FEATURE") {
		// Feature → lost all of its narrative signature. Mirrors the BUG rule
		// above: a targeted edit keeps the signature, a reformat drops it.
		const existingSig = countHeadingMatches(
			existingText,
			FEATURE_ONLY_SECTIONS,
		);
		const candidateSig = countHeadingMatches(
			candidateText,
			FEATURE_ONLY_SECTIONS,
		);
		if (existingSig >= 2 && candidateSig === 0) {
			return { destructive: true, reason: "feature_sections_dropped" };
		}
		// Deliberately NO mirror of the cross-type check here. `countHeadingMatches`
		// matches by substring, and BUG_SIGNATURE_SECTIONS carries "Impact" — a
		// feature legitimately headed "Business Impact" or "Impact Assessment"
		// would score a match and be refused on every edit. The bug direction is
		// safe because FEATURE_ONLY_SECTIONS are distinctive multi-word phrases
		// ("Feature Narrative", "Benefit Hypothesis") that a bug body has no
		// innocent reason to contain.
	}

	return { destructive: false };
}

/**
 * Index of the `##`/`#` heading line whose text equals `header`
 * (case-insensitive), or `-1`.
 *
 * Both sides run through `stripInlineDecoration` so the guard survives the
 * editor's inline decoration. Highlighting the heading stores
 * `## <mark data-color="#fef08a">Original Description from User (Do Not
 * Modify)</mark>`; bolding it stores `## **Original Description …**`. Against the
 * raw line both miss, `extractSectionBody` returns `null`, and the caller's
 * verbatim-preserve guard silently FAILS OPEN — the model's rewrite of the
 * reporter's own words is accepted and nothing notices. That is a data-integrity
 * failure, not a formatting one.
 *
 * `header` is normalized too, not just the document line: normalizing one side
 * only would break a `header` argument that legitimately contains `_` or `*`
 * against an identically-spelled undecorated heading.
 *
 * The normalized strings are used for the COMPARISON ONLY — the transform is
 * lossy by design. Both callers slice and re-join the ORIGINAL lines.
 */
function findSectionHeaderIdx(lines: string[], header: string): number {
	const target = stripInlineDecoration(header).toLowerCase();
	return lines.findIndex((line) => {
		const t = stripInlineDecoration(line);
		if (!/^#{1,2}\s/.test(t)) {
			return false;
		}
		return (
			t
				.replace(/^#{1,2}\s+/, "")
				.trim()
				.toLowerCase() === target
		);
	});
}

/**
 * Extract the markdown body under a `##`/`#` heading whose text equals `header`
 * (case-insensitive), up to the next same-or-higher-level heading or EOF.
 * Returns null when the header isn't present. Trimmed so trivial reformatting
 * (blank lines) doesn't read as a change.
 *
 * Generalized from the bug "Original Description (Do Not Modify)" guard.
 */
export function extractSectionBody(
	markdown: string,
	header: string,
): string | null {
	const lines = markdown.split("\n");
	const headerIdx = findSectionHeaderIdx(lines, header);
	if (headerIdx === -1) {
		return null;
	}
	return lines
		.slice(headerIdx + 1, findSectionEndIdx(lines, headerIdx))
		.join("\n")
		.trim();
}

/**
 * Replace the body of the section under `header` in `markdown` with `body`,
 * keeping the heading line — carried over UNCHANGED, decoration and all; only
 * the body between the boundaries is replaced. No-op (returns `markdown`) when
 * the header is absent. Generalized from the bug Original-Description splice.
 */
export function spliceSectionBody(
	markdown: string,
	header: string,
	body: string,
): string {
	const lines = markdown.split("\n");
	const headerIdx = findSectionHeaderIdx(lines, header);
	if (headerIdx === -1) {
		return markdown;
	}
	const before = lines.slice(0, headerIdx + 1);
	const after = lines.slice(findSectionEndIdx(lines, headerIdx));
	return [...before, "", body, "", ...after].join("\n");
}
