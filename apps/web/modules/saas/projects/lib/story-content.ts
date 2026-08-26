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
 * (`packages/api/modules/projects/lib/clean-spec-content.ts`) must split any
 * document exactly the way `parseStoryContent` does — the Decision→Spec patch
 * path applies offsets computed against the combined document the editor shows.
 * The two files used to hold that contract as two hand-synced copies of the
 * heading regex, and it drifted (the editor was broadened to `#{1,6}` while the
 * backend stayed at `#{1,2}`). The normalization half of the contract is now a
 * shared import instead of a copy. The loop half is still hand-held and MUST
 * stay aligned: both loops guard with `!inAcceptanceCriteria`, so the FIRST
 * matching heading wins. That guard is load-bearing on a document carrying two
 * acceptance headings — precisely the corrupted shape the decoration bug
 * produced — where testing every line would drop both headings and merge the
 * two bodies while the backend kept the second as literal text.
 */

import { stripInlineDecoration } from "@repo/utils/markdown-heading";

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

/** Whether the markdown contains an `Acceptance Criteria` section heading. */
export function hasAcceptanceCriteriaHeading(markdown: string): boolean {
	return markdown
		.split("\n")
		.some((line) =>
			ACCEPTANCE_HEADING_RE.test(stripInlineDecoration(line)),
		);
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
 */
function splitOnAcceptanceHeading(
	markdown: string,
): StoryContentParts & { headingFound: boolean } {
	const descriptionLines: string[] = [];
	const acceptanceCriteriaLines: string[] = [];
	let inAcceptanceCriteria = false;

	for (const line of markdown.split("\n")) {
		// EVERY acceptance heading is dropped; the first one opens the section.
		// Mirrors `splitCleanSpec` — the two must agree line for line.
		//
		// The guard is on the state transition, not on the match, and that
		// distinction is load-bearing for the documents this parser exists to
		// repair. A document carrying TWO acceptance headings is the shape the
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
		if (ACCEPTANCE_HEADING_RE.test(stripInlineDecoration(line))) {
			inAcceptanceCriteria = true;
			continue; // Drop the section heading itself; it's re-added on render.
		}
		if (inAcceptanceCriteria) {
			acceptanceCriteriaLines.push(line);
		} else {
			descriptionLines.push(line);
		}
	}

	return {
		description: descriptionLines.join("\n").trim(),
		acceptanceCriteria: acceptanceCriteriaLines.join("\n").trim(),
		headingFound: inAcceptanceCriteria,
	};
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
 */
export function resolveStoryContentForSave(
	markdown: string,
	existingAcceptanceCriteria: string | null | undefined,
): ResolvedStoryContent {
	const { description, acceptanceCriteria, headingFound } =
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
		acceptanceCriteria,
		acceptanceCriteriaPreserved: false,
	};
}

/**
 * Combine description and acceptance criteria into a single markdown document
 * for the editor. The description is rendered as-is (it may contain its own
 * heading structure from a stage-enhance prompt). Acceptance criteria, if
 * present, is rendered under a `## Acceptance Criteria` heading so
 * `parseStoryContent` can recover the split on save.
 */
export function formatStoryContent(parts: StoryContentParts): string {
	const { description, acceptanceCriteria } = parts;
	if (acceptanceCriteria) {
		return description
			? `${description}\n\n## Acceptance Criteria\n\n${acceptanceCriteria}`
			: `## Acceptance Criteria\n\n${acceptanceCriteria}`;
	}
	return description;
}
