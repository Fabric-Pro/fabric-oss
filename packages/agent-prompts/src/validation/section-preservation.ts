/**
 * Section-preservation guard.
 *
 * The document/feature AI editor lets the model rewrite a whole document
 * (`write_document_local`) or patch it (`apply_document_patches`). Under heavy
 * context, models occasionally DROP a whole section or COLLAPSE its body to a
 * one-line stub while leaving the rest of the document intact — e.g. gutting a
 * populated `## Acceptance Criteria` section down to "Enable Initiatives in
 * Settings". The existing guards miss this: markdown-structure validation only
 * checks well-formedness, and the patch content-loss guard only fires when the
 * WHOLE document drops below 20% of its size. A single gutted section keeps the
 * whole-document size well above that floor, so the corruption is accepted.
 *
 * `detectDroppedSections` compares the baseline document's sections against the
 * proposed result and reports sections that were removed or gutted WITHOUT the
 * content resurfacing elsewhere (so a legitimate rename/move/reorganize is not
 * flagged). The chat node uses it to reject-and-retry, nudging the model to
 * preserve the section, and accepts after the retry budget is spent so a
 * genuinely-intended removal is never permanently blocked.
 */

import { parseHeadings } from "./markdown-parser";

export interface DroppedSection {
	/** Heading text (without leading `#`s), e.g. "Acceptance Criteria". */
	heading: string;
	level: number;
	reason: "removed" | "gutted";
	baselineChars: number;
	resultChars: number;
}

export interface DetectDroppedSectionsOptions {
	/**
	 * Only guard sections whose baseline body has at least this many characters.
	 * Small sections aren't worth protecting and inflate false positives.
	 */
	minSubstantialChars?: number;
	/**
	 * A section is "gutted" when its result body shrinks below this fraction of
	 * its baseline body size.
	 */
	gutRatio?: number;
	/**
	 * Fraction of a baseline section's distinctive words that must survive
	 * ANYWHERE in the result for the content to count as "moved" (not lost).
	 */
	contentPresenceThreshold?: number;
}

const DEFAULTS = {
	minSubstantialChars: 300,
	gutRatio: 0.2,
	contentPresenceThreshold: 0.6,
} as const;

interface SectionSpan {
	heading: string;
	level: number;
	/** Section body (excluding the heading line), through the section's span. */
	body: string;
}

/**
 * Split markdown into sections keyed by heading. A section spans from its
 * heading to the line before the next heading of the SAME OR SHALLOWER level
 * (or end of document), so a parent section includes its subsections' bodies.
 */
function toSectionSpans(markdown: string): SectionSpan[] {
	const lines = markdown.split("\n");
	const headings = parseHeadings(markdown);
	const spans: SectionSpan[] = [];

	for (let i = 0; i < headings.length; i++) {
		const h = headings[i];
		// The section ends at the next heading of equal-or-shallower level.
		let endLine = lines.length; // 1-indexed exclusive-ish; slice handles it
		for (let j = i + 1; j < headings.length; j++) {
			if (headings[j].level <= h.level) {
				endLine = headings[j].line - 1;
				break;
			}
		}
		// Body excludes the heading line itself (h.line is 1-indexed).
		const body = lines.slice(h.line, endLine).join("\n").trim();
		spans.push({ heading: h.text.trim(), level: h.level, body });
	}

	return spans;
}

/** Distinctive words (>= 4 chars, alphanumeric, lowercased) for overlap checks. */
function distinctiveWords(text: string): Set<string> {
	const out = new Set<string>();
	const matches = text.toLowerCase().match(/[a-z0-9]{4,}/g);
	if (matches) {
		for (const w of matches) {
			out.add(w);
		}
	}
	return out;
}

/** Fraction of `needle`'s distinctive words that appear in `haystackWords`. */
function contentSurvival(needle: string, haystackWords: Set<string>): number {
	const words = distinctiveWords(needle);
	if (words.size === 0) {
		return 1; // nothing distinctive to lose — treat as preserved
	}
	let found = 0;
	for (const w of words) {
		if (haystackWords.has(w)) {
			found++;
		}
	}
	return found / words.size;
}

