/**
 * Diff-summary for the confirm-time review of a topic's Planning & Analysis.
 *
 * The Publishing Suite's assistant rewrites the analysis prose and the author
 * confirms it against an inline diff (`PlanningAnalysisEditor`'s `diffReview`).
 * This module turns that before→after pair into a short, section-tagged change
 * summary so the author reads ~4 lines instead of scanning the whole diff —
 * the parity this feature exists to close with Feature Maturation V2's
 * `summarize-spec-changes.ts`.
 *
 * Read-only: never writes the analysis, never mints a revision, so it cannot
 * race the author's own Save — the rule Fizzy #1929 bought and the one
 * `PlanningAnalysisEditor` is built around.
 *
 * ## Why this is a fork of `summarize-spec-changes.ts`, not a call into it
 *
 * The mechanics are the same four lines (short-circuit, resolve a model, one
 * `generateObject`, trim). The PROMPT is not, and the prompt is the whole
 * feature. A feature specification is free-form, so its summarizer can only ask
 * for "the affected section" and hope; a planning analysis has a fixed,
 * knowable set of headings, so this one can name them — see below. The feature
 * key differs too (`publishing-suite`, not `maturation`), which is what keeps
 * the AI-usage dashboards able to add this call up with the rest of the suite.
 *
 * Parameterising the maturation module over a prompt builder was the other
 * option and was rejected: its own test asserts a byte-for-byte prompt
 * assembly, so the shared seam would be one FMv2 regression away from the
 * first person who edits either prompt.
 *
 * No `getLockedAttachmentRulesClause()` here, deliberately, though its FMv2
 * counterpart carries one. That clause stops a spec digest fabricating
 * attachment contents; a planning analysis has no attachment surface at all
 * (`publishing-planning-prompt.ts` does not mention one), so importing it would
 * be a rule about nothing.
 */

import { generateObject, getAIModelWithMetadata } from "@repo/ai";
import { getProjectFunctionTagClause } from "@repo/ai/lib/function-tag-context";
import { stripInlineDecoration } from "@repo/utils/markdown-heading";
import {
	humanizeKey,
	PROSE_FIELDS,
} from "@repo/utils/publishing-analysis-prose";
import { zodSchema } from "ai";
import { z } from "zod";

const AnalysisChangeSummarySchema = z.object({
	changeSummary: z
		.array(z.string())
		.describe(
			"A reviewer-facing list of the substantive changes from the previous planning analysis to the new one — 3 to 8 bullets, one per meaningful change, each ONE sentence prefixed with the affected section heading and an em-dash, e.g. 'Topic angle — narrowed the piece to the migration itself'. The prefix must be one of the section headings named in the prompt, copied verbatim. Give additions EQUAL weight to removals — never a removal-only summary when the new version also adds content. Omit trivial wording/formatting tweaks. Empty array if nothing substantive changed.",
		),
});

/**
 * The headings `renderAnalysisProse` emits for an un-edited analysis, derived
 * rather than written down: `PROSE_FIELDS` is the schema's own prose key set
 * and `humanizeKey` is the single definition of how one becomes a heading, so
 * a schema field added or renamed reaches this list on the same commit.
 *
 * Do NOT hand-copy these strings, and in particular do not take them from
 * `planning-analysis-content.ts`'s `PROSE_FIELDS` labels in `apps/web`. That
 * list is a DIFFERENT list for a different job (labelling the data half), and
 * it already disagrees: it labels `whyWorthPublishing` "Why this is worth
 * publishing" where the document actually says "Why worth publishing". The
 * click handler matches a bullet's prefix with `startsWith` against the
 * heading, so the longer label never matches the shorter heading and every
 * bullet under that section would be silently dead.
 *
 * This is the FALLBACK, not the primary source — see `collectAnalysisSections`.
 */
export const PLANNING_ANALYSIS_SECTIONS: readonly string[] =
	PROSE_FIELDS.map(humanizeKey);

/** A Markdown ATX heading, after decoration has been stripped off the line. */
const HEADING_RE = /^#{1,6}\s+(.+)$/;

/**
 * Bounds on the vocabulary handed to the model. The canonical set is eight;
 * the slack is for an author who added their own headings. Both caps exist to
 * stop a pathological document (a pasted table of contents, one enormous
 * heading line) from crowding the two versions out of the prompt.
 */
const MAX_SECTIONS = 24;
const MAX_SECTION_LENGTH = 120;

/** Every ATX heading in one Markdown document, in document order. */
function headingsIn(markdown: string): string[] {
	const out: string[] = [];
	for (const line of markdown.split("\n")) {
		// Per-line, and normalized first: an author who bolds or highlights a
		// heading in the editor emits `### **Risks**` / `### <mark …>Risks</mark>`,
		// and a raw match would stop seeing the section the moment they did.
		// `stripInlineDecoration` is match-only and lossy, but nothing here is
		// stored — the extracted text only ever reaches a prompt.
		const text = HEADING_RE.exec(stripInlineDecoration(line))?.[1]?.trim();
		if (text) {
			out.push(text);
		}
	}
	return out;
}

