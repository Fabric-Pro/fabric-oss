/**
 * Pure helpers that pick which part of two FEATURE specs a duplicate check
 * should weigh most.
 *
 * Whole-document similarity over-matches features that share a topic. Two
 * specs about onboarding — one for new users, one for configuring a developer
 * integration — share their narrative, personas and product area, so their
 * vectors sit close together even though they deliver different things. What
 * actually separates two features is what each one commits to deliver: the
 * spec's Scope section (In Scope + Out of Scope), or, when a spec has none,
 * its acceptance criteria. Those sections become the primary signal for a
 * FEATURE↔FEATURE pair; the whole document stays a secondary one.
 *
 * Bugs are left alone on purpose: a bug's identity is its symptom and
 * reproduction, which the whole-document comparison already captures, and a
 * bug template has no Scope section to compare.
 *
 * Like `duplicate-detection.ts`, this module has no DB / AI imports, so the
 * parsing and weighting are unit-testable in isolation.
 */

/**
 * The focus-section cosine's share of a feature pair's score; the
 * whole-document cosine gets the rest. The score does two jobs:
 *
 *  - it is the similarity a feature pair is stored and shown with, so two
 *    features whose Scope sections do not overlap read as low even when their
 *    documents read alike;
 *  - it is the score a feature pair is selected on (see `candidateScore`), so
 *    two features whose Scope sections match are checked even when the rest
 *    of their documents are written differently, and two whose documents
 *    read alike but whose Scope sections do not are not.
 *
 * It never flags a pair by itself — the verifier, reading the same sections
 * as its primary signal, decides every candidate (see `buildVerifierPrompt`).
 * Checked against verifier verdicts on 68 staging feature pairs: ranking
 * linked above distinct pairs, 0.75 scored an AUC of 0.92, the whole document
 * alone 0.79, and every weight from 0.6 to 1.0 was within 0.01 of 0.75.
 */
export const FOCUS_SECTION_WEIGHT = 0.75;

/**
 * Ceiling on a focus text. Sized like the detection text's acceptance-criteria
 * budget: enough for any real Scope section, while a runaway one cannot bloat
 * the verifier prompt or the embedding call.
 */
export const MAX_FOCUS_CHARS = 4000;

/**
 * How much of a description is scanned for a section. Parsing is line-based
 * with anchored per-line patterns only, and runs on this already-bounded
 * slice (js/polynomial-redos: never hand a regex an unbounded description).
 */
const MAX_FOCUS_SOURCE_CHARS = 40000;

/** Level given to a bold label line (`**In Scope**`): lower than any heading,
 * so `## Scope` can contain bold subsections but a bold label cannot contain
 * a heading. */
const BOLD_LABEL_LEVEL = 7;

/** An ATX heading, also when an editor stored it escaped (`\## Scope`). */
const HEADING_LINE = /^ {0,3}\\?(#{1,6})[ \t]+(\S.*)$/;
/** Matched against an already-trimmed line, so no trailing-space quantifier
 * is needed next to the optional colon. */
const BOLD_LABEL_LINE = /^(\*\*|__)([^*_]+)\1:?$/;
const LEADING_NUMBERING = /^\d+(?:\.\d+)*[.)]?[ \t]+/;
/** A content line counts only when it has a letter or digit, so rules
 * (`---`) and placeholder bullets (`- ...`) leave a section empty. */
const HAS_TEXT = /[\p{L}\p{N}]/u;
/**
 * A template metadata line in an acceptance-criteria field: optionally a
 * `-`/`*` bullet, optionally bold, then a feature id, scope justification,
 * system-of-record or feature-link(s) label. Stub imports put these lines at
 * the top of the field; compared as criteria they make every stub look like
 * every other one. Run per line on already-bounded text only.
 */
const TEMPLATE_METADATA_LINE =
	/^[ \t]*(?:[-*][ \t]+)?(?:\*\*|__)?(?:feature id|scope justification|system of record|feature links?)\b/i;
/** Where a compound label is cut, so "Out of Scope / Non-Goals" and
 * "Scope & Boundaries" are read by their first part. Plain substrings — no
 * regex — and only ever spaced, so "In-Scope" stays one word. */
const LABEL_SEPARATORS = [" / ", " & ", " and ", " — ", " – "];

/** The sections a feature pair can be compared on, in order of preference. */
export const PAIR_FOCUS_KINDS = ["scope", "acceptance_criteria"] as const;

/** The section a feature pair is compared on. */
export type PairFocusKind = (typeof PAIR_FOCUS_KINDS)[number];

