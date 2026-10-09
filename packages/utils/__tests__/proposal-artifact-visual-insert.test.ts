import { describe, expect, it } from "vitest";
import { parseOutline } from "../lib/glossy/outline";
import { parseVisualSlots } from "../lib/glossy/visual-slots";
import type { ComparisonVisualSpec } from "../lib/glossy/visual-spec";
import {
	comparisonToMarkdownTable,
	insertVisuals,
	type SectionVisual,
	toMermaidFence,
} from "../lib/proposal-artifact/visual-insert";

const lines = (...parts: string[]) => parts.join("\n");

const TIMELINE = toMermaidFence(
	lines(
		"flowchart LR",
		't0["Q1 — Discovery"]',
		"style t0 fill:#eef2ff,stroke:#4f46e5",
	),
);

const SLOT =
	'<visual-slot data-slot-id="slot-a" data-kind="timeline" data-hint="Show &quot;phases&quot;"></visual-slot>';

const visual = (
	headingPath: string[],
	markdown = TIMELINE,
	occurrenceIndex = 0,
): SectionVisual => ({ headingPath, occurrenceIndex, markdown });

const DOC = lines(
	"# Website Redesign Proposal",
	"",
	"Prepared for Example Org.",
	"",
	"## Overview",
	"",
	"Example Org wants a faster website.",
	"It should load in under two seconds.",
	"",
	"A second paragraph.",
	"",
	"## Timeline",
	"",
	"Delivery runs over three quarters.",
	"",
	"```mermaid",
	"flowchart LR",
	"A --> B",
	"```",
	"",
	"## Investment",
	"",
	"Fixed fee by phase.",
	"",
	"| Phase | Fee |",
	"| --- | --- |",
	"| Discovery | 10 |",
	"",
);

