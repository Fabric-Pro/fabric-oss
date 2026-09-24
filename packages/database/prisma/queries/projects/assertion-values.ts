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
const MAX_INPUT_LENGTH = 8_000;

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

function capValue(raw: string): string | null {
	const trimmed = raw.trim().replace(/,$/, "").trim();
	if (!trimmed) {
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

/** One of these must be present for {@link parseLabeledProperties} to trust
 * `actual:`/`expected:` as Node's own inspected AssertionError properties
 * rather than two words that happen to appear, colon-suffixed, in free-form
 * text — "Unexpected actual: none. expected: something" has both, in order,
 * and is not an assertion. */
const NODE_ASSERTION_MARKER = /ERR_ASSERTION|AssertionError|\boperator:\s*/;

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
	const actualMatch = text.match(/\bactual:\s*/);
	const expectedMatch = text.match(/\bexpected:\s*/);
	if (
		!actualMatch ||
		!expectedMatch ||
		actualMatch.index === undefined ||
		expectedMatch.index === undefined ||
		actualMatch.index >= expectedMatch.index ||
		!NODE_ASSERTION_MARKER.test(text)
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
	return actual && expected ? { actual, expected } : null;
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
function splitOnFirstToken(
	line: string,
	tokens: readonly string[],
): [string, string] | null {
	let bestIndex = -1;
	let bestToken = "";
	for (const token of tokens) {
		const idx = line.indexOf(token);
		if (idx !== -1 && (bestIndex === -1 || idx < bestIndex)) {
			bestIndex = idx;
			bestToken = token;
		}
	}
	if (bestIndex === -1) {
		return null;
	}
	return [line.slice(0, bestIndex), line.slice(bestIndex + bestToken.length)];
}

/** `node:assert`'s operators, longest first so `!==` is never mistaken for a
 * prefix match of `!=`. */
const NODE_ASSERT_OPERATORS = ["!==", "!="] as const;

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
		/Expected values to be (?:strictly |loosely |deep-strictly |deeply )?equal:/,
	);
	if (!header || header.index === undefined) {
		return null;
	}
	const line = firstNonEmptyLine(text.slice(header.index + header[0].length));
	if (!line) {
		return null;
	}
	const parts = splitOnFirstToken(line, NODE_ASSERT_OPERATORS);
	if (!parts) {
		return null;
	}
	const actual = capValue(parts[0]);
	const expected = capValue(parts[1]);
	return actual && expected ? { actual, expected } : null;
}

/** Where a captured value block ends: the first blank line or the first stack
 * line, whichever comes first — a trailing value with nothing else to bound
 * it (no next label) would otherwise run straight into the next section of
 * the message. */
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
 * Refuses a message with MORE THAN ONE `Expected`/`Received` pair — a second
 * failure's report concatenated below the first (Jest's own multi-failure
 * output does exactly this) makes "which one broke" ambiguous, and this
 * module's rule is null over a guess, not "pick the first one and hope".
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
	if (expectedMatches.length !== 1 || receivedMatches.length !== 1) {
		return null;
	}

	const expectedLabel = expectedMatches[0];
	const receivedLabel = receivedMatches[0];
	if (
		expectedLabel.index === undefined ||
		receivedLabel.index === undefined
	) {
		return null;
	}

	const expectedStart = expectedLabel.index + expectedLabel[0].length;
	const receivedStart = receivedLabel.index + receivedLabel[0].length;

	const expectedRaw =
		expectedLabel.index < receivedLabel.index
			? text.slice(expectedStart, receivedLabel.index)
			: sliceValueBounded(text, expectedStart, text.length);
	const receivedRaw =
		receivedLabel.index < expectedLabel.index
			? text.slice(receivedStart, expectedLabel.index)
			: sliceValueBounded(text, receivedStart, text.length);

	const expected = capValue(expectedRaw);
	const actual = capValue(receivedRaw);
	return actual && expected ? { actual, expected } : null;
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
	if (butWasIdx === -1) {
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
function parseChaiStyle(text: string): ParsedAssertionValues | null {
	const lower = text.toLowerCase();
	const expectedIdx = lower.indexOf("expected ");
	if (expectedIdx === -1) {
		return null;
	}

	const lineEnd = indexOfLineEnd(text, expectedIdx);
	const line = text.slice(expectedIdx, lineEnd);
	if (line.length > MAX_LINE_LENGTH) {
		return null;
	}
	const lineLower = line.toLowerCase();
	const valueStart = "expected ".length;

	let bestIndex = -1;
	let bestToken = "";
	for (const token of CHAI_EQUAL_TOKENS) {
		const idx = lineLower.indexOf(token, valueStart);
		if (idx !== -1 && (bestIndex === -1 || idx < bestIndex)) {
			bestIndex = idx;
			bestToken = token;
		}
	}
	if (bestIndex !== -1) {
		const actualRaw = line.slice(valueStart, bestIndex);
		const rest = line.slice(bestIndex + bestToken.length);
		const commentIdx = rest.indexOf("//");
		const expectedRaw =
			commentIdx === -1 ? rest : rest.slice(0, commentIdx);
		const actual = capValue(actualRaw);
		const expected = capValue(expectedRaw);
		return actual && expected ? { actual, expected } : null;
	}

	const TO_BE = " to be ";
	const OBJECT_IS_MARKER = "// object.is equality";
	const toBeIdx = lineLower.indexOf(TO_BE, valueStart);
	if (toBeIdx === -1 || !lineLower.trimEnd().endsWith(OBJECT_IS_MARKER)) {
		return null;
	}
	const markerIdx = lineLower.lastIndexOf(OBJECT_IS_MARKER);
	const actualRaw = line.slice(valueStart, toBeIdx);
	const expectedRaw = line.slice(toBeIdx + TO_BE.length, markerIdx);
	const actual = capValue(actualRaw);
	const expected = capValue(expectedRaw);
	return actual && expected ? { actual, expected } : null;
}

/**
 * Recover `{ expected, actual }` from a failure message, or `null` when the
 * format is not one of the handful this recognises unambiguously.
 *
 * Tried most-explicit format first: Node's labelled `actual:`/`expected:`
 * properties beat its own one-line summary (which the labelled properties
 * often sit right beside, in a `node:test` JUnit report), which beats the
 * other runners' formats. The first match wins — this never tries to combine
 * or cross-check formats, only to recognise one cleanly.
 */
export function parseAssertionValues(
	message: string | null | undefined,
): ParsedAssertionValues | null {
	const trimmed = message?.trim();
	if (!trimmed) {
		return null;
	}
	const text = trimmed
		.slice(0, MAX_RAW_LENGTH)
		.replace(ANSI_PATTERN, "")
		.slice(0, MAX_INPUT_LENGTH);

	return (
		parseLabeledProperties(text) ??
		parseNodeAssertOneLiner(text) ??
		parseJestStyle(text) ??
		parseJUnitStyle(text) ??
		parseChaiStyle(text)
	);
}
