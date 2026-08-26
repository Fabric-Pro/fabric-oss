/**
 * QA tab traceability helpers. The parser must reproduce the "AC N"
 * counting the AI test-case drafter uses (criteria in order of appearance), and
 * the matrix must never silently drop a case — unresolvable refs land in the
 * explicit unmapped bucket.
 */

import { describe, expect, it } from "vitest";
import {
	buildTraceabilityMatrix,
	criterionIndexFromRef,
	parseAcceptanceCriteria,
	traceabilityMatrixToMarkdown,
} from "../qa-traceability";

describe("parseAcceptanceCriteria", () => {
	it("returns [] for null/empty/whitespace", () => {
		expect(parseAcceptanceCriteria(null)).toEqual([]);
		expect(parseAcceptanceCriteria(undefined)).toEqual([]);
		expect(parseAcceptanceCriteria("   \n  ")).toEqual([]);
	});

	it("folds CommonMark sub-bullets into the criterion they qualify", () => {
		// Regression: `\s{0,3}` matched a 2-space-indented sub-bullet as a new
		// top-level criterion, so a 2-criterion spec rendered a 4-row matrix and
		// every later "AC N" ref landed on the wrong row — in an audit artifact.
		const result = parseAcceptanceCriteria(
			[
				"- The user can mute a thread",
				"  - muting hides it from the inbox",
				"  - unmuting restores it",
				"- The user receives a daily digest",
			].join("\n"),
		);
		expect(result).toEqual([
			{
				index: 1,
				text: "The user can mute a thread muting hides it from the inbox unmuting restores it",
			},
			{ index: 2, text: "The user receives a daily digest" },
		]);
	});

	it("re-opens the parent criterion when a blank line precedes its sub-bullets", () => {
		const result = parseAcceptanceCriteria(
			["- Parent criterion", "", "  - trailing clause"].join("\n"),
		);
		expect(result).toEqual([
			{ index: 1, text: "Parent criterion trailing clause" },
		]);
	});

	it("parses bulleted criteria in order with 1-based indices", () => {
		const result = parseAcceptanceCriteria(
			"- First criterion\n- Second criterion\n- Third criterion",
		);
		expect(result).toEqual([
			{ index: 1, text: "First criterion" },
			{ index: 2, text: "Second criterion" },
			{ index: 3, text: "Third criterion" },
		]);
	});

	it("parses numbered lists (dot and paren)", () => {
		const result = parseAcceptanceCriteria("1. Alpha\n2) Beta");
		expect(result.map((c) => c.text)).toEqual(["Alpha", "Beta"]);
	});

	it("folds continuation lines into the current list item", () => {
		const result = parseAcceptanceCriteria(
			"- Given a user\n  When they log in\n  Then they see the dashboard\n- Second",
		);
		expect(result).toHaveLength(2);
		expect(result[0].text).toBe(
			"Given a user When they log in Then they see the dashboard",
		);
	});

	it("stops at the first H1/H2 sibling section — leaked sections are not criteria", () => {
		// The AC column stores everything after the spec's "## Acceptance
		// Criteria" heading, so sibling sections leak in (observed on staging:
		// "## Release Planning" bullets rendered as fake AC 8-11). H3 headings
		// GROUP criteria and must not terminate parsing. Lock-step with
		// `boundAcceptanceCriteria` in packages/ai.
		const result = parseAcceptanceCriteria(
			[
				"### Muting",
				"",
				"1.  GIVEN a member WHEN muting THEN muted.",
				"",
				"### Digest Emails",
				"",
				"2.  GIVEN muted WHEN digest runs THEN excluded.",
				"",
				"## Release Planning",
				"",
				"-   Rollout approach: TBD",
				"",
				"## Release Notes",
				"",
				"Prose about the release.",
			].join("\n"),
		);
		expect(result).toEqual([
			{ index: 1, text: "GIVEN a member WHEN muting THEN muted." },
			{ index: 2, text: "GIVEN muted WHEN digest runs THEN excluded." },
		]);
	});

	it("skips H3+ group headings without counting them as criteria", () => {
		const result = parseAcceptanceCriteria(
			"### Group heading\n- Only item",
		);
		expect(result).toEqual([{ index: 1, text: "Only item" }]);
	});

	it("treats a LEADING H2 as a heading of the criteria, not a boundary", () => {
		// e.g. a re-typed "## Acceptance Criteria" at the top of the blob must
		// not zero out the list.
		const result = parseAcceptanceCriteria(
			"## Acceptance Criteria\n- Only item\n\n## Rollout\n- leaked",
		);
		expect(result).toEqual([{ index: 1, text: "Only item" }]);
	});

	it("falls back to paragraph blocks when there is no list (GWT style)", () => {
		const result = parseAcceptanceCriteria(
			"Given A\nWhen B\nThen C\n\nGiven D\nWhen E\nThen F",
		);
		expect(result).toHaveLength(2);
		expect(result[0].text).toBe("Given A When B Then C");
		expect(result[1].text).toBe("Given D When E Then F");
	});

	it("skips markdown thematic breaks — `* * *` must not mint an 'AC N: * *' row", () => {
		// Live-observed: an hr line after the criteria matched the bullet regex
		// as marker `*` + content `* *` and rendered as a phantom criterion.
		const parsed = parseAcceptanceCriteria(
			"- First criterion\n- Second criterion\n\n* * *\n\n---\n\n___",
		);
		expect(parsed.map((c) => c.text)).toEqual([
			"First criterion",
			"Second criterion",
		]);
	});

	it("drops items that carry no letter or digit (markdown debris)", () => {
		const parsed = parseAcceptanceCriteria(
			"- First criterion\n- **\n- * *\n- Second criterion",
		);
		expect(parsed.map((c) => c.text)).toEqual([
			"First criterion",
			"Second criterion",
		]);
		// Numbering stays contiguous — the debris does not reserve an index.
		expect(parsed.map((c) => c.index)).toEqual([1, 2]);
	});

	it("ignores stray prose after a list (no phantom criteria)", () => {
		const result = parseAcceptanceCriteria(
			"- Item one\n\nSome closing note that is not a criterion.",
		);
		expect(result).toHaveLength(1);
	});
});

