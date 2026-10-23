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
	flow: "ordered steps of a process, at least two in sequence, that are not already a diagram, including a process that says which team or role performs each step. A list of items, capabilities, questions, risks, or requirements is not a flow.",
	org_chart:
		"reporting lines the section states outright (who reports to whom) that form one hierarchy under a single top role. Roles, owners, or stakeholders listed without stated reporting lines are not an org chart.",
};

/**
 * Options for the Proposal artifact's visuals step, which reuses these
 * prompts for a client-facing Proposal (Fizzy #2946). Unset, every prompt is
 * Glossy's own, unchanged.
 */
export interface GlossyPromptOptions {
	/** The visuals go into a Proposal's Main document. */
	proposalArtifact?: boolean;
}

/**
 * Who a Proposal's diagrams are for. Guidance, not a filter: detection may
 * still propose a technical diagram for a body section where nothing else
 * fits.
 */
const PROPOSAL_AUDIENCE_RULES = [
	"## Audience",
	"- The visuals sit inline in a client-facing Proposal. Inline visuals are for executive readers: non-technical, glanceable, a few short labels a reader takes in at once.",
	'- Technical diagrams (system architecture, data flows, detailed processes) fit sections marked appendix="true", where a plainer, more detailed look is fine.',
	"- Prefer the kind an executive reads fastest: a timeline for phases, a comparison for options, a flow only for a short process.",
];

export function buildGlossyDetectInstructions(
	documentType: string,
	options: GlossyPromptOptions = {},
): string {
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
		...(options.proposalArtifact ? [...PROPOSAL_AUDIENCE_RULES, ""] : []),
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
	/** A Proposal's appendix section, where a technical diagram fits. */
	appendix?: boolean;
}

/** A section's trusted attributes, or undefined when it has none. */
function sectionAttributes(
	section: GlossyDetectPromptSection,
): Record<string, string> | undefined {
	const attributes: Record<string, string> = {};
	if (section.reservedKinds?.length) {
		attributes.already_shows = section.reservedKinds.join(", ");
	}
	if (section.appendix) {
		attributes.appendix = "true";
	}
	return Object.keys(attributes).length > 0 ? attributes : undefined;
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
		attributes: sectionAttributes(section),
	}));
	return [
		`Propose at most ${input.limit} visual${input.limit === 1 ? "" : "s"} across the sections below.`,
		"",
		wrapGlossyDocument(sections),
		"",
		"Return the opportunities for the sections above, naming each by its ref.",
	].join("\n");
}
