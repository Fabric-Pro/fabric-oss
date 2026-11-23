/**
 * What a line-by-line review writes: the ticket's own text with only the
 * decided changes spliced in, never the editor's reading of the rest.
 */

import { describe, expect, it } from "vitest";
import { spliceReviewedText } from "../review-splice";
import {
	MOVED_BLOCKS_AFTER,
	MOVED_BLOCKS_BEFORE,
} from "./moved-list-block-fixtures";

const FENCE = "```";

// The three moves a live check accepted, as the ticket and the update
// write them.
const MOVES = [
	{
		before: `  - Run the installer:\n    ${FENCE}bash\n    pnpm install\n    ${FENCE}`,
		after: `- Run the installer:\n  ${FENCE}bash\n  pnpm install\n  ${FENCE}`,
	},
	{
		before: "  - Add the summary section\n    ### Summary heading\n    > A quoted tip for readers.",
		after: "- Add the summary section\n  ### Summary heading\n  > A quoted tip for readers.",
	},
	{
		before: "  - Plan table\n    | Plan | Price |\n    | --- | --- |\n    | Basic | 5 |",
		after: "- Plan table\n  | Plan | Price |\n  | --- | --- |\n  | Basic | 5 |",
	},
];

// The editor's reading of the review once those three moves were accepted
// and the rest left undecided, as a live check saved it: loose lists, a
// blank line after each heading, the HTML table written as Markdown with
// its data row for a header.
const REVIEWED_THREE_MOVES = [
	"## Overview",
	"",
	"A ticket for reviewing moved list blocks line by line.",
	"",
	"## Moved list block",
	"",
	"- Plan the release",
	"  - Draft the notes",
	"    - Collect merged changes",
	"- Publish the notes",
	"",
	"## Removed parent",
	"",
	"- Keep this item",
	"- Remove this parent",
	"  - First nested item",
	"  - Second nested item",
	"- Last item",
	"",
	"## Fenced code in a list item",
	"",
	"- Install the tools",
	"",
	"- Run the installer:",
	"",
	`  ${FENCE}bash`,
	"  pnpm install",
	`  ${FENCE}`,
	"",
	"- Start the app",
	"",
	"## Heading and quote in a moved block",
	"",
	"- Write the guide",
	"",
	"- Add the summary section",
	"",
	"  ### Summary heading",
	"",
	"  > A quoted tip for readers.",
	"",
	"- Review the guide",
	"",
	"## Tables in a moved block",
	"",
	"- Compare the plans",
	"",
	"- Plan table",
	"",
	"  | Plan | Price |",
	"  | --- | --- |",
	"  | Basic | 5 |",
	"",
	"- Choose a plan",
	"",
	"- Keep the HTML table",
	"",
	"  - HTML plan table",
	"",
	"    | Pro | 9 |",
	"    | --- | --- |",
	"",
	"- Close the comparison",
	"",
	"## Notes",
	"",
	"A closing paragraph that the update edits.",
].join("\n");

describe("spliceReviewedText", () => {
	it("writes the accepted moves as the update wrote them and every undecided line byte for byte", () => {
		const written = spliceReviewedText(
			MOVED_BLOCKS_BEFORE,
			MOVED_BLOCKS_AFTER,
			REVIEWED_THREE_MOVES,
		);

		let expected = MOVED_BLOCKS_BEFORE;
		for (const move of MOVES) {
			expected = expected.replace(move.before, move.after);
		}
		expect(written).toBe(expected);
		// The undecided moves and the edited paragraph are as they were.
		expect(written).toContain(
			"    - Collect merged changes\n- Publish the notes",
		);
		expect(written).toContain(
			"- Remove this parent\n  - First nested item",
		);
		expect(written).toContain("A closing paragraph that the update edits.");
	});

	it("keeps an undecided HTML table as HTML", () => {
		const written = spliceReviewedText(
			MOVED_BLOCKS_BEFORE,
			MOVED_BLOCKS_AFTER,
			REVIEWED_THREE_MOVES,
		);

		expect(written).toContain(
			"  - HTML plan table\n    <table><tr><td>Pro</td><td>9</td></tr></table>",
		);
		expect(written).not.toContain("| Pro | 9 |");
	});

	it("writes an accepted HTML table as the update wrote it", () => {
		const original =
			"- Keep the HTML table\n  - HTML plan table\n    <table><tr><td>Pro</td><td>9</td></tr></table>";
		const proposed =
			"- Keep the HTML table\n- HTML plan table\n  <table><tr><td>Pro</td><td>9</td></tr></table>";
		const reviewed =
			"- Keep the HTML table\n\n- HTML plan table\n\n  | Pro | 9 |\n  | --- | --- |";

		expect(spliceReviewedText(original, proposed, reviewed)).toBe(proposed);
	});

	it("writes every change of an update accepted whole, and nothing more", () => {
		// The editor's reading after Accept All: the update's lines, loose.
		const reviewed = MOVED_BLOCKS_AFTER.split("\n")
			.flatMap((line) =>
				/^\s*(?:- |#)/.test(line) ? [line, ""] : [line],
			)
			.join("\n")
			.replace(
				"  <table><tr><td>Pro</td><td>9</td></tr></table>",
				"  | Pro | 9 |\n  | --- | --- |",
			);

		expect(
			spliceReviewedText(
				MOVED_BLOCKS_BEFORE,
				MOVED_BLOCKS_AFTER,
				reviewed,
			),
		).toBe(MOVED_BLOCKS_AFTER);
	});

	it("writes the ticket as it was when nothing was decided", () => {
		const reviewed = MOVED_BLOCKS_BEFORE.replace(
			"<table><tr><td>Pro</td><td>9</td></tr></table>",
			"| Pro | 9 |\n    | --- | --- |",
		).replaceAll("\n- ", "\n\n- ");

		expect(
			spliceReviewedText(
				MOVED_BLOCKS_BEFORE,
				MOVED_BLOCKS_AFTER,
				reviewed,
			),
		).toBe(MOVED_BLOCKS_BEFORE);
	});

	it("writes the reviewed reading of a line decided only in part, and only that line", () => {
		const original =
			"## Notes\n\n- Ship on Monday with the old flag.\n- Keep this line   as written.";
		const proposed =
			"## Notes\n\n- Ship on Friday with the new flag.\n- Keep this line   as written.";
		// One of the line's two changes accepted.
		const reviewed =
			"## Notes\n\n- Ship on Friday with the old flag.\n- Keep this line as written.";

		expect(spliceReviewedText(original, proposed, reviewed)).toBe(
			"## Notes\n\n- Ship on Friday with the old flag.\n- Keep this line   as written.",
		);
	});
});
