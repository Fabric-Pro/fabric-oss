/**
 * Deterministic fact and structural guard for Glossy (Fizzy #2589, KTD12).
 *
 * A Glossy rewrite may condense a section but never alter it (R16, R41,
 * R42), and a visual may only show what its source segment says (R18). This
 * module decides both without a model:
 *
 * - presence: every figure, date, proper name, and commitment term in the
 *   output exists in the source;
 * - hedge: a figure the source only states in not-confirmed sentences keeps
 *   a qualifier in its output sentence;
 * - must-keep: a key section keeps every source figure and date;
 * - structural: the output adds no URL, email, markdown link or image, HTML,
 *   code fence, slot tag, or heading the source lacks, and no more negating
 *   words per negator group than the source states;
 * - negation: the output keeps as many negating words per negator group as
 *   the source states, and a negation does not move between statements:
 *   clauses are aligned by shared content words, and one aligned pair
 *   losing a negating word while another gains it fails;
 * - length: Brief is at most the source length, Standard at most 1.25x.
 *
 * Callers pass the CLEANED source (after cleanup), so a figure that only
 * lived in a stripped evidence quote is not present.
 *
 * Facts compare by canonical key after normalization (currency and
 * magnitude, number words, percentages, ranges, quarters and dates,
 * ordinals). Nothing is ever computed from a fact, so rounding, unit
 * conversion, and derived totals fail by construction.
 *
 * A false positive costs a section its rewrite, so the guard is deliberately
 * lenient where a miss is cheap: a less specific form of a source fact is
 * present ("2026" for "Q3 2026", "240k" for "$240k"), idiomatic "one" and
 * "first step" are never required, names match on a crude stem, and a
 * sentence-initial word is a name only outside a common-word stoplist.
 *
 * No Node built-ins: shared with browser bundles like the rest of `glossy/`.
 * Every pattern is linear or length-bounded, because both inputs are
 * untrusted (see the ReDoS note in `markdown-heading.ts`).
 */

import {
	FENCE_MARKER,
	headingAnchor,
	parseOutline,
	VISUAL_SLOT_TAG,
} from "./outline";

export type FactKind =
	| "money"
	| "percent"
	| "number"
	| "date"
	| "name"
	| "commitment";

export interface Fact {
	kind: FactKind;
	/** Canonical comparison key, e.g. `money:USD:240000`, `quarter:2026:3`, `name:contoso`. */
	key: string;
	/**
	 * Every key this fact vouches for when it appears in a source: its own
	 * key plus less specific forms, e.g. `quarter:2026:3` also provides
	 * `quarter:*:3` and `num:2026`.
	 */
	provides: string[];
	/** The fact as written. Both ends of a range carry the whole range. */
	text: string;
	/** Offset of `text` in the string passed to `extractFacts`. */
	index: number;
	/**
	 * Idiomatic numbers ("one of the risks", "the first step"): they provide
	 * their key but are never required by presence, hedge, or must-keep.
	 */
	weak?: boolean;
	/** Name facts only: the word opens a sentence, list item, or clause. */
	sentenceInitial?: boolean;
}

export type FactGuardViolationKind =
	| "presence"
	| "hedge"
	| "must-keep"
	| "structural"
	| "negation"
	| "length"
	| "label"
	| "placeholder";

export interface FactGuardViolation {
	kind: FactGuardViolationKind;
	/** The offending text: from the output, or from the source for must-keep. */
	text: string;
	/** One-line explanation, suitable for a retry prompt's violation list. */
	message: string;
}

export type FactGuardResult =
	| { pass: true }
	| { pass: false; violations: FactGuardViolation[] };

export type GlossyLengthMode = "brief" | "standard";

export interface CheckRewriteInput {
	/** The cleaned source section. */
	source: string;
	/** The model's rewrite of that section. */
	output: string;
	/** Whether the section is a key section (see `isKeySection`). */
	isKeySection: boolean;
	lengthMode: GlossyLengthMode;
}

export interface VisualFactsInput {
	labels: readonly string[];
	figures: readonly string[];
	/** The visual kind, e.g. `timeline`, `comparison`, `org_chart`. */
	kind: string;
}

/** Standard output may be at most this multiple of the source length. */
const STANDARD_LENGTH_FACTOR = 1.25;

/** Violation text is echoed into retry prompts and logs; keep it short. */
const MAX_VIOLATION_TEXT = 120;

// ---------------------------------------------------------------------------
// Numeric normalization
// ---------------------------------------------------------------------------

/** Digits with optional thousands separators and decimals. */
const NUM = String.raw`\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?`;

/**
 * A number starts a token: not mid-word, mid-number, or after an uppercase
 * code and hyphen ("COVID-19", "ISO-9001"). "mid-2026" still counts.
 */
const NUM_START = String.raw`(?<![\p{L}\p{N}_.,])(?<!\p{Lu}-)`;

const RANGE_SEP = String.raw`\s*(?:–|—|-|to)\s*`;

/** Magnitude after a currency amount: "k", "M", "bn", " million". */
const MONEY_MAG = String.raw`\s?(?:thousand|million|billion|trillion)|mn|bn|tn|MM|[kKmMbB]`;

/** Magnitude after a bare number. A bare "B" is too often a label ("Option 2B"). */
const BARE_MAG = String.raw`\s?(?:thousand|million|billion|trillion)|mn|bn|tn|MM|[kKmM]`;

const PERCENT_UNIT = String.raw`(?:%|percent(?!\p{L})|per\s?cent(?!\p{L})|pct(?!\p{L}))`;

const CURRENCY_BY_SYMBOL: Record<string, string> = {
	$: "USD",
	US$: "USD",
	USD: "USD",
	A$: "AUD",
	AUD: "AUD",
	C$: "CAD",
	CAD: "CAD",
	NZ$: "NZD",
	NZD: "NZD",
	"€": "EUR",
	EUR: "EUR",
	"£": "GBP",
	GBP: "GBP",
	"¥": "JPY",
	JPY: "JPY",
	"₹": "INR",
	INR: "INR",
	CHF: "CHF",
};

/** Currency words after an amount, by their first four letters. */
const CURRENCY_BY_WORD: Record<string, string> = {
	doll: "USD",
	euro: "EUR",
	poun: "GBP",
};

const CURRENCY_PREFIX = String.raw`US\$|NZ\$|A\$|C\$|USD|EUR|GBP|CHF|CAD|AUD|NZD|JPY|INR|\$|€|£|¥|₹`;

const CURRENCY_SUFFIX = String.raw`USD|EUR|GBP|CHF|CAD|AUD|NZD|JPY|INR|[Dd]ollars?|[Ee]uros?|[Pp]ounds?(?:\s+[Ss]terling)?`;

const MONTH_NAMES =
	"january february march april may june july august september october november december".split(
		" ",
	);

/** Capitalized month names; full names listed before their abbreviations. */
const MONTH = String.raw`(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec)\.?(?!\p{L})`;

/** Ordinal words by value: index 0 is "first". */
const ORDINAL_WORDS =
	"first second third fourth fifth sixth seventh eighth ninth tenth eleventh twelfth thirteenth fourteenth fifteenth sixteenth seventeenth eighteenth nineteenth twentieth".split(
		" ",
	);

/**
 * Nouns that make an adjacent ordinal or "one" a sequence position:
 * "second phase" equals "Phase 2", "year one" equals "Year 1".
 */
const SEQUENCE_NOUNS =
	"phase stage step wave milestone release iteration sprint tranche round gate tier level year month week day option increment cohort horizon workstream priority".split(
		" ",
	);

/** Number words by value: index 0 is "zero". */
const UNIT_WORDS =
	"zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split(
		" ",
	);

/** Tens words: index 0 is "twenty". */
const TENS_WORDS =
	"twenty thirty forty fifty sixty seventy eighty ninety".split(" ");

const SCALE_WORDS: Record<string, number> = {
	hundred: 100,
	thousand: 1e3,
	million: 1e6,
	billion: 1e9,
};

/** Power of ten for a magnitude suffix or word. */
function magnitudeExponent(mag: string | undefined): number {
	switch (mag?.trim().toLowerCase()) {
		case undefined:
		case "":
			return 0;
		case "k":
		case "thousand":
			return 3;
		case "m":
		case "mm":
		case "mn":
		case "million":
			return 6;
		case "b":
		case "bn":
		case "billion":
			return 9;
		default:
			// "tn", "trillion"
			return 12;
	}
}

/**
 * Canonical decimal string for `raw` (thousands separators allowed) times
 * 10^exponent, computed on the digit string so "1.2" x 10^6 is exactly
 * "1200000", never a float artifact.
 */
function canonicalNumber(raw: string, exponent = 0): string {
	const [intPart, fracPart = ""] = raw.replace(/,/g, "").split(".");
	const pointAt = intPart.length + exponent;
	const digits = (intPart + fracPart).padEnd(pointAt, "0");
	const whole = digits.slice(0, pointAt).replace(/^0+/, "") || "0";
	const fraction = digits.slice(pointAt).replace(/0+$/, "");
	return fraction ? `${whole}.${fraction}` : whole;
}