/** Normalise a heading for matching (case/spacing-insensitive). */
function normHeading(text: string): string {
	return text.toLowerCase().replace(/\s+/g, " ").trim();
}

export function detectDroppedSections(
	baseline: string,
	result: string,
	options: DetectDroppedSectionsOptions = {},
): DroppedSection[] {
	const minSubstantialChars =
		options.minSubstantialChars ?? DEFAULTS.minSubstantialChars;
	const gutRatio = options.gutRatio ?? DEFAULTS.gutRatio;
	const contentPresenceThreshold =
		options.contentPresenceThreshold ?? DEFAULTS.contentPresenceThreshold;

	if (!baseline.trim() || !result.trim()) {
		return [];
	}

	const allBaselineSpans = toSectionSpans(baseline);
	const resultSpans = toSectionSpans(result);
	if (allBaselineSpans.length === 0) {
		return [];
	}

	// A sole top-level `#` title (e.g. a prepended story/document title) wraps
	// the whole document, so guarding it is coarse — any broad edit flags the
	// whole doc instead of naming the section that actually collapsed. When such
	// a title exists alongside deeper content sections, guard the content
	// sections and skip the title wrapper.
	const h1Count = allBaselineSpans.filter((s) => s.level === 1).length;
	const hasDeeperSections = allBaselineSpans.some((s) => s.level > 1);
	const baselineSpans =
		h1Count === 1 && hasDeeperSections
			? allBaselineSpans.filter((s) => s.level !== 1)
			: allBaselineSpans;

	const resultByHeading = new Map<string, SectionSpan>();
	for (const s of resultSpans) {
		// Keep the first occurrence for a given heading text.
		const key = normHeading(s.heading);
		if (!resultByHeading.has(key)) {
			resultByHeading.set(key, s);
		}
	}
	const resultWords = distinctiveWords(result);

	const flagged: DroppedSection[] = [];

	for (const b of baselineSpans) {
		if (b.body.length < minSubstantialChars) {
			continue;
		}
		const match = resultByHeading.get(normHeading(b.heading));
		if (!match) {
			// Heading is gone. If its content moved elsewhere (rename/move),
			// don't flag; if it's genuinely lost, it was removed.
			if (
				contentSurvival(b.body, resultWords) < contentPresenceThreshold
			) {
				flagged.push({
					heading: b.heading,
					level: b.level,
					reason: "removed",
					baselineChars: b.body.length,
					resultChars: 0,
				});
			}
			continue;
		}
		// Heading kept — check for a collapsed body.
		if (
			match.body.length < b.body.length * gutRatio &&
			contentSurvival(b.body, resultWords) < contentPresenceThreshold
		) {
			flagged.push({
				heading: b.heading,
				level: b.level,
				reason: "gutted",
				baselineChars: b.body.length,
				resultChars: match.body.length,
			});
		}
	}

	// De-noise nested flags: when a shallower flagged section already covers a
	// deeper flagged one (e.g. a whole `##` section gutted also collapses its
	// `###` subsections), keep only the outermost. Containment is approximated
	// by baseline heading order + level: a deeper heading that follows a
	// shallower flagged one is subsumed by it.
	if (flagged.length <= 1) {
		return flagged;
	}
	const baselineOrder = baselineSpans.map((s) => normHeading(s.heading));
	const kept: DroppedSection[] = [];
	for (const f of flagged) {
		const idx = baselineOrder.indexOf(normHeading(f.heading));
		const covered = kept.some((k) => {
			const kIdx = baselineOrder.indexOf(normHeading(k.heading));
			return kIdx >= 0 && kIdx < idx && k.level < f.level;
		});
		if (!covered) {
			kept.push(f);
		}
	}
	return kept;
}
