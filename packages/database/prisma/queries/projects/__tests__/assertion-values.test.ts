/**
 * Unit tests for the assertion-direction parser.
 *
 * The card this exists for: `node:assert/strict` throws `90 !== 80` for
 * `equal(totalAfterDiscount(100), 80)` — actual first, expected second — and
 * the failure analysis read it backwards. What matters here is the DIRECTION
 * of every fixture, not just that something was extracted.
 */

import { describe, expect, it } from "vitest";
import { parseAssertionValues } from "../assertion-values";
import nodeJestCaptures from "./fixtures/node-24.15-jest-30.4-stored-failures.json";
import playwrightCaptures from "./fixtures/playwright-1.61.1-failures.json";

describe("parseAssertionValues", () => {
	it("reads the card's exact node:assert message — actual is on the LEFT", () => {
		// `assert.equal(totalAfterDiscount(100), 80)` with a discount bug that
		// produces 90. Node prints "90 !== 80": the test wanted 80, got 90.
		const result = parseAssertionValues(
			"Expected values to be strictly equal:\n\n90 !== 80\n",
		);

		expect(result).toEqual({ expected: "80", actual: "90" });
	});

	it("reads a real node:test JUnit report's failure text, labelled properties and all", () => {
		// Captured with `node --test --test-reporter=junit` against
		// `assert.equal(totalAfterDiscount(100), 80)` where the discount logic
		// returns 90. This is the JUnit reporter's actual <failure> text content
		// — the `message` attribute alone loses the blank line before "90 !== 80"
		// (XML attribute normalisation), but the element body carries the full
		// inspected AssertionError, including the explicit `actual:`/`expected:`
		// properties this parser prefers.
		const failureMessage = `Expected values to be strictly equal:90 !== 80
[Error [ERR_TEST_FAILURE]: Expected values to be strictly equal:

90 !== 80
] {
  code: 'ERR_TEST_FAILURE',
  failureType: 'testCodeFailure',
  cause: AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

  90 !== 80

      at TestContext.<anonymous> (file:///scratch.test.mjs:9:9)
      at Test.runInAsyncScope (node:async_hooks:214:14)
      at Test.run (node:internal/test_runner/test:1047:25)
      at Test.start (node:internal/test_runner/test:944:17)
      at startSubtestAfterBootstrap (node:internal/test_runner/harness:296:17) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: 90,
    expected: 80,
    operator: 'strictEqual',
    diff: 'simple'
  }
}`;

		expect(parseAssertionValues(failureMessage)).toEqual({
			expected: "80",
			actual: "90",
		});
	});

	it("reads Jest/Vitest's Expected/Received — Received is what the code produced", () => {
		const result = parseAssertionValues(
			"expect(received).toBe(expected)\n\nExpected: 80\nReceived: 90",
		);

		expect(result).toEqual({ expected: "80", actual: "90" });
	});

	it("reads JUnit/Java's expected:<X> but was:<Y> — 'was' is what happened", () => {
		const result = parseAssertionValues(
			"org.junit.ComparisonFailure: expected:<80> but was:<90>\n\tat org.junit.Assert.failNotEquals(Assert.java:834)",
		);

		expect(result).toEqual({ expected: "80", actual: "90" });
	});

	it("reads AssertJ/Hamcrest's bracket-less expected: X but was: Y", () => {
		const result = parseAssertionValues("expected: 80\n but was: 90");

		expect(result).toEqual({ expected: "80", actual: "90" });
	});

	it("reads Chai's expected X to equal Y — the subject is what the code produced", () => {
		const result = parseAssertionValues(
			"AssertionError: expected 90 to equal 80",
		);

		expect(result).toEqual({ expected: "80", actual: "90" });
	});

	it("reads Vitest's signed Object.is equality values", () => {
		// Arrange
		const message = "expected -20 to be +0 // Object.is equality";

		// Act
		const result = parseAssertionValues(message);

		// Assert
		expect(result).toEqual({ expected: "+0", actual: "-20" });
	});

	it.each([
		["a bare exit code", "exit code 1"],
		[
			"pytest's assert form, which this does not attempt",
			"assert 90 == 80",
		],
		["whitespace only", "   \n  "],
		["an empty string", ""],
		["null", null],
		["undefined", undefined],
	])("returns null for %s — never guesses a direction", (_label, input) => {
		expect(parseAssertionValues(input)).toBeNull();
	});

	it("caps a very long value rather than swallowing the rest of the body", () => {
		const result = parseAssertionValues(
			`Expected: ${"x".repeat(1000)}\nReceived: 90`,
		);

		expect(result?.actual).toBe("90");
		expect(result?.expected.length).toBeLessThan(400);
		expect(result?.expected.endsWith("…")).toBe(true);
	});

	describe("decimal and dotted values are never cut at the '.'", () => {
		it.each([
			[
				"JUnit bracketed",
				"expected:<3.14> but was:<2.5>",
				{ expected: "3.14", actual: "2.5" },
			],
			[
				"AssertJ/Hamcrest unbracketed",
				"expected: 3.14\n but was: 2.5",
				{ expected: "3.14", actual: "2.5" },
			],
			[
				"Chai",
				"AssertionError: expected 3.14 to equal 2.5",
				{ expected: "2.5", actual: "3.14" },
			],
			[
				"JUnit bracketed, non-numeric dots",
				"expected:<a.b> but was:<c.d>",
				{ expected: "a.b", actual: "c.d" },
			],
			[
				"Chai, non-numeric dots",
				"expected 'a.b' to equal 'c.d'",
				{ expected: "'c.d'", actual: "'a.b'" },
			],
		])("%s", (_label, input, expected) => {
			expect(parseAssertionValues(input)).toEqual(expected);
		});
	});

	describe("Vitest's one-line phrasing", () => {
		it("reads 'to be' only when Vitest's own '// Object.is equality' marker follows it", () => {
			const result = parseAssertionValues(
				"expected 90 to be 80 // Object.is equality",
			);

			expect(result).toEqual({ expected: "80", actual: "90" });
		});

		it.each(["to strictly equal", "to deeply equal", "to equal"])(
			"reads '%s'",
			(phrase) => {
				expect(
					parseAssertionValues(`expected 90 ${phrase} 80`),
				).toEqual({ expected: "80", actual: "90" });
			},
		);

		it("refuses a bare 'to be' with no Object.is marker — Chai's own language chain, not a value", () => {
			// `to be` alone is how Chai spells `to be above`, `to be true`, `to be
			// an instance of`, and how Cypress prints `to be 'visible'` — none of
			// them carry a direction this can trust. Vitest's toBe ALWAYS appends
			// the marker; its absence means this is not that.
			expect(
				parseAssertionValues("expected false to be true"),
			).toBeNull();
		});
	});

	describe("free-form text that merely CONTAINS assertion-shaped words", () => {
		it.each([
			[
				"ordinary prose using 'expected'/'to be'",
				"Expected the dialog to be closed after save",
			],
			[
				"Chai's 'to be above' language chain",
				"AssertionError: expected 90 to be above 100",
			],
			[
				"Cypress's bare 'to be' phrasing",
				"Timed out retrying after 4000ms: expected '<button#save>' to be 'visible'",
			],
			[
				"prose containing 'actual:'/'expected:' with no assertion marker",
				"Unexpected actual: none. expected: something",
			],
		])("returns null for %s", (_label, input) => {
			expect(parseAssertionValues(input)).toBeNull();
		});
	});

	it("rejects retry warning prose that happens to contain expected and actual", () => {
		// Arrange
		const message =
			"WARN retry 2/3: expected response code to equal 200 after token refresh";

		// Act
		const result = parseAssertionValues(message);

		// Assert
		expect(result).toBeNull();
	});

	it("reads Playwright's 'Expected string:' / 'Received string:' via the optional qualifier", () => {
		const result = parseAssertionValues(
			'Expected string: "Welcome"\nReceived string: "Hello"',
		);

		expect(result).toEqual({ expected: '"Welcome"', actual: '"Hello"' });
	});

	it("trusts Node's labelled actual:/expected: only alongside an assertion marker", () => {
		// The order alone ("actual" before "expected") is not sufficient — see
		// the free-form-text describe block above for the case this guards.
		// This pins the positive side: the real captured sample carries
		// ERR_ASSERTION before the own-property labels.
		const message =
			"AssertionError [ERR_ASSERTION]: values differ\n    actual: 90,\n    expected: 80,\n    operator: 'strictEqual',\n    diff: 'simple'\n";

		expect(parseAssertionValues(message)).toEqual({
			expected: "80",
			actual: "90",
		});
	});

	it.each([
		[
			"a joined Node summary followed by inline labels",
			[
				"Expected values to be strictly equal:90 !== 80",
				"note: actual: 80, expected: 90",
				"AssertionError: assertion failed",
			].join("\n"),
			{ expected: "80", actual: "90" },
		],
		[
			"a Node one-liner followed by inline labels",
			[
				"Expected values to be strictly equal:",
				"",
				"90 !== 80",
				"note: actual: 80, expected: 90",
				"AssertionError: assertion failed",
			].join("\n"),
			{ expected: "80", actual: "90" },
		],
		[
			"a multi-line Node message followed by inline context labels",
			[
				"AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:",
				"",
				"+ actual - expected",
				"",
				"+ 90",
				"- 80",
				"    at Object.<anonymous> (example.test.ts:1:1)",
				"context: { actual: 80, expected: 90 }",
			].join("\n"),
			null,
		],
		[
			"Jest labels followed by an AssertionError property-like note",
			[
				"Expected: 80",
				"Received: 90",
				"AssertionError: assertion failed",
				"actual: 80,",
				"expected: 90,",
			].join("\n"),
			{ expected: "80", actual: "90" },
		],
		[
			"a Chai message followed by indented property-like labels",
			[
				"AssertionError: expected 90 to equal 80",
				"  actual: 80,",
				"  expected: 90,",
			].join("\n"),
			{ expected: "80", actual: "90" },
		],
	])("does not trust forged labels in %s", (_label, message, expected) => {
		// Arrange
		const input = message;

		// Act
		const result = parseAssertionValues(input);

		// Assert
		expect(result).toEqual(expected);
	});

	it("returns null when Node's labelled properties disagree with its one-line summary", () => {
		// Arrange
		const message = [
			"AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:",
			"",
			"90 !== 80",
			"",
			"  actual: 80,",
			"  expected: 90,",
			"  operator: 'strictEqual',",
		].join("\n");

		// Act
		const result = parseAssertionValues(message);

		// Assert
		expect(result).toBeNull();
	});

	it("does not let inline forged labels extend a stored Node assertion value", () => {
		// Arrange
		const message = [
			"Expected values to be strictly equal: 90 !== 80 note: actual: 80, expected: 90, operator: strictEqual",
			"AssertionError: Expected values to be strictly equal: 90 !== 80",
			"note: actual: 80, expected: 90,",
			"operator: strictEqual",
		].join("\n");

		// Act
		const result = parseAssertionValues(message);

		// Assert
		expect(result).toBeNull();
	});

	it("reads Jest/Vitest lines that are indented and ANSI-coloured", () => {
		// Real shape when this text is re-quoted inside a JUnit wrapper or a
		// coloured CI log rather than printed at column 0.
		const result = parseAssertionValues(
			"  \x1b[32mExpected: 80\x1b[39m\n  \x1b[31mReceived: 90\x1b[39m",
		);

		expect(result).toEqual({ expected: "80", actual: "90" });
	});

	it("never picks up an unrelated '!==' from a stack trace below a deepStrictEqual diff", () => {
		// `deepStrictEqual`'s own diff format is left unparsed (a different shape
		// entirely), but the real defect here is worse: a naive "scan for !=="
		// can walk PAST the diff and land on an unrelated comparison several
		// lines down. That must never happen.
		const message = [
			"Expected values to be strictly deep-equal:",
			"",
			"+ actual - expected",
			"",
			"+ { foo: 90 }",
			"- { foo: 80 }",
			"",
			"    at Object.<anonymous> (test.js:12:3)",
			"    // unrelated: someFlag !== otherFlag",
		].join("\n");

		expect(parseAssertionValues(message)).toBeNull();
	});

	describe("a trailing value is bounded, never running into the next section", () => {
		it("accepts the same Playwright pair repeated in a JUnit message and stack", () => {
			const message = [
				"expect(locator).toHaveText(expected) failed",
				"Locator: getByTestId('order-total')",
				'Expected: "80"',
				'Received: "90"',
				"Timeout: 5000ms",
				"Call log:",
				"- waiting for getByTestId('order-total')",
				"Error: expect(locator).toHaveText(expected) failed",
				"Locator: getByTestId('order-total')",
				'Expected: "80"',
				'Received: "90"',
				"Timeout: 5000ms",
				"Call log:",
				"- waiting for getByTestId('order-total')",
				" ❯ test/assertion-reporting.test.js:14:11",
			].join("\n");

			expect(parseAssertionValues(message)).toEqual({
				expected: '"80"',
				actual: '"90"',
			});
		});

		it("returns null for differing Expected/Received pairs", () => {
			// Jest's own multi-failure output concatenates a second report right
			// below the first. Picking the first pair would silently report the
			// wrong failure; this module's rule is null over a guess.
			const message = [
				"1) expect(a).toBe(b)",
				"",
				"Expected: 80",
				"Received: 90",
				"",
				"2) expect(c).toBe(d)",
				"",
				"Expected: 5",
				"Received: 3",
			].join("\n");

			expect(parseAssertionValues(message)).toBeNull();
		});

		it("ends Playwright's trailing value at the blank line before 'Call log:'", () => {
			const message = [
				"Timed out retrying: expected 2 elements",
				"Expected: 2",
				"Received: 3",
				"",
				"Call log:",
				"  - waiting for locator",
				"  - element is visible",
			].join("\n");

			expect(parseAssertionValues(message)).toEqual({
				expected: "2",
				actual: "3",
			});
		});

		it("ends Jest's trailing value at the blank line before 'Number of calls:'", () => {
			const message =
				"Expected: 80\nReceived: 90, 100\n\nNumber of calls: 1";

			expect(parseAssertionValues(message)).toEqual({
				expected: "80",
				actual: "90, 100",
			});
		});
	});

	describe("runner-specific boundaries and syntax", () => {
		it("uses seven failures captured from Playwright 1.61.1", () => {
			expect(playwrightCaptures.version).toBe("1.61.1");
			expect(playwrightCaptures.captures).toHaveLength(7);
		});

		const expectedPlaywrightValues = new Map<
			string,
			{ expected: string; actual: string }
		>([
			["toHaveText-string", { expected: '"Welcome"', actual: '"Hello"' }],
			["toHaveText-regex", { expected: "/welcome/i", actual: '"Hello"' }],
			["toContainText", { expected: '"Welcome"', actual: '"Hello"' }],
			[
				"toHaveValue",
				{ expected: '"dev@example.com"', actual: '"test@example.com"' },
			],
			["toHaveCount", { expected: "2", actual: "3" }],
			["toBeVisible", { expected: "visible", actual: "hidden" }],
			[
				"toHaveURL",
				{
					expected: '"https://example.com/checkout"',
					actual: '"https://example.com/cart"',
				},
			],
		]);

		it.each(playwrightCaptures.captures)(
			"stops a Playwright $name value before its Timeout line",
			({ name, message }) => {
				expect(parseAssertionValues(message)).toEqual(
					expectedPlaywrightValues.get(name),
				);
			},
		);

		it.each([
			[
				"a Chai URL",
				"AssertionError: expected 'https://example.com/cart' to equal 'https://example.com/checkout'",
				{
					expected: "'https://example.com/checkout'",
					actual: "'https://example.com/cart'",
				},
			],
			[
				"a Cypress URL",
				"Timed out retrying after 4000ms: expected 'http://localhost:3000/cart' to equal 'http://localhost:3000/checkout'",
				{
					expected: "'http://localhost:3000/checkout'",
					actual: "'http://localhost:3000/cart'",
				},
			],
			[
				"a quoted value containing the comparison words",
				"AssertionError: expected 'a to equal b' to equal 'c'",
				{ expected: "'c'", actual: "'a to equal b'" },
			],
		])("keeps complete values for %s", (_label, input, expected) => {
			// Arrange
			const message = input;

			// Act
			const result = parseAssertionValues(message);

			// Assert
			expect(result).toEqual(expected);
		});

		it.each([
			[
				"a notStrictEqual Node property set",
				"AssertionError [ERR_ASSERTION]: values differ\n  actual: 80,\n  expected: 80,\n  operator: 'notStrictEqual',",
			],
			[
				"prose containing the comparison words",
				"Expected the order total to equal the discounted subtotal",
			],
			[
				"a Node object placeholder",
				"AssertionError [ERR_ASSERTION]: values differ\n  actual: [Object],\n  expected: [Object],\n  operator: 'deepStrictEqual',",
			],
			[
				"a Node array placeholder",
				"AssertionError [ERR_ASSERTION]: values differ\n  actual: [Array],\n  expected: [Array],\n  operator: 'deepStrictEqual',",
			],
			[
				"JUnit labels separated by unrelated sections",
				[
					"Setup expected: fixture loaded",
					...Array(21).fill("trace"),
					"Retry but was: recovered",
				].join("\n"),
			],
		])("returns null for %s", (_label, input) => {
			// Arrange
			const message = input;

			// Act
			const result = parseAssertionValues(message);

			// Assert
			expect(result).toBeNull();
		});
	});

	describe("Node runner output", () => {
		it("uses eleven failures captured from Node 24.15.0 and Jest expect 30.4.1", () => {
			expect(nodeJestCaptures.nodeVersion).toBe("v24.15.0");
			expect(nodeJestCaptures.jestExpectVersion).toBe("30.4.1");
			expect(nodeJestCaptures.captures).toHaveLength(11);
		});

		const supportedStoredValues = new Map<
			string,
			{ expected: string; actual: string }
		>([
			["strict-deep-number", { expected: "80", actual: "90" }],
			["legacy-deep-number", { expected: "80", actual: "90" }],
			["legacy-equal-number", { expected: "80", actual: "90" }],
			[
				"legacy-equal-string",
				{ expected: "'eighty'", actual: "'ninety'" },
			],
		]);

		it.each(nodeJestCaptures.captures)(
			"parses stored $name only when its direction is supported",
			({ name, stored }) => {
				expect(parseAssertionValues(stored)).toEqual(
					supportedStoredValues.get(name) ?? null,
				);
			},
		);

		it.each([
			[
				"node:assert/strict deepStrictEqual numeric message",
				"Expected values to be strictly deep-equal:\n\n90 !== 80\n",
			],
			[
				"legacy node:assert deepStrictEqual",
				"Expected values to be strictly deep-equal: 90 !== 80\nAssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:\n\n90 !== 80\n    at check (example.test.mjs:1:1)",
			],
		])("parses %s", (_label, input) => {
			// Arrange
			const message = input;

			// Act
			const result = parseAssertionValues(message);

			// Assert
			expect(result).toEqual({ expected: "80", actual: "90" });
		});

		it.each([
			["numeric", "90 == 80"],
			["string", "'ninety' == 'eighty'"],
		])(
			"parses legacy Node equal on %s values only with the matching error",
			(_label, firstLine) => {
				// Arrange
				const message = `${firstLine}\nAssertionError [ERR_ASSERTION]: ${firstLine}\n    at check (example.test.mjs:1:1)`;

				// Act
				const result = parseAssertionValues(message);

				// Assert
				expect(result).toEqual({
					expected: _label === "numeric" ? "80" : "'eighty'",
					actual: _label === "numeric" ? "90" : "'ninety'",
				});
			},
		);

		it.each([
			[
				"strict deep-equal objects",
				"Expected values to be strictly deep-equal:\n\n+ actual - expected\n+ { total: 90 }\n- { total: 80 }",
			],
			[
				"strict deep-equal nested objects",
				"Expected values to be strictly deep-equal:\n\n+ actual - expected\n+ { order: { total: 90 } }\n- { order: { total: 80 } }",
			],
			[
				"strict deep-equal arrays",
				"Expected values to be strictly deep-equal:\n\n+ actual - expected\n+ [ 90 ]\n- [ 80 ]",
			],
			[
				"legacy deepEqual objects",
				"Expected values to be loosely deep-equal:\n\n+ actual - expected\n+ { total: 90 }\n- { total: 80 }",
			],
			[
				"Jest toEqual objects",
				"expect(received).toEqual(expected)\n\n- Expected\n+ Received\n\n- { total: 80 }\n+ { total: 90 }",
			],
			[
				"Jest toStrictEqual objects",
				"expect(received).toStrictEqual(expected)\n\n- Expected\n+ Received\n\n- { total: 80 }\n+ { total: 90 }",
			],
			[
				"Jest toEqual arrays",
				"expect(received).toEqual(expected)\n\n- Expected\n+ Received\n\n- [80]\n+ [90]",
			],
			["pytest equality", "assert 90 == 80"],
			[
				"a legacy equality line without Node's error",
				"90 == 80\nError: test failed",
			],
		])("leaves %s unsupported", (_label, input) => {
			// Arrange
			const message = input;

			// Act
			const result = parseAssertionValues(message);

			// Assert
			expect(result).toBeNull();
		});

		it.each([
			["'a!=b' !== 'a=b'", { expected: "'a=b'", actual: "'a!=b'" }],
			["'x!==y' !== 'z'", { expected: "'z'", actual: "'x!==y'" }],
			["'a !== b' !== 'c'", { expected: "'c'", actual: "'a !== b'" }],
		])(
			"splits %s on Node's comparison, not a quoted operator",
			(line, expected) => {
				// Arrange
				const message = `Expected values to be strictly equal:\n\n${line}`;

				// Act
				const result = parseAssertionValues(message);

				// Assert
				expect(result).toEqual(expected);
			},
		);
	});

	describe("input boundaries", () => {
		it("parses a complete Node assertion ending at the input cap", () => {
			// Arrange
			const assertion =
				"Expected values to be strictly equal:\n\n90 !== 80";
			const prefix = [
				"x".repeat(1_999),
				"x".repeat(1_999),
				"x".repeat(1_999),
				"x".repeat(1_952),
			].join("\n");
			const message = `${prefix}\n${assertion}`;
			expect(message).toHaveLength(8_001);

			// Act
			const result = parseAssertionValues(message);

			// Assert
			expect(result).toEqual({ expected: "80", actual: "90" });
		});

		it("keeps an assertion at the top of a message longer than the parser cap", () => {
			// Arrange
			const message = `Expected: 80\nReceived: 90\n${"x".repeat(9_000)}`;

			// Act
			const result = parseAssertionValues(message);

			// Assert
			expect(result).toEqual({ expected: "80", actual: "90" });
		});

		it("does not return a value that crosses the parser cap", () => {
			// Arrange
			const message = `${"x".repeat(7_980)}\nExpected: 80\nReceived: ${"9".repeat(40)}`;

			// Act
			const result = parseAssertionValues(message);

			// Assert
			expect(result).toBeNull();
		});

		it("returns null when an assertion starts past the parser cap", () => {
			// Arrange
			const message = `${"x".repeat(8_001)}\nExpected: 80\nReceived: 90`;

			// Act
			const result = parseAssertionValues(message);

			// Assert
			expect(result).toBeNull();
		});

		it("does not treat a stack line after an oversized value line as an assertion", () => {
			// Arrange
			const message = `Expected values to be strictly equal:\n${"x".repeat(2_500)}\n    at check (lib/guard.js:4:9) // if (a !== b) throw`;

			// Act
			const result = parseAssertionValues(message);

			// Assert
			expect(result).toBeNull();
		});
	});

	describe("performance: stays linear on an unbounded, adversarial failureMessage", () => {
		// `failureMessage` is a `@db.Text` column with no size cap, and this runs
		// synchronously on both the request path and the sync path. Every one of
		// these inputs used to walk a backtracking regex into quadratic-or-worse
		// behaviour (290ms at n=500, ~2s at n=2000, ~21s at n=5000, a timeout at
		// n=10000, measured before the fix). The bound here is deliberately
		// generous — the point is "nowhere near linear-in-milliseconds", not a
		// tight budget CI could flake on.
		const BUDGET_MS = 50;

		function assertFast(label: string, input: string) {
			const start = performance.now();
			parseAssertionValues(input);
			const elapsed = performance.now() - start;
			expect(
				elapsed,
				`${label} took ${elapsed.toFixed(1)}ms`,
			).toBeLessThan(BUDGET_MS);
		}

		it("Chai/Vitest padding that never resolves to a match", () => {
			assertFast(
				"chai padding",
				`expected${" ".repeat(5000)}to equal${" ".repeat(1000)}y`,
			);
		});

		it("Node one-liner padding after the header", () => {
			assertFast(
				"node one-liner padding",
				`Expected values to be strictly equal:\n${"x".repeat(5000)}${" ".repeat(1000)}z`,
			);
		});

		it("JUnit unbracketed padding with no 'but was:'", () => {
			assertFast(
				"junit padding",
				`expected:${" ".repeat(5000)}y but nothing else here${" ".repeat(1000)}`,
			);
		});

		it("a 200 KB single line mixing every trigger word", () => {
			const mixed =
				"expected " +
				"x ".repeat(80_000) +
				"to " +
				"y ".repeat(40_000) +
				"but was: " +
				"!==".repeat(1000);
			expect(mixed.length).toBeGreaterThan(200_000);

			assertFast("200KB mixed line", mixed);
		});
	});
});