describe("criterionIndexFromRef", () => {
	it("extracts the first integer from common ref shapes", () => {
		expect(criterionIndexFromRef("AC 3")).toBe(3);
		expect(criterionIndexFromRef("Covers AC 12")).toBe(12);
		expect(criterionIndexFromRef("criterion 2 (partial)")).toBe(2);
	});

	it("returns null for empty, missing, or zero refs", () => {
		expect(criterionIndexFromRef(null)).toBeNull();
		expect(criterionIndexFromRef(undefined)).toBeNull();
		expect(criterionIndexFromRef("")).toBeNull();
		expect(criterionIndexFromRef("the whole spec")).toBeNull();
		expect(criterionIndexFromRef("AC 0")).toBeNull();
	});
});

describe("buildTraceabilityMatrix", () => {
	const criteria = parseAcceptanceCriteria("- One\n- Two");

	it("joins cases to their criterion row by ref index", () => {
		const matrix = buildTraceabilityMatrix(criteria, [
			{ id: "a", acceptanceCriterionRefs: ["AC 1"] },
			{ id: "b", acceptanceCriterionRefs: ["AC 2"] },
			{ id: "c", acceptanceCriterionRefs: ["AC 1"] },
		]);
		expect(matrix.rows[0].cases.map((c) => c.id)).toEqual(["a", "c"]);
		expect(matrix.rows[1].cases.map((c) => c.id)).toEqual(["b"]);
		expect(matrix.unmapped).toEqual([]);
	});

	it("buckets ref-less and out-of-range refs separately, never dropping either", () => {
		// These used to share the `unmapped` bucket. They are different facts —
		// "never mapped" versus "mapped to something I cannot place" — and the
		// remedy differs, so they are reported apart. Neither is dropped.
		const matrix = buildTraceabilityMatrix(criteria, [
			{ id: "none", acceptanceCriterionRefs: [] },
			{ id: "far", acceptanceCriterionRefs: ["AC 9"] },
		]);
		expect(matrix.rows.every((r) => r.cases.length === 0)).toBe(true);
		expect(matrix.unmapped.map((c) => c.id)).toEqual(["none"]);
		expect(matrix.unresolved.map((c) => c.id)).toEqual(["far"]);
	});

	it("keeps a row for every criterion even with zero cases", () => {
		const matrix = buildTraceabilityMatrix(criteria, []);
		expect(matrix.rows).toHaveLength(2);
	});
});

