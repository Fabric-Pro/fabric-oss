/**
 * The AI Assistant reads the feature document the editor saves, and that
 * markdown carries Turndown's defensive escapes (`\[`, `\-`, `1\.`, …). A model
 * that echoes those backslashes into its edit adds a real diff, and every
 * accepted edit saved one more visible layer. `toAgentDocument` gives the agent
 * the document without them; the diff restores the baseline's escaped form for
 * anything the agent left alone.
 */

import { Editor } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import { diffPartialText, fromMarkdown, toAgentDocument } from "../diff-utils";
import { getEditorMarkdownForSave } from "../editor-markdown-save";
import { advancedExtensions } from "../tiptap-extensions-advanced";

function saveFromMarkdown(markdown: string): string {
	const editor = new Editor({
		extensions: advancedExtensions,
		content: fromMarkdown(markdown),
	});
	const saved = getEditorMarkdownForSave(editor) ?? "";
	editor.destroy();
	return saved;
}

// StoryWorkspace's review flow: final diff against the editor baseline,
// rendered into the editor, then accepted (diff tags stripped) and saved.
function acceptAgentEdit(baseline: string, agentDocument: string): string {
	return saveFromMarkdown(diffPartialText(baseline, agentDocument, true));
}

// A stand-in for the model behaviour behind the stray backslashes: it
// rewrites one paragraph, carrying the text it was given verbatim, but
// doubles every backslash in it the way a mis-encoded JSON tool argument
// does. Everything else it returns unchanged.
function reviseSourcesParagraph(agentDocument: string): string {
	return agentDocument
		.split("\n")
		.map((line) =>
			line.startsWith("Sources:")
				? `${line.replace(/\\/g, "\\\\")} Reviewed.`
				: line,
		)
		.join("\n");
}

function countBackslashes(markdown: string): number {
	return (markdown.match(/\\/g) ?? []).length;
}

function runPasses(
	baseline: string,
	agentInput: (markdown: string) => string,
	passes: number,
): string {
	let document = baseline;
	for (let pass = 0; pass < passes; pass++) {
		document = acceptAgentEdit(
			document,
			reviseSourcesParagraph(agentInput(document)),
		);
	}
	return document;
}

const SOURCES_DOCUMENT = [
	"# Feature",
	"",
	"Sources: the notes [S1][S2] and [Docs](https://example.com/docs).",
	"",
	"Untouched paragraph with [brackets].",
].join("\n");

describe("AI Assistant document input escapes", () => {
	it("grows backslashes on every pass when the agent reads the escaped document", () => {
		// Arrange
		const baseline = saveFromMarkdown(SOURCES_DOCUMENT);

		// Act
		const afterOne = runPasses(baseline, (markdown) => markdown, 1);
		const afterThree = runPasses(baseline, (markdown) => markdown, 3);

		// Assert
		expect(baseline).toContain("\\[S1\\]\\[S2\\]");
		expect(countBackslashes(afterOne)).toBeGreaterThan(
			countBackslashes(baseline),
		);
		expect(countBackslashes(afterThree)).toBeGreaterThan(
			countBackslashes(afterOne),
		);
	});

	it("keeps the document's backslashes stable when the agent reads toAgentDocument", () => {
		// Arrange
		const baseline = saveFromMarkdown(SOURCES_DOCUMENT);

		// Act
		const afterThree = runPasses(baseline, toAgentDocument, 3);

		// Assert
		expect(countBackslashes(afterThree)).toBe(countBackslashes(baseline));
		expect(afterThree).toContain(
			"Sources: the notes \\[S1\\]\\[S2\\] and [Docs](https://example.com/docs). Reviewed. Reviewed. Reviewed.",
		);
		expect(afterThree).toContain(
			"Untouched paragraph with \\[brackets\\].",
		);
	});

	it("saves an untouched document byte for byte when the agent returns its input", () => {
		// Arrange
		const baseline = saveFromMarkdown(
			[
				"# Feature",
				"",
				"\\# Not a heading",
				"",
				"1\\. Not a list",
				"",
				"\\- Not a bullet",
				"",
				"\\> Not a quote",
				"",
				"Notes [S1] and [Docs](https://example.com/docs).",
				"",
				"Path C:\\\\Users\\\\example and a literal \\\\\\[x\\].",
				"",
				"Inline `a\\[b` code.",
				"",
				"```",
				"regex = /\\[a-z\\]/",
				"```",
				"",
				"| Item | Note |",
				"| --- | --- |",
				"| One | [S1] |",
			].join("\n"),
		);

		// Act
		const saved = acceptAgentEdit(baseline, toAgentDocument(baseline));

		// Assert
		expect(saved).toBe(baseline);
	});
});