/** "26" is 2026; four-digit years pass through. */
function fullYear(year: string): string {
	return year.length === 2 ? `20${year}` : year;
}

function pad2(value: number): string {
	return value < 10 ? `0${value}` : String(value);
}

function isValidDay(month: number, day: number): boolean {
	return month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

function numberFact(
	kind: FactKind,
	key: string,
	provides: Array<string | null>,
	text: string,
	index: number,
): Fact {
	const unique = [key];
	for (const provided of provides) {
		if (provided && !unique.includes(provided)) {
			unique.push(provided);
		}
	}
	return { kind, key, provides: unique, text, index };
}

function plainNumber(canon: string, text: string, index: number): Fact {
	return numberFact("number", `num:${canon}`, [], text, index);
}

function money(
	currency: string,
	canon: string,
	text: string,
	index: number,
): Fact {
	return numberFact(
		"money",
		`money:${currency}:${canon}`,
		[`num:${canon}`],
		text,
		index,
	);
}

function percent(canon: string, text: string, index: number): Fact {
	return numberFact("percent", `pct:${canon}`, [`num:${canon}`], text, index);
}

/** A quarter or half-year period, calendar or fiscal ("Q3 FY26"). */
function period(
	unit: "quarter" | "half",
	ordinal: string,
	year: string | undefined,
	fiscal: boolean,
	text: string,
	index: number,
): Fact {
	const anyYear = `${unit}:*:${ordinal}`;
	if (!year) {
		return numberFact("date", anyYear, [], text, index);
	}
	const fy = fullYear(year);
	return numberFact(
		"date",
		`${unit}:${fiscal ? "FY" : ""}${fy}:${ordinal}`,
		[anyYear, `num:${fy}`, fiscal ? `fy:${fy}` : null],
		text,
		index,
	);
}

function calendarDate(
	month: number,
	day: number | null,
	year: string | undefined,
	text: string,
	index: number,
): Fact {
	const mm = pad2(month);
	const anyYearMonth = `month:*-${mm}`;
	if (day === null) {
		return year
			? numberFact(
					"date",
					`month:${year}-${mm}`,
					[anyYearMonth, `num:${year}`],
					text,
					index,
				)
			: numberFact("date", anyYearMonth, [], text, index);
	}
	const anyYearDay = `day:*-${mm}-${pad2(day)}`;
	return year
		? numberFact(
				"date",
				`date:${year}-${mm}-${pad2(day)}`,
				[
					`month:${year}-${mm}`,
					anyYearMonth,
					anyYearDay,
					`num:${year}`,
				],
				text,
				index,
			)
		: numberFact("date", anyYearDay, [anyYearMonth], text, index);
}

/** 1-12 for a month name or abbreviation ("Sept."), 0 when unknown. */
function monthNumber(name: string): number {
	const prefix = name.replace(/\.$/, "").toLowerCase().slice(0, 3);
	return MONTH_NAMES.findIndex((month) => month.startsWith(prefix)) + 1;
}

/** 1-20 for an ordinal word, else the digits of "1st"-"4th". */
function ordinalValue(word: string): number {
	const index = ORDINAL_WORDS.indexOf(word.toLowerCase());
	return index >= 0 ? index + 1 : Number.parseInt(word, 10);
}

/** 0-19 or a multiple of ten for a number word, else undefined. */
function smallNumberValue(word: string): number | undefined {
	const unit = UNIT_WORDS.indexOf(word);
	if (unit >= 0) {
		return unit;
	}
	const tens = TENS_WORDS.indexOf(word);
	return tens >= 0 ? (tens + 2) * 10 : undefined;
}

interface NumericPass {
	pattern: RegExp;
	/** Facts for one match, or null to leave the match unconsumed. */
	build: (match: RegExpExecArray) => Fact[] | null;
}

function re(source: string, flags = "gu"): RegExp {
	return new RegExp(source, flags);
}

const YEAR_AFTER_PERIOD = String.raw`(?:(?:\s+(?:of\s+)?|\s*[-/]\s*)(FY\s?)?(\d{4})|\s*['’](\d{2})|\s+FY\s?['’]?(\d{2}))`;

/**
 * Ordered passes: each consumes (blanks) its matches so a later, more
 * general pass never re-reads them — a date's day is not also a number.
 */
const NUMERIC_PASSES: NumericPass[] = [
	{
		// ISO date: 2026-03-15
		pattern: re(
			String.raw`(?<![\p{L}\p{N}])(\d{4})-(\d{2})-(\d{2})(?!\p{N})`,
		),
		build: (m) => {
			const month = Number(m[2]);
			const day = Number(m[3]);
			return isValidDay(month, day)
				? [calendarDate(month, day, m[1], m[0], m.index)]
				: null;
		},
	},
	...(["Q", "H"] as const).flatMap((letter): NumericPass[] => {
		const unit = letter === "Q" ? "quarter" : "half";
		const digit = letter === "Q" ? "[1-4]" : "[12]";
		return [
			{
				// Q3 2026, Q3-2026, Q3 of 2026, Q3 FY2026, Q3'26, Q3 FY26
				pattern: re(
					String.raw`(?<![\p{L}\p{N}])${letter}(${digit})${YEAR_AFTER_PERIOD}(?![\p{L}\p{N}])`,
				),
				build: (m) => [
					period(
						unit,
						m[1],
						m[3] ?? m[4] ?? m[5],
						Boolean(m[2]) || Boolean(m[5]),
						m[0],
						m.index,
					),
				],
			},
			{
				// 2026 Q3, 2026-Q3
				pattern: re(
					String.raw`(?<![\p{L}\p{N}])(\d{4})\s*-?\s*${letter}(${digit})(?![\p{L}\p{N}])`,
				),
				build: (m) => [period(unit, m[2], m[1], false, m[0], m.index)],
			},
			{
				// 3Q26, 3Q 2026
				pattern: re(
					String.raw`(?<![\p{L}\p{N}])(${digit})${letter}\s?(?:(\d{4})|['’]?(\d{2}))(?![\p{L}\p{N}])`,
				),
				build: (m) => [
					period(unit, m[1], m[2] ?? m[3], false, m[0], m.index),
				],
			},
		];
	}),
	{
		// third quarter of 2026, 3rd quarter, first fiscal quarter of FY26
		pattern: re(
			String.raw`(?<!\p{L})(first|second|third|fourth|1st|2nd|3rd|4th)\s+(?:fiscal\s+|calendar\s+)?quarter(?!\p{L})(?:\s+(?:of\s+)?(?:(FY)\s?['’]?(\d{4}|\d{2})|(\d{4})(?!\p{N})))?`,
			"giu",
		),
		build: (m) => [
			period(
				"quarter",
				String(ordinalValue(m[1])),
				m[3] ?? m[4],
				Boolean(m[2]),
				m[0],
				m.index,
			),
		],
	},
	{
		// second half of 2026 (a half needs its year to be a date)
		pattern: re(
			String.raw`(?<!\p{L})(first|second|1st|2nd)\s+half\s+(?:of\s+)?(?:(FY)\s?['’]?(\d{4}|\d{2})|(\d{4})(?!\p{N}))`,
			"giu",
		),
		build: (m) => [
			period(
				"half",
				String(ordinalValue(m[1])),
				m[3] ?? m[4],
				Boolean(m[2]),
				m[0],
				m.index,
			),
		],
	},
	{
		// Q3 with no year
		pattern: re(String.raw`(?<![\p{L}\p{N}])Q([1-4])(?![\p{L}\p{N}])`),
		build: (m) => [
			period("quarter", m[1], undefined, false, m[0], m.index),
		],
	},
	{
		// FY26, FY2026, FY 2026
		pattern: re(
			String.raw`(?<![\p{L}\p{N}])FY\s?['’]?(\d{4}|\d{2})(?!\p{N})`,
		),
		build: (m) => {
			const year = fullYear(m[1]);
			return [
				numberFact(
					"date",
					`fy:${year}`,
					[`num:${year}`],
					m[0],
					m.index,
				),
			];
		},
	},
	{
		// 15 March 2026, 15th of March, 15 Mar
		pattern: re(
			String.raw`(?<![\p{L}\p{N}])(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?${MONTH}(?:,?\s+(\d{4})(?!\p{N}))?`,
		),
		build: (m) => {
			const month = monthNumber(m[2]);
			const day = Number(m[1]);
			return isValidDay(month, day)
				? [calendarDate(month, day, m[3], m[0], m.index)]
				: null;
		},
	},
	{
		// March 15, 2026, March 15th
		pattern: re(
			String.raw`(?<!\p{L})${MONTH}\s+(\d{1,2})(?:st|nd|rd|th)?(?![\p{L}\p{N}])(?:,?\s+(\d{4})(?!\p{N}))?`,
		),
		build: (m) => {
			const month = monthNumber(m[1]);
			const day = Number(m[2]);
			return isValidDay(month, day)
				? [calendarDate(month, day, m[3], m[0], m.index)]
				: null;
		},
	},
	{
		// March 2026, Sept 2026, March of 2026
		pattern: re(
			String.raw`(?<!\p{L})${MONTH},?\s+(?:of\s+)?(\d{4})(?!\p{N})`,
		),
		build: (m) => [
			calendarDate(monthNumber(m[1]), null, m[2], m[0], m.index),
		],
	},
	{
		// A bare full month name. "May" alone is too often the verb.
		pattern: re(
			String.raw`(?<!\p{L})(January|February|March|April|June|July|August|September|October|November|December)(?!\p{L})`,
		),
		build: (m) => [
			calendarDate(monthNumber(m[1]), null, undefined, m[0], m.index),
		],
	},
	{
		// $240k, USD 240K, €3–5M, $3M to $5M
		pattern: re(
			String.raw`(?<![\p{L}\p{N}])(${CURRENCY_PREFIX})\s?(${NUM})(${MONEY_MAG})?(?:${RANGE_SEP}(?:(${CURRENCY_PREFIX})\s?)?(${NUM})(${MONEY_MAG})?)?(?![\p{L}\p{N}])`,
		),
		build: (m) => {
			const currency = CURRENCY_BY_SYMBOL[m[1]];
			if (m[5] === undefined) {
				return [
					money(
						currency,
						canonicalNumber(m[2], magnitudeExponent(m[3])),
						m[0],
						m.index,
					),
				];
			}
			const endCurrency = m[4] ? CURRENCY_BY_SYMBOL[m[4]] : currency;
			return [
				money(
					currency,
					canonicalNumber(m[2], magnitudeExponent(m[3] ?? m[6])),
					m[0],
					m.index,
				),
				money(
					endCurrency,
					canonicalNumber(m[5], magnitudeExponent(m[6] ?? m[3])),
					m[0],
					m.index,
				),
			];
		},
	},
	{
		// 240,000 dollars, 240k USD, 3–5 million euros
		pattern: re(
			String.raw`${NUM_START}(${NUM})(${BARE_MAG})?(?:${RANGE_SEP}(${NUM})(${BARE_MAG})?)?\s?(${CURRENCY_SUFFIX})(?!\p{L})`,
		),
		build: (m) => {
			const currency =
				CURRENCY_BY_SYMBOL[m[5]] ??
				CURRENCY_BY_WORD[m[5].slice(0, 4).toLowerCase()];
			const facts = [
				money(
					currency,
					canonicalNumber(m[1], magnitudeExponent(m[2] ?? m[4])),
					m[0],
					m.index,
				),
			];
			if (m[3] !== undefined) {
				facts.push(
					money(
						currency,
						canonicalNumber(m[3], magnitudeExponent(m[4] ?? m[2])),
						m[0],
						m.index,
					),
				);
			}
			return facts;
		},
	},
	{
		// 10–15%, 10 to 15 percent
		pattern: re(
			String.raw`${NUM_START}(${NUM})${RANGE_SEP}(${NUM})\s?${PERCENT_UNIT}`,
		),
		build: (m) => [
			percent(canonicalNumber(m[1]), m[0], m.index),
			percent(canonicalNumber(m[2]), m[0], m.index),
		],
	},
	{
		// 15%, 15 percent, 15 per cent
		pattern: re(String.raw`${NUM_START}(${NUM})\s?${PERCENT_UNIT}`),
		build: (m) => [percent(canonicalNumber(m[1]), m[0], m.index)],
	},
	{
		// 240k, 1.2 million, 3–5M, 3 to 5 million
		pattern: re(
			String.raw`${NUM_START}(${NUM})(${BARE_MAG})?(?:${RANGE_SEP}(${NUM}))?(${BARE_MAG})(?![\p{L}\p{N}])`,
		),
		build: (m) => {
			const facts = [
				plainNumber(
					canonicalNumber(m[1], magnitudeExponent(m[2] ?? m[4])),
					m[0],
					m.index,
				),
			];
			if (m[3] !== undefined) {
				facts.push(
					plainNumber(
						canonicalNumber(m[3], magnitudeExponent(m[4])),
						m[0],
						m.index,
					),
				);
			}
			return facts;
		},
	},
	{
		// 2nd, 3rd, 21st
		pattern: re(String.raw`${NUM_START}(\d+)(?:st|nd|rd|th)(?!\p{L})`),
		build: (m) => [plainNumber(canonicalNumber(m[1]), m[0], m.index)],
	},
	{
		// Any other number. Ranges ("3–5", "3 to 5") are two of these.
		pattern: re(String.raw`${NUM_START}(${NUM})(?!\p{N}|[.,]\d)`),
		build: (m) => [plainNumber(canonicalNumber(m[1]), m[0], m.index)],
	},
	{
		// second phase, third stage (but "first step" is only idiom-strength)
		pattern: re(
			String.raw`(?<!\p{L})(${ORDINAL_WORDS.join("|")})[\s-]+(?:${SEQUENCE_NOUNS.join("|")})(?!\p{L})`,
			"giu",
		),
		build: (m) => {
			const value = ordinalValue(m[1]);
			const fact = plainNumber(String(value), m[0], m.index);
			return [value === 1 ? { ...fact, weak: true } : fact];
		},
	},
];

/** All matches of `pattern` (made global) in `text`, without shared lastIndex state. */
function allMatches(text: string, pattern: RegExp): RegExpExecArray[] {
	const flags = pattern.flags.includes("g")
		? pattern.flags
		: `${pattern.flags}g`;
	const regex = new RegExp(pattern.source, flags);
	const matches: RegExpExecArray[] = [];
	for (let m = regex.exec(text); m !== null; m = regex.exec(text)) {
		matches.push(m);
		if (m[0].length === 0) {
			regex.lastIndex++;
		}
	}
	return matches;
}

/** Replace each span with spaces (newlines kept), preserving every offset. */
function blank(text: string, spans: ReadonlyArray<[number, number]>): string {
	if (spans.length === 0) {
		return text;
	}
	let out = "";
	let cursor = 0;
	for (const [start, end] of spans) {
		out += text.slice(cursor, start);
		out += text.slice(start, end).replace(/[^\n]/g, " ");
		cursor = end;
	}
	return out + text.slice(cursor);
}

function blankMatches(text: string, pattern: RegExp): string {
	return blank(
		text,
		allMatches(text, pattern).map((m): [number, number] => [
			m.index,
			m.index + m[0].length,
		]),
	);
}

// ---------------------------------------------------------------------------
// Markup that never carries facts
// ---------------------------------------------------------------------------

const HTML_TAG = /<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]{0,1000})?\/?>/g;
const HTML_COMMENT_OPEN = /<!--/g;
const MARKDOWN_IMAGE =
	/!\[[^\]\n]{0,500}\]\(([^()\s]{0,2000})(?:\s+"[^"\n]{0,500}")?\)/g;
const MARKDOWN_LINK =
	/(?<!!)\[[^\]\n]{0,500}\]\(([^()\s]{0,2000})(?:\s+"[^"\n]{0,500}")?\)/g;
const MARKDOWN_LINK_TARGET =
	/(?<=\])\([^()\s]{0,2000}(?:\s+"[^"\n]{0,500}")?\)/g;
const MARKDOWN_REFERENCE_DEFINITION = /^ {0,3}\[[^\]\n]{1,500}\]:[ \t]*(\S+)/gm;
const URL = /(?<![\w/@.])(?:https?:\/\/|www\.)[^\s<>()[\]{}"'`]+/gi;
const EMAIL = /(?<![\w.%+-])[\w.%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const FOOTNOTE_REFERENCE = /\[\^[^\]\s]{1,50}\]/g;
const LIST_MARKER = /^[ \t]*(?:[-*+•]|\d{1,3}[.)])[ \t]+/gm;
const HEADING_MARKER =
	/^[ \t]{0,3}#{1,6}[ \t]+(?:\d{1,3}[A-Za-z]?[.)][ \t]+)?/gm;