describe("traceabilityMatrixToMarkdown — compliance export", () => {
	const criteria = parseAcceptanceCriteria(
		"- First criterion\n- Second criterion",
	);
	const mkCase = (
		over: {
			id?: string;
			identifier?: string;
			title?: string;
			currentResult?: string;
			acceptanceCriterionRefs?: string[];
		} = {},
	) => ({
		id: over.id ?? "c1",
		identifier: over.identifier ?? "TC-001",
		title: over.title ?? "covers login",
		currentResult: over.currentResult ?? "PASSED",
		acceptanceCriterionRefs: over.acceptanceCriterionRefs ?? ["AC 1"],
	});

	it("prints an uncovered criterion as an explicit gap, never omits it", () => {
		const matrix = buildTraceabilityMatrix(criteria, [mkCase()]);
		const md = traceabilityMatrixToMarkdown({ matrix });

		// The export is evidence: it must prove the absence of coverage too.
		expect(md).toContain("coverage gap");
		expect(md).toContain("Second criterion");
		expect(md).toContain("gaps: 1");
	});

	it("carries each case's latest result", () => {
		const matrix = buildTraceabilityMatrix(criteria, [
			mkCase({ currentResult: "FAILED" }),
		]);
		expect(traceabilityMatrixToMarkdown({ matrix })).toContain("FAILED");
	});

	it("declares a partial export rather than implying full coverage", () => {
		const matrix = buildTraceabilityMatrix(criteria, [mkCase()]);
		const md = traceabilityMatrixToMarkdown({
			matrix,
			totalCases: 40,
			truncated: true,
		});
		// An audit document that describes one page as the whole set is worse
		// than no document.
		expect(md).toContain("Partial export");
		expect(md).toContain("40");
	});

	it("lists cases whose ref maps to no criterion instead of dropping them", () => {
		// The export is evidence, so an unplaceable reference has to appear —
		// under its own heading, because an auditor reading "not mapped" would
		// conclude nobody tried, and somebody did.
		const matrix = buildTraceabilityMatrix(criteria, [
			mkCase({
				id: "c9",
				identifier: "TC-009",
				acceptanceCriterionRefs: ["AC 99"],
			}),
		]);
		const md = traceabilityMatrixToMarkdown({ matrix });
		expect(md).toContain("could not be placed");
		expect(md).toContain("TC-009");
		// The reference itself is printed, since it is the thing to fix.
		expect(md).toContain("AC 99");
	});

	it("escapes pipes and newlines so free text can't break the table", () => {
		const odd = parseAcceptanceCriteria("- has a | pipe");
		const matrix = buildTraceabilityMatrix(odd, []);
		const md = traceabilityMatrixToMarkdown({ matrix });
		const row = md.split("\n").find((l) => l.includes("pipe"));
		expect(row).toContain("\\|");
		// Count DELIMITERS only — an escaped pipe is still the `|` character, so
		// splitting on the raw char cannot tell a column break from escaped text.
		// 4 columns => 5 unescaped delimiters => 6 segments.
		expect(row?.split(/(?<!\\)\|/).length).toBe(6);
	});
});

/**
 * "Linked but unplaceable" is not the same as "never linked".
 *
 * The traceability criterion says a case explicitly linked to a criterion is
 * never shown as unmapped. It was: a free-text reference, or a number past the
 * end of the criteria after the specification shrank, both fell into the same
 * bucket as a case nobody had mapped at all. Telling somebody to map a case they
 * already mapped sends them round the same loop, because the second attempt
 * fails identically — the fix is usually the criterion text, not the case.
 */
