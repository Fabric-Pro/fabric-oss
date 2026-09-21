/**
 * `countDiffLines` has to agree with what `prefixDiffPart` actually draws,
 * because the two describe the same diff: the header says `+N −N` and the
 * body below it draws the lines. `diffLines` keeps each part's terminating
 * newline, so the naive `split("\n").length` over-counts by exactly one line
 * per part — which is the miscount these cases pin.
 */
import { diffLines } from "diff";
import { describe, expect, it } from "vitest";
import { countDiffLines, toDiffRows } from "../lib/instruction-diff";

/** The text the <pre> actually shows, as the rows are concatenated in it. */
function rendered(parts: Parameters<typeof countDiffLines>[0]): string {
	return toDiffRows(parts)
		.map((row) => row.text)
		.join("");
}

/** Gutter lines the rendered <pre> would actually contain, by marker. */
function renderedCounts(parts: Parameters<typeof countDiffLines>[0]) {
	const lines = rendered(parts)
		.split("\n")
		.filter((line) => line.length > 0);
	return {
		added: lines.filter((line) => line.startsWith("+ ")).length,
		removed: lines.filter((line) => line.startsWith("- ")).length,
	};
}

describe("countDiffLines", () => {
	it("counts nothing for an unchanged body", () => {
		expect(countDiffLines(diffLines("a\nb\n", "a\nb\n"))).toEqual({
			added: 0,
			removed: 0,
		});
	});

	it("counts every line of a brand-new file as added", () => {
		const parts = diffLines("", "one\ntwo\nthree\n");
		expect(countDiffLines(parts)).toEqual({ added: 3, removed: 0 });
		expect(countDiffLines(parts)).toEqual(renderedCounts(parts));
	});

	it("counts every line of a deleted file as removed", () => {
		const parts = diffLines("one\ntwo\n", "");
		expect(countDiffLines(parts)).toEqual({ added: 0, removed: 2 });
		expect(countDiffLines(parts)).toEqual(renderedCounts(parts));
	});

	it("counts both sides of an edit and ignores the context around it", () => {
		const parts = diffLines(
			"intro\nold line\ntail\n",
			"intro\nnew line\nanother new line\ntail\n",
		);
		expect(countDiffLines(parts)).toEqual({ added: 2, removed: 1 });
		expect(countDiffLines(parts)).toEqual(renderedCounts(parts));
	});

	it("does not count the empty segment a trailing newline leaves behind", () => {
		// One added line, written with its newline — `split("\n")` yields
		// ["only", ""], and the empty tail renders nothing.
		expect(countDiffLines([{ value: "only\n", added: true }])).toEqual({
			added: 1,
			removed: 0,
		});
		// A file whose last line has no newline still counts as one line.
		expect(countDiffLines([{ value: "only", added: true }])).toEqual({
			added: 1,
			removed: 0,
		});
		expect(countDiffLines([{ value: "", added: true }])).toEqual({
			added: 0,
			removed: 0,
		});
	});
});

/**
 * A part boundary has to be a ROW boundary.
 *
 * `diffLines` (diff@8.0.3) leaves the terminating newline on the part that
 * owns the line, so a file whose last line has no newline produces a part
 * without one — and for a single-line file that is the only part. Rendering
 * `prefixDiffPart` over those back to back merged the removed and the added
 * line into one row, `- old+ new`, showing the reader a line that exists in
 * neither version. These pin the two shapes the review reproduced.
 */
describe("toDiffRows", () => {
	it("separates a changed single line that carries no trailing newline", () => {
		const parts = diffLines("old", "new");
		// The shape this regression depends on, asserted rather than assumed.
		expect(parts.map((p) => p.value)).toEqual(["old", "new"]);

		expect(rendered(parts)).toBe("- old\n+ new");
		expect(rendered(parts).split("\n")).toEqual(["- old", "+ new"]);
	});

	it("separates the two sides when only the trailing newline changed", () => {
		const parts = diffLines("line", "line\n");
		expect(parts.map((p) => p.value)).toEqual(["line", "line\n"]);

		expect(rendered(parts)).toBe("- line\n+ line\n");
		expect(
			rendered(parts)
				.split("\n")
				.filter((l) => l.length > 0),
		).toEqual(["- line", "+ line"]);
	});

	it("separates a changed last line that follows context", () => {
		const parts = diffLines("a\nb", "a\nc");
		expect(rendered(parts).split("\n")).toEqual(["  a", "- b", "+ c"]);
	});

	it("adds no boundary after the final part, so no empty trailing row", () => {
		expect(rendered(diffLines("", "only"))).toBe("+ only");
		expect(rendered(diffLines("only", ""))).toBe("- only");
		// A part that already closes itself is left exactly as it was.
		expect(rendered(diffLines("a\n", "b\n"))).toBe("- a\n+ b\n");
	});

	it("carries each part's added/removed flag onto its row", () => {
		expect(toDiffRows(diffLines("old", "new"))).toEqual([
			{ text: "- old\n", added: false, removed: true },
			{ text: "+ new", added: true, removed: false },
		]);
	});

	it("counts the inserted boundaries as separators, not as lines", () => {
		// Two rows on screen, one added and one removed line — the "\n" that
		// splits them belongs to neither.
		const parts = diffLines("old", "new");
		expect(countDiffLines(parts)).toEqual({ added: 1, removed: 1 });
		expect(countDiffLines(parts)).toEqual(renderedCounts(parts));
	});
});
