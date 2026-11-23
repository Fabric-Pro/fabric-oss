/**
 * Pure utilities for parsing and formatting feature/story content.
 *
 * The TipTap editor edits a single markdown document, but the database stores
 * two columns (`description` and `acceptanceCriteria`). These helpers convert
 * between the two shapes — preserving any rich content the LLM emits (e.g.
 * stage-analysis preambles like `# Passive Analysis: ...`) by treating only
 * an `Acceptance Criteria` heading as a section boundary.
 *
 * History note: an earlier version of `parseStoryContent` also split on
 * `## Description`, which silently discarded any markdown that appeared
 * BEFORE the first `## Description` heading. That broke the stage-enhance
 * flow (issue #737) because the LLM emits a stage-titled preamble above the
 * Description subsection. The current implementation only treats the
 * `Acceptance Criteria` heading as a marker; everything before it (including any
 * `## Description` heading the LLM may have emitted) is preserved verbatim
 * inside the description field.
 *
 * Data-loss note: the split is recovered on save purely from the presence of
 * an `Acceptance Criteria` heading. When an AI edit (or a manual one) renames,
 * removes, or demotes that heading, a naive re-split folds the criteria into
 * `description` and returns an empty `acceptanceCriteria` — which the save
 * layer then persists as `null`, silently wiping the column. `parseStoryContent`
 * matches the heading at any level to tolerate demotion; `resolveStoryContentForSave`
 * guards the remaining rename/removal cases so a populated column is never
 * destroyed by an edit that simply moved the heading.
 *
 * Data-loss note 2 (inline decoration): the same wipe fired for an edit that
 * did not touch the heading TEXT at all. Highlighting `## Acceptance Criteria`
 * in the editor makes TipTap store `## <mark data-color="#fef08a">Acceptance
 * Criteria</mark>`, and bolding it stores `## **Acceptance Criteria**` — both
 * still render as the heading, and both stop matching a regex anchored on
 * `#{1,6}\s+acceptance`. The user then sees the "kept your existing acceptance
 * criteria" warning toast on every save, and the criteria are re-appended as a
 * second section. Every line is therefore normalized through the shared
 * `stripInlineDecoration` before it is matched. That output is MATCH-ONLY: the
 * description and acceptance-criteria bodies below are built from the ORIGINAL
 * lines, never the normalized copy, which is deliberately lossy (see the
 * helper's docstring) and would corrupt the stored document.
 *
 * Byte-compatibility contract: the backend's `splitCleanSpec`
 * (`packages/utils/lib/clean-spec-content.ts`) must split any document exactly
 * the way `parseStoryContent` does — backend drafting splits model drafts into
 * description and acceptance criteria with it, and the editor must agree on
 * where that boundary falls.
 * The two files used to hold that contract as two hand-synced copies of the
 * heading regex, and it drifted (the editor was broadened to `#{1,6}` while the
 * backend stayed at `#{1,2}`). The normalization half of the contract is now a
 * shared import instead of a copy. The loop half is still hand-held and MUST
 * stay aligned: both loops test every line, drop EVERY acceptance heading
 * outside a code fence (the shared `fencedCodeLines` finds fences), and let
 * the first one open the acceptance part. On a document carrying two
 * acceptance headings — precisely the corrupted shape the decoration bug
 * produced — both sides therefore keep both bodies in `acceptanceCriteria`
 * with no heading left inside it; the loop comment below says why no heading
 * may survive there. The editor loop also notes where each section of the
 * acceptance part starts, for the save's repeated-section check; that changes
 * nothing about the split.
 */

import {
	fencedCodeLines,
	findHeadingLine,
	stripInlineDecoration,
} from "@repo/utils/markdown-heading";

interface StoryContentParts {
	description: string;
	acceptanceCriteria: string;
}

