/**
 * Which side of a failed assertion is which — parsed from the raw text a test
 * runner printed, not guessed from it.
 *
 * `node:assert/strict` prints ACTUAL first: `Expected values to be strictly
 * equal:\n\n90 !== 80\n` means the test wanted 80 and got 90. A reader — human
 * or model — who has not internalised that convention reads it backwards, and
 * an LLM asked to summarise the message has no reason to know the convention
 * exists. This module recovers `{ expected, actual }` from the handful of
 * runner formats whose direction is unambiguous, and returns `null` for
 * everything else rather than guess: a wrong direction stated as fact is worse
 * than no direction stated at all.
 *
 * `failureMessage` is a `@db.Text` column with no size cap, and this runs
 * synchronously on the request path (`buildFailureEvidence`) and the sync path
 * (`promoteFindingToBug`, `openBugsForFailedCases`). Every parser below is
 * therefore written to stay LINEAR in the length of its input: no two
 * variable-length quantifiers ever sit adjacent over an overlapping character
 * class (that shape is what makes a regex engine try every possible split
 * between them — quadratic at best, exponential on a crafted input). Where a
 * value has to be located, it is located with `indexOf`/`slice`, not a
 * backtracking capture group. {@link MAX_INPUT_LENGTH} and
 * {@link MAX_LINE_LENGTH} are a second, independent layer on top of that: even
 * a parser this module gets wrong tomorrow can only ever pay for a few
 * thousand characters of work.
 */

/** One assertion's two sides, in the runner's own words. */
export interface ParsedAssertionValues {
	expected: string;
	actual: string;
}

/** Long enough to show a real value, short enough that an object dump cannot
 * swallow the rest of a bug body or a model prompt. */
const MAX_VALUE_LENGTH = 300;

/**
 * A generous ceiling on the RAW message, applied before ANSI codes are
 * stripped — so a message padded with heavy colour escapes doesn't have its
 * actual content trimmed away before cleaning gets a chance to remove the
 * padding. {@link MAX_INPUT_LENGTH} is the real, tighter budget the parsers
 * see after that cleanup.
 */
const MAX_RAW_LENGTH = 20_000;

/**
 * The budget every parser actually works with, after ANSI stripping. An
 * assertion sits at the TOP of a failure message — the runner's summary line,
 * then the diff, then (usually much later) a stack trace — so nothing past
 * this point is worth the cost of looking at, and bounding it here is what
 * turns "linear in a `@db.Text` column" into "linear in a small constant".
 */
const MAX_INPUT_LENGTH = 8_001;

/**
 * A single line longer than this is either a serialised object dump or an
 * adversarial payload, never a runner's own value or label line. Parsers that
 * scan line by line skip it rather than spend work on it.
 */
const MAX_LINE_LENGTH = 2_000;

/** CI logs are routinely ANSI-coloured; stripped before any parser sees the
 * text so a colour code never lands inside a captured value or defeats a
 * label match. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching the ESC control character is the point — it's what strips ANSI codes.
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

function capInput(text: string): string {
	if (text.length <= MAX_INPUT_LENGTH) {
		return text;
	}
	const capped = text.slice(0, MAX_INPUT_LENGTH);
	if (capped.endsWith("\n") || text[MAX_INPUT_LENGTH] === "\n") {
		return capped;
	}
	const lastNewline = capped.lastIndexOf("\n");
	return lastNewline === -1 ? "" : capped.slice(0, lastNewline);
}

function capValue(raw: string): string | null {
	const trimmed = raw.trim().replace(/,$/, "").trim();
	if (!trimmed || trimmed.includes("\n")) {
		return null;
	}
	return trimmed.length <= MAX_VALUE_LENGTH
		? trimmed
		: `${trimmed.slice(0, MAX_VALUE_LENGTH)}…`;
}

/** The index one past the end of the line containing `fromIndex` — the next
 * `\n`, or the end of the text when there is none. `indexOf` is linear, and
 * called at most once per candidate line, so scanning stays linear overall. */