const BLOCKQUOTE_MARKER = /^[ \t]*>+[ \t]?/gm;

/**
 * Every fence-marker line, counted as a structural token. Deliberately not
 * `scanFences`: a marker-shaped line counts wherever it sits, even inside
 * another fence, so an output cannot slip an extra marker in by nesting it,
 * and a source that quotes markers inside a fence still vouches for them.
 * Only the marker grammar is shared.
 */
const FENCE_LINE = new RegExp(FENCE_MARKER.source, "gm");

/** Blank markup whose digits and words are not prose: tags, URLs, list numbers. */
function premask(text: string): string {
	let work = text;
	for (const pattern of [
		HTML_TAG,
		MARKDOWN_LINK_TARGET,
		URL,
		EMAIL,
		FOOTNOTE_REFERENCE,
		LIST_MARKER,
		HEADING_MARKER,
		BLOCKQUOTE_MARKER,
	]) {
		work = blankMatches(work, pattern);
	}
	return work;
}

// ---------------------------------------------------------------------------
// Fact extraction
// ---------------------------------------------------------------------------

interface WordToken {
	word: string;
	start: number;
	end: number;
}

const WORD = /(?<![\p{L}\p{M}\p{N}_])\p{L}[\p{L}\p{M}\p{N}]*/gu;

function wordTokens(text: string): WordToken[] {
	return allMatches(text, WORD).map((m) => ({
		word: m[0],
		start: m.index,
		end: m.index + m[0].length,
	}));
}

