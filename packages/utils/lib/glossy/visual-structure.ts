/**
 * Visual structure checks for Glossy (Fizzy #2589 follow-up): a flow shows
 * only the ordered steps of a process, and an org chart draws only the
 * reporting lines its section states. `checkVisualFacts` in `fact-guard.ts`
 * runs these after its label and figure checks, and this module reuses that
 * module's tokenizer, stemmer, sentence splitter, and negation reader, so
 * both read a section the same way.
 *
 * English only: a section in another language states no order or reporting
 * line here, so its flow or org chart fails safe and is not shown. Every
 * pattern is linear or length-bounded, because both inputs are untrusted.
 */

import {
	allMatches,
	type FactGuardViolation,
	LABEL_FUNCTION_WORDS,
	negatingWords,
	negationProse,
	splitSentences,
	stem,
	stemSet,
	type VisualFactsInput,
	VISUAL_STRUCTURAL_WORDS,
	violation,
	wordTokens,
} from "./fact-guard";
import { headingAnchor } from "./outline";

/**
 * Terms that head a list, not a process, as stem runs: a flow drawn from an
 * "Open Questions", "In Scope", or "Decision Criteria" section invents an
 * order. Compared on stems, so each also matches its singular. Longest
 * first, so "in scope" wins over "scope".
 */
const LIST_HEADING_TERM_TEXTS: readonly string[] = [
	"out of scope",
	"open questions",
	"in scope",
	"success metrics",
	"non goals",
	"questions",
	"risks",
	"assumptions",
	"scope",
	"deliverables",
	"stakeholders",
	"dependencies",
	"requirements",
	"goals",
	"capabilities",
	"features",
	"criteria",
	"criterion",
	"options",
	"alternatives",
	"benefits",
	"constraints",
	"unknowns",
	"issues",
	"objectives",
	"outcomes",
	"metrics",
	"kpis",
	"principles",
	"considerations",
	"roles",
	"responsibilities",
];

let listHeadingTerms: readonly string[][] | undefined;

/**
 * The list terms as stem runs, built on first use: this module and
 * `fact-guard.ts` import each other, so nothing here may call into
 * `fact-guard.ts` while the modules are still loading.
 */
function listHeadingTermStems(): readonly string[][] {
	if (listHeadingTerms === undefined) {
		listHeadingTerms = LIST_HEADING_TERM_TEXTS.map((term) =>
			term.split(" ").map(stem),
		);
	}
	return listHeadingTerms;
}

/** Words a list-type heading may add around its terms: "Key Risks and Assumptions". */
const LIST_HEADING_FILLER = new Set(
	"and or the our key main top major known critical core open remaining outstanding project primary".split(
		" ",
	),
);

/** A list-type heading is short; anything longer is read as prose. */
const LIST_HEADING_MAX_WORDS = 12;

/**
 * Whether a heading names a list-type section: after its numbering ("11) "),
 * decoration, and case are normalized, every word is a list term or filler,
 * apart from at most one qualifier ahead of a list term ("Decision
 * Criteria", "Key Evaluation Criteria"). A word after the last list term is
 * the heading's head noun, so "Risk Management", "Issue Escalation", and
 * "Risk Mitigation Process" name a process, not a list. A word-by-word
 * scan, so no pattern backtracks.
 */
function isListTypeHeading(heading: string): boolean {
	const words = wordTokens(headingAnchor(heading.slice(0, 300))).map(
		(token) => token.word.toLowerCase(),
	);
	if (words.length === 0 || words.length > LIST_HEADING_MAX_WORDS) {
		return false;
	}
	const stems = words.map(stem);
	const terms = listHeadingTermStems();
	let lastTerm = -1;
	let qualifier = -1;
	let i = 0;
	while (i < words.length) {
		const term = terms.find((candidate) =>
			candidate.every((part, k) => stems[i + k] === part),
		);
		if (term) {
			lastTerm = i;
			i += term.length;
		} else if (LIST_HEADING_FILLER.has(words[i])) {
			i++;
		} else if (qualifier === -1) {
			qualifier = i;
			i++;
		} else {
			return false;
		}
	}
	return lastTerm >= 0 && qualifier < lastTerm;
}