function indexOfLineEnd(text: string, fromIndex: number): number {
	const idx = text.indexOf("\n", fromIndex);
	return idx === -1 ? text.length : idx;
}

/** Node's own inspected assertion properties always carry this code. A generic
 * `AssertionError` or an `operator:` note can appear in runner output and does
 * not establish that a later `actual:`/`expected:` pair is Node's. */
const NODE_ASSERTION_MARKER = /\bERR_ASSERTION\b/;

const NODE_EQUAL_OPERATORS = new Set([
	"strictEqual",
	"deepStrictEqual",
	"equal",
	"deepEqual",
	"==",
]);

/**
 * Node's own inspected `AssertionError` properties — `actual: 90,` /
 * `expected: 80,` — which show up verbatim in the text body of a `node:test`
 * JUnit report (the message *attribute* loses the blank line between "equal:"
 * and the values, but the element's text content carries the full inspected
 * error, properties and all).
 *
 * Explicitly labelled, so there is nothing to get backwards — but only once
 * the text is confirmed to actually BE one of these: `actual` before
 * `expected` is necessary but not sufficient, since ordinary prose can contain
 * both words. {@link NODE_ASSERTION_MARKER} is the confirmation.
 */
function parseLabeledProperties(text: string): ParsedAssertionValues | null {
	const actualMatch = text.match(/^[ \t]*actual:\s*/m);
	const expectedMatch = text.match(/^[ \t]*expected:\s*/m);
	if (
		!actualMatch ||
		!expectedMatch ||
		actualMatch.index === undefined ||
		expectedMatch.index === undefined ||
		actualMatch.index >= expectedMatch.index ||
		!NODE_ASSERTION_MARKER.test(text.slice(0, actualMatch.index))
	) {
		return null;
	}

	const actualStart = actualMatch.index + actualMatch[0].length;
	const actualRaw = text.slice(actualStart, expectedMatch.index);

	const expectedStart = expectedMatch.index + expectedMatch[0].length;
	const nextKey = text
		.slice(expectedStart)
		.match(/\n\s*(?:operator|generatedMessage|code|diff|stack)\s*:/);
	const expectedEnd =
		nextKey && nextKey.index !== undefined
			? expectedStart + nextKey.index
			: text.length;
	const expectedRaw = text.slice(expectedStart, expectedEnd);

	const actual = capValue(actualRaw);
	const expected = capValue(expectedRaw);
	const operatorMatch = text
		.slice(expectedEnd)
		.match(/\n\s*operator:\s*['"]?([^,'"\n]+)['"]?\s*,?/);
	const operator = operatorMatch?.[1]?.trim();
	if (
		!actual ||
		!expected ||
		!operator ||
		!NODE_EQUAL_OPERATORS.has(operator) ||
		actual === "[Object]" ||
		actual === "[Array]" ||
		expected === "[Object]" ||
		expected === "[Array]"
	) {
		return null;
	}
	return { actual, expected };
}

/** The first line in `text` that isn't blank and isn't itself over
 * {@link MAX_LINE_LENGTH} — an oversized "line" is never a runner's own value
 * line, and scanning past it rather than into it is what keeps this bounded
 * regardless of what an adversarial message puts there. */
function firstNonEmptyLine(text: string): string | null {
	let start = 0;
	while (start <= text.length) {
		const end = indexOfLineEnd(text, start);
		const line = text.slice(start, end);
		if (line.length <= MAX_LINE_LENGTH && line.trim().length > 0) {
			return line;
		}
		if (end === text.length) {
			return null;
		}
		start = end + 1;
	}
	return null;
}

/** Split `line` on the earliest occurrence of any token in `tokens`, tried
 * left to right — `indexOf`, never a backtracking capture, so this is linear
 * regardless of how the line is shaped. */