describe("review diff against an agent edit", () => {
	it("does not strike through the escape at the end of a removed run", () => {
		// Arrange
		const baseline = saveFromMarkdown(
			"- Reference link: \\[S1\\] — [Docs](https://example.com/docs).",
		);
		const agentEdit = toAgentDocument(baseline).replace(
			"Reference link: [S1] —",
			"[S1] is documented in",
		);

		// Act
		const html = fromMarkdown(diffPartialText(baseline, agentEdit, true));
		const saved = acceptAgentEdit(baseline, agentEdit);

		// Assert
		const struck = [...html.matchAll(/<del\b[^>]*>([\s\S]*?)<\/del>/g)]
			.map((match) => match[1])
			.join("");
		expect(struck).toContain("Reference link:");
		expect(struck).not.toContain("\\");
		expect(saved).toContain(
			"\\[S1\\] is documented in [Docs](https://example.com/docs).",
		);
	});
});

describe("review diff when the rewrite inserts text before an escape", () => {
	it("keeps the escape out of the struck-through text", () => {
		// Arrange
		const baseline = saveFromMarkdown(
			"- Recording the source labels \\[S1\\] and \\[S2\\] as support for the plan.",
		);
		const agentEdit = toAgentDocument(baseline)
			.replace("Recording the source labels", "The plan cites")
			.replace("support for the plan", "supporting sources");

		// Act
		const html = fromMarkdown(diffPartialText(baseline, agentEdit, true));
		const saved = acceptAgentEdit(baseline, agentEdit);

		// Assert
		const struck = [...html.matchAll(/<del\b[^>]*>([\s\S]*?)<\/del>/g)]
			.map((match) => match[1])
			.join("");
		expect(struck).toContain("Recording the source labels");
		expect(struck).not.toContain("\\");
		expect(saved).toContain(
			"The plan cites \\[S1\\] and \\[S2\\] as supporting sources.",
		);
	});
});

describe("toAgentDocument", () => {
	it("removes the escapes the diff restores", () => {
		// Arrange
		const markdown = [
			"\\# Title",
			"1\\. Step",
			"\\- Item",
			"\\+ Item",
			"\\> Quote",
			"Notes \\[S1\\]\\[S2\\].",
		].join("\n");

		// Act
		const result = toAgentDocument(markdown);

		// Assert
		expect(result).toBe(
			[
				"# Title",
				"1. Step",
				"- Item",
				"+ Item",
				"> Quote",
				"Notes [S1][S2].",
			].join("\n"),
		);
	});

	it("keeps escaped backslashes and backticks", () => {
		// Arrange
		const markdown = "C:\\\\Users, a literal \\\\\\[x\\] and \\`tick\\`";

		// Act
		const result = toAgentDocument(markdown);

		// Assert
		expect(result).toBe("C:\\\\Users, a literal \\\\[x] and \\`tick\\`");
	});

	it("leaves code, pipe tables and HTML tables byte-identical", () => {
		// Arrange
		const markdown = [
			"Inline `a\\[b` code \\[x\\].",
			"```",
			"\\[fenced\\]",
			"```",
			"| A | \\[B\\] |",
			"| --- | --- |",
			'<table class="tiptap-table">',
			"<tr><td>\\[C\\]</td></tr>",
			"</table>",
			"After \\[y\\].",
		].join("\n");

		// Act
		const result = toAgentDocument(markdown);

		// Assert
		expect(result).toBe(
			[
				"Inline `a\\[b` code [x].",
				"```",
				"\\[fenced\\]",
				"```",
				"| A | \\[B\\] |",
				"| --- | --- |",
				'<table class="tiptap-table">',
				"<tr><td>\\[C\\]</td></tr>",
				"</table>",
				"After [y].",
			].join("\n"),
		);
	});

	it("leaves visual slot tags byte-identical", () => {
		// Arrange
		const markdown =
			'<visual-slot data-slot-id="slot-a" data-hint="Show \\[phases\\]"></visual-slot>\nAfter \\[y\\].';

		// Act
		const result = toAgentDocument(markdown);

		// Assert
		expect(result).toBe(
			'<visual-slot data-slot-id="slot-a" data-hint="Show \\[phases\\]"></visual-slot>\nAfter [y].',
		);
	});

	it("is idempotent", () => {
		// Arrange
		const markdown = "A literal \\\\\\[x\\] and \\- item";

		// Act
		const once = toAgentDocument(markdown);

		// Assert
		expect(toAgentDocument(once)).toBe(once);
	});
});
