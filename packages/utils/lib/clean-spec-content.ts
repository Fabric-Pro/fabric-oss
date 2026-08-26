/**
 * Backend combine/split for the Clean Specification (Feature Maturation V2).
 *
 * The Clean Spec IS `UserStory.description` + `UserStory.acceptanceCriteria`.
 * The TipTap editor
 * round-trips the two columns through a single markdown document, splitting on
 * the `## Acceptance Criteria` heading. The Decision→Spec patch is produced
 * against — and applied to — that SAME combined document, so the block a patch's
 * `from` references is exactly what the PO sees in the Clean Spec tab.
 *
 * These helpers MUST stay byte-compatible with the editor's
 * `formatStoryContent` / `parseStoryContent`
 * (`apps/web/modules/saas/projects/lib/story-content.ts`). Deliberately NOT the
 * `## Description`-prefixed shape in `update-with-context.ts` — that surface
 * injects a heading the editor never stores, which would shift every patch
 * offset. Pure, no I/O.
 *
 * The byte-compatibility half that concerns inline decoration is no longer a
 * hand-synced copy: both sides call the shared `stripInlineDecoration` from
 * `@repo/utils/markdown-heading` before matching, so a heading the PO
 * highlighted (`## <mark data-color="#fef08a">Acceptance Criteria</mark>`) or
 * bolded (`## **Acceptance Criteria**`) in the editor splits here exactly as it
 * does there. The normalized string is used for the COMPARISON ONLY — it is
 * lossy by design — and both stored columns are assembled from the ORIGINAL
 * lines.
 *
 * The loop shape is still a hand-held copy and MUST stay aligned with
 * `parseStoryContent`: both guard with `!inAcceptanceCriteria` so the FIRST
 * matching heading wins. The editor used to test every line instead; on a
 * document with two acceptance headings — the shape the decoration bug produced
 * by re-appending the section on every save — that made the client drop both
 * headings and merge the bodies while this splitter kept the second heading as
 * literal text. The guards were aligned when the normalizer landed.
 */

import { stripInlineDecoration } from "./markdown-heading";

// Match an `Acceptance Criteria` heading at ANY level (`#`–`######`), exactly
// like the editor's `parseStoryContent`. This file's contract is to stay
// byte-compatible with that parser, and it had drifted: the editor was
// broadened to tolerate a demoted `### Acceptance Criteria` (a common AI edit)
// while this stayed at `#{1,2}`. The consequence was silent data loss on the
// patch path — `combineCleanSpec` always emits `##`, so a patch that DEMOTES
// the heading made this split miss the section, fold every criterion back into
// `description`, and persist an empty `acceptanceCriteria`. That empties the QA
// tab's traceability matrix and makes drafting refuse ("no acceptance
// criteria"). Broadening is a strict superset of `#{1,2}`, so every document
// that split correctly before still splits identically.
//
// The pattern is unchanged by the decoration fix — it is tested against
// `stripInlineDecoration(line)` rather than the raw line, which makes the
// heading text visible without loosening what counts as a heading. The helper's
// forgery guard keeps a body line like `` `## Acceptance Criteria` `` (inline
// code) from being promoted into a section boundary.
//
// Exported so the ONE definition serves every surface that has to recognise a
// rewritten acceptance heading. `update-with-context` keeps its own strict
// anchor for the document it builds itself and reaches for this only as a
// fallback; sharing the pattern is what stops a fourth copy drifting the way
// the first three did.
export const ACCEPTANCE_HEADING_RE = /^#{1,6}\s+acceptance/i;

/**
 * Combine description + acceptance criteria into the single markdown document
 * the Clean Spec is patched in. Description is emitted as-is (it may carry its
 * own heading structure from a stage-enhance prompt); acceptance criteria, when
 * present, is placed under a `## Acceptance Criteria` heading so `splitCleanSpec`
 * recovers the boundary.
 */
export function combineCleanSpec(
	description: string | null | undefined,
	acceptanceCriteria: string | null | undefined,
): string {
	const desc = (description ?? "").trim();
	const ac = (acceptanceCriteria ?? "").trim();
	if (ac) {
		return desc
			? `${desc}\n\n## Acceptance Criteria\n\n${ac}`
			: `## Acceptance Criteria\n\n${ac}`;
	}
	return desc;
}