/**
 * A heading that names a process: "Order process", "Approval Flow",
 * "Onboarding journey", "Release Pipeline", "Delivery Stages". A cash flow
 * is a figure, not a process.
 */
const PROCESS_HEADING =
	/\b(?:process(?:es)?|workflows?|procedures?|(?<!\bcash[ \t-])flows?|journeys?|lifecycles?|pipelines?|paths?|sequences?|phases?|steps?|stages?)\b/i;

/** The first line of a list entry: a bullet, or a number (`1.` or `1)`). */
const LIST_ENTRY_LINE = /^[ \t]{0,12}(?:[-*+•]|\d{1,3}\\?[.)])[ \t]/;

/** The first line of a numbered entry. */
const NUMBERED_ENTRY_LINE = /^[ \t]{0,12}\d{1,3}\\?[.)][ \t]/;

/** A line that starts another block: a heading, table row, quote, or fence. */
const OTHER_BLOCK_LINE = /^[ \t]{0,3}(?:#{1,6}[ \t]|\||>|```|~~~)/;

/**
 * Only this many steps are matched against the section, each clipped and
 * named at most this many ways, so the scan stays linear in the section.
 */
const MAX_ORDER_STEPS = 16;
const MAX_ORDER_LABEL = 200;
const MAX_STEP_NAMINGS = 8;

/**
 * Words and marks that state an order between steps. English only: a flow
 * from a section in another language fails safe and is not shown.
 */
const SEQUENCING_LANGUAGE =
	/\b(?:then|next|after(?:wards)?|before|followed\s+by|once|finally|first|steps?|stages?|phases?|sequenc(?:e[sd]?|ing))\b|→|->/i;

/** A "Q1:" or "Q1)" label prefix: a question number, or a quarter. */
const QUESTION_PREFIX = /^[\s*_]{0,4}Q\d{1,3}[ \t]{0,3}[:)]/i;

/** A word that opens a question, read after a "Q1:" prefix. */
const INTERROGATIVE_OPENING =
	/^[\s*_]{0,4}(?:which|what|how|when|who|why|where|should|can|do|does|is|are|will|must|has|have)\b/i;

/** Characters that may follow a label's final "?": emphasis, quotes, brackets. */
const QUESTION_TRAILING = new Set(" \t\r\n*_`\"'”’)]");

/** Whether a label ends in "?"; a loop, so a long run cannot backtrack. */
function endsWithQuestionMark(label: string): boolean {
	let end = label.length;
	while (end > 0 && QUESTION_TRAILING.has(label[end - 1])) {
		end--;
	}
	return end > 0 && label[end - 1] === "?";
}

/**
 * Whether a step label asks: it ends in "?", or a "Q1:" prefix opens an
 * interrogative ("Q1: Which vendor"). "Q1: Discovery" is a quarter's step.
 */
function isQuestion(label: string): boolean {
	if (endsWithQuestionMark(label)) {
		return true;
	}
	const prefix = QUESTION_PREFIX.exec(label);
	return (
		prefix !== null &&
		INTERROGATIVE_OPENING.test(label.slice(prefix[0].length))
	);
}

interface ListEntry {
	text: string;
	numbered: boolean;
}

/** The section's bulleted and numbered entries, soft-wrapped lines joined. */
function listEntries(sourceSection: string): ListEntry[] {
	const entries: ListEntry[] = [];
	let lines: string[] = [];
	let numbered = false;
	for (const line of sourceSection.split("\n")) {
		if (LIST_ENTRY_LINE.test(line)) {
			if (lines.length > 0) {
				entries.push({ text: lines.join(" "), numbered });
			}
			lines = [line];
			numbered = NUMBERED_ENTRY_LINE.test(line);
		} else if (
			lines.length > 0 &&
			line.trim() !== "" &&
			!OTHER_BLOCK_LINE.test(line)
		) {
			lines.push(line);
		} else if (lines.length > 0) {
			entries.push({ text: lines.join(" "), numbered });
			lines = [];
		}
	}
	if (lines.length > 0) {
		entries.push({ text: lines.join(" "), numbered });
	}
	return entries;
}

/**
 * How each step can be named in the section, by the label-naming rule org
 * charts use. A flow's own structural words ("Start") name nothing, so a
 * Start node never finds itself in a sentence that merely says "start".
 */
