/**
 * Glossy visual extraction prompt (Fizzy #2589, R18, R22, KTD13).
 *
 * One call per opportunity: the model fills the typed spec of one kind from
 * one section. The spec is then fact-checked against that section, and one
 * that shows anything the section does not say is dropped (R18), so the
 * rules below mirror what the check enforces — a model that follows them is
 * not wasted work.
 *
 * Style direction and a slot's hint are editor-authored, so each is its own
 * labelled, length-bounded untrusted block that may shape presentation only.
 * The variant nonce drives a single-visual regenerate: the same inputs with a
 * fresh nonce ask for a different arrangement of the same facts.
 */

import { GLOSSY_DETECTABLE_KINDS, type GlossyDetectableKind } from "./detect";
import {
	boundGlossyField,
	GLOSSY_UNTRUSTED_GUIDANCE,
	glossyDocumentLabel,
	truncateCodePoints,
	wrapGlossyUntrusted,
} from "./untrusted";

/** A concrete kind, or `auto` for a slot that lets the model choose. */
export type GlossyExtractPromptKind = GlossyDetectableKind | "auto";

/** Bound on the editor's style direction (KTD13). */
export const GLOSSY_STYLE_DIRECTION_MAX_CHARS = 500;

/** Bound on a slot's hint; matches the `auto` spec's `hint` limit. */
export const GLOSSY_SLOT_HINT_MAX_CHARS = 300;

/**
 * Bound on the section text an extraction reads. Generous — a visual needs
 * the section's substance — but finite, so one runaway section cannot make
 * an unbounded request. The fact check still reads the whole section.
 */
export const GLOSSY_EXTRACTION_SECTION_MAX_CHARS = 16_000;

/**
 * Structural words a kind may use although the section does not; the same
 * list the visual fact check allows.
 */
const STRUCTURAL_WORDS: Readonly<Record<GlossyDetectableKind, string | null>> =
	{
		timeline: '"Phase" and "Start"',
		comparison: '"Pros" and "Cons"',
		stat: null,
		flow: '"Start"',
		org_chart: '"Owner"',
	};

/** Field rules per kind; bounds match `visualSpecSchema` in @repo/utils. */
export const GLOSSY_KIND_FIELD_RULES: Readonly<
	Record<GlossyDetectableKind, string>
> = {
	timeline:
		"items: 2–8 entries in chronological order. date: the section's own date, quarter, or phase name (≤60 characters). label: what happens (≤120). description: optional (≤240).",
	comparison:
		"items: 2–4 options. title: the option's name (≤60). points: 1–6 short points each (≤120), for example its pros and cons.",
	stat: "items: 1–4 figures. value: the figure exactly as the section writes it (≤24 characters, e.g. 240k or 15%). label: what the figure measures (≤120).",
	flow: "steps: 2–8 steps of the process, in the order the section gives them. Only ordered steps of a process make a flow: never turn a list of items, capabilities, questions, risks, or requirements into steps. label: the step as a short phrase of a few words (≤120), with any detail in description. description: optional (≤240). lane: who performs the step, a team, role, or person as the section names them (≤60). Set a lane on every step only when the section says who performs each one; otherwise every lane is null.",
	org_chart:
		"nodes: 2–16 roles, only roles joined by a reporting line the section states (such as reports to, managed by, or led by). The top node is the role they report up to; leave out every role the section states no reporting line for. id: a short unique id (≤40). label: the role or person (≤120). parentId: the id of the node it reports to as the section states, or null for the top node only. No cycles.",
};

export function buildGlossyExtractInstructions(documentType: string): string {
	const label = glossyDocumentLabel(documentType);
	return [
		`You turn one section of a ${label} into the content of a single visual for a stakeholder edition. You fill a structured spec; the visual is drawn from it later.`,
		"",
		"## Fidelity rules",
		"Every visual is checked against its section, and one that fails is discarded.",
		"- Every label, date, figure, and name must come from the section. Copy figures and dates exactly as written: do not round, convert units or currencies, compute totals, or infer dates.",
		"- Build labels from the section's own words. You may shorten by dropping words, but never add a word the section does not use, apart from small function words (a, an, the, of, and, or, to, for, in, on, at, by, with, vs, per, from, into, via).",
		"- Keep a qualifier such as assumed, to be confirmed, indicative, or estimated next to the figure it qualifies.",
		"- A flow's order and an org chart's reporting lines must be stated in the section too: never draw a sequence the section does not give or a reporting line it does not state.",
		"- No links, images, HTML, markdown, or code in any field.",
		"- title is optional; when you set one, take it from the section's heading or wording.",
		"",
		"## Kinds",
		...GLOSSY_DETECTABLE_KINDS.map((kind) => {
			const structural = STRUCTURAL_WORDS[kind];
			return `- ${kind}: ${GLOSSY_KIND_FIELD_RULES[kind]}${structural ? ` May also use ${structural}.` : ""}`;
		}),
		"",
		'When the requested kind is "auto", choose whichever kind above fits the section best, guided by the slot hint when there is one, and set spec.kind to it.',
		"",
		GLOSSY_UNTRUSTED_GUIDANCE,
	].join("\n");
}

export interface GlossyExtractPromptInput {
	kind: GlossyExtractPromptKind;
	heading: string | null;
	/** The cleaned section body. */
	markdown: string;
	slotHint?: string | null;
	styleDirection?: string | null;
	/** Server-generated; a fresh value asks for a different arrangement. */
	variantNonce?: string | null;
}

export function buildGlossyExtractPrompt(
	input: GlossyExtractPromptInput,
): string {
	const lines: string[] = [
		input.kind === "auto"
			? "Requested kind: auto — choose the best-fitting kind."
			: `Requested kind: ${input.kind}.`,
	];
	const nonce = input.variantNonce
		?.replace(/[^A-Za-z0-9-]/g, "")
		.slice(0, 64);
	if (nonce) {
		lines.push(
			`Variant request ${nonce}: an editor asked for another version of this visual. Arrange the same facts differently from an obvious first attempt (grouping, emphasis, title, or level of detail) while following every rule.`,
		);
	}
	const hint = boundGlossyField(input.slotHint, GLOSSY_SLOT_HINT_MAX_CHARS);
	if (hint) {
		lines.push(
			"",
			"Slot hint from the editor:",
			wrapGlossyUntrusted("slot_hint", hint),
		);
	}
	const style = boundGlossyField(
		input.styleDirection,
		GLOSSY_STYLE_DIRECTION_MAX_CHARS,
	);
	if (style) {
		lines.push(
			"",
			"Style direction from the editor:",
			wrapGlossyUntrusted("style_direction", style),
		);
	}
	const heading = input.heading?.trim();
	const body = truncateCodePoints(
		input.markdown.trim(),
		GLOSSY_EXTRACTION_SECTION_MAX_CHARS,
	);
	lines.push(
		"",
		"The section:",
		wrapGlossyUntrusted(
			"section",
			heading ? `Heading: ${heading}\n\n${body}` : body,
		),
		"",
		"Return the spec for the section above.",
	);
	return lines.join("\n");
}