/**
 * Split a patched Clean Spec document back into the two stored columns. Only
 * `## Acceptance Criteria` (or a single `#`) is treated as the section boundary;
 * everything before it — including any `## Description` heading the content may
 * carry — stays in `description` (mirrors the editor's parse, which fixed #737).
 */
export function splitCleanSpec(markdown: string): {
	description: string;
	acceptanceCriteria: string;
} {
	const lines = markdown.split("\n");
	const descriptionLines: string[] = [];
	const acceptanceCriteriaLines: string[] = [];
	let inAcceptanceCriteria = false;

	for (const line of lines) {
		// EVERY acceptance heading is dropped; the first opens the section.
		// `parseStoryContent` does the same, line for line.
		//
		// The guard sits on the state transition, not on the match. Skipping the
		// match once the section is open would leave a second acceptance heading
		// inside `acceptanceCriteria`, and `parseAcceptanceCriteria` stops at the
		// first heading it meets — emptying the QA traceability matrix of every
		// criterion below it. A two-heading document is exactly what the
		// decorated-heading bug produced, so that is the population this must be
		// right for. Dropping them all lets `combineCleanSpec` collapse a forked
		// document back to one section on its next write.
		if (ACCEPTANCE_HEADING_RE.test(stripInlineDecoration(line))) {
			inAcceptanceCriteria = true;
			continue; // Drop the heading itself; combineCleanSpec re-adds it.
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
	};
}

/**
 * Recover the description/criteria split from a generator that ignored it.
 *
 * The drafting schemas ask a model for `description` and `acceptanceCriteria`
 * as two separate fields, and nothing downstream checked that it complied. A
 * model handed a feature template whose own sections include "Acceptance
 * Criteria" routinely reproduces that heading INSIDE the description and
 * leaves the criteria field empty. The spec then looks complete in the editor —
 * which renders description verbatim — while every consumer that reads the
 * column sees a feature with no criteria at all: test-case drafting refuses,
 * the traceability matrix is empty, and a PM push sends no criteria. The story
 * stays that way until someone opens the editor and saves, because that save is
 * the only thing that has ever run the split.
 *
 * Applied where model output enters the system rather than at persistence: a
 * BUG's body is a single markdown document whose template legitimately carries
 * `## Acceptance Criteria (Fix Verification)`, and its criteria column is
 * deliberately left empty, so splitting every write would carve up every
 * drafted bug. Only a generator that was ASKED for two fields is normalized.
 *
 * A model that DID comply is never second-guessed — a non-empty
 * `acceptanceCriteria` is returned untouched, whatever the description holds.
 *
 * Externally-authored bodies are deliberately NOT run through this. A PM
 * ticket imported from Jira/ADO/GitLab may carry an "Acceptance Criteria"
 * heading, but that is the external tool's convention, not this system's
 * section anchor, and splitting it has consequences the import cannot consent
 * to: the outbound push recombines with `**Acceptance Criteria:**` rather than
 * a heading (`story-sync.ts`), so relocating the text rewrites the body pushed
 * back to the tracker on the next sync — a spurious external edit, against a
 * conflict baseline. Azure DevOps bodies are stored as HTML besides, where a
 * markdown-heading split is inert. Ingestion semantics are a product decision;
 * this helper only holds generators that were ASKED for two fields.
 */
export function separateEmbeddedAcceptanceCriteria<
	T extends { description: string; acceptanceCriteria?: string },
>(drafted: T): T {
	if (drafted.acceptanceCriteria?.trim()) {
		return drafted;
	}
	const split = splitCleanSpec(drafted.description ?? "");
	if (!split.acceptanceCriteria) {
		return drafted;
	}
	return {
		...drafted,
		description: split.description,
		acceptanceCriteria: split.acceptanceCriteria,
	};
}

/**
 * Whether {@link separateEmbeddedAcceptanceCriteria} actually moved anything.
 *
 * The recovery is a no-op whenever the model fills the two fields correctly, so
 * a call site that does not check this cannot tell "never needed" apart from
 * "silently not working" — the pair looks identical from outside, and the only
 * symptom of the second is a feature whose criteria column is empty for reasons
 * nobody can reconstruct afterwards. Log on this so the model's actual
 * behaviour is a number somebody can look up rather than an assumption.
 */
export function recoveredAcceptanceCriteria(
	before: { acceptanceCriteria?: string },
	after: { acceptanceCriteria?: string },
): boolean {
	return (
		!before.acceptanceCriteria?.trim() && !!after.acceptanceCriteria?.trim()
	);
}