// Match an `Acceptance Criteria` heading at ANY level (`#`–`######`). Anchoring
// only to `#{1,2}` meant a common AI edit — demoting `## Acceptance Criteria`
// to `### Acceptance Criteria` — slipped past the split and folded the criteria
// into the description. Broadening the level is a strict superset of the prior
// `#{1,2}` match, so existing docs keep splitting exactly as before.
//
// Always tested against `stripInlineDecoration(line)`, never the raw line — see
// "Data-loss note 2" above. The pattern itself stays strict on purpose: the
// normalizer makes the heading TEXT visible, it does not loosen what counts as
// a heading, and its forgery guard keeps a body line like `` `## Acceptance
// Criteria` `` (inline code) from being promoted into a section boundary.
//
// Exported so `pending-decisions-preserve.ts` — which has to insert content
// immediately ABOVE the boundary this pattern defines — matches the boundary
// with the same regex instead of a third copy of it. The drift this file's
// header describes (the editor broadened to `#{1,6}` while the backend stayed
// at `#{1,2}`) is what copies of this pattern produce.
export const ACCEPTANCE_HEADING_RE = /^#{1,6}\s+acceptance/i;

// An H1/H2 heading below the acceptance heading opens a sibling section such as
// `## Release Planning`; H3+ headings group criteria inside the section. This
// is the boundary `boundAcceptanceCriteria` (`@repo/utils/acceptance-criteria`)
// uses for the criteria themselves.
const SECTION_HEADING_RE = /^\s{0,3}#{1,2}\s/;

// The "View in Fabric" back-link the server appends to the criteria column
// (`placeFabricBackLink`), as stored (HTML) and as the editor saves it
// (markdown). Bounded spans keep the match linear on long lines.
const FABRIC_BACK_LINK_LINE_RE =
	/^(?:<p><a href="[^"]{1,2000}">View in Fabric<\/a><\/p>|\[View in Fabric\]\([^)\s]{1,2000}\))$/;

function isFabricBackLink(line: string): boolean {
	return FABRIC_BACK_LINK_LINE_RE.test(line.trim());
}

function isAcceptanceHeading(line: string): boolean {
	return ACCEPTANCE_HEADING_RE.test(stripInlineDecoration(line));
}

/** Whether the markdown contains an `Acceptance Criteria` section heading. */
export function hasAcceptanceCriteriaHeading(markdown: string): boolean {
	return findHeadingLine(markdown, ACCEPTANCE_HEADING_RE) !== null;
}

/**
 * The split, plus whether a heading was actually found.
 *
 * `resolveStoryContentForSave` needs both, and this runs synchronously on the
 * editor save path: deriving "was there a heading?" from a second
 * `hasAcceptanceCriteriaHeading` pass would normalize every line twice, and
 * worst-case — a document whose heading was renamed or decorated away, which is
 * exactly the case this module exists to handle — both passes scan the whole
 * document.
 *
 * `acceptanceSections` holds the same acceptance lines, cut where each
 * acceptance heading and each later H1/H2 heading outside a code fence starts
 * a section, so a copy of the criteria can be recognized by the section it
 * fills.
 */
function splitOnAcceptanceHeading(markdown: string): StoryContentParts & {
	headingFound: boolean;
	acceptanceSections: string[][];
} {
	const descriptionLines: string[] = [];
	const acceptanceSections: string[][] = [];
	let section: string[] | null = null;
	const lines = markdown.split("\n");
	const code = fencedCodeLines(lines, isAcceptanceHeading);

	for (const [i, line] of lines.entries()) {
		// EVERY acceptance heading outside a code fence is dropped; the first
		// one opens the section. Mirrors `splitCleanSpec` — the two must agree
		// line for line. A heading-shaped line inside a fence is code: taking
		// it for the boundary cut the code block in two and dropped the line.
		//
		// Every line is tested, also once the section is open, and that is
		// load-bearing for the documents this parser exists to repair. A
		// document carrying TWO acceptance headings is the shape the
		// decorated-heading bug produced. Skipping the match once the section is
		// open would store the second heading inside `acceptanceCriteria`, and
		// `parseAcceptanceCriteria` stops at the first heading it meets — so the
		// QA traceability matrix, the test-case drafter's cap and the AC ref
		// picker would all silently see only the criteria above it while the
		// editor still showed every one.
		//
		// Dropping them all also makes the repair self-healing: `formatStoryContent`
		// re-emits exactly one heading, so a forked document collapses back to a
		// single section on its next save.
		if (!code[i] && isAcceptanceHeading(line)) {
			// Drop the section heading itself; it's re-added on render.
			section = [];
			acceptanceSections.push(section);
			continue;
		}
		if (section === null) {
			descriptionLines.push(line);
		} else if (!code[i] && SECTION_HEADING_RE.test(line)) {
			section = [line];
			acceptanceSections.push(section);
		} else {
			section.push(line);
		}
	}

	return {
		description: descriptionLines.join("\n").trim(),
		acceptanceCriteria: acceptanceSections.flat().join("\n").trim(),
		headingFound: acceptanceSections.length > 0,
		acceptanceSections,
	};
}