function stepNamings(steps: readonly string[]): Array<Array<Set<string>>> {
	const structural = stemSet(VISUAL_STRUCTURAL_WORDS.flow ?? []);
	return steps.slice(0, MAX_ORDER_STEPS).map((step) =>
		labelNamings(step.slice(0, MAX_ORDER_LABEL))
			.map(
				(naming) =>
					new Set(
						[...naming].filter((part) => !structural.has(part)),
					),
			)
			.filter((naming) => naming.size > 0)
			.slice(0, MAX_STEP_NAMINGS),
	);
}

/**
 * Whether the section's numbered entries order the steps: at least two
 * steps name a numbered entry, each a later one than the step before. A
 * step that names only an earlier entry reorders the list, so the list
 * vouches for no order; steps the list does not name are skipped.
 */
function numberedListOrders(
	entries: ReadonlyArray<Set<string>>,
	steps: ReadonlyArray<ReadonlyArray<Set<string>>>,
): boolean {
	let previous = -1;
	let placed = 0;
	for (const namings of steps) {
		let at = -1;
		for (let k = previous + 1; k < entries.length && at < 0; k++) {
			if (names(namings, entries[k])) {
				at = k;
			}
		}
		if (at >= 0) {
			previous = at;
			placed++;
			continue;
		}
		for (let k = 0; k < previous; k++) {
			if (names(namings, entries[k])) {
				return false;
			}
		}
	}
	return placed >= 2;
}

/**
 * Whether the section states an order for these steps (Fizzy #2589
 * follow-up): its numbered entries order them, or a sentence or list entry
 * that names a step holds a sequencing word. "We revisit pricing next
 * quarter" orders nothing in a flow of market trends.
 */
function statesStepOrder(
	sourceSection: string,
	flowSteps: readonly string[],
): boolean {
	const steps = stepNamings(flowSteps).filter(
		(namings) => namings.length > 0,
	);
	if (steps.length === 0) {
		return false;
	}
	const entries = listEntries(sourceSection);
	const numbered = entries
		.filter((entry) => entry.numbered)
		.map((entry) => stemsOf(entry.text));
	if (numberedListOrders(numbered, steps)) {
		return true;
	}
	const statements = [
		...splitSentences(sourceSection),
		...entries.map((entry) => entry.text),
	];
	return statements.some((statement) => {
		if (!SEQUENCING_LANGUAGE.test(statement)) {
			return false;
		}
		const stems = stemsOf(statement);
		return steps.some((namings) => names(namings, stems));
	});
}

/**
 * A flow shows ordered steps of a process, never a list (Fizzy #2589
 * follow-up). It fails when its section is list-type by heading, when most
 * of its steps are questions, or when the section states no order for its
 * steps: no heading naming a process, no numbered entries in the steps'
 * order, and no sequencing word beside a step (see `statesStepOrder`). A
 * flow the author placed (`authorRequested`) is its own statement of order,
 * so only that last rule is skipped for it.
 */
function flowSequenceViolations(
	visual: VisualFactsInput,
	sourceSection: string,
): FactGuardViolation[] {
	const violations: FactGuardViolation[] = [];
	const heading = visual.heading?.trim() ?? "";
	if (heading && isListTypeHeading(heading)) {
		violations.push(
			violation(
				"flow-sequence",
				heading,
				'"%s" heads a list, not a process; a flow shows only ordered steps.',
			),
		);
	}
	const steps = visual.flowSteps ?? [];
	const questions = steps.filter(isQuestion).length;
	if (questions * 2 > steps.length) {
		violations.push(
			violation(
				"flow-sequence",
				`${questions} of ${steps.length} steps are questions`,
				"%s; a list of questions is not a process.",
			),
		);
	}
	const statesOrder =
		visual.authorRequested === true ||
		PROCESS_HEADING.test(heading) ||
		statesStepOrder(sourceSection, steps);
	if (!statesOrder) {
		violations.push(
			violation(
				"flow-sequence",
				"no numbered steps or sequencing words",
				"The section states no order for these steps (%s such as then, next, after, or finally beside a step); a flow shows only ordered steps.",
			),
		);
	}
	return violations;
}