function splitOnFirstUnquotedToken(
	line: string,
	tokens: readonly string[],
): [string, string] | null {
	let quote: string | null = null;
	let escaped = false;
	for (let index = 0; index < line.length; index += 1) {
		const char = line[index];
		if (quote) {
			if (escaped) {
				escaped = false;
			} else if (char === "\\") {
				escaped = true;
			} else if (char === quote) {
				quote = null;
			}
			continue;
		}
		if (char === "'" || char === '"' || char === "`") {
			quote = char;
			continue;
		}
		for (const token of tokens) {
			if (line.startsWith(token, index)) {
				return [line.slice(0, index), line.slice(index + token.length)];
			}
		}
	}
	return null;
}

/** `node:assert` prints these operators with a space on both sides. */
const NODE_ASSERT_OPERATORS = [" !== ", " != "] as const;
const NODE_PROPERTY_LABEL = /(?:^|[\s,])(?:actual|expected|operator)\s*:/i;

function firstNodeAssertionLine(text: string): string | null {
	let start = 0;
	while (start <= text.length) {
		const end = indexOfLineEnd(text, start);
		const line = text.slice(start, end);
		if (line.trim().length > 0) {
			if (
				line.length > MAX_LINE_LENGTH ||
				line.trimStart().startsWith("at ")
			) {
				return null;
			}
			return line;
		}
		if (end === text.length) {
			return null;
		}
		start = end + 1;
	}
	return null;
}

/**
 * `node:assert`'s one-line summary: `Expected values to be strictly equal:
 * \n\n90 !== 80\n`. Actual is always on the LEFT of the operator — that is
 * what `strictEqual(actual, expected)` throws — so this never needs to guess.
 *
 * Reads the FIRST NON-EMPTY LINE after the header and splits it on the
 * operator, both by `indexOf` — never a capture group spanning arbitrary text,
 * which is what let a crafted message walk this into quadratic-or-worse
 * backtracking. Deliberately narrow: only the "equal" family that prints as
 * `actual OP expected` on one line. `deepStrictEqual`'s multi-line `+`/`-`
 * diff is a different shape entirely and is left unparsed rather than
 * misread.
 */
function parseNodeAssertOneLiner(text: string): ParsedAssertionValues | null {
	const header = text.match(
		/Expected values to be (?:strictly |loosely |deeply )?(?:deep-)?equal:/,
	);
	if (!header || header.index === undefined) {
		return null;
	}
	const line = firstNodeAssertionLine(
		text.slice(header.index + header[0].length),
	);
	if (!line) {
		return null;
	}
	if (NODE_PROPERTY_LABEL.test(line)) {
		return null;
	}
	const parts = splitOnFirstUnquotedToken(line, NODE_ASSERT_OPERATORS);
	if (!parts) {
		return null;
	}
	const actual = capValue(parts[0]);
	const expected = capValue(parts[1]);
	return actual && expected ? { actual, expected } : null;
}

function parseLegacyNodeAssertOneLiner(
	text: string,
): ParsedAssertionValues | null {
	const line = firstNodeAssertionLine(text);
	if (!line) {
		return null;
	}
	const parts = splitOnFirstUnquotedToken(line, [" == "]);
	if (!parts) {
		return null;
	}
	const lineEnd = indexOfLineEnd(text, 0);
	const errorLine = firstNodeAssertionLine(text.slice(lineEnd + 1));
	const prefix = "AssertionError [ERR_ASSERTION]:";
	if (
		!errorLine ||
		!errorLine.startsWith(prefix) ||
		errorLine.slice(prefix.length).trim() !== line.trim()
	) {
		return null;
	}
	const actual = capValue(parts[0]);
	const expected = capValue(parts[1]);
	return actual && expected ? { actual, expected } : null;
}

/** Where a captured value block ends: the first blank line, stack line, or
 * error header, whichever comes first — a trailing value with nothing else to
 * bound it (no next label) would otherwise run straight into the next section
 * of the message. */