describe("insertVisuals", () => {
	it("places a visual after the first paragraph of the matching section", () => {
		const result = insertVisuals(DOC, [
			visual(["website redesign proposal", "overview"]),
		]);

		expect(result).toMatchObject({ inserted: 1, skipped: 0, unmatched: 0 });
		expect(result.markdown).toBe(
			DOC.replace(
				"It should load in under two seconds.\n\n",
				`It should load in under two seconds.\n\n${TIMELINE}\n\n`,
			),
		);
	});

	it("drops a visual whose anchor matches no section", () => {
		const result = insertVisuals(DOC, [
			visual(["website redesign proposal", "pricing"]),
		]);

		expect(result).toEqual({
			markdown: DOC,
			inserted: 0,
			skipped: 0,
			unmatched: 1,
		});
	});

	it("skips a section that already holds a mermaid fence", () => {
		const result = insertVisuals(DOC, [
			visual(["website redesign proposal", "timeline"]),
		]);

		expect(result).toEqual({
			markdown: DOC,
			inserted: 0,
			skipped: 1,
			unmatched: 0,
		});
	});

	it("still gives a section that holds a table its visual", () => {
		const result = insertVisuals(DOC, [
			visual(["website redesign proposal", "investment"]),
		]);

		expect(result.inserted).toBe(1);
		expect(result.markdown).toContain(
			lines("Fixed fee by phase.", "", TIMELINE, "", "| Phase | Fee |"),
		);
	});

	it("leaves visual slot tags byte-identical", () => {
		const withSlots = lines(
			"## Overview",
			"",
			SLOT,
			"",
			"Example Org wants a faster website.",
			"",
			"<visual-slot data-slot-id='slot-b'></visual-slot>",
			"",
			"## Delivery",
			"",
			`Six sprints. ${SLOT}`,
			"",
		);

		const result = insertVisuals(withSlots, [
			visual(["overview"]),
			visual(["delivery"]),
		]);

		expect(result.inserted).toBe(2);
		const outLines = result.markdown.split("\n");
		for (const line of withSlots.split("\n")) {
			if (line.includes("visual-slot")) {
				expect(outLines).toContain(line);
			}
		}
		expect(
			parseVisualSlots(result.markdown).map(
				({ line: _line, ...slot }) => slot,
			),
		).toEqual(
			parseVisualSlots(withSlots).map(({ line: _line, ...slot }) => slot),
		);
		// A slot-only line is not the section's first block.
		expect(result.markdown).toContain(
			lines("Example Org wants a faster website.", "", TIMELINE),
		);
	});

	it("matches the path without the document's # title, as Glossy's sections carry it", () => {
		const result = insertVisuals(DOC, [visual(["overview"])]);

		expect(result.inserted).toBe(1);
		expect(result.markdown).toContain(
			lines("It should load in under two seconds.", "", TIMELINE),
		);
	});

	it("tries the full path before the title-less one", () => {
		const doc = lines(
			"# Plan",
			"",
			"## Scope",
			"",
			"Under the title.",
			"",
			"# Scope",
			"",
			"A later top-level section.",
		);

		const result = insertVisuals(doc, [visual(["scope"])]);

		expect(result.markdown).toBe(
			lines(
				"# Plan",
				"",
				"## Scope",
				"",
				"Under the title.",
				"",
				"# Scope",
				"",
				"A later top-level section.",
				"",
				TIMELINE,
			),
		);
	});

	it("picks a repeated heading by its occurrence index", () => {
		const doc = lines(
			"## Phase",
			"",
			"First phase.",
			"",
			"## Phase",
			"",
			"Second phase.",
		);

		const result = insertVisuals(doc, [visual(["phase"], TIMELINE, 1)]);

		expect(result.markdown).toBe(
			lines(
				"## Phase",
				"",
				"First phase.",
				"",
				"## Phase",
				"",
				"Second phase.",
				"",
				TIMELINE,
			),
		);
	});

	it("gives a section at most one visual, the first given for it", () => {
		const table = lines("| A | B |", "| --- | --- |", "| 1 | 2 |");

		const result = insertVisuals(DOC, [
			visual(["overview"], table),
			visual(["website redesign proposal", "overview"]),
		]);

		expect(result).toMatchObject({ inserted: 1, skipped: 1 });
		expect(result.markdown).toContain(table);
		expect(result.markdown).not.toContain("```mermaid\nflowchart LR\nt0");
	});

	it("inserts after the heading of a section with no body of its own", () => {
		const doc = lines("## Approach", "### Discovery", "", "Interviews.");

		const result = insertVisuals(doc, [visual(["approach"])]);

		expect(result.markdown).toBe(
			lines(
				"## Approach",
				"",
				TIMELINE,
				"",
				"### Discovery",
				"",
				"Interviews.",
			),
		);
	});

	it("checks only the section's own content for a mermaid fence", () => {
		const doc = lines(
			"## Approach",
			"",
			"Two phases.",
			"",
			"### Discovery",
			"",
			"```mermaid",
			"flowchart LR",
			"```",
		);

		expect(insertVisuals(doc, [visual(["approach"])]).inserted).toBe(1);
		expect(
			insertVisuals(doc, [visual(["approach", "discovery"])]).skipped,
		).toBe(1);
	});

	it("recognizes a tilde mermaid fence", () => {
		const doc = lines("## Flow", "", "~~~ mermaid", "graph TD", "~~~");

		expect(insertVisuals(doc, [visual(["flow"])]).skipped).toBe(1);
	});

	it("does not split a loose list", () => {
		const doc = lines(
			"## Deliverables",
			"",
			"- Design system",
			"",
			"- Page templates",
			"  with responsive variants",
			"",
			"1. Launch",
			"",
			"Closing paragraph.",
		);

		const result = insertVisuals(doc, [visual(["deliverables"])]);

		expect(result.markdown).toBe(
			lines(
				"## Deliverables",
				"",
				"- Design system",
				"",
				"- Page templates",
				"  with responsive variants",
				"",
				"1. Launch",
				"",
				TIMELINE,
				"",
				"Closing paragraph.",
			),
		);
	});

	it("counts a leading fenced block as the first block", () => {
		const doc = lines(
			"## Setup",
			"",
			"```bash",
			"",
			"pnpm install",
			"```",
			"",
			"Then run it.",
		);

		expect(insertVisuals(doc, [visual(["setup"])]).markdown).toBe(
			lines(
				"## Setup",
				"",
				"```bash",
				"",
				"pnpm install",
				"```",
				"",
				TIMELINE,
				"",
				"Then run it.",
			),
		);
	});

	it("never anchors to a heading inside a fenced block", () => {
		const doc = lines("## Notes", "", "```md", "## Hidden", "```");

		expect(insertVisuals(doc, [visual(["hidden"])]).unmatched).toBe(1);
	});

	it("refuses a block that would put the visual inside a fence that never closes", () => {
		const doc = lines("## Notes", "", "```js", "const a = 1;");

		expect(insertVisuals(doc, [visual(["notes"])])).toMatchObject({
			markdown: doc,
			skipped: 1,
		});
	});

	it("refuses a visual that leaves a fence open, and a blank one", () => {
		const result = insertVisuals(DOC, [
			visual(["overview"], "```mermaid\nflowchart LR"),
			visual(["investment"], "  \n\n"),
		]);

		expect(result).toEqual({
			markdown: DOC,
			inserted: 0,
			skipped: 2,
			unmatched: 0,
		});
	});

	it("does not re-insert into a section a mermaid visual already went into", () => {
		const once = insertVisuals(DOC, [visual(["overview"])]).markdown;
		const twice = insertVisuals(once, [visual(["overview"])]);

		expect(twice).toMatchObject({ markdown: once, skipped: 1 });
	});

	it("keeps every heading and its anchor", () => {
		const result = insertVisuals(DOC, [
			visual(["overview"]),
			visual(["investment"]),
		]);

		const anchors = (markdown: string) =>
			parseOutline(markdown).map(({ headingPath, occurrenceIndex }) => ({
				headingPath,
				occurrenceIndex,
			}));
		expect(anchors(result.markdown)).toEqual(anchors(DOC));
	});

	it("keeps a missing trailing newline missing", () => {
		const doc = lines("## Overview", "", "Text.");

		expect(insertVisuals(doc, [visual(["overview"])]).markdown).toBe(
			lines("## Overview", "", "Text.", "", TIMELINE),
		);
	});

	it("returns the input itself when there is nothing to place", () => {
		expect(insertVisuals(DOC, [])).toEqual({
			markdown: DOC,
			inserted: 0,
			skipped: 0,
			unmatched: 0,
		});
	});

	it("gives the same body for the same input", () => {
		const visuals = [visual(["overview"]), visual(["investment"])];

		expect(insertVisuals(DOC, visuals)).toEqual(
			insertVisuals(DOC, visuals),
		);
	});
});

