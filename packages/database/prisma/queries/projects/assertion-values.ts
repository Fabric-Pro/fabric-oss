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
 */

/** One assertion's two sides, in the runner's own words. */
export interface ParsedAssertionValues {
	expected: string;
	actual: string;
}

/** Long enough to show a real value, short enough that an object dump cannot
 * swallow the rest of a bug body or a model prompt. */
const MAX_VALUE_LENGTH = 300;

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

/**
 * `node:assert`'s one-line summary: `Expected values to be strictly equal:
 * \n\n90 !== 80\n`. Actual is always on the LEFT of the operator — that is
 * what `strictEqual(actual, expected)` throws — so this never needs to guess.
 *
 * Deliberately narrow: only the "equal" family that prints as `actual OP
 * expected` on one line. `deepStrictEqual`'s multi-line `+`/`-` diff is a
 * different shape entirely and is left unparsed rather than misread — and
 * both sides are held to a SINGLE line (`[^\n]`, not `[\s\S]`) so a `!==`
 * sitting in an unrelated stack-trace line further down the message can never
 * be mistaken for this one. `\s+` (not `\s*`) between each side and the
 * operator matters too: it can only bridge pure whitespace, never jump over
 * another line's actual content to reach a `!==` further down.
 */
function parseNodeAssertOneLiner(text: string): ParsedAssertionValues | null {
	const match = text.match(
		/Expected values to be (?:strictly |loosely |deep-strictly |deeply )?equal:\s*([^\n]+?)\s+!==?\s+([^\n]+)/,
	);
	if (!match) {
		return null;
	}
	const actual = capValue(match[1]);
	const expected = capValue(match[2]);
	return actual && expected ? { actual, expected } : null;
}

/** Where a captured value block ends — the next label, or the start of the
 * stack trace, whichever comes first. */
function sliceUntilNextLabelOrStack(
	text: string,
	start: number,
	hardEnd: number,
): string {
	const region = text.slice(start, hardEnd);
	const stop = region.match(/\n\s*at\s/);
	return stop && stop.index !== undefined
		? region.slice(0, stop.index)
		: region;
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
 */
function parseJestStyle(text: string): ParsedAssertionValues | null {
	const expectedLabel = text.match(
		/^[ \t]*Expected(?:\s+(?:string|pattern|substring))?:\s*/m,
	);
	const receivedLabel = text.match(
		/^[ \t]*Received(?:\s+(?:string|pattern|substring))?:\s*/m,
	);
	if (
		!expectedLabel ||
		!receivedLabel ||
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
			: sliceUntilNextLabelOrStack(text, expectedStart, text.length);
	const receivedRaw =
		receivedLabel.index < expectedLabel.index
			? text.slice(receivedStart, expectedLabel.index)
			: sliceUntilNextLabelOrStack(text, receivedStart, text.length);

	const expected = capValue(expectedRaw);
	const actual = capValue(receivedRaw);
	return actual && expected ? { actual, expected } : null;
}

/**
 * JUnit/Java's `expected:<X> but was:<Y>` (also written without the angle
 * brackets by some AssertJ/Hamcrest matchers). "Was" is what happened, so it
 * maps to `actual`.
 *
 * The bracketed and unbracketed forms are two separate patterns rather than
 * one with an optional `>?`: an optional closing bracket lets a value like
 * `3.14` stop at the FIRST thing that could end it — `.` was one of the old
 * terminators — truncating to `3`. Requiring the literal `>` for the
 * bracketed form, and running the unbracketed form to end-of-line instead,
 * means the only thing that ends a value is the actual end of it.
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

	const unbracketed = text.match(
		/expected:\s*([^\n<]+?)\s*but was:\s*([^\n]+?)\s*$/im,
	);
	if (!unbracketed) {
		return null;
	}
	const expected = capValue(unbracketed[1]);
	const actual = capValue(unbracketed[2]);
	return actual && expected ? { actual, expected } : null;
}

/**
 * Chai's `expected X to equal Y` (from `expect(x).to.equal(y)` /
 * `assert.equal(x, y)`, also accepting `to strictly equal` / `to deeply
 * equal`), and Vitest's own `toBe` summary in the same shape — `expected 90
 * to be 80 // Object.is equality`. Runs to end-of-line rather than stopping
 * at `.`, so a decimal value is never cut at its own decimal point.
 *
 * `to be` is accepted ONLY when Vitest's own trailing `// Object.is equality`
 * marker follows it — that marker is what `toBe` always prints, and nothing
 * else does. A bare `to be …` is Chai's own LANGUAGE CHAIN (`to be above`,
 * `to be true`, `to be an instance of`, …), not a value comparison, and
 * Cypress prints `expected '<el>' to be 'visible'` in the same bare shape —
 * neither carries a direction this can trust. (This also means the ordinary
 * "equal" family below can never accidentally match Node's own "Expected
 * values to be ... equal:" header, since that header's "be" is followed by
 * "strictly"/"deeply"/nothing, never by one of the literal alternatives this
 * regex requires — so no separate guard against that header is needed here.)
 */
function parseChaiStyle(text: string): ParsedAssertionValues | null {
	const toBe = text.match(
		/expected\s+([^\n]+?)\s+to\s+be\s+([^\n]+?)\s*\/\/\s*Object\.is equality\s*$/im,
	);
	if (toBe) {
		const actual = capValue(toBe[1]);
		const expected = capValue(toBe[2]);
		return actual && expected ? { actual, expected } : null;
	}

	const match = text.match(
		/expected\s+([^\n]+?)\s+to\s+(?:strictly equal|deeply equal|equal)\s+([^\n]+?)(?:\s*\/\/.*)?$/im,
	);
	if (!match) {
		return null;
	}
	const actual = capValue(match[1]);
	const expected = capValue(match[2]);
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
	const text = trimmed.replace(ANSI_PATTERN, "");

	return (
		parseLabeledProperties(text) ??
		parseNodeAssertOneLiner(text) ??
		parseJestStyle(text) ??
		parseJUnitStyle(text) ??
		parseChaiStyle(text)
	);
}