function sliceValueBounded(
	text: string,
	start: number,
	hardEnd: number,
): string {
	const region = text.slice(start, hardEnd);
	let end = region.length;
	const blankLine = region.match(/\n[ \t]*\n/);
	if (blankLine && blankLine.index !== undefined && blankLine.index < end) {
		end = blankLine.index;
	}
	const stackLine = region.match(/\n[ \t]*at\s/);
	if (stackLine && stackLine.index !== undefined && stackLine.index < end) {
		end = stackLine.index;
	}
	const assertionErrorLine = region.match(/\n[ \t]*AssertionError\b/);
	if (
		assertionErrorLine &&
		assertionErrorLine.index !== undefined &&
		assertionErrorLine.index < end
	) {
		end = assertionErrorLine.index;
	}
	const nextLabel = region.match(/\n[ \t]*[A-Z][A-Za-z ]*:/);
	if (nextLabel && nextLabel.index !== undefined && nextLabel.index < end) {
		end = nextLabel.index;
	}
	return region.slice(0, end);
}

/**
 * Jest/Vitest's `Expected: X` / `Received: Y` lines, and Playwright's own
 * variants of the same shape — `Expected string:`, `Expected pattern:`,
 * `Expected substring:`, alongside its plain `Received:` — via the optional
 * qualifier word. `Received` is what the code actually produced, so it maps
 * to `actual`.
 *
 * Leading whitespace before each label is allowed: this text routinely shows
 * up re-indented inside a JUnit wrapper or a CI log rather than at column 0.
 *
 * A JUnit wrapper can repeat the same pair in its message and stack. Different
 * pairs remain ambiguous and return null rather than choosing one.
 */
function parseJestStyle(text: string): ParsedAssertionValues | null {
	const expectedMatches = [
		...text.matchAll(
			/^[ \t]*Expected(?:\s+(?:string|pattern|substring))?:\s*/gm,
		),
	];
	const receivedMatches = [
		...text.matchAll(
			/^[ \t]*Received(?:\s+(?:string|pattern|substring))?:\s*/gm,
		),
	];
	if (
		expectedMatches.length === 0 ||
		expectedMatches.length !== receivedMatches.length
	) {
		return null;
	}
	const labels = [
		...expectedMatches.map((match) => ({ match, isExpected: true })),
		...receivedMatches.map((match) => ({ match, isExpected: false })),
	].sort((a, b) => (a.match.index ?? 0) - (b.match.index ?? 0));
	let result: ParsedAssertionValues | null = null;
	for (let index = 0; index < labels.length; index += 2) {
		const first = labels[index];
		const second = labels[index + 1];
		if (
			first.match.index === undefined ||
			second.match.index === undefined ||
			first.isExpected === second.isExpected
		) {
			return null;
		}
		const firstValue = capValue(
			sliceValueBounded(
				text,
				first.match.index + first.match[0].length,
				second.match.index,
			),
		);
		const secondValue = capValue(
			sliceValueBounded(
				text,
				second.match.index + second.match[0].length,
				labels[index + 2]?.match.index ?? text.length,
			),
		);
		const expected = first.isExpected ? firstValue : secondValue;
		const actual = first.isExpected ? secondValue : firstValue;
		if (
			!actual ||
			!expected ||
			(result &&
				(result.actual !== actual || result.expected !== expected))
		) {
			return null;
		}
		result = { actual, expected };
	}
	return result;
}

/**
 * JUnit/Java's `expected:<X> but was:<Y>` (also written without the angle
 * brackets by some AssertJ/Hamcrest matchers). "Was" is what happened, so it
 * maps to `actual`.
 *
 * The bracketed form stays a single small regex: each value is closed by a
 * literal `>`, so there is no adjacent-quantifier ambiguity to backtrack over.
 * The unbracketed form is `indexOf`/`slice` instead of a capture group — its
 * old shape (`[^\n<]+?` right next to `\s*but was`) is exactly the pattern
 * that makes a regex engine try every possible split when the input doesn't
 * cleanly match, and this text comes from the same unbounded column the
 * runner's own message does.
 */