/** The fields of a story the focus selection reads. `kind` mirrors the
 * `StoryKind` enum; a row without one is treated as not-a-feature, so it
 * keeps the whole-document behaviour. */
export type FocusStory = {
	kind?: "FEATURE" | "BUG" | null;
	description?: string | null;
	acceptanceCriteria?: string | null;
};

/** A feature's comparable section texts, one entry per section it has. */
export type FocusTexts = Partial<Record<PairFocusKind, string>>;

/** The comparable section text of both sides of a FEATURE↔FEATURE pair. */
export type PairFocus = {
	kind: PairFocusKind;
	textA: string;
	textB: string;
};

/** Human name of a focus section, for the verifier prompt and reasoning. */
export function focusSectionName(kind: PairFocusKind): string {
	switch (kind) {
		case "scope":
			return "Scope";
		case "acceptance_criteria":
			return "Acceptance criteria";
		default: {
			const unreachable: never = kind;
			return unreachable;
		}
	}
}

function trimChars(text: string, chars: string): string {
	let start = 0;
	let end = text.length;
	while (start < end && chars.includes(text[start])) {
		start++;
	}
	while (end > start && chars.includes(text[end - 1])) {
		end--;
	}
	return text.slice(start, end);
}

/** Cut a label at its first {@link LABEL_SEPARATORS} occurrence. */
function cutAtSeparator(label: string): string {
	let end = label.length;
	for (const separator of LABEL_SEPARATORS) {
		const index = label.indexOf(separator);
		if (index > 0 && index < end) {
			end = index;
		}
	}
	return trimChars(label.slice(0, end), "*_: \t");
}

/**
 * Reduce a section label to a comparable key: lowercase, emphasis markers,
 * closing hashes, a trailing colon, leading numbering ("5.", "8.1"), one
 * trailing parenthetical ("(Next Increment)") and everything after a
 * compound separator ("/ Non-Goals", "& Boundaries") removed, hyphens read as
 * spaces. "### **In-Scope:**" and "5. In Scope (v1)" both become "in scope";
 * "Scope justification" stays itself, so it never opens a Scope section.
 */
function normalizeLabel(raw: string): string {
	let label = trimChars(raw.toLowerCase(), "*_#: \t");
	label = trimChars(label.replace(LEADING_NUMBERING, ""), "*_: \t");
	if (label.endsWith(")")) {
		const open = label.lastIndexOf("(");
		if (open > 0) {
			label = trimChars(label.slice(0, open), "*_: \t");
		}
	}
	label = cutAtSeparator(label.replace(/\s+/g, " "));
	return label.replace(/-/g, " ").replace(/\s+/g, " ");
}

/** A heading or whole-line bold label, with its nesting level and raw text. */
function parseLabel(line: string): { level: number; text: string } | null {
	const heading = HEADING_LINE.exec(line);
	if (heading) {
		return { level: heading[1].length, text: heading[2] };
	}
	const bold = BOLD_LABEL_LINE.exec(line.trim());
	if (bold) {
		return { level: BOLD_LABEL_LEVEL, text: bold[2] };
	}
	return null;
}

/**
 * Collect the body of every section whose label `classify` recognises.
 *
 * `classify` maps a normalized label to the header its content is emitted
 * under ("" for none), or null when the label is not part of the section.
 * Capture starts at a recognised label and runs until the next label at the
 * same or a higher level that is not itself recognised — so `## Scope` keeps
 * its `### In Scope` / `### Out of Scope` children, and a recognised label at
 * a HIGHER level than the one that opened the section (some templates nest
 * `## In Scope` under `### Scope`) continues the section rather than ending
 * it. Unrecognised sub-labels inside the section are kept as content lines.
 *
 * Content is grouped per recognised label, and a group with no body text is
 * dropped together with its header, so an empty section yields "".
 */
function extractSection(
	text: string,
	classify: (label: string) => string | null,
): string {
	const groups: Array<{ header: string; lines: string[] }> = [];
	let sectionLevel: number | null = null;
	for (const rawLine of text.slice(0, MAX_FOCUS_SOURCE_CHARS).split("\n")) {
		const line = rawLine.replace(/\r$/, "");
		const label = parseLabel(line);
		if (label) {
			const header = classify(normalizeLabel(label.text));
			if (header !== null) {
				sectionLevel =
					sectionLevel === null
						? label.level
						: Math.min(sectionLevel, label.level);
				groups.push({ header, lines: [] });
				continue;
			}
			if (sectionLevel !== null && label.level <= sectionLevel) {
				sectionLevel = null;
				continue;
			}
		}
		if (sectionLevel === null) {
			continue;
		}
		const content = (label ? label.text : line).trim();
		if (HAS_TEXT.test(content)) {
			groups[groups.length - 1].lines.push(content);
		}
	}
	return groups
		.filter((group) => group.lines.length > 0)
		.map((group) =>
			[group.header, ...group.lines].filter(Boolean).join("\n"),
		)
		.join("\n")
		.slice(0, MAX_FOCUS_CHARS);
}