const WORD_CHAR = /[\p{L}\p{M}\p{N}_]/u;

/**
 * Word tokens of the fact-blanked `work` that are words of `original` too.
 * Blanking the "2" of "Option 2B" leaves a lone "B" that the raw source never
 * tokenizes, so a verbatim copy would read as a new word.
 */
function proseWords(original: string, work: string): WordToken[] {
	return wordTokens(work).filter(
		(token) =>
			token.start === 0 || !WORD_CHAR.test(original[token.start - 1]),
	);
}

/** "percent" right after spelled-out numbers: "fifteen percent". */
const PERCENT_AFTER_WORDS = new RegExp(String.raw`^\s?${PERCENT_UNIT}`, "u");

/**
 * Spelled-out numbers: "twelve", "twenty-five", "one hundred and twenty",
 * "three million", "fifteen percent". A bare "one" is weak unless it follows
 * a sequence noun ("phase one").
 */
function numberWordFacts(work: string): {
	facts: Fact[];
	spans: Array<[number, number]>;
} {
	const tokens = wordTokens(work);
	const facts: Fact[] = [];
	const spans: Array<[number, number]> = [];
	let i = 0;
	while (i < tokens.length) {
		const parsed = parseNumberWords(work, tokens, i);
		if (!parsed) {
			i++;
			continue;
		}
		const start = tokens[i].start;
		let end = tokens[parsed.lastIndex].end;
		const unit = PERCENT_AFTER_WORDS.exec(work.slice(end, end + 12));
		if (unit) {
			end += unit[0].length;
		}
		const text = work.slice(start, end);
		const canon = String(parsed.value);
		const previous = i > 0 ? tokens[i - 1] : null;
		const afterSequenceNoun =
			previous !== null &&
			SEQUENCE_NOUNS.includes(previous.word.toLowerCase()) &&
			/^[ \t]+$/.test(work.slice(previous.end, start));
		const fact = unit
			? percent(canon, text, start)
			: plainNumber(canon, text, start);
		facts.push(
			parsed.value === 1 && !parsed.hasScale && !afterSequenceNoun
				? { ...fact, weak: true }
				: fact,
		);
		spans.push([start, end]);
		i = parsed.lastIndex + 1;
	}
	return { facts, spans };
}

/**
 * "unit" (1-9) may follow a tens word ("twenty-five"); "teen" (0, 10-19)
 * and "tens" may not follow another number word.
 */
function numberWordClass(value: number): "unit" | "teen" | "tens" {
	if (value >= 20) {
		return "tens";
	}
	return value >= 10 || value === 0 ? "teen" : "unit";
}

function parseNumberWords(
	text: string,
	tokens: WordToken[],
	startIndex: number,
): { value: number; lastIndex: number; hasScale: boolean } | null {
	if (smallNumberValue(tokens[startIndex].word.toLowerCase()) === undefined) {
		return null;
	}
	let total = 0;
	let current = 0;
	let previous: "unit" | "teen" | "tens" | "hundred" | "scale" | null = null;
	let hasScale = false;
	let lastIndex = startIndex;
	for (let k = startIndex; k < tokens.length; k++) {
		if (
			k > startIndex &&
			!/^[ \t-]*$/.test(text.slice(tokens[k - 1].end, tokens[k].start))
		) {
			break;
		}
		const word = tokens[k].word.toLowerCase();
		if (
			word === "and" &&
			(previous === "hundred" || previous === "scale")
		) {
			continue;
		}
		const small = smallNumberValue(word);
		const scale = SCALE_WORDS[word];
		if (small !== undefined) {
			const kind = numberWordClass(small);
			const allowed =
				previous === null ||
				previous === "hundred" ||
				previous === "scale" ||
				(previous === "tens" && kind === "unit");
			if (!allowed) {
				break;
			}
			current += small;
			previous = kind;
		} else if (scale === 100) {
			if (previous !== "unit" && previous !== "teen") {
				break;
			}
			current *= 100;
			previous = "hundred";
			hasScale = true;
		} else if (scale !== undefined) {
			if (previous === null || previous === "scale") {
				break;
			}
			total += current * scale;
			current = 0;
			previous = "scale";
			hasScale = true;
		} else {
			break;
		}
		lastIndex = k;
	}
	return { value: total + current, lastIndex, hasScale };
}

/** Numeric facts (money, percent, number, date) and the text left after them. */
function scanNumeric(text: string): { facts: Fact[]; work: string } {
	let work = premask(text);
	const facts: Fact[] = [];
	for (const pass of NUMERIC_PASSES) {
		const spans: Array<[number, number]> = [];
		for (const m of allMatches(work, pass.pattern)) {
			const built = pass.build(m);
			if (built) {
				facts.push(...built);
				spans.push([m.index, m.index + m[0].length]);
			}
		}
		work = blank(work, spans);
	}
	const words = numberWordFacts(work);
	facts.push(...words.facts);
	work = blank(work, words.spans);
	return { facts: facts.sort((a, b) => a.index - b.index), work };
}

const COMMITMENT =
	/\b(?:guarantee(?:s|d|ing)?|commit(?:s|ted|ting|ments?)?|promis(?:e|es|ed|ing)|pledg(?:e|es|ed|ing)|warrant(?:s|ed|y|ies)?|binding|fixed[- ](?:price|fee)|shall)\b/gi;

/** One key per commitment, so "committed" in the source covers "commits". */
const COMMITMENT_STEMS =
	"guarantee commit promis pledg warrant binding fixed shall".split(" ");

function commitmentFacts(work: string): Fact[] {
	return allMatches(work, COMMITMENT).map((m) => {
		const lower = m[0].toLowerCase();
		const stemmed =
			COMMITMENT_STEMS.find((prefix) => lower.startsWith(prefix)) ??
			lower;
		const key = `commitment:${stemmed}`;
		return {
			kind: "commitment",
			key,
			provides: [key],
			text: m[0],
			index: m.index,
		};
	});
}

/**
 * Words that are never proper names, even capitalized. Lowercase.
 */
const COMMON_WORDS = new Set(
	[
		// Function words and pronouns.
		`a an the this that these those it its we our ours us you your they their them he she his her i my me
		there here and or but so yet nor if then else when while where whereas which who whom whose what why how
		as at by for from in into of on onto to with within without across after before during since until upon
		over under above below between among through throughout beyond via per versus vs about around against
		along toward towards despite following given once unless although though because all any both each every
		either neither few many most much more less least several some such other another same own only just also
		too very not no yes none nothing one is are was were be been being am has have had do does did will would
		shall should can could may might must let up down out off`,
		// Discourse openers.
		`overall however therefore thus hence accordingly additionally moreover furthermore further finally
		first firstly second secondly third lastly next now today currently initially ultimately importantly
		notably specifically meanwhile instead otherwise together similarly likewise still already again soon
		later early please note see`,
		// Generic business nouns, adjectives, and imperatives an executive rewrite opens with.
		`key main core total new current existing proposed planned expected estimated approximately roughly
		nearly almost summary recommendation decision budget cost costs investment benefit benefits risk risks
		timeline scope approach background context objective objectives goal goals outcome outcomes step steps
		phase stage option options pros cons owner status approval action actions impact value savings result
		results success growth demand revenue spend funding headcount staff team teams customers users
		performance security compliance quality delivery support operations adoption migration rollout go live
		approve proceed adopt fund invest delay defer move start begin continue launch deliver build buy reduce
		cut save retire replace consolidate migrate implement pilot scale expand complete plan`,
		// Generic acronyms.
		"roi kpi kpis tco fte ftes mvp poc api apis ceo cfo cto cio coo it ai hr ui ux faq tbd tbc ok",
	]
		.join(" ")
		.split(/\s+/),
);

/** A sentence-initial -ing, -ly, or -ed word is an ordinary word, not a name. */
const COMMON_MORPHOLOGY = /^\p{Lu}\p{Ll}{2,}(?:ing|ly|ed)$/u;

/** "Go-live", "Follow-up": a capitalized first half of a lowercase compound. */
const LOWERCASE_COMPOUND_TAIL = /^-\p{Ll}/u;

/** An acronym, optionally plural: "NPV", "KPIs". */
const ACRONYM = /^\p{Lu}{2,6}s?$/u;

/** Words an acronym may skip: "TCO" is total cost of ownership. */
const ACRONYM_SKIPPED_WORDS = new Set(
	"of and the for to in on a an".split(" "),
);

/** Characters that end a sentence or open a clause; a table cell is a clause. */
const SENTENCE_BOUNDARY = new Set([...".!?:|\n"]);

/** Characters that may sit between a boundary and the clause's first word. */
const OPENERS = new Set([..." \t\r*_>#-+•\"“‘'([–—`~"]);

/** Whether only openers stand between `index` and a sentence, line, or clause start. */
function isSentenceInitial(text: string, index: number): boolean {
	for (let i = index - 1; i >= 0; i--) {
		const ch = text[i];
		if (SENTENCE_BOUNDARY.has(ch)) {
			return true;
		}
		if (!OPENERS.has(ch)) {
			return false;
		}
	}
	return true;
}

