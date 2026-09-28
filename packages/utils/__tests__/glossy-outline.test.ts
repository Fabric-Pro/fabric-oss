import { describe, expect, it } from "vitest";
import {
	headingAnchor,
	parseOutline,
	scanFences,
	VISUAL_SLOT_HINT_ATTR,
	VISUAL_SLOT_ID_ATTR,
	VISUAL_SLOT_KIND_ATTR,
	VISUAL_SLOT_TAG,
} from "../lib/glossy/outline";

describe("scanFences", () => {
	it("marks a fence's opening marker, its lines, and its closing marker", () => {
		expect(
			scanFences([
				"before",
				"```mermaid",
				"graph TD",
				"",
				"```",
				"after",
			]),
		).toEqual([null, "open", "inside", "inside", "close", null]);
	});

	it("closes only on the same character with at least as many repetitions", () => {
		expect(scanFences(["````md", "```", "~~~~", "````", "after"])).toEqual([
			"open",
			"inside",
			"inside",
			"close",
			null,
		]);
		expect(scanFences(["```", "`````", "after"])).toEqual([
			"open",
			"close",
			null,
		]);
	});

	it("tracks tilde and backtick fences independently", () => {
		expect(scanFences(["~~~", "```", "~~~", "```", "x", "```"])).toEqual([
			"open",
			"inside",
			"close",
			"open",
			"inside",
			"close",
		]);
	});

	it("runs an unclosed fence to the last line", () => {
		expect(scanFences(["text", "~~~", "## not a heading", "```"])).toEqual([
			null,
			"open",
			"inside",
			"inside",
		]);
	});

	it("allows up to 3 spaces of indent, and no marker shorter than 3", () => {
		expect(scanFences(["   ```", "x", "   ```"])).toEqual([
			"open",
			"inside",
			"close",
		]);
		expect(scanFences(["    ```", "``", "~~"])).toEqual([null, null, null]);
	});
});

describe("parseOutline", () => {
	describe("fence-aware: a heading-shaped line inside a fence is not a heading", () => {
		it("skips a `##` line inside a triple-backtick fence", () => {
			const markdown = [
				"## Real Heading",
				"",
				"```",
				"## Not a heading",
				"```",
				"",
				"## Another Real Heading",
			].join("\n");

			const headings = parseOutline(markdown);

			expect(headings.map((h) => h.text)).toEqual([
				"Real Heading",
				"Another Real Heading",
			]);
		});

		it("also skips inside a tilde (~~~) fence", () => {
			const markdown = [
				"## Real Heading",
				"~~~",
				"## Not a heading",
				"~~~",
				"## After",
			].join("\n");

			const headings = parseOutline(markdown);

			expect(headings.map((h) => h.text)).toEqual([
				"Real Heading",
				"After",
			]);
		});

		it("tolerates up to 3 spaces of indent on the fence marker", () => {
			const markdown = [
				"## Real Heading",
				"   ```",
				"## Not a heading",
				"   ```",
				"## After",
			].join("\n");

			const headings = parseOutline(markdown);

			expect(headings.map((h) => h.text)).toEqual([
				"Real Heading",
				"After",
			]);
		});

		it("does not treat 4-space indent as a fence, so the heading inside is real", () => {
			const markdown = [
				"## Real Heading",
				"    ```",
				"## Also Real",
			].join("\n");

			const headings = parseOutline(markdown);

			expect(headings.map((h) => h.text)).toEqual([
				"Real Heading",
				"Also Real",
			]);
		});

		it("a mismatched marker character does not close the fence", () => {
			// Per the ported `parseHeadings` rule: only the SAME character, with
			// at least as many repetitions, closes an open fence.
			const markdown = [
				"## Real Heading",
				"```",
				"~~~",
				"## Still inside the fence",
				"```",
				"## After",
			].join("\n");

			const headings = parseOutline(markdown);

			expect(headings.map((h) => h.text)).toEqual([
				"Real Heading",
				"After",
			]);
		});

		it("a shorter closing marker does not close a longer opening fence", () => {
			const markdown = [
				"## Real Heading",
				"````",
				"## Not a heading",
				"```",
				"## Still not a heading",
				"````",
				"## After",
			].join("\n");

			const headings = parseOutline(markdown);

			expect(headings.map((h) => h.text)).toEqual([
				"Real Heading",
				"After",
			]);
		});
	});

	describe("heading anchor sharing (KTD7 identity key)", () => {
		it("numbered-dot and numbered-paren headings share the anchor 'scope'", () => {
			const markdown = [
				"## 5. Scope (Required)",
				"",
				"body",
				"",
				"## 6) Scope",
			].join("\n");

			const headings = parseOutline(markdown);

			expect(headings).toHaveLength(2);
			expect(headings[0].headingPath).toEqual(["scope"]);
			expect(headings[1].headingPath).toEqual(["scope"]);
		});

		it("gives same-path headings occurrence indexes 0 and 1, in document order", () => {
			const markdown = [
				"## 5. Scope (Required)",
				"",
				"body",
				"",
				"## 6) Scope",
			].join("\n");

			const headings = parseOutline(markdown);

			expect(headings[0].occurrenceIndex).toBe(0);
			expect(headings[1].occurrenceIndex).toBe(1);
		});

		it("gives two literally identical headings occurrence indexes 0 and 1", () => {
			const markdown = ["## Scope", "", "## Scope"].join("\n");

			const headings = parseOutline(markdown);

			expect(headings.map((h) => h.occurrenceIndex)).toEqual([0, 1]);
		});

		it("does not increment occurrence for a heading with a different anchor", () => {
			const markdown = ["## Scope", "", "## Timeline"].join("\n");

			const headings = parseOutline(markdown);

			expect(headings.map((h) => h.occurrenceIndex)).toEqual([0, 0]);
		});
	});

	describe("heading path", () => {
		it("a ### heading's path includes its parent ##", () => {
			const markdown = ["## Parent", "", "### Child"].join("\n");

			const headings = parseOutline(markdown);

			expect(headings[1].headingPath).toEqual(["parent", "child"]);
		});

		it("a top-level heading's path is just its own anchor", () => {
			const headings = parseOutline("## Solo");

			expect(headings[0].headingPath).toEqual(["solo"]);
		});

		it("closes an ancestor once a same-or-shallower heading appears", () => {
			const markdown = [
				"## Parent",
				"### Child",
				"## Sibling",
				"### Sibling Child",
			].join("\n");

			const headings = parseOutline(markdown);

			expect(headings.map((h) => h.headingPath)).toEqual([
				["parent"],
				["parent", "child"],
				["sibling"],
				["sibling", "sibling child"],
			]);
		});

		it("tolerates a skipped level (### with no ## ancestor)", () => {
			const headings = parseOutline("### Orphan");

			expect(headings[0].headingPath).toEqual(["orphan"]);
		});
	});

	describe("level and line span", () => {
		it("reports level 1 through 6 for # through ######", () => {
			const markdown = [
				"# H1",
				"## H2",
				"### H3",
				"#### H4",
				"##### H5",
				"###### H6",
			].join("\n");

			const headings = parseOutline(markdown);

			expect(headings.map((h) => h.level)).toEqual([1, 2, 3, 4, 5, 6]);
		});

		it("spans a heading up to the line before the next same-or-shallower heading", () => {
			const markdown = [
				"## A", // line 1
				"text a", // line 2
				"", // line 3
				"### B", // line 4
				"text b", // line 5
				"", // line 6
				"## C", // line 7
				"text c", // line 8
			].join("\n");

			const headings = parseOutline(markdown);

			expect(headings[0]).toMatchObject({
				text: "A",
				startLine: 1,
				endLine: 6,
			});
			expect(headings[1]).toMatchObject({
				text: "B",
				startLine: 4,
				endLine: 6,
			});
			expect(headings[2]).toMatchObject({
				text: "C",
				startLine: 7,
				endLine: 8,
			});
		});

		it("a subsection's span nests inside its parent's, not past it", () => {
			// The parent's span includes the subsection's lines (hierarchical),
			// so a caller using the ## body only when no ### is present still
			// sees the subsection text as part of it.
			const markdown = [
				"## Parent",
				"### Child",
				"child text",
				"## Next",
			].join("\n");

			const headings = parseOutline(markdown);

			expect(headings[0].endLine).toBeGreaterThanOrEqual(
				headings[1].endLine,
			);
		});
	});

	describe("degenerate input", () => {
		it("returns an empty array for an empty document", () => {
			expect(parseOutline("")).toEqual([]);
		});

		it("returns an empty array for a document with no headings", () => {
			expect(parseOutline("just prose\n\nmore prose")).toEqual([]);
		});
	});
});