/**
 * Polarity is kept on purpose: a feature whose Out of Scope lists exactly
 * what another feature's In Scope delivers shares vocabulary with it, and
 * without the prefixes that deliberate separation would read as overlap.
 */
function classifyScopeLabel(label: string): string | null {
	switch (label) {
		case "scope":
			return "";
		case "in scope":
			return "In scope:";
		case "out of scope":
		case "non goals":
			return "Out of scope:";
		default:
			return null;
	}
}

/** "Acceptance Criteria", and any qualified form of it ("Functional
 * Acceptance Criteria"). */
function classifyAcceptanceCriteriaLabel(label: string): string | null {
	return label === "acceptance criteria" ||
		label.endsWith(" acceptance criteria")
		? ""
		: null;
}

/** The field with its template metadata lines dropped. */
function stripTemplateMetadata(text: string): string {
	return text
		.split("\n")
		.filter((line) => !TEMPLATE_METADATA_LINE.test(line))
		.join("\n")
		.trim();
}

/** The Scope section (In Scope + Out of Scope) of a description, with each
 * part prefixed by its polarity; "" when there is none or it is empty. */
export function extractScopeText(description?: string | null): string {
	return extractSection(description ?? "", classifyScopeLabel);
}

/**
 * A story's acceptance criteria, from the first source that has any:
 *  1. an Acceptance Criteria section INSIDE the field — legacy stub imports
 *     put template metadata first and the real criteria under a heading such
 *     as "### Functional Acceptance Criteria", and some hold a whole spec;
 *  2. the field itself, minus its template metadata lines;
 *  3. the description's Acceptance Criteria section.
 * "" when none has any.
 */
export function extractAcceptanceCriteriaText(story: FocusStory): string {
	const field = (story.acceptanceCriteria ?? "").slice(
		0,
		MAX_FOCUS_SOURCE_CHARS,
	);
	const fieldSection = extractSection(field, classifyAcceptanceCriteriaLabel);
	if (fieldSection) {
		return fieldSection;
	}
	const fieldText = stripTemplateMetadata(field)
		.slice(0, MAX_FOCUS_CHARS)
		.trim();
	if (HAS_TEXT.test(fieldText)) {
		return fieldText;
	}
	return extractSection(
		story.description ?? "",
		classifyAcceptanceCriteriaLabel,
	);
}

/**
 * A story's comparable sections, or null when it is not a feature (bugs keep
 * the whole-document comparison). Only non-empty sections get an entry.
 */
export function extractFocusTexts(story: FocusStory): FocusTexts | null {
	if (story.kind !== "FEATURE") {
		return null;
	}
	const texts: FocusTexts = {};
	const scope = extractScopeText(story.description);
	if (scope) {
		texts.scope = scope;
	}
	const criteria = extractAcceptanceCriteriaText(story);
	if (criteria) {
		texts.acceptance_criteria = criteria;
	}
	return texts;
}

/**
 * The section two features are compared on, given which sections each one has
 * (texts or their vectors), or null to keep the whole-document comparison.
 *
 * Both sides must have the SAME kind of section — comparing one feature's
 * Scope with the other's acceptance criteria would measure two different kinds
 * of text — so Scope is used when both have one, acceptance criteria when both
 * have those, and otherwise the pair falls back to the whole document. The
 * candidate selection and the verifier prompt both go through this, so a pair
 * is always verified on the section it was scored on.
 */
export function choosePairFocusKind(
	a: Partial<Record<PairFocusKind, unknown>> | null | undefined,
	b: Partial<Record<PairFocusKind, unknown>> | null | undefined,
): PairFocusKind | null {
	return PAIR_FOCUS_KINDS.find((kind) => a?.[kind] && b?.[kind]) ?? null;
}

/** A feature pair's score: the focus-section cosine weighted by `weight`,
 * the whole-document cosine by the rest. */
export function weightedFocusSimilarity(
	focusCosine: number,
	documentCosine: number,
	weight = FOCUS_SECTION_WEIGHT,
): number {
	return weight * focusCosine + (1 - weight) * documentCosine;
}
