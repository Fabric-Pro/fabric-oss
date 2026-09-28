/**
 * Glossy section rewrite prompt (Fizzy #2589, R14–R16, R41, R42, KTD12).
 *
 * One call per section, on the body only: the heading is given for context
 * and never asked back, so the rewrite cannot rename, merge, or split a
 * section (R15). The output is checked by the deterministic fact guard; the
 * rules below say what it enforces, so a faithful model passes first time.
 * A rejected attempt gets one retry that carries the guard's findings, and
 * those findings quote document and model text, so they travel inside their
 * own untrusted block.
 */

import {
	GLOSSY_UNTRUSTED_GUIDANCE,
	glossyDocumentLabel,
	wrapGlossyUntrusted,
} from "./untrusted";

/** Matches `GlossyLengthMode` in @repo/utils/glossy/fact-guard. */
export type GlossyRewriteLengthMode = "brief" | "standard";

/** Standard may be at most this multiple of the source; the guard's limit. */
const STANDARD_LENGTH_FACTOR = 1.25;

/** A guard finding as the retry prompt shows it. */
export interface GlossyRewriteFinding {
	kind: string;
	message: string;
}

/** Retry prompts list at most this many findings; the rest are summarized. */
const MAX_RETRY_FINDINGS = 12;

export function buildGlossyRewriteInstructions(documentType: string): string {
	const label = glossyDocumentLabel(documentType);
	return [
		`You rewrite one section of a ${label} for an executive, external audience: a stakeholder edition. Your text replaces the section body under its existing heading.`,
		"",
		"## Length modes",
		"- brief: condense to what an executive needs. Never longer than the source body; aim for roughly half to two thirds of it.",
		"- standard: keep roughly the original length (never more than a quarter longer) and adjust tone and flow for an external executive reader.",
		"",
		"## Fidelity rules",
		"A deterministic check compares your text with the source body. If it fails, the source wording is used instead of yours.",
		"- Every figure, amount, percentage, date, quarter, name, and commitment you write must appear in the source body. Copy each exactly as written: do not round, convert units or currencies, compute totals, or change a date.",
		"- Add nothing the source does not state: no new facts, names, claims, promises, or examples.",
		"- Keep qualifiers such as assumed, to be confirmed, indicative, dependent, estimated, or expected in the same sentence as the statement or figure they qualify.",
		"- Do not add a negation (not, no, none, nothing, nobody, nowhere, neither, nor, never, cannot, without, or a contraction such as isn't) the source does not state: use no more negating words than the source does, and never reverse a statement's meaning.",
		'- Keep every negation the source states, each with its own explicit negating word (not, no, none, neither, nor, never, without, no longer, or a contraction such as isn\'t), including when you condense or merge sentences. Keep "never" as "never". A rewrite with fewer negating words than the source is rejected: "A is not in scope. B is not in scope." may become "Neither A nor B is in scope." but not "A and B are not in scope."',
		"- Include no images, not even one the source has: the edition places the document's own images itself.",
		"- Do not add links, HTML, code or code fences, headings, or visual-slot tags.",
		"- Keep tables and lists that carry figures; you may tighten their wording.",
		"",
		"## Output",
		"Only the rewritten section body, in Markdown. No heading or title, no preamble or commentary, and no code fence around the answer.",
		"",
		GLOSSY_UNTRUSTED_GUIDANCE,
	].join("\n");
}

/** Characters after collapsing whitespace runs: how the fact guard measures length. */
export function glossyMeasuredLength(text: string): number {
	return text.replace(/\s+/g, " ").trim().length;
}

export interface GlossyRewritePromptInput {
	heading: string | null;
	/** The cleaned section body. */
	markdown: string;
	lengthMode: GlossyRewriteLengthMode;
	/** An executive summary, decision or recommendation, or budget section (R42). */
	isKeySection: boolean;
	/** The previous attempt's guard findings; present on the one retry only. */
	retryFindings?: readonly GlossyRewriteFinding[];
}

export function buildGlossyRewritePrompt(
	input: GlossyRewritePromptInput,
): string {
	const sourceLength = glossyMeasuredLength(input.markdown);
	const limit =
		input.lengthMode === "brief"
			? sourceLength
			: Math.floor(sourceLength * STANDARD_LENGTH_FACTOR);
	const lines: string[] = [
		`Length mode: ${input.lengthMode}. The source body is ${sourceLength} characters; your text must stay at or under ${limit} characters.`,
	];
	if (input.isKeySection) {
		lines.push(
			"This is a key section (executive summary, decision or recommendation, or investment and budget): keep every figure and date from the source body.",
		);
	}

	const findings = input.retryFindings ?? [];
	if (findings.length > 0) {
		const shown = findings.slice(0, MAX_RETRY_FINDINGS);
		const more = findings.length - shown.length;
		lines.push(
			"",
			"Your previous attempt was rejected by the fact check. Write a new version that resolves every finding below and still follows every rule.",
			wrapGlossyUntrusted(
				"guard_feedback",
				[
					...shown.map(
						(finding) => `- [${finding.kind}] ${finding.message}`,
					),
					...(more > 0
						? [`- …and ${more} more of the same kinds.`]
						: []),
				].join("\n"),
			),
		);
	}

	const heading = input.heading?.trim();
	lines.push(
		"",
		heading
			? "The section (the heading is context only; do not repeat it):"
			: "The section body:",
		wrapGlossyUntrusted(
			"section",
			heading
				? `Heading: ${heading}\n\n${input.markdown.trim()}`
				: input.markdown.trim(),
		),
		"",
		"Return only the rewritten body.",
	);
	return lines.join("\n");
}