function parseJUnitStyle(text: string): ParsedAssertionValues | null {
	const bracketed = text.match(
		/expected:\s*<([^\n]*?)>\s*but was:\s*<([^\n]*?)>/i,
	);
	if (bracketed) {
		const expected = capValue(bracketed[1]);
		const actual = capValue(bracketed[2]);
		return actual && expected ? { actual, expected } : null;
	}

	const lower = text.toLowerCase();
	const expectedIdx = lower.indexOf("expected:");
	if (expectedIdx === -1) {
		return null;
	}
	const expectedValueStart = expectedIdx + "expected:".length;
	const butWasIdx = lower.indexOf("but was:", expectedValueStart);
	const expectedLineEnd = indexOfLineEnd(text, expectedIdx);
	const nextLineEnd = indexOfLineEnd(text, expectedLineEnd + 1);
	if (butWasIdx === -1 || butWasIdx > nextLineEnd) {
		return null;
	}
	// "but was:" may sit on the line AFTER the value (AssertJ writes it that
	// way) — that gap is fine. What must not happen is the CAPTURED VALUE
	// itself running past its own line or into a stray "<": truncate at
	// whichever of "\n" / "<" comes first, exactly what the old capture
	// group's `[^\n<]` exclusion did by never matching past them.
	const expectedRawSpan = text.slice(expectedValueStart, butWasIdx);
	const cutCandidates = [
		expectedRawSpan.indexOf("\n"),
		expectedRawSpan.indexOf("<"),
	].filter((i) => i !== -1);
	const expectedRaw =
		cutCandidates.length > 0
			? expectedRawSpan.slice(0, Math.min(...cutCandidates))
			: expectedRawSpan;
	const actualValueStart = butWasIdx + "but was:".length;
	const actualRaw = firstNonEmptyLine(text.slice(actualValueStart)) ?? "";

	const expected = capValue(expectedRaw);
	const actual = capValue(actualRaw);
	return actual && expected ? { actual, expected } : null;
}

/** Chai/Vitest's "equal" family, longest phrase first so `equal` never
 * pre-empts `strictly equal`/`deeply equal` at the same position. */
const CHAI_EQUAL_TOKENS = [
	" to strictly equal ",
	" to deeply equal ",
	" to equal ",
] as const;

/**
 * Chai's `expected X to equal Y` (from `expect(x).to.equal(y)` /
 * `assert.equal(x, y)`, also accepting `to strictly equal` / `to deeply
 * equal`), and Vitest's own `toBe` summary in the same shape — `expected 90
 * to be 80 // Object.is equality`.
 *
 * Every boundary here is `indexOf`/`slice` on the ONE line containing
 * "expected " — never a backtracking capture spanning arbitrary text, which
 * is what turned this parser quadratic-to-exponential on a crafted message
 * (padding between "expected" and "to equal" that never resolves to a match
 * forces a regex engine to try every possible split of that padding between
 * two adjacent variable-length groups).
 *
 * `to be` is accepted ONLY when Vitest's own trailing `// Object.is equality`
 * marker ends the line — that marker is what `toBe` always prints, and
 * nothing else does. A bare `to be …` is Chai's own LANGUAGE CHAIN (`to be
 * above`, `to be true`, `to be an instance of`, …), not a value comparison,
 * and Cypress prints `expected '<el>' to be 'visible'` in the same bare shape
 * — neither carries a direction this can trust. (This also means the
 * ordinary "equal" family can never accidentally match Node's own "Expected
 * values to be ... equal:" header: that header's "be" is followed by
 * "strictly"/"deeply"/nothing, never immediately by one of
 * {@link CHAI_EQUAL_TOKENS}.)
 */
