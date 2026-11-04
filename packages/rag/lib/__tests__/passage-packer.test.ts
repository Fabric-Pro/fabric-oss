import { expect, it } from "vitest";
import { packPassageBlocks } from "../passage-packer";

const options = {
	maxChars: 100,
	omittedNote: "[cut]",
	render: (blocks: string[]) => blocks.join("\n"),
	measure: (output: string) => JSON.stringify(output).length,
	metadataOverflow: "Metadata too large",
};
it.each([Number.NaN, Number.POSITIVE_INFINITY, 99.5, -1, 0, 10])(
	"rejects an unusable character budget (%s)",
	(maxChars) => {
		expect(() => packPassageBlocks([], { ...options, maxChars })).toThrow(
			RangeError,
		);
	},
);
it("accepts the smallest budget that can show the metadata warning", () => {
	const maxChars = options.measure(options.metadataOverflow);
	expect(
		packPassageBlocks(
			[
				{
					header: "H".repeat(200),
					passages: [{ content: "x", score: 1 }],
					matched: true,
				},
			],
			{ ...options, maxChars, render: () => "H".repeat(200) },
		),
	).toBe(options.metadataOverflow);
});

it("completes a fitting passage when removing its cut note makes it fit", () => {
	const body = "x".repeat(95);
	const output = packPassageBlocks(
		[
			{
				header: "H",
				passages: [{ content: body, score: 1 }],
				matched: true,
			},
		],
		{ ...options, omittedNote: "[content cut]" },
	);
	expect(output).toBe(`H${body}`);
});

it("keeps an astral character intact at an odd plain-text boundary", () => {
	const output = packPassageBlocks(
		[
			{
				header: "H",
				passages: [{ content: "😀".repeat(100), score: 1 }],
				matched: true,
			},
		],
		{ ...options, maxChars: 101, measure: (output) => output.length },
	);
	expect(output.length).toBeLessThanOrEqual(101);
	expect(output).not.toMatch(
		/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
	);
	expect(output).toContain("😀");
});
it("reuses room freed by completing a later result", () => {
	const output = packPassageBlocks(
		[
			{
				header: "A",
				passages: [{ content: "x".repeat(10000), score: 1 }],
				matched: true,
			},
			{
				header: "B",
				passages: [{ content: "y".repeat(810), score: 0.9 }],
				matched: true,
			},
		],
		{ ...options, maxChars: 4000, omittedNote: "[cut]".repeat(20) },
	);
	expect(output).toContain("y".repeat(810));
	expect(JSON.stringify(output).length).toBe(4000);
});