describe("toMermaidFence", () => {
	it("wraps the source in a mermaid fence", () => {
		expect(toMermaidFence("\nflowchart LR\nA --> B\n\n")).toBe(
			lines("```mermaid", "flowchart LR", "A --> B", "```"),
		);
	});

	it("uses a longer fence than any backtick run inside", () => {
		expect(toMermaidFence(lines("flowchart LR", "````", "A"))).toBe(
			lines("`````mermaid", "flowchart LR", "````", "A", "`````"),
		);
	});
});

describe("comparisonToMarkdownTable", () => {
	const spec: ComparisonVisualSpec = {
		kind: "comparison",
		title: "Options",
		items: [
			{ title: "Option A", points: ["Faster launch", "Lower cost"] },
			{ title: "Option B", points: ["Full redesign"] },
		],
	};

	it("puts each item in a column with its points down the rows", () => {
		expect(comparisonToMarkdownTable(spec)).toBe(
			lines(
				"| Option A | Option B |",
				"| --- | --- |",
				"| Faster launch | Full redesign |",
				"| Lower cost |  |",
			),
		);
	});

	it("does not render the spec's title", () => {
		expect(comparisonToMarkdownTable(spec)).not.toContain("Options");
	});

	it("escapes pipes and backslashes and keeps every cell on one line", () => {
		const table = comparisonToMarkdownTable({
			kind: "comparison",
			items: [
				{ title: "In | Out", points: ["C:\\path", "two\nlines"] },
				{ title: "B", points: ["x"] },
			],
		});

		expect(table).toBe(
			lines(
				"| In \\| Out | B |",
				"| --- | --- |",
				"| C:\\\\path | x |",
				"| two lines |  |",
			),
		);
	});

	it("inserts as a block like any other visual", () => {
		const result = insertVisuals(DOC, [
			visual(["overview"], comparisonToMarkdownTable(spec)),
		]);

		expect(result.inserted).toBe(1);
		expect(result.markdown).toContain(
			lines(
				"It should load in under two seconds.",
				"",
				"| Option A | Option B |",
			),
		);
	});
});
