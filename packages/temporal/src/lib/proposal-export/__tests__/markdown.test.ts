import { ApplicationFailure } from "@temporalio/common";
import { describe, expect, it, vi } from "vitest";

const parse = vi.hoisted(() => ({ calls: 0 }));

// Counts parses, so the size check is shown to run before any.
vi.mock(
	"@repo/utils/proposal-artifact/markdown-ast",
	async (importOriginal) => {
		const actual =
			await importOriginal<
				typeof import("@repo/utils/proposal-artifact/markdown-ast")
			>();
		return {
			...actual,
			parseMarkdownAst: (markdown: string) => {
				parse.calls++;
				return actual.parseMarkdownAst(markdown);
			},
		};
	},
);

import { coverFence } from "../document-content";
import { prepareExportMarkdown } from "../markdown";

/** A node without its source positions, so only what is printed is checked. */
function stripPositions(node: unknown): unknown {
	return JSON.parse(
		JSON.stringify(node, (key, value) =>
			key === "position" ? undefined : value,
		),
	);
}

import { PROPOSAL_EXPORT_LIMITS } from "../types";

describe("prepareExportMarkdown", () => {
	it("fails a 2 MB Main with DOCUMENT_TOO_LARGE before parsing it", () => {
		const content = "Example paragraph text.\n\n".repeat(
			Math.ceil((2 * 1024 * 1024) / 25),
		);
		expect(content.length).toBeGreaterThan(
			PROPOSAL_EXPORT_LIMITS.maxMarkdownLength,
		);
		parse.calls = 0;

		let failure: unknown;
		try {
			prepareExportMarkdown(content);
		} catch (error) {
			failure = error;
		}

		expect(failure).toBeInstanceOf(ApplicationFailure);
		expect(failure).toMatchObject({
			type: "DOCUMENT_TOO_LARGE",
			nonRetryable: true,
		});
		expect(parse.calls).toBe(0);
	});

	it("fails a Main nested too deeply to parse with DOCUMENT_TOO_LARGE, not a retried error", () => {
		const content = `${"> ".repeat(20_000)}Example quote.`;
		expect(content.length).toBeLessThan(
			PROPOSAL_EXPORT_LIMITS.maxMarkdownLength,
		);

		let failure: unknown;
		try {
			prepareExportMarkdown(content);
		} catch (error) {
			failure = error;
		}

		expect(failure).toMatchObject({
			type: "DOCUMENT_TOO_LARGE",
			nonRetryable: true,
		});
	});

	it("finds a diagram fence however deeply the document nests it", () => {
		const content = `${"> ".repeat(200)}\n${"> ".repeat(200)}\`\`\`mermaid\n${"> ".repeat(200)}flowchart LR\n${"> ".repeat(200)}  A --> B\n${"> ".repeat(200)}\`\`\``;
		const prepared = prepareExportMarkdown(content);
		expect(prepared.diagramSources).toEqual(["flowchart LR\n  A --> B"]);
	});

	it("scrubs the parsed tree too, where a fence left open in a list item hides the rest from the line scrubber", () => {
		const prepared = prepareExportMarkdown(
			[
				"- Setup step",
				"  ```",
				"  npm run build",
				"",
				"Revenue grew [S1] and the pilot [cite] proved it, see [S2](#s2).",
				"",
				"## Pricing",
				"",
				"Fixed fee.",
				"",
				"## 1A. Source Index",
				"",
				"- [S1] Kickoff notes",
				"",
				"### Excerpts",
				"",
				"Internal excerpt.",
				"",
				"## Team",
				"",
				"Two engineers.",
			].join("\n"),
		);
		const text = JSON.stringify(prepared.root);
		expect(text).not.toMatch(
			/\[S\d|\[cite|Source Index|Kickoff notes|Internal excerpt/,
		);
		expect(text).toContain("npm run build");
		expect(text).toContain("Revenue grew");
		expect(text).toContain("Fixed fee.");
		expect(text).toContain("Two engineers.");
		expect(
			prepared.root.children
				.filter((node) => node.type === "heading")
				.map((node) => JSON.stringify(node)),
		).toHaveLength(2);
	});

	it("drops citation markers from cards, columns and stat tiles line by line, and leaves any other fence as written", () => {
		const fences = prepareExportMarkdown(
			[
				"```cards",
				"01",
				"**Route planning**",
				"Saves 12 hours a week [S2]",
				"[S4]",
				"Before `[S1]` each morning.",
				"",
				"Pilot",
				"Twelve weeks.",
				"```",
				"",
				"```Columns",
				"### Today",
				"- Paper route sheets [cite]",
				"- [S5]",
				"---",
				"One schedule.",
				"```",
				"",
				"```stat-tiles",
				"Hours saved [S1]: 12",
				"Pilot sites: 3 [S3]",
				"```",
				"",
				"```text",
				"Literal [S1] stays.",
				"```",
			].join("\n"),
		).root.children.map((node) => (node.type === "code" ? node.value : ""));

		expect(fences).toEqual([
			[
				"01",
				"**Route planning**",
				"Saves 12 hours a week",
				// A line of markers alone goes, so the card is not split.
				"Before `[S1]` each morning.",
				"",
				"Pilot",
				"Twelve weeks.",
			].join("\n"),
			["### Today", "- Paper route sheets", "---", "One schedule."].join(
				"\n",
			),
			["Hours saved: 12", "Pilot sites: 3"].join("\n"),
			"Literal [S1] stays.",
		]);
	});

	it("drops citation markers from a cover fence's values line by line, so the cover still reads it", () => {
		const prepared = prepareExportMarkdown(
			[
				"# Proposal for Example Harbor Co",
				"",
				"```cover",
				"eyebrow: Proposal · Operations board [S1]",
				"for: Example Harbor Co [S3]",
				"for: 1 Example Quay [S2, S4]",
				"[S5]",
				"by: Example Delivery Team [cite]",
				"by: `[S1]` example.com",
				"version: 12",
				"```",
				"",
				"## 1. Summary",
			].join("\n"),
		);
		const cover = prepared.root.children.find(
			(node) => node.type === "code",
		);

		expect(cover?.type === "code" && cover.lang).toBe("cover");
		expect(cover?.type === "code" && cover.value).toBe(
			[
				"eyebrow: Proposal · Operations board",
				"for: Example Harbor Co",
				"for: 1 Example Quay",
				// A line of markers alone goes, rather than stay a line the
				// cover would refuse.
				"by: Example Delivery Team",
				// A marker written inside backticks stays, as in prose.
				"by: `[S1]` example.com",
				"version: 12",
			].join("\n"),
		);
		expect(prepared.diagramSources).toEqual([]);
	});

	it("drops a cover line whose whole value was a marker, so the cover still reads the block", () => {
		const prepared = prepareExportMarkdown(
			[
				"```cover",
				"eyebrow: Proposal · Operations board",
				"version: [S2]",
				"for: \\[S1\\]",
				"```",
				"",
				"## 1. Summary",
			].join("\n"),
		);
		const cover = prepared.root.children[0];

		expect(cover?.type === "code" && cover.value).toBe(
			"eyebrow: Proposal · Operations board",
		);
		expect(coverFence(prepared.root)?.details).toMatchObject({
			eyebrow: "Proposal · Operations board",
			version: null,
			forLines: [],
		});
	});

	it("drops citation markers from a diagram's quoted text, so a bar chart's labels print without them", () => {
		const prepared = prepareExportMarkdown(
			[
				"## Figures",
				"",
				"```mermaid",
				"%% figure: bars",
				"xychart-beta horizontal",
				'  title "Payback by scenario [cite]"',
				'  x-axis ["Cost [S3]", "Revenue", "Savings [S1, S2]"]',
				'  y-axis "months [S4]" 0 --> 30',
				"  bar [9, 4, 12]",
				"```",
				"",
				"```mermaid",
				"flowchart LR",
				'  A["Intake [S2]"] --> B[S3]',
				"  B -->|Approved [S5]| C[Done]",
				"  C -.->|[cite]| D[Archive]",
				"```",
			].join("\n"),
		);
		const [bars, flow] = prepared.diagramSources;

		expect(bars).not.toMatch(/\[(?:S\d|cite)/);
		expect(bars).toContain('title "Payback by scenario"');
		expect(bars).toContain('x-axis ["Cost", "Revenue", "Savings"]');
		expect(bars).toContain('y-axis "months" 0 --> 30');
		// Quoted and edge labels lose their markers; an unquoted bracket is a
		// node shape.
		expect(flow).toContain('A["Intake"] --> B[S3]');
		expect(flow).toContain("B -->|Approved| C[Done]");
		expect(flow).toContain("C -.-> D[Archive]");
	});

	it("keeps a Sources section of prose in the parsed tree", () => {
		const prepared = prepareExportMarkdown(
			"## Sources\n\nOur estimates draw on three comparable projects.",
		);
		expect(JSON.stringify(prepared.root)).toContain("comparable projects");
	});

	it("hands an uploaded image tag the parser read as text back as raw HTML", () => {
		// A quote in the file name the editor wrote into alt unescaped.
		const tag =
			'<img src="https://storage.example.com/x.png?X-Amz-Signature=abc" alt="27" display.png" data-s3-key="document-media/project-example/document-example/x.png" />';
		const prepared = prepareExportMarkdown(`Intro.\n\n- ${tag}\n\n${tag}`);

		const [, list, last] = prepared.root.children;
		expect(last).toMatchObject({ type: "html", value: tag });
		expect(list?.type).toBe("list");
		expect(JSON.stringify(list)).not.toContain('"type":"link"');
		expect(JSON.stringify(list)).toContain('"type":"html"');
	});

	it("drops every token that refers to a stored object from text, links, code and diagrams", () => {
		const signed =
			"https://storage.example.com/document-media/project-example/document-example/x.pdf?X-Amz-Signature=abc";
		const prepared = prepareExportMarkdown(
			[
				`See ${signed} for the brief.`,
				"",
				`Or [the brief](${signed}), <${signed}> and \`${signed}\`.`,
				"",
				"Unsigned: https://storage.example.com/document-media/p/d/y.png here.",
				"",
				"Recipient logo: project-brand/project-example/recipient-brand/current/logo.png kept out.",
				"",
				"```bash",
				`curl ${signed}`,
				"```",
				"",
				"```mermaid",
				"flowchart LR",
				`  A["Brief ${signed}"] --> B[Build]`,
				"```",
			].join("\n"),
		);
		const tree = JSON.stringify(prepared.root.children.map(stripPositions));
		expect(tree).not.toMatch(/X-Amz|document-media|project-brand/);
		expect(tree).toContain("kept out.");
		expect(tree).toContain("for the brief.");
		expect(tree).toContain("the brief");
		expect(tree).toContain("here.");
		expect(tree).toContain("curl ");
		expect(prepared.diagramSources).toEqual([
			'flowchart LR\n  A["Brief "] --> B[Build]',
		]);
	});

	it("leaves a paragraph that opens with an image tag the parser did read", () => {
		const prepared = prepareExportMarkdown(
			'<img src="x" alt="a" data-s3-key="document-media/p/d/x.png" /> and words',
		);
		const [paragraph] = prepared.root.children;
		expect(paragraph?.type).toBe("paragraph");
		expect(JSON.stringify(paragraph)).toContain("and words");
	});

	it("parses Main within the limit", () => {
		parse.calls = 0;
		const prepared = prepareExportMarkdown("## Example\n\nText.");

		expect(parse.calls).toBe(1);
		expect(prepared.root.children.map((node) => node.type)).toEqual([
			"heading",
			"paragraph",
		]);
	});
});
