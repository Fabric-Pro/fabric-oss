/**
 * Glossy visual-opportunity detection prompt (Fizzy #2589, R17, KTD9).
 *
 * One document-level call: the model sees every section to consider (all of
 * them on a first build, only the changed ones on a rebuild) and names the
 * sections where a visual would help, one kind each. Sections are named back
 * by a short caller-assigned ref rather than by their 64-character key, which
 * a model copies unreliably; the caller maps refs to keys and discards any
 * ref it did not issue.
 *
 * Style direction deliberately does not enter detection (KTD8): it shapes
 * extraction only, so changing it never re-detects.
 */

import {
	GLOSSY_UNTRUSTED_GUIDANCE,
	glossyDocumentLabel,
	truncateCodePoints,
	wrapGlossyDocument,
} from "./untrusted";

/**
 * The kinds a model may propose. Existing Mermaid is detected
 * deterministically, and `auto` exists only on an unresolved slot (KTD9).
 */
export const GLOSSY_DETECTABLE_KINDS = [
	"timeline",
	"comparison",
	"stat",
	"flow",
	"org_chart",
] as const;

export type GlossyDetectableKind = (typeof GLOSSY_DETECTABLE_KINDS)[number];

/** A document never gets more than this many detected opportunities (R17). */
export const GLOSSY_MAX_OPPORTUNITIES = 8;

/** Detection reasons are shown to editors as plain text, capped here (KTD13). */
export const GLOSSY_REASON_MAX_CHARS = 160;

/**
 * Per-section excerpt bound for detection. Judging whether a section suits a
 * visual needs its substance, not every paragraph; extraction later reads
 * the whole section.
 */
export const GLOSSY_DETECTION_SECTION_MAX_CHARS = 4_000;

/** One line per kind: what a section must already contain to qualify. */
export const GLOSSY_KIND_DEFINITIONS: Readonly<
	Record<GlossyDetectableKind, string>
> = {
	timeline:
		"ordered phases, milestones, or dated events — at least two, in sequence.",
	comparison:
		"two to four options or alternatives, or pros and cons, set against each other.",
	stat: "one to four headline figures the section states outright (amounts, savings, percentages, counts).",
	flow: "a described process of at least two sequential steps that is not already a diagram.",
	org_chart:
		"roles, ownership, or reporting lines that form one hierarchy under a single top role.",
};

export function buildGlossyDetectInstructions(documentType: string): string {
	const label = glossyDocumentLabel(documentType);
	return [
		`You are preparing a stakeholder edition of a ${label}. Find the sections where one visual would help an executive reader grasp the content faster.`,
		"",
		"## Visual kinds",
		...GLOSSY_DETECTABLE_KINDS.map(
			(kind) => `- ${kind}: ${GLOSSY_KIND_DEFINITIONS[kind]}`,
		),
		"",
		"## Rules",
		"- Propose a visual only where the section's own text already contains everything the visual would show. Never propose one that needs information the section does not state.",
		"- At most one visual per section, and never more in total than the request allows. When more sections qualify, keep the strongest candidates.",
		"- A section may declare kinds it already shows (already_shows); never propose those kinds for it.",
		"- Proposing nothing is a valid answer. Do not force a visual onto plain narrative.",
		"- Name each section only by its ref, exactly as given.",
		`- reason: one short plain-text sentence (at most ${GLOSSY_REASON_MAX_CHARS} characters) saying what in the section suits the kind. No markdown, links, or long quotes.`,
		"",
		GLOSSY_UNTRUSTED_GUIDANCE,
	].join("\n");
}

export interface GlossyDetectPromptSection {
	/** Caller-assigned ref the model names the section by. */
	ref: string;
	heading: string | null;
	/** The cleaned section body. */
	markdown: string;
	/** Kinds the section already shows (a slot or an existing diagram). */
	reservedKinds?: readonly string[];
}

export function buildGlossyDetectPrompt(input: {
	sections: readonly GlossyDetectPromptSection[];
	/** How many opportunities the model may return; the caller also enforces it. */
	limit: number;
}): string {
	const sections = input.sections.map((section) => ({
		ref: section.ref,
		heading: section.heading,
		body: truncateCodePoints(
			section.markdown.trim(),
			GLOSSY_DETECTION_SECTION_MAX_CHARS,
		),
		attributes: section.reservedKinds?.length
			? { already_shows: section.reservedKinds.join(", ") }
			: undefined,
	}));
	return [
		`Propose at most ${input.limit} visual${input.limit === 1 ? "" : "s"} across the sections below.`,
		"",
		wrapGlossyDocument(sections),
		"",
		"Return the opportunities for the sections above, naming each by its ref.",
	].join("\n");
}