function nameFacts(original: string, work: string): Fact[] {
	const facts: Fact[] = [];
	for (const token of proseWords(original, work)) {
		if (!/^\p{Lu}/u.test(token.word)) {
			continue;
		}
		const lower = token.word.toLowerCase();
		if (COMMON_WORDS.has(lower)) {
			continue;
		}
		const sentenceInitial = isSentenceInitial(work, token.start);
		if (
			sentenceInitial &&
			(COMMON_MORPHOLOGY.test(token.word) ||
				LOWERCASE_COMPOUND_TAIL.test(
					original.slice(token.end, token.end + 2),
				))
		) {
			continue;
		}
		const key = `name:${lower}`;
		facts.push({
			kind: "name",
			key,
			provides: [key],
			text: token.word,
			index: token.start,
			sentenceInitial,
		});
	}
	return facts;
}

/**
 * Every figure, date, proper name, and commitment term in `text`, in order.
 *
 * Figures and dates carry canonical keys (see `normalizeFact`). Names are
 * capitalized words outside a common-word stoplist; `sentenceInitial` marks
 * those that open a sentence, list item, or clause. Commitment terms are
 * guarantee, commit, promise, pledge, warrant, binding, fixed price or fee,
 * and shall. Digits inside URLs, emails, HTML tags, list markers, and
 * heading numbers are not facts.
 */
export function extractFacts(text: string): Fact[] {
	const { facts, work } = scanNumeric(text);
	return [...facts, ...commitmentFacts(work), ...nameFacts(text, work)].sort(
		(a, b) => a.index - b.index,
	);
}

/**
 * The canonical form of the figures and dates `text` states, or null when it
 * states none. Two strings normalize equal when they state the same facts:
 * "$240k", "$240,000", and "USD 240K"; "Q3 2026" and "third quarter of
 * 2026"; "Phase 2" and "second phase"; "3–5" and "3 to 5".
 */
export function normalizeFact(text: string): string | null {
	const { facts } = scanNumeric(text);
	return facts.length > 0 ? facts.map((fact) => fact.key).join(" ") : null;
}

function providedKeys(facts: readonly Fact[]): Set<string> {
	const keys = new Set<string>();
	for (const fact of facts) {
		for (const key of fact.provides) {
			keys.add(key);
		}
	}
	return keys;
}

function isFigure(fact: Fact): boolean {
	return fact.kind !== "name" && fact.kind !== "commitment";
}

// ---------------------------------------------------------------------------
// Words and stems
// ---------------------------------------------------------------------------

/** Suffixes the crude stemmer strips, longest first. */
const STEM_SUFFIXES =
	"ements ement ments ment ings ing ities ity ness ions ion ers er als al ies ied ed es ly s y e".split(
		" ",
	);

/**
 * A crude stem so "Retirement" matches "retire", "Approve" matches
 * "approval", and "Databricks's" matches "databricks": strip one common
 * suffix, then a trailing "e".
 */
function stem(word: string): string {
	const lower = word.toLowerCase();
	for (const suffix of STEM_SUFFIXES) {
		if (
			lower.endsWith(suffix) &&
			lower.length - suffix.length >= 3 &&
			!(suffix === "s" && lower.endsWith("ss"))
		) {
			const base = lower.slice(0, -suffix.length);
			return base.length > 3 && base.endsWith("e")
				? base.slice(0, -1)
				: base;
		}
	}
	return lower;
}

function stemSet(words: Iterable<string>): Set<string> {
	const stems = new Set<string>();
	for (const word of words) {
		stems.add(stem(word));
	}
	return stems;
}

/**
 * Initials of every run of two to six consecutive words, with and without
 * skippable words, so "NPV" is present when the source says "net present
 * value" and "TCO" when it says "total cost of ownership".
 */
function initialisms(words: readonly string[]): Set<string> {
	const lower = words.map((word) => word.toLowerCase());
	const runs = [
		lower,
		lower.filter((word) => !ACRONYM_SKIPPED_WORDS.has(word)),
	];
	const found = new Set<string>();
	for (const run of runs) {
		for (let i = 0; i < run.length; i++) {
			let initials = run[i][0];
			for (let j = i + 1; j < run.length && j < i + 6; j++) {
				initials += run[j][0];
				found.add(initials);
			}
		}
	}
	return found;
}

// ---------------------------------------------------------------------------
// Sentences
// ---------------------------------------------------------------------------

const BLOCK_START = /^\s*(?:[-*+•]\s|\d{1,3}[.)]\s|\||#{1,6}\s|>)/;

/** Words whose trailing period does not end a sentence. */
const ABBREVIATIONS = new Set(
	"e.g i.e etc vs approx est inc ltd co corp no mr mrs ms dr st fig cf al jr sr".split(
		" ",
	),
);

/** Paragraphs, list items, table rows, and headings; soft-wrapped lines joined. */
function splitBlocks(text: string): string[] {
	const blocks: string[] = [];
	let current: string[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim() || BLOCK_START.test(line)) {
			if (current.length > 0) {
				blocks.push(current.join(" "));
			}
			current = [];
		}
		if (line.trim()) {
			current.push(line);
		}
	}
	if (current.length > 0) {
		blocks.push(current.join(" "));
	}
	return blocks;
}

function splitSentences(text: string): string[] {
	const sentences: string[] = [];
	for (const block of splitBlocks(text)) {
		let start = 0;
		// Matching only at the head of a punctuation run finds the same ends
		// and scans a long run once.
		for (const m of allMatches(block, /(?<![.!?])[.!?]+(?=\s)/g)) {
			const end = m.index + m[0].length;
			if (m[0] === "." && isAbbreviation(block, m.index)) {
				continue;
			}
			let next = end;
			while (next < block.length && /\s/.test(block[next])) {
				next++;
			}
			if (next < block.length && /\p{Ll}/u.test(block[next])) {
				continue;
			}
			sentences.push(block.slice(start, end).trim());
			start = end;
		}
		const tail = block.slice(start).trim();
		if (tail) {
			sentences.push(tail);
		}
	}
	return sentences;
}

/** Whether the word ending at `dotIndex` is an abbreviation or an initial. */
function isAbbreviation(block: string, dotIndex: number): boolean {
	let start = dotIndex;
	while (start > 0 && /[\p{L}.]/u.test(block[start - 1])) {
		start--;
	}
	const word = block.slice(start, dotIndex).toLowerCase();
	return ABBREVIATIONS.has(word) || /^\p{L}$/u.test(word);
}

// ---------------------------------------------------------------------------
// Hedges
// ---------------------------------------------------------------------------

/**
 * Terms that mark a source statement as not confirmed: the qualifiers
 * cleanup writes for tagged claims (indicative, assumed, to be confirmed,
 * dependent) and natural hedges.
 */
const HEDGE_MARKER_TERMS = String.raw`\b(?:indicative|assum(?:e|es|ed|ing|ptions?)|to\s+be\s+(?:confirmed|determined)|tb[cd]|unconfirmed|not\s+yet\s+confirmed|pending\s+confirmation|dependent|depends\s+on|depending\s+on|contingent|expect(?:s|ed|ing)?|estimat(?:e|es|ed|ing)|approximately|approx|circa|roughly|projected|projections?|anticipat(?:e|es|ed|ing)|subject\s+to|forecast(?:s|ed|ing)?|preliminary|provisional|tentative(?:ly)?)\b|\best\.|~\s?\d`;

/**
 * Further qualifiers an output sentence may use to keep a hedge. Broader
 * than the markers on purpose: detecting a hedge strictly and accepting a
 * qualifier generously both lower false positives.
 */
const QUALIFIER_EXTRA_TERMS = String.raw`\b(?:around|about|nearly|almost|up\s+to|may|might|could|would|should|likely|possibl[ey]|potential(?:ly)?|target(?:s|ed|ing)?|aim(?:s|ed|ing)?|planned|if|unless|provided|pending)\b`;

const HEDGE_MARKER = new RegExp(HEDGE_MARKER_TERMS, "iu");
const QUALIFIER = new RegExp(
	`${HEDGE_MARKER_TERMS}|${QUALIFIER_EXTRA_TERMS}`,
	"iu",
);

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

function clip(text: string): string {
	const single = text.replace(/\s+/g, " ").trim();
	return single.length > MAX_VIOLATION_TEXT
		? `${single.slice(0, MAX_VIOLATION_TEXT - 1)}…`
		: single;
}

function violation(
	kind: FactGuardViolationKind,
	text: string,
	message: string,
): FactGuardViolation {
	const clipped = clip(text);
	// A function replacer: figures like "$240k" must not be read as `$` patterns.
	return {
		kind,
		text: clipped,
		message: message.replace("%s", () => clipped),
	};
}

function toResult(violations: FactGuardViolation[]): FactGuardResult {
	const seen = new Set<string>();
	const unique = violations.filter((item) => {
		const id = `${item.kind}\u0000${item.text}`;
		if (seen.has(id)) {
			return false;
		}
		seen.add(id);
		return true;
	});
	return unique.length === 0
		? { pass: true }
		: { pass: false, violations: unique };
}