describe("headingAnchor", () => {
	it("normalizes a dot-numbered heading with a tag suffix", () => {
		expect(headingAnchor("5. Scope (Required)")).toBe("scope");
	});

	it("normalizes a paren-numbered heading with no tag suffix", () => {
		expect(headingAnchor("6) Scope")).toBe("scope");
	});

	it("handles a letter-suffixed number, e.g. Proposal's '1A.' numbering", () => {
		expect(headingAnchor("1A. Source Index")).toBe("source index");
	});

	it("strips multiple trailing tag suffixes", () => {
		expect(headingAnchor("Scope (Required) (Draft)")).toBe("scope");
	});

	it("strips inline decoration before anchoring", () => {
		expect(headingAnchor("**Executive Summary**")).toBe(
			"executive summary",
		);
	});

	it("collapses internal whitespace and lowercases", () => {
		expect(headingAnchor("  Investment   Ask  ")).toBe("investment ask");
	});

	it("returns '' for null, undefined, and whitespace-only input", () => {
		expect(headingAnchor(null)).toBe("");
		expect(headingAnchor(undefined)).toBe("");
		expect(headingAnchor("   ")).toBe("");
	});
});

describe("visual slot tag grammar (KTD18)", () => {
	it("matches the markdown form <visual-slot data-slot-id data-kind data-hint></visual-slot>", () => {
		const tag = `<${VISUAL_SLOT_TAG} ${VISUAL_SLOT_ID_ATTR} ${VISUAL_SLOT_KIND_ATTR} ${VISUAL_SLOT_HINT_ATTR}></${VISUAL_SLOT_TAG}>`;

		expect(tag).toBe(
			"<visual-slot data-slot-id data-kind data-hint></visual-slot>",
		);
	});
});

describe("headingAnchor editor-escaped numbering", () => {
	it("treats an editor-escaped numbering separator like the plain one", () => {
		expect(headingAnchor("5\\. Scope")).toBe("scope");
		expect(headingAnchor("5\\) Scope (Required)")).toBe("scope");
		expect(headingAnchor("5\\. Scope")).toBe(headingAnchor("5. Scope"));
	});
});
