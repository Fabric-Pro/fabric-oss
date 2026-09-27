/**
 * Unit tests for the shared cause/assertion lines both bug builders draw on.
 *
 * The point: a bug drafted from an Inconclusive or absent analysis must never
 * read as a firmer diagnosis than the analysis behind it.
 */

import { describe, expect, it } from "vitest";
import {
	buildAssertionLines,
	buildCauseLines,
	formatFailureOutput,
} from "../bug-cause-lines";

describe("buildCauseLines", () => {
	it("states plainly that no analysis ran", () => {
		const lines = buildCauseLines({
			analysedAt: null,
			suspectedCause: null,
			suspectedKind: null,
			analysisModel: null,
		});

		expect(lines).toEqual([
			"Cause: not established — no AI analysis has run for this failure.",
		]);
	});

	it("labels an UNKNOWN-kind analysis as inconclusive, then quotes the hypothesis as unverified", () => {
		const lines = buildCauseLines({
			analysedAt: new Date("2026-09-01T00:00:00Z"),
			suspectedCause: "the discount calculation looks off by 10 units",
			suspectedKind: "UNKNOWN",
			analysisModel: "gpt-test",
		});

		expect(lines[0]).toContain("not established");
		expect(lines[0]).toContain("inconclusive");
		expect(lines[1]).toContain("Unverified AI hypothesis");
		expect(lines[1]).toContain("gpt-test");
		expect(lines[1]).toContain(
			"the discount calculation looks off by 10 units",
		);
	});

	it("keeps a null suspected kind inconclusive", () => {
		// Arrange
		const analysis = {
			analysedAt: new Date("2026-09-01T00:00:00Z"),
			suspectedCause: "the runner may have timed out",
			suspectedKind: null,
			analysisModel: "gpt-test",
		};

		// Act
		const lines = buildCauseLines(analysis);

		// Assert
		expect(lines).toEqual([
			"Cause: not established — the AI analysis of this failure was inconclusive.",
			"Unverified AI hypothesis (gpt-test): the runner may have timed out",
		]);
	});

	it("never states a cause more strongly than Inconclusive allows", () => {
		// The exact defect the card reports: an Inconclusive verdict rendered
		// as "the discount calculation is off by 10 units" — a firm cause.
		const lines = buildCauseLines({
			analysedAt: new Date("2026-09-01T00:00:00Z"),
			suspectedCause: "the discount calculation is off by 10 units",
			suspectedKind: "UNKNOWN",
			analysisModel: null,
		});

		expect(lines.join("\n")).not.toMatch(/^the discount calculation/m);
		expect(lines[0]).toContain("not established");
	});

	it.each([
		["PRODUCT_BUG", "Product bug"],
		["TEST_DEFECT", "Test defect"],
		["ENVIRONMENT", "Environment"],
		["FLAKY", "Flaky"],
	])("keeps a named %s verdict unverified", (suspectedKind, label) => {
		// Arrange
		const lines = buildCauseLines({
			analysedAt: new Date("2026-09-01T00:00:00Z"),
			suspectedCause: "the discount logic dropped the percentage sign",
			suspectedKind,
			analysisModel: "gpt-test",
		});

		// Act
		const [causeLine, hypothesisLine] = lines;

		// Assert
		expect(causeLine).toBe(
			"Cause: not established — the AI analysis has not verified this diagnosis.",
		);
		expect(hypothesisLine).toBe(
			`Unverified AI hypothesis (suspected kind: ${label} (gpt-test)): the discount logic dropped the percentage sign`,
		);
	});

	it("treats a verdict this code cannot name as inconclusive, not a confident finding", () => {
		// A future TestFailureKind value this map hasn't caught up with yet must
		// not be shown as a named, confident diagnosis just because it is SET.
		const lines = buildCauseLines({
			analysedAt: new Date("2026-09-01T00:00:00Z"),
			suspectedCause: "cause",
			suspectedKind: "SOMETHING_NEW",
			analysisModel: null,
		});

		expect(lines[0]).toContain("not established");
		expect(lines[0]).toContain("inconclusive");
		expect(lines[1]).toContain("Unverified AI hypothesis");
		expect(lines.join("\n")).not.toContain(
			"AI hypothesis — not a verified diagnosis",
		);
	});
});

describe("buildAssertionLines", () => {
	it("adds Expected/Actual as a markdown list, each on its own line", () => {
		// A bare "Expected: X\nActual: Y" collapses into one paragraph in the
		// markdown editor this body is rendered in — "Expected: X Actual: Y" on
		// a single line. A `-` list item forces the line break.
		expect(
			buildAssertionLines(
				"Expected values to be strictly equal:\n\n90 !== 80\n",
			),
		).toEqual(["- Expected: `80`", "- Actual: `90`"]);
	});

	it("adds no list when a Node property value spans multiple lines", () => {
		// Arrange
		const message = [
			"AssertionError [ERR_ASSERTION]: values differ",
			"  actual: 90,",
			"  detail: unexpected extra context,",
			"  expected: 80,",
			"  operator: 'strictEqual',",
		].join("\n");

		// Act
		const lines = buildAssertionLines(message);

		// Assert
		expect(lines).toEqual([]);
	});

	it("adds nothing when the message does not parse", () => {
		expect(buildAssertionLines("exit code 1")).toEqual([]);
		expect(buildAssertionLines(null)).toEqual([]);
	});

	it("uses a code-span delimiter that contains backticks in parsed values", () => {
		// Arrange
		const message =
			"AssertionError: expected 'actual' to equal 'expected ` ## injected heading ![injected image](https://example.com/pixel)'";

		// Act
		const lines = buildAssertionLines(message);

		// Assert
		expect(lines).toEqual([
			"- Expected: ``'expected ` ## injected heading ![injected image](https://example.com/pixel)'``",
			"- Actual: `'actual'`",
		]);
	});

	it("adds nothing when Node's labelled properties disagree with its one-line summary", () => {
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
		const lines = buildAssertionLines(message);

		// Assert
		expect(lines).toEqual([]);
	});
});

describe("formatFailureOutput", () => {
	it("uses a text fence that stays closed when CI output contains backticks", () => {
		// Arrange
		const failureMessage = "Expected: 80\n```\n## injected heading";

		// Act
		const output = formatFailureOutput(failureMessage);

		// Assert
		expect(output).toContain("~~~~text");
		expect(output).toContain("\n```\n");
		expect(output.endsWith("~~~~")).toBe(true);
	});
});
