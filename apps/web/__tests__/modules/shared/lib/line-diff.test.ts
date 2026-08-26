import { prefixDiffPart } from "@shared/lib/line-diff";
import { diffLines } from "diff";
import { describe, expect, it } from "vitest";

// prefixDiffPart renders a `diff` part as gutter-marked lines. It was written
// for the Playwright script history and is now shared with the prompt version
// history, so the marker/newline handling is pinned here rather than in either
// caller.
describe("prefixDiffPart", () => {
	it("marks added lines with '+ ' and removed lines with '- '", () => {
		expect(prefixDiffPart({ value: "hello\n", added: true })).toBe(
			"+ hello\n",
		);
		expect(prefixDiffPart({ value: "hello\n", removed: true })).toBe(
			"- hello\n",
		);
	});

	it("marks unchanged lines with two spaces", () => {
		expect(prefixDiffPart({ value: "hello\n" })).toBe("  hello\n");
	});

	it("prefixes every line of a multi-line part", () => {
		expect(prefixDiffPart({ value: "a\nb\nc\n", added: true })).toBe(
			"+ a\n+ b\n+ c\n",
		);
	});

	it("does not emit a marker for the empty trailing segment", () => {
		// "a\n".split("\n") is ["a", ""] — the empty tail must not become "  ",
		// or every part would render a phantom gutter line.
		expect(prefixDiffPart({ value: "a\n" })).toBe("  a\n");
	});

	it("handles a part with no trailing newline", () => {
		expect(prefixDiffPart({ value: "a\nb", removed: true })).toBe(
			"- a\n- b",
		);
	});

	it("round-trips a real diffLines result without losing content", () => {
		const before = "one\ntwo\nthree\n";
		const after = "one\ntwo point five\nthree\n";
		const rendered = diffLines(before, after).map(prefixDiffPart).join("");

		expect(rendered).toContain("  one");
		expect(rendered).toContain("- two\n");
		expect(rendered).toContain("+ two point five");
		expect(rendered).toContain("  three");
	});
});