function presenceViolations(
	source: string,
	sourceFacts: Fact[],
	output: string,
	outputFacts: Fact[],
): FactGuardViolation[] {
	const provided = providedKeys(
		sourceFacts.filter((fact) => fact.kind !== "name"),
	);
	const sourceWords = wordTokens(source).map((token) => token.word);
	const sourceStems = stemSet(sourceWords);
	const sourceInitialisms = initialisms(sourceWords);
	const outputLowercaseStems = stemSet(
		wordTokens(output)
			.map((token) => token.word)
			.filter((word) => /^\p{Ll}/u.test(word)),
	);
	const violations: FactGuardViolation[] = [];
	for (const fact of outputFacts) {
		if (fact.kind === "name") {
			const stemmed = stem(fact.text);
			const acronymOfSource =
				ACRONYM.test(fact.text) &&
				sourceInitialisms.has(
					fact.text.replace(/s$/, "").toLowerCase(),
				);
			if (
				!sourceStems.has(stemmed) &&
				!outputLowercaseStems.has(stemmed) &&
				!acronymOfSource
			) {
				violations.push(
					violation(
						"presence",
						fact.text,
						'Name "%s" does not appear in the source.',
					),
				);
			}
		} else if (!fact.weak && !provided.has(fact.key)) {
			violations.push(
				violation(
					"presence",
					fact.text,
					fact.kind === "commitment"
						? 'Commitment term "%s" does not appear in the source.'
						: '"%s" does not appear in the source; keep figures and dates exactly as written there.',
				),
			);
		}
	}
	return violations;
}

function hedgeViolations(source: string, output: string): FactGuardViolation[] {
	const sourceSentences = splitSentences(source).map((sentence) => ({
		hedged: HEDGE_MARKER.test(sentence),
		provided: providedKeys(scanNumeric(sentence).facts),
	}));
	const violations: FactGuardViolation[] = [];
	for (const sentence of splitSentences(output)) {
		if (QUALIFIER.test(sentence)) {
			continue;
		}
		for (const fact of scanNumeric(sentence).facts) {
			if (fact.weak) {
				continue;
			}
			const stating = sourceSentences.filter((item) =>
				item.provided.has(fact.key),
			);
			if (stating.length > 0 && stating.every((item) => item.hedged)) {
				violations.push(
					violation(
						"hedge",
						fact.text,
						'The source does not confirm "%s"; keep a qualifier such as "expected" or "assumed" in the same sentence.',
					),
				);
			}
		}
	}
	return violations;
}

function mustKeepViolations(
	sourceFacts: Fact[],
	outputFacts: Fact[],
): FactGuardViolation[] {
	const kept = providedKeys(outputFacts.filter(isFigure));
	return sourceFacts
		.filter((fact) => isFigure(fact) && !fact.weak && !kept.has(fact.key))
		.map((fact) =>
			violation(
				"must-keep",
				fact.text,
				'"%s" from the source is missing; a key section keeps every figure and date.',
			),
		);
}

/** Multiset difference: items in `output` beyond their count in `source`. */
function addedItems(source: string[], output: string[]): string[] {
	const remaining = new Map<string, number>();
	for (const item of source) {
		remaining.set(item, (remaining.get(item) ?? 0) + 1);
	}
	const added: string[] = [];
	for (const item of output) {
		const count = remaining.get(item) ?? 0;
		if (count > 0) {
			remaining.set(item, count - 1);
		} else {
			added.push(item);
		}
	}
	return added;
}

const SLOT_TAG_NAME = new RegExp(String.raw`^</?${VISUAL_SLOT_TAG}\b`, "i");

/**
 * Negating words, one list for both directions: an added one fails as
 * structural, a dropped one as negation. It holds every word the rewrite
 * prompt's two negation rules name, so the guard enforces what the prompt
 * states. Contractions match whole, so a finding quotes "isn't", not "n't".
 */