/**
 * A stated reporting line, read as CHILD <phrase> PARENT. "Manages" and
 * "under the" are deliberately absent: "the product owner manages the
 * backlog" names a responsibility, not a hierarchy. "Report" and "answers"
 * after an article or a possessive are nouns ("writes a report to the
 * sponsor", "sends a weekly report to", "the lead's answers to the
 * sponsor"), not a reporting line.
 * English only, so an org chart from a section in another language fails
 * safe.
 */
const REPORTING_RELATION =
	/\b(?:(?<!\b(?:a|an|the|our|their|its|his|her|my|your)\s{1,4}(?:(?:weekly|monthly|quarterly|daily|annual|final|formal|written|status|progress)\s{1,4})?|['’]s\s{1,4})(?:reports?\s+(?:directly\s+)?(?:to|into)|answers\s+(?:directly\s+)?to)|reporting\s+(?:directly\s+)?(?:to|into)|reporting\s+lines?\s+to|direct\s+reports?\s+of|managed\s+by|led\s+by)\b/gi;

/**
 * A table column whose cells name the row's parent: "Reports to", "Managed
 * by", "Line manager".
 */
const REPORTING_COLUMN =
	/^(?:reports?\s+(?:to|into)|reporting\s+(?:lines?\s+)?(?:to|into)|reporting\s+lines?|direct\s+reports?\s+of|managed\s+by|led\s+by|answers\s+to|(?:line\s+)?managers?)$/i;

/**
 * A reporting phrase that is no verb of its own ("Reporting to the sponsor:
 * …", "Direct reports of …", "Managed by …"): opening a clause, it names
 * the parent first, then the children.
 */
const NON_FINITE_RELATION = /^(?:reporting|direct|managed|led)\b/i;

/**
 * A break between clauses: a semicolon; "but", "while", or "whereas"; or a
 * comma before "and". A comma before "and" that ends a list ("The product
 * owner, the architect, and the QA lead report to …") is no break; see
 * `clauseBreaks`.
 */
const CLAUSE_BREAK = /;|,\s{0,4}and\b|\b(?:but|while|whereas)\b/gi;

/** A relative pronoun: the clause it opens describes the word before it. */
const RELATIVE_PRONOUN = /\b(?:who|which)\b/gi;

/** "And" with no comma: between two reporting phrases, it opens a new clause. */
const PLAIN_AND = /\band\b/gi;

/**
 * Words that name no one, beyond label function words: a window of only
 * these has no subject of its own ("… and is managed by …").
 */
const AUXILIARY_WORDS = new Set(
	"is are was were be been being has have had also directly formally currently now still both will would shall".split(
		" ",
	),
);

/**
 * Marks a statement as unsettled: it supports no reporting line even when
 * it names one. Negating words are read by `negatingWords`.
 */
const UNSETTLED =
	/\b(?:undefined|undecided|unconfirmed|unclear|tb[acd]|to\s+be\s+(?:defined|confirmed|determined|decided|agreed))\b/i;

/**
 * Where the object of an opening phrase ends: "Reporting to the sponsor:
 * the delivery lead and the product owner."
 */
const OPENING_OBJECT_END = /[,:;–—]|\s-\s|\b(?:are|is|include|includes)\b/i;

/** A statement longer than this is not read for reporting lines. */
const MAX_RELATION_STATEMENT = 1_000;

/** Only this many relational phrases per statement are read. */
const MAX_RELATIONS_PER_STATEMENT = 8;

/** The parts a label may name its node by: "Delivery Lead (Person B)". */
const LABEL_PART_BREAK = /[()[\]:,;/|–—]|\s-\s/;

/**
 * Each way a label names its node, as content-word stems: the whole label,
 * or one of its parts. A label is named where every stem of one way
 * appears, the token-subset rule labels already follow.
 */
function labelNamings(label: string): Array<Set<string>> {
	const namings: Array<Set<string>> = [];
	for (const part of [label, ...label.split(LABEL_PART_BREAK)]) {
		const stems = stemSet(
			wordTokens(part)
				.map((token) => token.word)
				.filter(
					(word) => !LABEL_FUNCTION_WORDS.has(word.toLowerCase()),
				),
		);
		if (stems.size > 0) {
			namings.push(stems);
		}
	}
	return namings;
}

function stemsOf(text: string): Set<string> {
	return stemSet(wordTokens(text).map((token) => token.word));
}

function names(
	namings: ReadonlyArray<Set<string>>,
	stems: Set<string>,
): boolean {
	return namings.some((naming) =>
		[...naming].every((part) => stems.has(part)),
	);
}

/** One place a reporting line may be stated: who is named on each side. */
interface StatedRelation {
	child: Set<string>;
	parent: Set<string>;
}

function settles(text: string): boolean {
	return (
		negatingWords(negationProse(text)).length === 0 && !UNSETTLED.test(text)
	);
}

interface Span {
	start: number;
	end: number;
}

function spansOf(text: string, pattern: RegExp): Span[] {
	return allMatches(text, pattern).map((m) => ({
		start: m.index,
		end: m.index + m[0].length,
	}));
}

/** The first span inside [from, to), or undefined. */
function firstIn(spans: readonly Span[], from: number, to: number) {
	return spans.find((span) => span.start >= from && span.end <= to);
}

/** The last span inside [from, to), or undefined. */
function lastIn(spans: readonly Span[], from: number, to: number) {
	let last: Span | undefined;
	for (const span of spans) {
		if (span.start >= from && span.end <= to) {
			last = span;
		}
	}
	return last;
}

/**
 * The clause breaks of a statement. A comma before "and" is a break only
 * when no other comma precedes it in its stretch, counted from the last
 * break, reporting phrase, or relative pronoun; otherwise it closes a list.
 * The statement is at most `MAX_RELATION_STATEMENT` long, so the rescans
 * stay small.
 */
function clauseBreaks(statement: string, resets: readonly number[]): Span[] {
	const breaks: Span[] = [];
	let stretchStart = 0;
	let r = 0;
	for (const span of spansOf(statement, CLAUSE_BREAK)) {
		while (r < resets.length && resets[r] <= span.start) {
			stretchStart = Math.max(stretchStart, resets[r]);
			r++;
		}
		const closesList =
			statement[span.start] === "," &&
			statement.slice(stretchStart, span.start).includes(",");
		if (!closesList) {
			breaks.push(span);
			stretchStart = span.end;
		}
	}
	return breaks;
}

function namesNoOne(text: string, alsoIgnoring?: ReadonlySet<string>): boolean {
	return wordTokens(text).every((token) => {
		const word = token.word.toLowerCase();
		return (
			LABEL_FUNCTION_WORDS.has(word) || alsoIgnoring?.has(word) === true
		);
	});
}

/**
 * How the text between two reporting phrases with no clause break or
 * relative pronoun splits into the first one's parent and the second one's
 * child. `childFrom` is unset when the second shares the first's child.
 *
 * - "A, managed by B, has a reporting line to C" and "A, managed by B and
 *   D, reports to C": the last comma closes a description of A, and nothing
 *   named follows it, so A is the child of both.
 * - "While A reports to B, C reports to D": a comma followed by a name
 *   ends the first clause.
 * - "A reports to B and C reports to D", "A is managed by B and reports to
 *   C": a plain "and" ends it; with nothing named after it, the child is
 *   shared.
 * - "The team led by B reports to C": nothing splits, so the team is the
 *   child of both.
 */
function splitBeforeNext(
	statement: string,
	from: number,
	to: number,
	ands: readonly Span[],
): { parentEnd: number; childFrom?: number } | undefined {
	const between = statement.slice(from, to);
	const lastComma = between.lastIndexOf(",");
	if (
		lastComma >= 0 &&
		namesNoOne(between.slice(lastComma + 1), AUXILIARY_WORDS)
	) {
		return { parentEnd: from + lastComma };
	}
	const firstComma = between.indexOf(",");
	if (firstComma >= 0) {
		return {
			parentEnd: from + firstComma,
			childFrom: from + firstComma + 1,
		};
	}
	const and = firstIn(ands, from, to);
	return and ? { parentEnd: and.start, childFrom: and.end } : undefined;
}

/**
 * Where a relation's child is named, as the previous relation left it: a
 * window of the statement's own; the antecedent of a relative pronoun
 * ("B, who reports to C"); or the previous relation's child, shared ("A is
 * managed by B and reports to C") or described ("A, managed by B, has a
 * reporting line to C"). `from` is where the relation's own clause starts,
 * the text its negation and open questions are read in.
 */
type ChildSource =
	| { kind: "window"; from: number }
	| { kind: "antecedent"; text: string; from: number }
	| { kind: "shared"; from: number };

/**
 * Relations one statement states, each read from its own clause (Fizzy
 * #2589 follow-up). A relation's child window starts at the previous clause
 * break, and its parent window ends at the next clause break, relative
 * pronoun, or reporting phrase; between two reporting phrases a comma or a
 * plain "and" may end it too (see `splitBeforeNext`). So "A reports to B,
 * while C reports to D" states no A → D,
 * and "A reports to B, who reports to C" states B → C but no A → C. A
 * relative clause that holds no reporting phrase only describes its
 * antecedent. A relation whose own clause negates it or leaves it open
 * states nothing, while another clause's negation leaves it alone; a child
 * read from elsewhere must be settled too.
 */
function statementRelations(statement: string): StatedRelation[] {
	const matches = allMatches(statement, REPORTING_RELATION);
	if (matches.length === 0) {
		return [];
	}
	const ends = matches.map((m) => m.index + m[0].length);
	const pronouns = spansOf(statement, RELATIVE_PRONOUN);
	const breaks = clauseBreaks(
		statement,
		[...ends, ...pronouns.map((span) => span.end)].sort((a, b) => a - b),
	);
	const ands = spansOf(statement, PLAIN_AND);
	const relations: StatedRelation[] = [];
	let source: ChildSource = {
		kind: "window",
		from: lastIn(breaks, 0, matches[0].index)?.end ?? 0,
	};
	let previousChild = "";
	const count = Math.min(matches.length, MAX_RELATIONS_PER_STATEMENT);
	for (let i = 0; i < count; i++) {
		const m = matches[i];
		const end = ends[i];
		const hasNext = i + 1 < matches.length;
		const limit = hasNext ? matches[i + 1].index : statement.length;

		// Who the child is: named in this clause, or carried over.
		let child: string =
			source.kind === "antecedent" ? source.text : previousChild;
		let ownChild = false;
		let opening = false;
		if (source.kind === "window") {
			const window = statement.slice(source.from, m.index);
			if (!namesNoOne(window, AUXILIARY_WORDS)) {
				child = window;
				ownChild = true;
			} else if (
				namesNoOne(window) &&
				(i === 0 || NON_FINITE_RELATION.test(m[0]))
			) {
				opening = true;
			}
		}

		// Where the parent window ends: the first clause break or relative
		// pronoun, or, before another reporting phrase, a comma or a plain
		// "and" (see `splitBeforeNext`).
		const clauseBreak = firstIn(breaks, end, limit);
		const pronoun = firstIn(pronouns, end, limit);
		const endsAtBreak =
			clauseBreak !== undefined &&
			(pronoun === undefined || clauseBreak.start < pronoun.start);
		const split =
			hasNext && !opening && !clauseBreak && !pronoun
				? splitBeforeNext(statement, end, limit, ands)
				: undefined;
		const parentEnd = endsAtBreak
			? clauseBreak.start
			: (pronoun?.start ?? split?.parentEnd ?? limit);
		let parent = statement.slice(end, parentEnd);
		if (opening) {
			const objectEnd = OPENING_OBJECT_END.exec(parent);
			child = objectEnd ? parent.slice(objectEnd.index) : "";
			parent = objectEnd ? parent.slice(0, objectEnd.index) : "";
			ownChild = true;
		}
		if (
			child !== "" &&
			parent !== "" &&
			settles(statement.slice(source.from, parentEnd)) &&
			(ownChild || settles(child))
		) {
			relations.push({ child: stemsOf(child), parent: stemsOf(parent) });
		}

		// Where the next relation's child is named.
		previousChild = child;
		if (endsAtBreak) {
			source = {
				kind: "window",
				from: (lastIn(breaks, end, limit) ?? clauseBreak).end,
			};
		} else if (pronoun) {
			const laterBreak = lastIn(breaks, pronoun.end, limit);
			const laterAnd = lastIn(ands, pronoun.end, limit);
			if (laterBreak) {
				source = { kind: "window", from: laterBreak.end };
			} else if (
				laterAnd &&
				!namesNoOne(
					statement.slice(laterAnd.end, limit),
					AUXILIARY_WORDS,
				)
			) {
				// "B, who leads delivery and C reports to D": C is the child.
				source = { kind: "window", from: laterAnd.end };
			} else {
				source = {
					kind: "antecedent",
					text: opening ? child : parent,
					from: pronoun.start,
				};
			}
		} else if (split?.childFrom !== undefined) {
			source = { kind: "window", from: split.childFrom };
		} else {
			source = { kind: "shared", from: end };
		}
	}
	return relations;
}

/**
 * Relations the sentences, list items, and table rows state, each read from
 * its own clause (see `statementRelations`). The child is named before the
 * phrase and the parent after it; a phrase that opens its clause names the
 * parent first, then the children.
 */
function sentenceRelations(sourceSection: string): StatedRelation[] {
	const relations: StatedRelation[] = [];
	for (const statement of splitSentences(sourceSection)) {
		if (statement.length <= MAX_RELATION_STATEMENT) {
			relations.push(...statementRelations(statement));
		}
	}
	return relations;
}

const TABLE_ROW = /^[ \t]{0,3}\|/;
const TABLE_SEPARATOR = /^[\s|:-]+$/;

function tableCells(row: string): string[] {
	return row
		.trim()
		.replace(/^\|/, "")
		.replace(/(?<!\\)\|$/, "")
		.split(/(?<!\\)\|/)
		.map((cell) => cell.replace(/[*_`]/g, "").trim());
}

/**
 * Relations a table's `Reports to` column states: each row's other cells
 * name the child, its `Reports to` cell the parent. A cell that negates or
 * leaves the relation open ("TBD", "none") states none.
 */
function columnRelations(sourceSection: string): StatedRelation[] {
	const relations: StatedRelation[] = [];
	const lines = sourceSection.split("\n");
	for (let i = 0; i + 1 < lines.length; i++) {
		const separator = lines[i + 1];
		if (
			!TABLE_ROW.test(lines[i]) ||
			!TABLE_SEPARATOR.test(separator) ||
			!separator.includes("-")
		) {
			continue;
		}
		const column = tableCells(lines[i]).findIndex((cell) =>
			REPORTING_COLUMN.test(cell.replace(/\s+/g, " ")),
		);
		// Skip past this table's rows either way, so none is read as a header.
		i += 2;
		while (i < lines.length && TABLE_ROW.test(lines[i])) {
			const cells = tableCells(lines[i]);
			const parent = column >= 0 ? cells[column] : undefined;
			if (parent !== undefined && settles(parent)) {
				relations.push({
					child: stemsOf(
						cells.filter((_, k) => k !== column).join(" | "),
					),
					parent: stemsOf(parent),
				});
			}
			i++;
		}
		i--;
	}
	return relations;
}

/**
 * An org chart draws only reporting lines its section states (Fizzy #2589
 * follow-up): every (child, parent) edge needs one sentence or table row
 * that names both and states the relation. A flat `Role | Person` table
 * states none, so a chart built from it fails.
 */
function reportingLineViolations(
	edges: ReadonlyArray<{ child: string; parent: string }>,
	sourceSection: string,
): FactGuardViolation[] {
	const relations = [
		...sentenceRelations(sourceSection),
		...columnRelations(sourceSection),
	];
	const violations: FactGuardViolation[] = [];
	for (const edge of edges) {
		const child = labelNamings(edge.child);
		const parent = labelNamings(edge.parent);
		const stated = relations.some(
			(relation) =>
				names(child, relation.child) && names(parent, relation.parent),
		);
		if (!stated) {
			violations.push(
				violation(
					"reporting-line",
					`${edge.child} → ${edge.parent}`,
					'The section states no reporting line "%s"; an org chart draws only reporting lines a sentence or table row states.',
				),
			);
		}
	}
	return violations;
}

/**
 * The structure findings for one visual: a flow's order, an org chart's
 * reporting lines. Other kinds have no structure to check.
 */
export function visualStructureViolations(
	visual: VisualFactsInput,
	sourceSection: string,
): FactGuardViolation[] {
	if (visual.kind === "flow") {
		return flowSequenceViolations(visual, sourceSection);
	}
	if (visual.kind === "org_chart" && visual.orgChartEdges) {
		return reportingLineViolations(visual.orgChartEdges, sourceSection);
	}
	return [];
}