function isChaiLiteral(value: string): boolean {
	const trimmed = value.trim();
	if (trimmed.length < 1) {
		return false;
	}
	const quote = trimmed[0];
	if (
		(quote === "'" || quote === '"' || quote === "`") &&
		trimmed.endsWith(quote)
	) {
		return true;
	}
	return (
		/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?$/i.test(trimmed) ||
		(trimmed.startsWith("[") && trimmed.endsWith("]")) ||
		(trimmed.startsWith("{") && trimmed.endsWith("}"))
	);
}

function findChaiMessageLine(text: string): string | null {
	let start = 0;
	while (start <= text.length) {
		const end = indexOfLineEnd(text, start);
		const fullLine = text.slice(start, end);
		if (fullLine.length <= MAX_LINE_LENGTH) {
			const expectedIndex = fullLine.toLowerCase().indexOf("expected ");
			if (expectedIndex !== -1) {
				const prefix = fullLine.slice(0, expectedIndex);
				if (
					prefix.trim().length === 0 ||
					/^AssertionError:\s*$/i.test(prefix) ||
					/^Timed out retrying after \d+ms:\s*$/i.test(prefix)
				) {
					return fullLine.slice(expectedIndex);
				}
			}
		}
		if (end === text.length) {
			return null;
		}
		start = end + 1;
	}
	return null;
}

function parseChaiStyle(text: string): ParsedAssertionValues | null {
	const line = findChaiMessageLine(text);
	if (!line) {
		return null;
	}
	const lineLower = line.toLowerCase();
	const valueStart = "expected ".length;
	const equalParts = splitOnFirstUnquotedToken(
		line.slice(valueStart),
		CHAI_EQUAL_TOKENS,
	);
	if (equalParts) {
		const commentIndex = equalParts[1].search(/\s\/\//);
		const expectedRaw =
			commentIndex === -1
				? equalParts[1]
				: equalParts[1].slice(0, commentIndex);
		const actual = capValue(equalParts[0]);
		const expected = capValue(expectedRaw);
		return actual &&
			expected &&
			isChaiLiteral(actual) &&
			isChaiLiteral(expected)
			? { actual, expected }
			: null;
	}

	const TO_BE = " to be ";
	const OBJECT_IS_MARKER = "// object.is equality";
	const toBeIdx = lineLower.indexOf(TO_BE, valueStart);
	if (toBeIdx === -1 || !lineLower.trimEnd().endsWith(OBJECT_IS_MARKER)) {
		return null;
	}
	const markerIdx = lineLower.lastIndexOf(OBJECT_IS_MARKER);
	const actual = capValue(line.slice(valueStart, toBeIdx));
	const expected = capValue(line.slice(toBeIdx + TO_BE.length, markerIdx));
	return actual &&
		expected &&
		isChaiLiteral(actual) &&
		isChaiLiteral(expected)
		? { actual, expected }
		: null;
}

/**
 * Recover `{ expected, actual }` from a failure message, or `null` when the
 * format is not one of the handful this recognises unambiguously.
 *
 * Every recognised format must agree. A `node:test` JUnit report carries both
 * Node's one-line summary and its labelled properties, so matching values are
 * normal; a disagreement means surrounding text has introduced a second claim
 * and this parser must not choose a side.
 */
export function parseAssertionValues(
	message: string | null | undefined,
): ParsedAssertionValues | null {
	const trimmed = message?.trim();
	if (!trimmed) {
		return null;
	}
	const text = capInput(
		trimmed.slice(0, MAX_RAW_LENGTH).replace(ANSI_PATTERN, ""),
	);

	const candidates = [
		parseLabeledProperties(text),
		parseNodeAssertOneLiner(text),
		parseLegacyNodeAssertOneLiner(text),
		parseJestStyle(text),
		parseJUnitStyle(text),
		parseChaiStyle(text),
	].filter(
		(candidate): candidate is ParsedAssertionValues => candidate !== null,
	);
	const first = candidates[0];
	if (
		!first ||
		candidates.some(
			(candidate) =>
				candidate.expected !== first.expected ||
				candidate.actual !== first.actual,
		)
	) {
		return null;
	}
	return first;
}
