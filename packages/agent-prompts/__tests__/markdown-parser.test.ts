import { describe, expect, it } from "vitest";
import { listAnchorPaths } from "../src/core/document-patches";
import { parseHeadings } from "../src/validation/markdown-parser";

describe("Markdown heading parsing", () => {
	it.each([" ", "\t"])(
		"bounds matching on repeated %j before an embedded line separator",
		(space) => {
			const markdown = `##${space.repeat(80_000)}x\u2028x`;
			const start = performance.now();
			expect(parseHeadings(markdown)).toEqual([]);
			expect(listAnchorPaths(markdown)).toEqual([]);
			expect(performance.now() - start).toBeLessThan(500);
		},
	);

	it("keeps tabs, trailing whitespace, blank headings and fence exclusion", () => {
		expect(
			parseHeadings(
				"##\tScope \t\n### \t\n# \n```\n## Hidden\n```\n# End",
			),
		).toEqual([
			{ level: 2, text: "Scope", line: 1 },
			{ level: 3, text: "", line: 2 },
			{ level: 1, text: "End", line: 7 },
		]);
	});
});