/**
 * A section's text as the comparison of two copies sees it: without a "View
 * in Fabric" back-link, which depends only on the column the server appended
 * it to, and without the whitespace a model varies between the two copies it
 * writes at create (`description` and `acceptanceCriteria` are separate
 * fields of one reply, so nothing makes them byte-identical): line endings,
 * trailing whitespace and the number of blank lines between paragraphs.
 * Whatever can change what the markdown shows counts: indentation, a hard
 * line break (`lineKey`) and every line of a fenced code block, blank ones
 * included.
 */
function sectionKey(section: string[]): string {
	const lines = section.filter((line) => !isFabricBackLink(line));
	const code = fencedCodeLines(lines, () => false);
	const keys = lines.map(lineKey);
	const kept = keys.filter(
		(key, i) => code[i] || key !== "" || (i > 0 && keys[i - 1] !== ""),
	);
	while (kept.at(-1) === "") {
		kept.pop();
	}
	return kept.join("\n");
}

/**
 * A line without its line ending and trailing whitespace, except that two
 * trailing spaces or more, a hard line break, stay as two.
 */
function lineKey(line: string): string {
	const text = line.endsWith("\r") ? line.slice(0, -1) : line;
	const trimmed = text.trimEnd();
	return trimmed !== "" && text.endsWith("  ") ? `${trimmed}  ` : trimmed;
}

/**
 * The acceptance criteria with each repeated section kept once.
 *
 * A story can carry its criteria twice, as a section of the description and in
 * the acceptance-criteria column, and the editor then shows both copies, each
 * below its own acceptance heading. A section that repeats an earlier one, as
 * `sectionKey` compares them, is dropped; a back-link it carried is kept. A
 * section that differs in any other character is kept.
 */
function withoutRepeatedSections(sections: string[][]): string {
	const seen = new Set<string>();
	const kept = sections.map((section) => {
		const key = sectionKey(section);
		if (key !== "" && seen.has(key)) {
			return section.filter(isFabricBackLink);
		}
		seen.add(key);
		return section;
	});
	return kept.flat().join("\n").trim();
}

export function parseStoryContent(markdown: string): StoryContentParts {
	const { description, acceptanceCriteria } =
		splitOnAcceptanceHeading(markdown);
	return { description, acceptanceCriteria };
}

/**
 * User-facing warning shown when `resolveStoryContentForSave` preserves the
 * acceptance criteria instead of wiping them (the edit removed the heading).
 */
export const ACCEPTANCE_CRITERIA_PRESERVED_MESSAGE =
	"Kept your existing acceptance criteria — the edit removed the “Acceptance Criteria” heading, so they weren’t overwritten. Add an “Acceptance Criteria” heading to edit them here.";

export interface ResolvedStoryContent extends StoryContentParts {
	/**
	 * True when the edit dropped the `Acceptance Criteria` heading while the
	 * story still had acceptance criteria, so the existing criteria were kept
	 * instead of being wiped. Callers should surface a warning to the user.
	 */
	acceptanceCriteriaPreserved: boolean;
}