/**
 * The section vocabulary a bullet's prefix may name.
 *
 * Taken from the two documents themselves, not from the schema, because the
 * schema is not what the click handler matches against. `scrollDiffToSection`
 * searches the EDITOR's DOM for a heading starting with the bullet's prefix,
 * and under review that editor is seeded with `diffPartialText(baseline,
 * proposed)` — so the only strings that can ever match are headings present in
 * one of these two texts.
 *
 * The union of both, not just `after`: a removal bullet legitimately names a
 * section the new version dropped, and the diff document still renders that
 * heading inside a deletion mark, so it is still there to scroll to.
 *
 * This matters most in the case that is NOT an edge case here. `effective.prose`
 * is the author's own revision body whenever one exists (`overridden: true`),
 * i.e. hand-edited Markdown with whatever headings they chose — and an author
 * iterating with the assistant is exactly who this feature is for. A
 * schema-derived list would name sections their document does not have.
 *
 * Falls back to `PLANNING_ANALYSIS_SECTIONS` when neither version has a heading
 * at all: with no vocabulary the prompt would have to go open-ended, and the
 * canonical set is a better guess than none for an analysis that still has the
 * shape the generator gave it.
 */
export function collectAnalysisSections(
	before: string,
	after: string,
): string[] {
	const seen = new Set<string>();
	const sections: string[] = [];
	for (const heading of [...headingsIn(before), ...headingsIn(after)]) {
		if (heading.length > MAX_SECTION_LENGTH) {
			continue;
		}
		// Deduped case-insensitively; the FIRST spelling wins, because that is
		// the one the reader is looking at.
		const key = heading.toLowerCase();
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		sections.push(heading);
		if (sections.length >= MAX_SECTIONS) {
			break;
		}
	}
	return sections.length > 0 ? sections : [...PLANNING_ANALYSIS_SECTIONS];
}

export function buildAnalysisChangeSummaryPrompt(
	before: string,
	after: string,
	sections: string[],
): string {
	return `Two versions of a publishing topic's Planning & Analysis follow: the PREVIOUS version and the NEW version the assistant just produced. List the substantive changes the new version makes, for the topic's owner to review before accepting.

Rules:
- 3 to 8 bullets, one per meaningful change; each ONE sentence prefixed with the affected section and " — ", e.g. "Topic angle — narrowed the piece to the migration itself".
- The prefix MUST be one of these section headings, copied VERBATIM. Never invent a section, and never use a label nested inside one — the indented "Released:", "The problem:" and similar labels under a heading are body text, not sections, so a bullet must be filed under the heading above them:
${sections.map((s) => `  - ${s}`).join("\n")}
- Describe only what MATERIALLY changed — the angle, the argument, who should write it, the audience, the risks, the guidance a drafter would follow. Ignore pure wording, ordering, or formatting tweaks.
- Cover changes of ALL kinds — give ADDITIONS equal weight to removals. Do NOT return a removal-only summary when the new version also adds content.
- Be concrete about the change itself, not "updated the X section".
- One bullet per change. If a change touches several sections, file it under the one it most affects rather than repeating it.
- If nothing substantive changed, return an empty list.

PREVIOUS VERSION:
${before || "(empty)"}

NEW VERSION:
${after || "(empty)"}`;
}

/**
 * Who the model call is billed and resolved for.
 *
 * Declared here rather than borrowed from `MaturationTenantFilter`: that type
 * belongs to the feature-maturation queries and is free to grow a field this
 * module has no business knowing about. Two fields, and the `organizationId`
 * is the one taken off the loaded Project row — never off caller input.
 */
interface AnalysisSummaryTenantFilter {
	organizationId: string | null;
	userId: string;
}

export interface SummarizeAnalysisChangesParams {
	before: string;
	after: string;
	tenantFilter: AnalysisSummaryTenantFilter;
	projectId: string;
}

/**
 * Summarize before→after into section-tagged change bullets. Returns `[]` when
 * the two versions are identical or the model produces nothing.
 *
 * Throws on a model failure rather than degrading to `[]`. "The model returned
 * nothing to say" and "the call failed" are different facts, and the caller is
 * the only layer that can tell the author which one happened — see the
 * procedure's doc comment for what the UI does with each.
 */
export async function summarizeAnalysisChanges({
	before,
	after,
	tenantFilter,
	projectId,
}: SummarizeAnalysisChangesParams): Promise<string[]> {
	if (before.trim() === after.trim()) {
		return [];
	}

	const { model } = await getAIModelWithMetadata(
		{ taskType: "COMPLEX" },
		{
			userId: tenantFilter.userId,
			organizationId: tenantFilter.organizationId ?? undefined,
			// One key for the whole suite (see `AI_FEATURE_KEYS`): the question
			// this feature is measured against is asked of the suite, and
			// `getAiOutcomeBreakdown` groups by `featureKey` alone.
			featureKey: "publishing-suite",
		},
	);

	// The same role-composition clause the analysis GENERATOR splices in
	// (`generate-planning-analysis.ts`, FR28): "Recommended authors" is a
	// section about who on the project should write the piece, so a digest of
	// how it changed reads better knowing who those people are. Flag-gated and
	// self-authorizing — see `getProjectFunctionTagClause`.
	const roleClause = await getProjectFunctionTagClause({
		projectId,
		requesterUserId: tenantFilter.userId,
		surface: "summarize-analysis-changes",
	});

	const { object } = await generateObject({
		model,
		schema: zodSchema(AnalysisChangeSummarySchema),
		prompt:
			buildAnalysisChangeSummaryPrompt(
				before,
				after,
				collectAnalysisSections(before, after),
			) + (roleClause ? `\n\n${roleClause}` : ""),
	});

	return object.changeSummary
		.map((b) => b.trim())
		.filter((b) => b.length > 0);
}
