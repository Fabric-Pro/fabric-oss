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