describe("buildTraceabilityMatrix — unresolved vs unmapped", () => {
	const criteria = parseAcceptanceCriteria("- First\n- Second");
	const mk = (id: string, ...refs: string[]) => ({
		id,
		acceptanceCriterionRefs: refs,
	});

	it("places a case whose ref resolves", () => {
		const m = buildTraceabilityMatrix(criteria, [mk("a", "AC 2")]);

		expect(m.rows[1].cases.map((c) => c.id)).toEqual(["a"]);
		expect(m.unmapped).toEqual([]);
		expect(m.unresolved).toEqual([]);
	});

	it("reports a ref past the end as UNRESOLVED, not unmapped", () => {
		// The spec shrank from 7 criteria to 2 after the case was written.
		const m = buildTraceabilityMatrix(criteria, [mk("a", "AC 7")]);

		expect(m.unresolved.map((c) => c.id)).toEqual(["a"]);
		expect(m.unmapped).toEqual([]);
	});

	it("reports a free-text ref as UNRESOLVED, not unmapped", () => {
		const m = buildTraceabilityMatrix(criteria, [
			mk("a", "covers the login criterion"),
		]);

		expect(m.unresolved.map((c) => c.id)).toEqual(["a"]);
		expect(m.unmapped).toEqual([]);
	});

	it("keeps a case with no ref in unmapped", () => {
		const m = buildTraceabilityMatrix(criteria, [mk("a")]);

		expect(m.unmapped.map((c) => c.id)).toEqual(["a"]);
		expect(m.unresolved).toEqual([]);
	});

	it("treats whitespace as no reference at all", () => {
		// An empty box is not an attempt to map something.
		const m = buildTraceabilityMatrix(criteria, [mk("a", "   ")]);

		expect(m.unmapped.map((c) => c.id)).toEqual(["a"]);
		expect(m.unresolved).toEqual([]);
	});

	it("counts unresolved cases in the export's loaded total", () => {
		// A partial-export warning that ignored them would understate the set.
		const m = buildTraceabilityMatrix(criteria, [
			{
				...mk("a", "AC 9"),
				identifier: "TC-1",
				title: "T",
				currentResult: "NOT_RUN",
			},
		]);
		const md = traceabilityMatrixToMarkdown({
			matrix: m,
			totalCases: 5,
			truncated: true,
		});

		expect(md).toMatch(/1 of 5 linked cases/);
		expect(md).toMatch(/could not be placed/i);
		expect(md).toMatch(/AC 9/);
	});
});

/**
 * A case can cover more than one criterion (2026-07-31).
 *
 * The storage held one reference per link until then, so a case proving AC 1
 * and AC 3 was counted under whichever came first and the other criterion read
 * as uncovered. The coverage figure said less than the suite actually did.
 */
describe("buildTraceabilityMatrix — a case covering several criteria", () => {
	const criteria = parseAcceptanceCriteria("- First\n- Second\n- Third");
	const mk = (id: string, ...refs: string[]) => ({
		id,
		acceptanceCriterionRefs: refs,
	});

	it("lists the case under every criterion it names", () => {
		const m = buildTraceabilityMatrix(criteria, [mk("a", "AC 1", "AC 3")]);

		expect(m.rows[0].cases.map((c) => c.id)).toEqual(["a"]);
		expect(m.rows[1].cases).toEqual([]);
		expect(m.rows[2].cases.map((c) => c.id)).toEqual(["a"]);
		expect(m.unmapped).toEqual([]);
		expect(m.unresolved).toEqual([]);
	});

	it("keeps a case mapped when only SOME of its refs resolve", () => {
		// One bad reference must not discard a good one. Reporting this case as
		// unresolved would hide that it genuinely covers AC 1.
		const m = buildTraceabilityMatrix(criteria, [mk("a", "AC 1", "AC 99")]);

		expect(m.rows[0].cases.map((c) => c.id)).toEqual(["a"]);
		expect(m.unresolved).toEqual([]);
		expect(m.unmapped).toEqual([]);
	});

	it("is unresolved only when NO ref resolves", () => {
		const m = buildTraceabilityMatrix(criteria, [
			mk("a", "AC 98", "AC 99"),
		]);

		expect(m.unresolved.map((c) => c.id)).toEqual(["a"]);
		expect(m.unmapped).toEqual([]);
	});

	it("is unmapped when it names nothing, and whitespace names nothing", () => {
		const m = buildTraceabilityMatrix(criteria, [mk("a"), mk("b", "  ")]);

		expect(m.unmapped.map((c) => c.id)).toEqual(["a", "b"]);
		expect(m.unresolved).toEqual([]);
	});

	it("lists a case once when two of its refs point at the same criterion", () => {
		// "AC 3" and "3" resolve to the same row. Listing the case twice would
		// double it in that criterion's coverage count.
		const m = buildTraceabilityMatrix(criteria, [mk("a", "AC 3", "3")]);

		expect(m.rows[2].cases.map((c) => c.id)).toEqual(["a"]);
	});
});