const NEGATOR =
	/\b(?:no\s+longer|nothing|nobody|nowhere|neither|never|cannot|without|none|nor|not|no)\b|\b[a-z]+n['’]t\b/gi;

/** What follows "No" in "No. of seats" or "No. 4": the number abbreviation. */
const NUMBER_ABBREVIATION = /^\.\s?(?:\d|of\b)/;

/** What follows "not" in "not only … but also". */
const NOT_ONLY = /^\s+only\b/i;

/** What follows "no" in "no matter how" or "no doubt". */
const NO_MATTER_OR_DOUBT = /^\s+(?:matter|doubt)\b/i;

/**
 * A hyphen joining "no" to the next word, as in "no-code", "no-show", or
 * "go/no-go". "No-one" and "no-longer" still negate.
 */
const NO_COMPOUND_AFTER = /^[-‐‑](?!one\b|longer\b)\p{L}/iu;

/** A hyphen joining "no" to the previous word, as in "yes-no". */
const NO_COMPOUND_BEFORE = /\p{L}[-‐‑]$/u;

/** How far past a match the fixed-phrase checks look. */
const PHRASE_WINDOW = 32;

/**
 * Whether a negating-word match negates anything. Neither direction counts
 * the number abbreviation, "not only", "no matter", "no doubt", or a "no-"
 * compound. Only "no" compounds are skipped: a "not-" or "never-" compound
 * ("not-yet-approved") usually still negates, and counting a harmless one
 * only keeps the source wording.
 */
function isNegatingUse(prose: string, m: RegExpExecArray): boolean {
	const word = m[0].toLowerCase();
	const end = m.index + m[0].length;
	const after = prose.slice(end, end + PHRASE_WINDOW);
	if (word === "not") {
		return !NOT_ONLY.test(after);
	}
	if (word !== "no") {
		return true;
	}
	return !(
		NUMBER_ABBREVIATION.test(after) ||
		NO_MATTER_OR_DOUBT.test(after) ||
		NO_COMPOUND_AFTER.test(after) ||
		NO_COMPOUND_BEFORE.test(prose.slice(Math.max(0, m.index - 2), m.index))
	);
}

/**
 * The prose the negation checks read, offsets preserved. Alt text is
 * blanked: a rewrite carries no image (an added one fails as structural),
 * so alt text holds no negation the output could keep. Premasking drops
 * URLs, link targets, and tags.
 */
function negationProse(text: string): string {
	return premask(blankMatches(text, MARKDOWN_IMAGE));
}

interface NegatingWord {
	/** Lowercased, whitespace collapsed: "no longer", "isn't". */
	word: string;
	index: number;
}

/** Negating words in `prose`, in order, skipping uses that negate nothing. */
function negatingWords(prose: string): NegatingWord[] {
	return allMatches(prose, NEGATOR)
		.filter((m) => isNegatingUse(prose, m))
		.map((m) => ({
			word: m[0].toLowerCase().replace(/\s+/g, " "),
			index: m.index,
		}));
}

function withoutLinks(text: string): string {
	return blankMatches(
		blankMatches(blankMatches(text, MARKDOWN_IMAGE), MARKDOWN_LINK),
		MARKDOWN_REFERENCE_DEFINITION,
	);
}

/**
 * Negators by group, the unit both negation counts compare: rephrasing "no
 * contingency" as "does not include contingency" stays in one group, while
 * "never" is a group of its own, so swapping "not" for it adds one and drops
 * the other.
 */
function negatorGroup(word: string): string {
	return word.toLowerCase() === "never" ? "never" : "not";
}

/**
 * Structural items per category, compared as a multiset: the output fails
 * for each item beyond the source's count of it. Negating words are counted
 * per negator group by `negationViolations` instead.
 */
const STRUCTURAL_CATEGORIES: Array<{
	label: string;
	items: (text: string) => string[];
}> = [
	{
		label: "markdown image",
		items: (text) => allMatches(text, MARKDOWN_IMAGE).map((m) => m[1]),
	},
	{
		label: "markdown link",
		items: (text) => [
			...allMatches(text, MARKDOWN_LINK).map((m) => m[1]),
			...allMatches(text, MARKDOWN_REFERENCE_DEFINITION).map((m) => m[1]),
		],
	},
	{
		label: "URL",
		items: (text) =>
			allMatches(withoutLinks(text), URL).map((m) =>
				m[0].replace(/[.,;:!?]+$/, ""),
			),
	},
	{
		label: "email address",
		items: (text) =>
			allMatches(withoutLinks(text), EMAIL).map((m) =>
				m[0].toLowerCase(),
			),
	},
	{
		label: "visual slot tag",
		items: (text) =>
			allMatches(text, HTML_TAG)
				.map((m) => m[0])
				.filter(
					(tag) => SLOT_TAG_NAME.test(tag) && !tag.startsWith("</"),
				)
				.map((tag) => tag.replace(/\s+/g, " ")),
	},
	{
		label: "HTML tag",
		items: (text) => [
			...allMatches(text, HTML_TAG)
				.map((m) => m[0])
				.filter((tag) => !SLOT_TAG_NAME.test(tag))
				.map((tag) => tag.replace(/\s+/g, " ").toLowerCase()),
			...allMatches(text, HTML_COMMENT_OPEN).map((m) => m[0]),
		],
	},
	{
		label: "code fence",
		items: (text) => allMatches(text, FENCE_LINE).map((m) => m[0].trim()),
	},
	{
		label: "heading",
		items: (text) =>
			parseOutline(text).map((heading) => headingAnchor(heading.text)),
	},
];

function structuralViolations(
	source: string,
	output: string,
): FactGuardViolation[] {
	const violations: FactGuardViolation[] = [];
	for (const { label, items } of STRUCTURAL_CATEGORIES) {
		for (const item of addedItems(items(source), items(output))) {
			violations.push(
				violation(
					"structural",
					item,
					`Adds a ${label} the source does not have: %s`,
				),
			);
		}
	}
	return violations;
}

function wordsInGroup(words: readonly string[], group: string): string[] {
	return words.filter((word) => negatorGroup(word) === group);
}

/**
 * A sentence end or semicolon closes a clause; "2.5" and "example.com" do
 * not. The lookbehind starts a match only at the head of a punctuation run,
 * so a long run is scanned once.
 */
const CLAUSE_END = /(?<![.!?])[.!?]+(?=\s|$)|;/g;

/**
 * A blank line, or a line break before a list item, table row, blockquote,
 * or heading, also closes one. A lone line break does not, so a
 * soft-wrapped sentence stays one clause. Read on the unmasked text, since
 * premasking blanks the markers.
 */
const BLOCK_BREAK =
	/\n[ \t]*\n|\n(?=[ \t]*(?:[-*+•][ \t]|\d{1,3}[.)][ \t]|[|>#]))/g;

/** Function words too common to align two clauses on. */
const CLAUSE_STOP_WORDS = new Set(
	(
		"the and for with from that this these those are was were will would " +
		"shall should can could may might must has have had been being does " +
		"did its our their they them your into onto than then also but all " +
		"any each per via who whom which what when where how why there here " +
		"only just more most very such both either over under about after " +
		"before while within across between out off too yet still"
	).split(" "),
);

/** Two clauses align only when they share this many content words… */
const CLAUSE_MIN_SHARED = 2;
/** …and their content words have at least this Jaccard similarity. */
const CLAUSE_MIN_SIMILARITY = 0.5;
/** Words a finding quotes from the start of a clause. */
const CLAUSE_LEAD_WORDS = 8;
/**
 * Beyond this many clauses on either side the clause check is skipped and
 * the totals alone apply: it bounds the alignment work on untrusted input,
 * far above any one section a rewrite covers.
 */
const MAX_ALIGNED_CLAUSES = 400;

interface Clause {
	/** Lowercased words of 3+ letters, without negators or stop words. */
	words: Set<string>;
	/** The clause's negating words. */
	negators: string[];
	/** The clause's first words, as a finding quotes them. */
	lead: string;
}

function clauseLead(clause: string): string {
	const words = clause.trim().split(/\s+/).filter(Boolean);
	const lead = words.slice(0, CLAUSE_LEAD_WORDS);
	if (words.length > CLAUSE_LEAD_WORDS) {
		return `${lead.join(" ")}…`;
	}
	let text = lead.join(" ");
	while (text.length > 0 && ".!?;".includes(text.charAt(text.length - 1))) {
		text = text.slice(0, -1);
	}
	return text;
}

/**
 * `text` split into clauses. `prose` is its `negationProse` and `negators`
 * its `negatingWords`, so a clause holds exactly the negating words the
 * section-wide counts saw.
 */
function clausesOf(
	text: string,
	prose: string,
	negators: readonly NegatingWord[],
): Clause[] {
	const cuts = [
		...allMatches(prose, CLAUSE_END).map((m) => m.index + m[0].length),
		...allMatches(text, BLOCK_BREAK).map((m) => m.index),
		prose.length,
	].sort((a, b) => a - b);
	// Every negator match leaves the content words, negating or not.
	const content = blankMatches(prose, NEGATOR);
	const clauses: Clause[] = [];
	let start = 0;
	let next = 0;
	for (const end of cuts) {
		if (end <= start) {
			continue;
		}
		const clauseNegators: string[] = [];
		for (; next < negators.length && negators[next].index < end; next++) {
			clauseNegators.push(negators[next].word);
		}
		clauses.push({
			words: new Set(
				allMatches(content.slice(start, end), WORD)
					.map((m) => m[0].toLowerCase())
					.filter(
						(word) =>
							word.length >= 3 && !CLAUSE_STOP_WORDS.has(word),
					),
			),
			negators: clauseNegators,
			lead: clauseLead(prose.slice(start, end)),
		});
		start = end;
	}
	return clauses;
}

/**
 * Source and rewrite clauses that align with confidence: each is the
 * other's only confident match. A clause that confidently matches two, as
 * a merge or a split does, aligns with nothing, so condensing falls back
 * to the section-wide counts.
 */
function alignedClauses(
	source: readonly Clause[],
	output: readonly Clause[],
): Array<[Clause, Clause]> {
	if (
		source.length > MAX_ALIGNED_CLAUSES ||
		output.length > MAX_ALIGNED_CLAUSES
	) {
		return [];
	}
	const holders = new Map<string, number[]>();
	output.forEach((clause, j) => {
		for (const word of clause.words) {
			const list = holders.get(word);
			if (list) {
				list.push(j);
			} else {
				holders.set(word, [j]);
			}
		}
	});
	const sourceMatches = source.map((): number[] => []);
	const outputMatches = output.map((): number[] => []);
	source.forEach((clause, i) => {
		const shared = new Map<number, number>();
		for (const word of clause.words) {
			for (const j of holders.get(word) ?? []) {
				shared.set(j, (shared.get(j) ?? 0) + 1);
			}
		}
		for (const [j, count] of shared) {
			const union = clause.words.size + output[j].words.size - count;
			if (
				count >= CLAUSE_MIN_SHARED &&
				count / union >= CLAUSE_MIN_SIMILARITY
			) {
				sourceMatches[i].push(j);
				outputMatches[j].push(i);
			}
		}
	});
	return source.flatMap((clause, i): Array<[Clause, Clause]> => {
		const matches = sourceMatches[i];
		if (matches.length !== 1 || outputMatches[matches[0]].length !== 1) {
			return [];
		}
		return [[clause, output[matches[0]]]];
	});
}

function describeNegators(words: readonly string[]): string {
	return words.length > 0
		? words.map((word) => `"${word}"`).join(", ")
		: "no negating word";
}

/**
 * Aligned clauses whose negating words differ in a group the section-wide
 * counts found balanced: a negation moved from one statement to another.
 * A group whose totals differ already fails section-wide. A move shows at
 * both ends, so a group counts as moved only when one aligned pair lost a
 * negating word and another gained one; a single uneven pair means its
 * partner was condensed or restructured ("does not include billing. It
 * covers reporting." to "covers reporting, not billing"), which the totals
 * judge.
 */
function movedNegationViolations(
	sourceClauses: readonly Clause[],
	outputClauses: readonly Clause[],
	balancedGroups: readonly string[],
): FactGuardViolation[] {
	const pairs = alignedClauses(sourceClauses, outputClauses);
	// Per pair and group: rewrite count minus source count.
	const shift = ([from, to]: [Clause, Clause], group: string) =>
		wordsInGroup(to.negators, group).length -
		wordsInGroup(from.negators, group).length;
	const movedGroups = balancedGroups.filter(
		(group) =>
			pairs.some((pair) => shift(pair, group) < 0) &&
			pairs.some((pair) => shift(pair, group) > 0),
	);
	return pairs
		.filter((pair) => movedGroups.some((group) => shift(pair, group) !== 0))
		.map(([from, to]) =>
			violation(
				"negation",
				from.lead,
				`Reverses the polarity of "%s": the source states ${describeNegators(from.negators)} there, and the rewrite's matching clause "${to.lead}" states ${describeNegators(to.negators)}. Keep each statement's negation in that statement.`,
			),
		);
}

/**
 * Negating words counted per negator group, in both directions. More than
 * the source in a group fails as structural: a second "not" can reverse a
 * statement the source left positive, and a first "never" hardens one.
 * Fewer fails as negation: "not X and not Y" condensed to "not X and Y".
 * Rephrasing within a group passes: "no contingency" as "does not include
 * contingency". The rewrite prompt states both rules.
 *
 * Equal totals can still hide a negation moved to another statement, so
 * each source clause is aligned with its rewrite clause by shared content
 * words and their counts compared: "A is not in scope; B is in scope" to
 * "A is in scope; B is not in scope" fails. Clauses that do not align with
 * confidence (condensed, merged, dropped) are judged by the totals alone.
 * The clause check runs only for groups whose totals balance, so it never
 * repeats a section-wide finding. Added findings come first, as the
 * structural ones did.
 */
function negationViolations(
	source: string,
	output: string,
): FactGuardViolation[] {
	const sourceProse = negationProse(source);
	const outputProse = negationProse(output);
	const statedWords = negatingWords(sourceProse);
	const writtenWords = negatingWords(outputProse);
	const stated = statedWords.map(({ word }) => word);
	const written = writtenWords.map(({ word }) => word);
	const counts = [...new Set([...stated, ...written].map(negatorGroup))].map(
		(group) => ({
			group,
			sourceWords: wordsInGroup(stated, group),
			outputWords: wordsInGroup(written, group),
		}),
	);
	// Each finding names the words one side has more of; the counts say how many.
	const extra = (fewer: string[], more: string[]) =>
		[...new Set(addedItems(fewer, more))].join(", ");
	const added = counts
		.filter(
			({ sourceWords, outputWords }) =>
				outputWords.length > sourceWords.length,
		)
		.map(({ sourceWords, outputWords }) =>
			violation(
				"structural",
				extra(sourceWords, outputWords),
				`Adds a negation the source does not state (%s): ${sourceWords.length} in the source, ${outputWords.length} in the rewrite. Negate only what the source negates, with no more negating words than it uses.`,
			),
		);
	const dropped = counts
		.filter(
			({ sourceWords, outputWords }) =>
				outputWords.length < sourceWords.length,
		)
		.map(({ sourceWords, outputWords }) =>
			violation(
				"negation",
				extra(outputWords, sourceWords),
				`Drops a negation the source states (%s): ${sourceWords.length} in the source, ${outputWords.length} in the rewrite. Keep each negation with its own negating word, even when merging sentences.`,
			),
		);
	const balancedGroups = counts
		.filter(
			({ sourceWords, outputWords }) =>
				outputWords.length === sourceWords.length,
		)
		.map(({ group }) => group);
	// No negator on either side leaves nothing to move, and skips the split.
	const moved =
		balancedGroups.length === 0
			? []
			: movedNegationViolations(
					clausesOf(source, sourceProse, statedWords),
					clausesOf(output, outputProse, writtenWords),
					balancedGroups,
				);
	return [...added, ...dropped, ...moved];
}

function measuredLength(text: string): number {
	return text.replace(/\s+/g, " ").trim().length;
}

function lengthViolations(
	source: string,
	output: string,
	lengthMode: GlossyLengthMode,
): FactGuardViolation[] {
	const sourceLength = measuredLength(source);
	const outputLength = measuredLength(output);
	if (outputLength === 0 && sourceLength > 0) {
		return [violation("length", "0 characters", "The rewrite is empty.")];
	}
	const limit =
		lengthMode === "brief"
			? sourceLength
			: Math.floor(sourceLength * STANDARD_LENGTH_FACTOR);
	return outputLength > limit
		? [
				violation(
					"length",
					`${outputLength} characters`,
					`The rewrite is %s; ${lengthMode === "brief" ? "Brief" : "Standard"} allows at most ${limit}.`,
				),
			]
		: [];
}

/**
 * Check one rewritten section against its cleaned source (KTD12). Presence,
 * hedge, structural, negation, and length always apply; must-keep applies
 * to key sections. Lengths count characters after collapsing whitespace
 * runs.
 */
export function checkRewrite(input: CheckRewriteInput): FactGuardResult {
	const { source, output, lengthMode } = input;
	const sourceFacts = extractFacts(source);
	const outputFacts = extractFacts(output);
	return toResult([
		...presenceViolations(source, sourceFacts, output, outputFacts),
		...hedgeViolations(source, output),
		...(input.isKeySection
			? mustKeepViolations(sourceFacts, outputFacts)
			: []),
		...structuralViolations(source, output),
		...negationViolations(source, output),
		...lengthViolations(source, output, lengthMode),
	]);
}

/**
 * Words a visual's own structure introduces, per kind: comparison cards
 * label their columns Pros and Cons, a timeline or flow may mark its Start,
 * a timeline its Phases, an org chart its Owner.
 */
const VISUAL_STRUCTURAL_WORDS: Record<string, readonly string[]> = {
	comparison: ["pros", "cons"],
	timeline: ["phase", "start"],
	flow: ["start"],
	org_chart: ["owner"],
};

/** Words a label may use whether or not the source does. */
const LABEL_FUNCTION_WORDS = new Set(
	"a an the of and or to for in on at by with vs per from into via".split(
		" ",
	),
);

/**
 * A whole value that stands in for content whatever the source says: an
 * angle-bracket token (`<UNKNOWN>`, `<Option X>`), a bracketed template
 * token (`[Owner Name]`, escaped or not), or TBD, TBC, TBA, placeholder, or
 * lorem ipsum. Tested after `unwrapPlaceholder`, so `**TBD**` and `TBD.`
 * count.
 */
const PLACEHOLDER_VALUE =
	/^(?:<[^<>]{1,200}>|\\?\[[^[\]]{1,200}\\?\]|tbd|tbc|tba|placeholder|lorem ipsum\b[\s\S]*)$/i;

/**
 * N/A and Unknown can be content: an "Unknown 25%" share, a cell the
 * document marks N/A. As a whole value each is a placeholder only when the
 * source section never states it as a token of its own; one inside `<…>` or
 * `[…]` in the source is a placeholder there too, so it vouches for nothing.
 */
const SOURCE_STATABLE_PLACEHOLDERS: ReadonlyArray<{
	value: RegExp;
	stated: RegExp;
}> = [
	{ value: /^n\/a$/i, stated: /(?<![\w<[\\/])n\/a(?![\w>\]\\/])/i },
	{ value: /^unknown$/i, stated: /(?<![\w<[\\])unknown(?![\w>\]\\])/i },
];

/** Emphasis, quotes, and punctuation around a value, but never its brackets. */
const PLACEHOLDER_WRAPPING = new Set(" \t\r\n*_`\"'“”‘’().,;:!?–—-");

/** A value without its wrapping; a loop, so a long run cannot backtrack. */
function unwrapPlaceholder(value: string): string {
	let start = 0;
	let end = value.length;
	while (start < end && PLACEHOLDER_WRAPPING.has(value[start])) {
		start++;
	}
	while (end > start && PLACEHOLDER_WRAPPING.has(value[end - 1])) {
		end--;
	}
	return value.slice(start, end);
}

function isPlaceholder(value: string, sourceSection: string): boolean {
	const bare = unwrapPlaceholder(value);
	return (
		PLACEHOLDER_VALUE.test(bare) ||
		SOURCE_STATABLE_PLACEHOLDERS.some(
			(entry) =>
				entry.value.test(bare) && !entry.stated.test(sourceSection),
		)
	);
}

/**
 * Check a visual's extracted labels and figures against its source segment
 * (R18). Every figure and date must be present under the same normalizer as
 * rewrites; every other label word must appear in the segment (token-subset
 * rule, on stems), apart from function words and the kind's structural
 * words.
 *
 * A label or figure that is a whole-value placeholder fails (Fizzy #2589
 * follow-up): with nothing to show, a model fills a comparison with
 * `<UNKNOWN>`, and a template's own `[Owner Name]` or TBD vouches for no
 * content. N/A and Unknown fail only when the source never states them.
 * Labels are plain text, so `<…>` inside one is read as words rather than
 * masked as an HTML tag.
 */
export function checkVisualFacts(
	visual: VisualFactsInput,
	sourceSection: string,
): FactGuardResult {
	const provided = providedKeys(scanNumeric(sourceSection).facts);
	const sectionStems = stemSet(
		wordTokens(sourceSection).map((token) => token.word),
	);
	const structural = stemSet(VISUAL_STRUCTURAL_WORDS[visual.kind] ?? []);
	const violations: FactGuardViolation[] = [];
	for (const value of [...visual.figures, ...visual.labels]) {
		if (isPlaceholder(value, sourceSection)) {
			violations.push(
				violation(
					"placeholder",
					value,
					'"%s" is a placeholder, not content from the source section.',
				),
			);
			continue;
		}
		// One-for-one, so every offset `scanNumeric` reports still holds.
		const text = value.replace(/[<>]/g, " ");
		const { facts, work } = scanNumeric(text);
		for (const fact of facts) {
			if (!fact.weak && !provided.has(fact.key)) {
				violations.push(
					violation(
						"presence",
						fact.text,
						'"%s" does not appear in the source section.',
					),
				);
			}
		}
		const newWords = proseWords(text, work)
			.map((token) => token.word)
			.filter((word) => {
				if (LABEL_FUNCTION_WORDS.has(word.toLowerCase())) {
					return false;
				}
				const stemmed = stem(word);
				return !structural.has(stemmed) && !sectionStems.has(stemmed);
			});
		if (newWords.length > 0) {
			violations.push(
				violation(
					"label",
					value,
					`"%s" uses words the source section does not: ${clip(newWords.join(", "))}.`,
				),
			);
		}
	}
	return toResult(violations);
}

const KEY_SECTION =
	/\b(?:exec(?:utive)? summary|decisions?|recommendations?|recommended|recommend|investments?|budgets?|budgeting|costs?|costing)\b/;

/**
 * Whether a section is a key section (R42): the executive summary, a
 * decision or recommendation, or investment, budget, or cost. Any heading on
 * the path counts, so a subsection of a key section is key too. Headings are
 * compared by their anchor, so numbering, tags, and decoration do not matter.
 */
export function isKeySection(headingPath: readonly string[]): boolean {
	return headingPath.some((heading) =>
		KEY_SECTION.test(headingAnchor(heading)),
	);
}
