/**
 * Regression corpus for THE acceptance-criteria parser.
 *
 * This file was a *parity* guard: `parseAcceptanceCriteria` (QA tab, builds the
 * traceability matrix) and `countAcceptanceCriteria` (@repo/ai, sizes the
 * drafter's per-criterion cap and defines the "AC N" numbering the drafter is
 * told to use) were two independent implementations of one contract, and they had
 * already drifted once — an H3-grouped prose spec read as 2 criteria in the
 * matrix and 0 in the drafter.
 *
 * Parity guarding was the wrong fix. A differential run over 11,154 generated
 * blobs found the two still disagreeing on 2,098 of them, in BOTH directions —
 * this corpus could only ever cover the shapes somebody thought to add. So there
 * is now ONE implementation in `@repo/utils/acceptance-criteria`, both call sites
 * re-export it, and `countAcceptanceCriteria` is defined as the parser's length.
 *
 * The corpus keeps its value as a regression pin on that single parser: every
 * blob asserts an EXPECTED count, not merely that two functions agree. Two
 * functions agreeing on a wrong answer was always a passing test.
 *
 * The `disagreed` block at the bottom holds minimal reproducers the differential
 * run surfaced. Each documents which implementation was right and why, so the
 * unified behaviour is pinned rather than merely inherited.
 */

// The parser straight from its canonical home, and the count through @repo/ai's
// re-export — so a future change that gives the drafter its own scan again fails
// here instead of drifting silently, which is what happened last time.
import { countAcceptanceCriteria } from "@repo/ai";
import { parseAcceptanceCriteria } from "@repo/utils/acceptance-criteria";
import { describe, expect, it } from "vitest";

const CORPUS: Array<{ name: string; markdown: string; expected: number }> = [
	{
		name: "flat bullets",
		markdown: "- First\n- Second\n- Third",
		expected: 3,
	},
	{
		name: "numbered list",
		markdown: "1. First\n2. Second",
		expected: 2,
	},
	{
		name: "nested sub-bullets belong to their parent",
		markdown: [
			"- The user can mute a thread",
			"  - muting hides it from the inbox",
			"  - unmuting restores it",
			"- The user receives a daily digest",
		].join("\n"),
		expected: 2,
	},
	{
		name: "deeply nested sub-bullets",
		markdown: [
			"- Parent",
			"  - child",
			"    - grandchild",
			"- Sibling",
		].join("\n"),
		expected: 2,
	},
	{
		name: "thematic break is not a criterion",
		markdown: "- First\n\n* * *\n\n- Second",
		expected: 2,
	},
	{
		name: "paragraph blocks when no list exists",
		markdown: "The user can log in.\n\nThe user can log out.",
		expected: 2,
	},
	{
		name: "H3 sub-group headings keep the prose under them",
		markdown: [
			"### Muting",
			"The user can mute a thread.",
			"",
			"### Digest",
			"The user receives a daily digest.",
		].join("\n"),
		expected: 2,
	},
	{
		name: "a leading H2 heads the criteria rather than bounding them",
		markdown: "## Acceptance Criteria\n\n- First\n- Second",
		expected: 2,
	},
	{
		name: "a trailing H2 bounds the criteria",
		markdown:
			"- First\n- Second\n\n## Release Planning\n\n- Not a criterion",
		expected: 2,
	},
];

describe("acceptance-criteria parser", () => {
	for (const { name, markdown, expected } of CORPUS) {
		it(`counts: ${name}`, () => {
			expect(parseAcceptanceCriteria(markdown)).toHaveLength(expected);
			// Asserted through @repo/ai's re-export too, so the drafter losing its
			// delegation would fail here rather than silently drift again.
			expect(countAcceptanceCriteria(markdown)).toBe(expected);
		});
	}

	it("reads an empty blob as no criteria", () => {
		expect(parseAcceptanceCriteria("   \n  ")).toEqual([]);
		expect(countAcceptanceCriteria("   \n  ")).toBe(0);
	});

	/**
	 * Minimal reproducers where the two former implementations disagreed. The
	 * unified answer is pinned here WITH the reason it is the right one, because
	 * "whatever the surviving implementation happened to do" is not a contract.
	 */
	describe("shapes the two old implementations disagreed on", () => {
		it("counts lead-in prose above a list as its own criterion", () => {
			// Old counter: 1 — it only ever counted list markers and ignored prose.
			// Parser: 2, and the parser wins because the MATRIX renders what it
			// produces, so "AC 2" written against that matrix has to mean the same
			// row the drafter was told about.
			expect(parseAcceptanceCriteria("> quote\n* Beta")).toHaveLength(2);
			expect(countAcceptanceCriteria("> quote\n* Beta")).toBe(2);
		});

		it("folds sub-bullets under an empty parent marker into one criterion", () => {
			// Old counter: 2 — its marker regex demanded a letter or digit on the
			// marker line, so an empty "- " parent was skipped and its two indented
			// children became top-level criteria. Parser: 1, the CommonMark
			// reading — they qualify the item above them.
			const markdown = "- \n\t- tabbed\n\t- tabbed";
			expect(parseAcceptanceCriteria(markdown)).toHaveLength(1);
			expect(countAcceptanceCriteria(markdown)).toBe(1);
		});

		it("keeps the list item beneath a thematic break and a heading", () => {
			// Old counter: 0. Parser: 1 — the surviving list item is the criterion.
			const markdown = "---\n# Title\n* Beta";
			expect(parseAcceptanceCriteria(markdown)).toHaveLength(1);
			expect(countAcceptanceCriteria(markdown)).toBe(1);
		});

		it("finds nothing in an empty marker followed by stray prose", () => {
			// Old counter: 1 — its marker scan credited the bare "- ". Parser: 0,
			// and 0 is right on both counts: an item carrying no letter or digit is
			// markdown debris, and once a list has been seen, prose after it does
			// not mint a criterion (which is what stops a trailing note becoming
			// one). This is the direction that DECREASES the drafter's count.
			expect(parseAcceptanceCriteria("- \n\n> quote")).toHaveLength(0);
			expect(countAcceptanceCriteria("- \n\n> quote")).toBe(0);
		});
	});
});