/**
 * Resolve the `{ description, acceptanceCriteria }` to persist from an edited
 * combined markdown, guarding the destructive round-trip.
 *
 * The editor round-trips both columns through a single document; the split back
 * relies on an `Acceptance Criteria` heading being present. If an edit renames
 * or removes that heading, `parseStoryContent` returns an empty
 * `acceptanceCriteria` and folds the criteria into `description` — and the save
 * layer persists `null`, silently wiping a populated column (proven on staging:
 * an AI edit renaming the heading to `## Success Criteria` nulled the column).
 *
 * When the edited markdown has no `Acceptance Criteria` heading but the story
 * currently has acceptance criteria, this preserves the existing criteria
 * rather than destroying them, and flags `acceptanceCriteriaPreserved` so the
 * caller can warn the user (their edit likely renamed the heading). A genuine
 * clear — the heading is still present but its body is empty — is respected and
 * returns an empty string as before.
 *
 * A section the document repeats below a second acceptance heading is stored
 * once (see `withoutRepeatedSections`), so a story that carried its criteria
 * twice keeps one copy after its first save.
 */
export function resolveStoryContentForSave(
	markdown: string,
	existingAcceptanceCriteria: string | null | undefined,
): ResolvedStoryContent {
	const { description, acceptanceSections, headingFound } =
		splitOnAcceptanceHeading(markdown);
	const existing = (existingAcceptanceCriteria ?? "").trim();

	if (existing.length > 0 && !headingFound) {
		return {
			description,
			acceptanceCriteria: existing,
			acceptanceCriteriaPreserved: true,
		};
	}

	return {
		description,
		acceptanceCriteria: withoutRepeatedSections(acceptanceSections),
		acceptanceCriteriaPreserved: false,
	};
}

/** The criteria column without an acceptance heading on its first line. */
function withoutLeadingAcceptanceHeading(acceptanceCriteria: string): string {
	const [first = "", ...rest] = acceptanceCriteria.trimStart().split("\n");
	return isAcceptanceHeading(first)
		? rest.join("\n").trim()
		: acceptanceCriteria;
}

/**
 * Combine description and acceptance criteria into a single markdown document
 * for the editor. The description is rendered as-is (it may contain its own
 * heading structure from a stage-enhance prompt). Acceptance criteria, if
 * present, is rendered under a `## Acceptance Criteria` heading so
 * `parseStoryContent` can recover the split on save. A column that starts
 * with an acceptance heading of its own, as a story drafted at create can
 * store it, is shown under that one heading only.
 */
export function formatStoryContent(parts: StoryContentParts): string {
	const { description } = parts;
	const acceptanceCriteria = withoutLeadingAcceptanceHeading(
		parts.acceptanceCriteria,
	);
	if (acceptanceCriteria) {
		return description
			? `${description}\n\n## Acceptance Criteria\n\n${acceptanceCriteria}`
			: `## Acceptance Criteria\n\n${acceptanceCriteria}`;
	}
	return description;
}

/**
 * The editor document for a stored story.
 *
 * A story can carry its acceptance criteria twice: as a section of
 * `description` and in the acceptance-criteria column. An older revision
 * stored that shape, and a story the AI drafts at create still gets it, with
 * the server's "View in Fabric" back-link appended to the column copy. The
 * description's section is often followed by sibling sections such as
 * `## Release Planning`, which the column does not hold. When every section of
 * the column is already a section of the description, the description shows
 * the criteria once and is used as it is, followed by the column's back-link;
 * its next save moves them out of the description. A column section the
 * description lacks is shown, so no text is dropped, and the save then stores
 * a repeated section once (`resolveStoryContentForSave`).
 */
export function formatStoredStoryContent(parts: StoryContentParts): string {
	const embedded = splitOnAcceptanceHeading(parts.description);
	if (!embedded.headingFound) {
		return formatStoryContent(parts);
	}
	const shown = new Set(embedded.acceptanceSections.map(sectionKey));
	const column = splitOnAcceptanceHeading(
		formatStoryContent({
			description: "",
			acceptanceCriteria: parts.acceptanceCriteria,
		}),
	);
	const columnAlreadyShown = column.acceptanceSections.every((section) => {
		const key = sectionKey(section);
		return key === "" || shown.has(key);
	});
	if (!columnAlreadyShown) {
		return formatStoryContent(parts);
	}
	const backLinks = column.acceptanceSections
		.flat()
		.filter(isFabricBackLink)
		.map((line) => line.trim());
	return [parts.description, ...backLinks].join("\n\n");
}
