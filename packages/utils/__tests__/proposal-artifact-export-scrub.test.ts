import { describe, expect, it } from "vitest";
import { scrubProposalExport } from "../lib/proposal-artifact/export-scrub";

function scrub(markdown: string): string {
	return scrubProposalExport(markdown).markdown;
}

describe("scrubProposalExport", () => {
	it("removes citation markers in every written form and closes the gaps", () => {
		const input = [
			"Revenue grew 40% [S3].",
			"Two sources agree \\[S2\\] and **[S4]**, see [S1–S3].",
			"A range [S1]–[S15] and a placeholder [cite if derived] go.",
			"Linked [S5](#source-5) too.",
		].join("\n");
		const result = scrubProposalExport(input);
		expect(result.markdown).toBe(
			[
				"Revenue grew 40%.",
				"Two sources agree and, see.",
				"A range and a placeholder go.",
				"Linked too.",
			].join("\n"),
		);
		expect(result.removedMarkers).toBe(7);
		expect(result.removedSections).toBe(0);
	});

	it("keeps markers inside inline code and fenced code", () => {
		const input = [
			"Write `[S1]` to cite a source [S2].",
			"```text",
			"Example citation: [S3]",
			"```",
			"~~~",
			"[S4] stays",
			"~~~",
		].join("\n");
		expect(scrub(input)).toBe(
			[
				"Write `[S1]` to cite a source.",
				"```text",
				"Example citation: [S3]",
				"```",
				"~~~",
				"[S4] stays",
				"~~~",
			].join("\n"),
		);
	});

	it("keeps the document's own Appendix and TBD lines exactly as written", () => {
		const input = [
			"# Example Proposal",
			"",
			"## Pricing",
			"",
			"Fee: TBD pending scope review.",
			"",
			"## Appendix A: Assumptions",
			"",
			"- Hosting stays on the client's cloud account.",
			"- Start date: TBD",
		].join("\n");
		const result = scrubProposalExport(input);
		expect(result.markdown).toBe(input);
		expect(result.removedMarkers).toBe(0);
	});

	it("removes a Source Index section with its subsections, numbered or not", () => {
		const input = [
			"## Approach",
			"",
			"We start with discovery [S1].",
			"",
			"## 1A. Source Index",
			"",
			"- [S1] Discovery call notes",
			"",
			"### Excerpts",
			"",
			"Internal excerpt text.",
			"",
			"## Team",
			"",
			"Two engineers.",
		].join("\n");
		const result = scrubProposalExport(input);
		expect(result.markdown).toBe(
			[
				"## Approach",
				"",
				"We start with discovery.",
				"",
				"## Team",
				"",
				"Two engineers.",
			].join("\n"),
		);
		expect(result.removedSections).toBe(1);
		expect(result.removedMarkers).toBe(1);
	});

	it("removes a Sources section only when its first entry is an [S#] label", () => {
		const indexed = [
			"## Summary",
			"",
			"Body.",
			"",
			"## Sources",
			"",
			"1. **[S1]** Kickoff meeting transcript",
			"2. [S2] Requirements document",
		].join("\n");
		expect(scrub(indexed)).toBe(["## Summary", "", "Body.", ""].join("\n"));

		const prose = [
			"## Sources",
			"",
			"Our estimates draw on three comparable delivery projects.",
		].join("\n");
		expect(scrub(prose)).toBe(prose);
	});

	it("never treats a heading inside a fence as a section", () => {
		const input = [
			"```markdown",
			"## Source Index",
			"- [S1] example",
			"```",
			"",
			"Done.",
		].join("\n");
		expect(scrub(input)).toBe(input);
	});

	it("keeps indentation and a trailing hard break on a scrubbed line", () => {
		const input = ["- Item one [S1]  ", "  continued [S2] here."].join(
			"\n",
		);
		expect(scrub(input)).toBe(
			["- Item one  ", "  continued here."].join("\n"),
		);
	});

	it("drops a line that held only markers", () => {
		const input = ["Paragraph.", "[S1] [S2]", "", "- [S3]", "- Kept"].join(
			"\n",
		);
		expect(scrub(input)).toBe(["Paragraph.", "", "- Kept"].join("\n"));
	});

	it("reads CRLF line endings and returns LF", () => {
		expect(scrub("Line one [S1].\r\nLine two.\r\n")).toBe(
			"Line one.\nLine two.\n",
		);
	});

	it("never reassembles a marker out of what removing one leaves behind", () => {
		expect(scrub("a [S[S1]1] b")).toBe("a b");
		expect(scrub("a [S1[S2]] b")).toBe("a b");
		expect(scrub("[c[S1]ite] text")).toBe("text");
		// Tidying an emptied pair of brackets cannot join one either.
		expect(scrub("x [S2] [S()1] y")).toBe("x y");
		for (const input of [
			"a [S[S1]1] b",
			"a [S1[S2]] b",
			"[c[S1]ite] text",
			"x [S2] [S()1] y",
		]) {
			expect(scrub(input)).not.toMatch(/\[(?:S\d|cite)/);
		}
	});

	it("drops a line built to reassemble markers past the pass limit", () => {
		const nested = `${"[S".repeat(30)}1${"1]".repeat(30)}`;
		const result = scrubProposalExport(
			["Before.", nested, "After."].join("\n"),
		);
		expect(result.markdown).toBe(["Before.", "After."].join("\n"));
		expect(result.markdown).not.toContain("[S");
	});

	it("leaves inline code exactly as written on a line it scrubs", () => {
		expect(scrub("Call `init()` now [S2].")).toBe("Call `init()` now.");
		expect(scrub("Run `a  b` then [S1] `( , )` too")).toBe(
			"Run `a  b` then `( , )` too",
		);
	});

	it("is idempotent", () => {
		const input = [
			"# Title",
			"",
			"Claim [S1], another [cite].",
			"",
			"## Source Index",
			"",
			"- [S1] Notes",
		].join("\n");
		const once = scrub(input);
		expect(scrub(once)).toBe(once);
	});

	it("leaves a bracketed year and a link label alone", () => {
		const input = "Signed in [2025], see [the plan](https://example.com).";
		expect(scrub(input)).toBe(input);
	});
});
