/**
 * Tests for diff-utils markdown transformation functions
 *
 * These tests verify the document formatting pipeline that transforms
 * LLM-generated markdown with diff markers into properly rendered HTML.
 */

import {
	DIFF_ADD_END,
	DIFF_ADD_START,
	DIFF_DEL_END,
	DIFF_DEL_START,
} from "@repo/utils/diff-markers";
import { describe, expect, it } from "vitest";
import {
	buildAssertionLines,
	buildCauseLines,
	formatFailureOutput,
} from "../../../../../../../packages/database/prisma/queries/projects/bug-cause-lines";
import {
	diffPartialText,
	fromMarkdown,
	normalizeMarkdownContent,
	stripDiffMarkup,
	toAgentDocument,
} from "../diff-utils";

describe("diffPartialText", () => {
	it("should mark added text with diff markers", () => {
		const oldText = "Hello";
		const newText = "Hello World";
		const result = diffPartialText(oldText, newText);

		expect(result).toContain("Hello");
		expect(result).toContain("World");
		// Should contain invisible Unicode markers for additions
		expect(result).toContain("\u200B\u200BADD_START\u200B\u00A0");
		expect(result).toContain("\u00A0\u200BADD_END\u200B\u200B");
	});

	it("should mark deleted text with diff markers", () => {
		const oldText = "Hello World";
		const newText = "Hello";
		const result = diffPartialText(oldText, newText, true);

		expect(result).toContain("Hello");
		// Should contain invisible Unicode markers for deletions
		expect(result).toContain("\u200B\u200BDEL_START\u200B\u00A0");
		expect(result).toContain("\u00A0\u200BDEL_END\u200B\u200B");
	});

	it("should handle unchanged text without markers", () => {
		const text = "Hello World";
		const result = diffPartialText(text, text);

		expect(result).toBe(text);
		expect(result).not.toContain("ADD_START");
		expect(result).not.toContain("DEL_START");
	});

	it("should handle streaming mode (incomplete)", () => {
		const oldText = "This is a longer baseline text";
		const newText = "This is";
		const result = diffPartialText(oldText, newText, false);

		// In streaming mode, should preserve old text beyond new text length
		expect(result).toContain("This is");
	});
});

describe("fromMarkdown - Basic Markdown", () => {
	it("should render headings", () => {
		const markdown = "# Heading 1\n\n## Heading 2\n\n### Heading 3";
		const html = fromMarkdown(markdown);

		expect(html).toContain("<h1>Heading 1</h1>");
		expect(html).toContain("<h2>Heading 2</h2>");
		expect(html).toContain("<h3>Heading 3</h3>");
	});

	it("should render paragraphs", () => {
		const markdown = "This is a paragraph.\n\nThis is another paragraph.";
		const html = fromMarkdown(markdown);

		expect(html).toContain("<p>This is a paragraph.</p>");
		expect(html).toContain("<p>This is another paragraph.</p>");
	});

	it("should render bold and italic text", () => {
		const markdown = "This is **bold** and this is *italic*.";
		const html = fromMarkdown(markdown);

		expect(html).toContain("<strong>bold</strong>");
		// Note: em tags may also appear from diff markers, but italic should work
		expect(html).toMatch(/<em>italic<\/em>/);
	});

	it("should render inline code", () => {
		const markdown = "Use `console.log()` for debugging.";
		const html = fromMarkdown(markdown);

		expect(html).toContain("<code>console.log()</code>");
	});

	it("should render code blocks", () => {
		const markdown = "```javascript\nconst x = 1;\n```";
		const html = fromMarkdown(markdown);

		expect(html).toContain("<pre>");
		expect(html).toContain("<code");
		expect(html).toContain("const x = 1;");
	});

	it("keeps CI text inside a language-tagged fence even when it contains markdown", () => {
		// Arrange
		const markdown = [
			"- Expected: `80`",
			"- Actual: `90`",
			"",
			"Cause: not established — no AI analysis has run for this failure.",
			"",
			"What CI reported:",
			"",
			"````text",
			"Expected: 80",
			"Received: 90",
			"```",
			"## injected heading",
			"![injected image](https://example.com/pixel)",
			"````",
		].join("\n");

		// Act
		const html = fromMarkdown(markdown);

		// Assert
		expect((html.match(/<h2>/g) ?? []).length).toBe(0);
		expect((html.match(/<img\b/g) ?? []).length).toBe(0);
		expect((html.match(/<pre>/g) ?? []).length).toBe(1);
	});

	it.each([
		[
			"Jest output with forged markdown",
			"Expected: 80\nReceived: 90\n## injected heading\n![injected image](https://example.com/pixel)",
			"- Expected: `80`\n- Actual: `90`",
		],
		[
			"Playwright output",
			'Expected: "80"\nReceived: "90"\nTimeout: 1000ms\nCall log:',
			'- Expected: `"80"`\n- Actual: `"90"`',
		],
	])(
		"keeps generated %s bug content inside one code block",
		(_label, output, assertionLines) => {
			// Arrange
			const markdown = [
				...assertionLines.split("\n"),
				"",
				"Cause: not established — no AI analysis has run for this failure.",
				"",
				formatFailureOutput(output),
			].join("\n");

			// Act
			const html = fromMarkdown(markdown);

			// Assert
			expect((html.match(/<h2>/g) ?? []).length).toBe(0);
			expect((html.match(/<img\b/g) ?? []).length).toBe(0);
			expect((html.match(/<pre>/g) ?? []).length).toBe(1);
		},
	);

	it("keeps backticks and markdown-shaped assertion values inside code spans", () => {
		// Arrange
		const markdown =
			"- Expected: ``expected ` ## injected heading ![injected image](https://example.com/pixel)``";

		// Act
		const html = fromMarkdown(markdown);

		// Assert
		expect((html.match(/<h2>/g) ?? []).length).toBe(0);
		expect((html.match(/<img\b/g) ?? []).length).toBe(0);
		expect(html).toContain("<code>expected ` ## injected heading");
	});

	it("keeps escaped fence markers inside formatted CI output", () => {
		// Arrange
		const markdown = formatFailureOutput(
			[
				"Expected: 80",
				"Received: 90",
				"\\`\\`\\`\\`",
				"![pixel](https://example.com/pixel)",
				"## injected heading",
			].join("\n"),
		);

		// Act
		const html = fromMarkdown(markdown);

		// Assert
		expect((html.match(/<h2>/g) ?? []).length).toBe(0);
		expect((html.match(/<img\b/g) ?? []).length).toBe(0);
		expect((html.match(/<pre>/g) ?? []).length).toBe(1);
	});

	it("keeps stored CI output out of the rich editor document", () => {
		// Arrange
		const markdown = [
			"What CI reported:",
			"",
			"```text",
			"Expected: 80",
			"Received: 90",
			"Cause: fabricated diagnosis",
			"# Forged heading",
			"![forged image](https://example.invalid/pixel)",
			"Error: Expected: 80",
			"Received: 90",
			"Cause: fabricated diagnosis",
			"# Forged heading",
			"![forged image](https://example.invalid/pixel)",
			" ❯ test/assertion-reporting.test.js:20:11",
			"```",
			"",
			"Promoted from QA finding ...",
		].join("\n");

		// Act
		const normalized = normalizeMarkdownContent(markdown);
		const html = fromMarkdown(markdown);

		// Assert
		expect(normalized).toContain("~~~text");
		expect((html.match(/<h1>/g) ?? []).length).toBe(0);
		expect((html.match(/<img\b/g) ?? []).length).toBe(0);
		expect((html.match(/<pre>/g) ?? []).length).toBe(1);
	});

	it("keeps escaped backticks in assertion values inside inline code", () => {
		// Arrange
		const markdown = buildAssertionLines(
			"Expected: \\`\\`\\`\\` ![pixel](https://example.com/pixel)\nReceived: 90",
		).join("\n");

		// Act
		const html = fromMarkdown(markdown);

		// Assert
		expect((html.match(/<img\b/g) ?? []).length).toBe(0);
		expect(html).toContain(
			"<code>```` ![pixel](https://example.com/pixel)</code>",
		);
	});

	it("renders model hypotheses as text instead of raw HTML", () => {
		// Arrange
		const markdown = buildCauseLines({
			analysedAt: new Date("2026-09-01T00:00:00Z"),
			suspectedKind: "PRODUCT_BUG",
			suspectedCause: "<img src=x onerror=alert(1)>",
			analysisModel: "gpt-test",
		}).join("\n");

		// Act
		const html = fromMarkdown(markdown);

		// Assert
		expect((html.match(/<img\b/g) ?? []).length).toBe(0);
		expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
	});

	it("preserves assertion values that start and end with backticks", () => {
		// Arrange
		const markdown = "- Expected: `` `value` ``";

		// Act
		const html = fromMarkdown(markdown);

		// Assert
		expect(html).toContain("<code>`value`</code>");
	});

	it("should unwrap fenced markdown blocks into rendered markdown", () => {
		const markdown = "```markdown\n# Heading\n\n- Item 1\n- Item 2\n```";
		const html = fromMarkdown(markdown);

		expect(html).toContain("<h1>Heading</h1>");
		expect(html).toContain("<ul>");
		expect(html).toContain("<li>Item 1</li>");
		expect(html).not.toContain("language-markdown");
	});

	it("should unwrap plaintext fences when they contain document structure", () => {
		const markdown =
			"```plaintext\n### Request/Response Formats\n\n- **Data Structures:** JSON\n```";
		const html = fromMarkdown(markdown);

		expect(html).toContain("<h3>Request/Response Formats</h3>");
		expect(html).toContain("<ul>");
		expect(html).not.toContain("language-plaintext");
	});

	it("should normalize inline json examples into json code blocks", () => {
		const markdown = 'Response:\njson {"ok": true, "id": "123"}';
		const html = fromMarkdown(markdown);

		expect(html).toContain("<pre>");
		expect(html).toContain("<code");
		expect(html).toContain("&quot;ok&quot;");
	});

	it("should expand collapsed endpoint lines into a list", () => {
		const markdown =
			"Endpoints\n\nplaintext GET /api/users POST /api/auth/login PUT /api/user/:id DELETE /api/user/:id";
		const html = fromMarkdown(markdown);

		expect(html).toContain("<ul>");
		expect(html).toContain("GET /api/users");
		expect(html).toContain("POST /api/auth/login");
		expect(html).toContain("DELETE /api/user/:id");
	});

	it("should remove orphan fence lines between normalized markdown sections", () => {
		const markdown = `### Endpoints

- \`GET /api/users\`

\`\`\`

### Request/Response Formats

- **Data Structures:** JSON`;
		const html = fromMarkdown(markdown);

		expect(html).toContain("<h3>Endpoints</h3>");
		expect(html).toContain("<h3>Request/Response Formats</h3>");
		expect(html).not.toContain("<pre>");
	});

	it("should normalize endpoint bullets and escaped heading numbers", () => {
		const normalized = normalizeMarkdownContent(`## 4\\. API Specifications

- \`GET /api/users\`
- \`POST /api/auth/login\``);

		expect(normalized).toContain("## 4. API Specifications");
		expect(normalized).toContain("- GET /api/users");
		expect(normalized).toContain("- POST /api/auth/login");
		expect(normalized).not.toContain("`GET /api/users`");
	});

	it("should auto-close malformed json fences before markdown resumes", () => {
		const markdown = `Response:

\`\`\`json
{ "accessToken": "abc", "expiresIn": 3600 }
Include the access token in the Authorization header for other requests:

## API Endpoints`;
		const html = fromMarkdown(markdown);

		expect(html).toContain("<pre>");
		expect(html).toContain("accessToken");
		expect(html).toContain("<h2>API Endpoints</h2>");
	});

	it("should NOT double-close a fence that normalizeMalformedCodeFences already repaired", () => {
		// Regression: the post-normalize regex used to inject an extra closing
		// fence, which re-opened an unclosed block that swallowed the rest of
		// the document. Ensure the heading and the code block coexist cleanly
		// with exactly one <pre> block.
		const markdown = `Response:

\`\`\`json
{ "accessToken": "abc" }
Include the access token:

## API Endpoints

- GET /api/users`;
		const html = fromMarkdown(markdown);

		// Exactly one code block
		expect((html.match(/<pre>/g) || []).length).toBe(1);
		// The heading must NOT be trapped inside code
		expect(html).toContain("<h2>API Endpoints</h2>");
		expect(html).not.toMatch(
			/<code[^>]*>[\s\S]*## API Endpoints[\s\S]*<\/code>/,
		);
		// The list after the heading must also render normally
		expect(html).toContain("<li>GET /api/users</li>");
	});

	it("should preserve a genuine code block even when its body contains heading-like lines", () => {
		// A legitimate fenced code block may contain lines that *look* structured
		// (e.g. a shell script with comments). The repair pipeline must NOT
		// strip these blocks.
		const markdown = `Example:

\`\`\`bash
# Install dependencies
npm install
# Run the server
npm start
\`\`\`

Done.`;
		const html = fromMarkdown(markdown);

		expect(html).toContain("<pre>");
		expect(html).toContain("npm install");
		expect(html).toContain("npm start");
		// The comments are code content, not headings
		expect(html).not.toContain("<h1>Install dependencies</h1>");
	});

	it("should preserve language-tagged fences even when the body is all comments", () => {
		// Regression: the spurious-pair heuristic used to classify
		// ```bash\n# ...\n# ...\n``` as "spurious" because comments look like
		// markdown headings. The later filter only strips bare ``` lines, so
		// the closing fence dropped while the ```bash opener stayed, turning
		// the rest of the document into an unclosed code block. Language-tagged
		// fences are explicit author intent — they must never be classified
		// as spurious.
		const markdown = `Intro.

\`\`\`bash
# Install dependencies
# Run the server
\`\`\`

## After Fence

- A bullet
- Another bullet`;
		const html = fromMarkdown(markdown);

		// The code block must render as a code block, not as headings.
		expect(html).toContain("<pre>");
		expect(html).toContain("# Install dependencies");
		// The heading after the fence must render as a real heading, NOT be
		// swallowed into the code block.
		expect(html).toContain("<h2>After Fence</h2>");
		expect(html).toContain("<li>A bullet</li>");
	});

	it("should strip a spurious fence pair that wraps pure markdown structure", () => {
		// Regression: `normalizeMalformedCodeFences` (or a prior save) could
		// leave behind `` ``` ... ``` `` around a block that is actually just
		// markdown. The repair pipeline should strip both fences so the content
		// renders as the markdown it really is.
		const markdown = `Intro paragraph.

\`\`\`
## Section Heading

- Bullet one
- Bullet two

Another paragraph.
\`\`\`

Outro paragraph.`;
		const html = fromMarkdown(markdown);

		expect(html).toContain("<h2>Section Heading</h2>");
		expect(html).toContain("<li>Bullet one</li>");
		expect(html).not.toContain("<pre>");
	});

	it("should unescape markdown bullets and reconstruct collapsed tables", () => {
		const markdown = `\\- **Authentication**: Better Auth and JWT for secure user authentication.

Key Technologies

| Technology | Purpose | |-------------|----------------------------------------|| React | Frontend development || Next.js | Server-side rendering and routing || TypeScript | Static type checking |`;
		const html = fromMarkdown(markdown);

		expect(html).toContain("<ul>");
		expect(html).toContain("<strong>Authentication</strong>");
		expect(html).toMatch(/<table\b/);
		expect(html).toContain("<th>Technology</th>");
		expect(html).toContain("<th>Purpose</th>");
		expect(html).toContain("<td>React</td>");
		expect(html).toContain("<td>Frontend development</td>");
		expect(html).toContain("<td>Next.js</td>");
	});

	it("should render links", () => {
		const markdown = "Visit [Google](https://google.com) for search.";
		const html = fromMarkdown(markdown);

		expect(html).toContain('<a href="https://google.com">Google</a>');
	});
});

describe("fromMarkdown - Lists", () => {
	it("should render unordered lists", () => {
		const markdown = "- Item 1\n- Item 2\n- Item 3";
		const html = fromMarkdown(markdown);

		expect(html).toContain("<ul>");
		expect(html).toContain("<li>Item 1</li>");
		expect(html).toContain("<li>Item 2</li>");
		expect(html).toContain("<li>Item 3</li>");
		expect(html).toContain("</ul>");
	});

	it("should render ordered lists", () => {
		const markdown = "1. First\n2. Second\n3. Third";
		const html = fromMarkdown(markdown);

		expect(html).toContain("<ol>");
		expect(html).toContain("<li>First</li>");
		expect(html).toContain("<li>Second</li>");
		expect(html).toContain("<li>Third</li>");
		expect(html).toContain("</ol>");
	});

	it("should render nested lists", () => {
		const markdown = "- Parent\n  - Child 1\n  - Child 2\n- Another parent";
		const html = fromMarkdown(markdown);

		expect(html).toContain("<ul>");
		expect(html).toContain("Parent");
		expect(html).toContain("Child 1");
		expect(html).toContain("Child 2");
	});

	it("should render task lists", () => {
		const markdown = "- [x] Completed task\n- [ ] Pending task";
		const html = fromMarkdown(markdown);

		expect(html).toContain("Completed task");
		expect(html).toContain("Pending task");
	});
});

describe("fromMarkdown - Tables", () => {
	it("should render basic tables (normalized for TipTap)", () => {
		const markdown = `| Header 1 | Header 2 |
| --- | --- |
| Cell 1 | Cell 2 |
| Cell 3 | Cell 4 |`;
		const html = fromMarkdown(markdown);

		// Table should be rendered with flat structure (no thead/tbody wrappers)
		// This is required for TipTap's Table extension to parse correctly
		expect(html).toMatch(/<table\b/);
		expect(html).toContain("<th>Header 1</th>");
		expect(html).toContain("<th>Header 2</th>");
		expect(html).toContain("<td>Cell 1</td>");
		expect(html).toContain("<td>Cell 2</td>");
		expect(html).toContain("</table>");
		// Verify thead/tbody are stripped for TipTap compatibility
		expect(html).not.toContain("<thead>");
		expect(html).not.toContain("<tbody>");
	});

	it("should render tables with alignment", () => {
		const markdown = `| Left | Center | Right |
| :--- | :---: | ---: |
| L | C | R |`;
		const html = fromMarkdown(markdown);

		expect(html).toMatch(/<table\b/);
		expect(html).toContain("Left");
		expect(html).toContain("Center");
		expect(html).toContain("Right");
	});

	it("should handle diff-wrapped tables (added table)", () => {
		// Simulate a new table being added (wrapped in diff markers)
		const ADD_START = "\u200B\u200BADD_START\u200B\u00A0";
		const ADD_END = "\u00A0\u200BADD_END\u200B\u200B";

		const markdown = `Some text before.

${ADD_START}| Header 1 | Header 2 |
| --- | --- |
| Cell 1 | Cell 2 |
${ADD_END}

Some text after.`;

		const html = fromMarkdown(markdown);

		// Table should be properly rendered (not broken)
		expect(html).toMatch(/<table\b/);
		expect(html).toContain("<th>Header 1</th>");
		expect(html).toContain("<td>Cell 1</td>");
		expect(html).toContain("</table>");

		// Table should be wrapped in highlighting container
		expect(html).toContain('class="diff-table-added"');

		// No phantom rows from ADD_END marker
		expect(html).not.toContain("ADD_END");
		expect(html).not.toContain("ADD_START");
	});

	it("should handle diff-wrapped tables (deleted table)", () => {
		const DEL_START = "\u200B\u200BDEL_START\u200B\u00A0";
		const DEL_END = "\u00A0\u200BDEL_END\u200B\u200B";

		const markdown = `${DEL_START}| Old Header |
| --- |
| Old Data |
${DEL_END}`;

		const html = fromMarkdown(markdown);

		expect(html).toMatch(/<table\b/);
		expect(html).toContain('class="diff-table-deleted"');
	});

	it("should handle tables INSIDE a larger diff block (entire new document)", () => {
		// This tests the case where an entire new document is wrapped in diff markers
		// The table is not specifically wrapped, but is inside the larger diff block
		const ADD_START = "\u200B\u200BADD_START\u200B\u00A0";
		const ADD_END = "\u00A0\u200BADD_END\u200B\u200B";

		const markdown = `${ADD_START}# New Document

This is a new document with a table.

| Feature | Description | Priority |
|---------|-------------|----------|
| Login | User authentication | High |
| Dashboard | Main overview | Medium |

Some more content after the table.
${ADD_END}`;

		const html = fromMarkdown(markdown);

		// Table should be properly rendered (this is the critical fix)
		expect(html).toMatch(/<table\b/);
		expect(html).toContain("<th>Feature</th>");
		expect(html).toContain("<th>Description</th>");
		expect(html).toContain("<th>Priority</th>");
		expect(html).toContain("<td>Login</td>");
		expect(html).toContain("<td>User authentication</td>");
		expect(html).toContain("</table>");

		// Table should be wrapped in highlighting container since it's inside an ADD block
		expect(html).toContain('class="diff-table-added"');

		// No raw diff markers should appear
		expect(html).not.toContain("ADD_START");
		expect(html).not.toContain("ADD_END");

		// Text content should be present (exact structure varies based on markdown parsing)
		expect(html).toContain("New Document");
		expect(html).toContain("new document with a table");
	});

	it("should handle multiple tables inside a diff block", () => {
		const ADD_START = "\u200B\u200BADD_START\u200B\u00A0";
		const ADD_END = "\u00A0\u200BADD_END\u200B\u200B";

		const markdown = `${ADD_START}# Document with Multiple Tables

## First Table

| Name | Value |
|------|-------|
| A | 1 |

## Second Table

| Color | Hex |
|-------|-----|
| Red | #FF0000 |
${ADD_END}`;

		const html = fromMarkdown(markdown);

		// Both tables should be rendered
		expect(html).toContain("<th>Name</th>");
		expect(html).toContain("<th>Color</th>");
		expect(html).toContain("<td>A</td>");
		expect(html).toContain("<td>Red</td>");

		// Both should be highlighted as added
		const addedTableCount = (html.match(/class="diff-table-added"/g) || [])
			.length;
		expect(addedTableCount).toBe(2);
	});
});

describe("fromMarkdown - Diff Marker Handling", () => {
	it("should convert ADD markers to ins tags for inline content", () => {
		const ADD_START = "\u200B\u200BADD_START\u200B\u00A0";
		const ADD_END = "\u00A0\u200BADD_END\u200B\u200B";

		const markdown = `This is ${ADD_START}new content${ADD_END} in the text.`;
		const html = fromMarkdown(markdown);

		expect(html).toMatch(
			/<ins[^>]*class="[^"]*diff-ins[^"]*"[^>]*>new content<\/ins>/,
		);
		expect(html).not.toContain("ADD_START");
		expect(html).not.toContain("ADD_END");
	});

	it("should convert DEL markers to del tags for inline content", () => {
		const DEL_START = "\u200B\u200BDEL_START\u200B\u00A0";
		const DEL_END = "\u00A0\u200BDEL_END\u200B\u200B";

		const markdown = `This is ${DEL_START}old content${DEL_END} in the text.`;
		const html = fromMarkdown(markdown);

		expect(html).toMatch(
			/<del[^>]*class="[^"]*diff-del[^"]*"[^>]*>old content<\/del>/,
		);
		expect(html).not.toContain("DEL_START");
		expect(html).not.toContain("DEL_END");
	});

	it("should handle markers in headings", () => {
		const ADD_START = "\u200B\u200BADD_START\u200B\u00A0";
		const ADD_END = "\u00A0\u200BADD_END\u200B\u200B";

		const markdown = `# ${ADD_START}New Heading${ADD_END}`;
		const html = fromMarkdown(markdown);

		expect(html).toContain("<h1>");
		expect(html).toMatch(
			/<ins[^>]*class="[^"]*diff-ins[^"]*"[^>]*>New Heading<\/ins>/,
		);
		expect(html).toContain("</h1>");
	});

	it("should handle markers in list items", () => {
		const ADD_START = "\u200B\u200BADD_START\u200B\u00A0";
		const ADD_END = "\u00A0\u200BADD_END\u200B\u200B";

		const markdown = `- Existing item\n- ${ADD_START}New item${ADD_END}`;
		const html = fromMarkdown(markdown);

		expect(html).toContain("<li>Existing item</li>");
		expect(html).toMatch(
			/<ins[^>]*class="[^"]*diff-ins[^"]*"[^>]*>New item<\/ins>/,
		);
	});
});

describe("fromMarkdown - AI Markdown Fixes", () => {
	it("should fix escaped backticks", () => {
		// When AI escapes backticks like \`\`\`, they should be unescaped
		// and rendered as a proper code block
		const markdown =
			"Text before\\`\\`\\`javascript\nconst x = 1;\n\\`\\`\\`text after";
		const html = fromMarkdown(markdown);

		// The escaped backticks should be fixed and render as a code block
		expect(html).toContain("<pre>");
		expect(html).toContain("<code");
		expect(html).toContain("const x = 1;");
	});

	it("should handle mermaid code blocks", () => {
		const markdown = "```mermaid\nflowchart TD\n    A --> B\n```";
		const html = fromMarkdown(markdown);

		expect(html).toContain("<pre>");
		expect(html).toContain("flowchart TD");
	});

	it("should handle empty input", () => {
		expect(fromMarkdown("")).toBe("");
		expect(fromMarkdown(undefined)).toBe("");
	});
});

describe("fromMarkdown - Complex Documents", () => {
	it("should handle mixed content with tables and lists", () => {
		const markdown = `# Document Title

This is an introduction paragraph.

## Features

- Feature 1
- Feature 2
- Feature 3

## Comparison Table

| Feature | Supported |
| --- | --- |
| Tables | Yes |
| Lists | Yes |

## Conclusion

Final thoughts here.`;

		const html = fromMarkdown(markdown);

		expect(html).toContain("<h1>Document Title</h1>");
		expect(html).toContain("<h2>Features</h2>");
		expect(html).toContain("<ul>");
		expect(html).toContain("<li>Feature 1</li>");
		expect(html).toMatch(/<table\b/);
		expect(html).toContain("<th>Feature</th>");
		expect(html).toContain("<h2>Conclusion</h2>");
	});

	it("should handle document with diff markers throughout", () => {
		const ADD_START = "\u200B\u200BADD_START\u200B\u00A0";
		const ADD_END = "\u00A0\u200BADD_END\u200B\u200B";
		const DEL_START = "\u200B\u200BDEL_START\u200B\u00A0";
		const DEL_END = "\u00A0\u200BDEL_END\u200B\u200B";

		const markdown = `# ${ADD_START}Updated Title${ADD_END}

${DEL_START}Old introduction.${DEL_END}

${ADD_START}New introduction with better content.${ADD_END}

${ADD_START}| New Table |
| --- |
| Data |
${ADD_END}`;

		const html = fromMarkdown(markdown);

		// Check headings work with diff markers
		expect(html).toMatch(
			/<ins[^>]*class="[^"]*diff-ins[^"]*"[^>]*>Updated Title<\/ins>/,
		);

		// Check deletions work
		expect(html).toMatch(
			/<del[^>]*class="[^"]*diff-del[^"]*"[^>]*>Old introduction\.<\/del>/,
		);

		// Check additions work
		expect(html).toMatch(
			/<ins[^>]*class="[^"]*diff-ins[^"]*"[^>]*>New introduction with better content\.<\/ins>/,
		);

		// Check table is wrapped in diff container
		expect(html).toContain('class="diff-table-added"');
		expect(html).toMatch(/<table\b/);
	});
});

describe("stripDiffMarkup", () => {
	it("should remove ins tags", () => {
		const html = "This is <ins>highlighted</ins> text.";
		const result = stripDiffMarkup(html);

		expect(result).toBe("This is highlighted text.");
	});

	it("should remove del tags", () => {
		const html = "This is <del>deleted</del> text.";
		const result = stripDiffMarkup(html);

		expect(result).toBe("This is deleted text.");
	});

	it("should remove both ins and del tags", () => {
		const html = "New: <ins>added</ins>, Old: <del>removed</del>.";
		const result = stripDiffMarkup(html);

		expect(result).toBe("New: added, Old: removed.");
	});

	it("should remove placeholder tokens", () => {
		const ADD_START = "\u200B\u200BADD_START\u200B\u00A0";
		const ADD_END = "\u00A0\u200BADD_END\u200B\u200B";

		const text = `This is ${ADD_START}new${ADD_END} content.`;
		const result = stripDiffMarkup(text);

		expect(result).toBe("This is new content.");
	});

	it("should handle empty input", () => {
		expect(stripDiffMarkup("")).toBe("");
		expect(stripDiffMarkup(undefined)).toBe("");
	});
});

describe("fromMarkdown - Plain Markdown (No Diff Markers)", () => {
	it("should render tables correctly without any diff markers (regeneration scenario)", () => {
		// This simulates what happens during document regeneration:
		// The AI generates a new document with tables, and it's saved directly to the database.
		// When loaded, there are NO diff markers - just plain markdown.
		const markdown = `# Product Requirements Document

## Overview

This document outlines the product requirements.

## Features

| Feature | Description | Priority | Notes |
|---------|-------------|----------|-------|
| User Registration | Sign-up with email verification | High | MVP |
| Dashboard | Main overview page | Medium | V1.1 |

## Technical Requirements

The system should use React and Node.js.`;

		const html = fromMarkdown(markdown);

		// Critical: Tables should be properly rendered as HTML tables
		expect(html).toMatch(/<table\b/);
		expect(html).toContain("<th>Feature</th>");
		expect(html).toContain("<th>Description</th>");
		expect(html).toContain("<th>Priority</th>");
		expect(html).toContain("<th>Notes</th>");
		expect(html).toContain("<td>User Registration</td>");
		expect(html).toContain("<td>Sign-up with email verification</td>");
		expect(html).toContain("</table>");

		// Other content should be rendered correctly
		expect(html).toContain("<h1>Product Requirements Document</h1>");
		expect(html).toContain("<h2>Overview</h2>");
		expect(html).toContain("<h2>Features</h2>");
		expect(html).toContain("<h2>Technical Requirements</h2>");

		// Should NOT have diff highlighting classes (no diff markers = no highlighting)
		// Actually, since we default to "added" type, it will have diff-table-added
		// But the table should still be rendered correctly
	});

	it("should handle multiple tables without diff markers", () => {
		const markdown = `# Document

## Table 1

| A | B |
|---|---|
| 1 | 2 |

## Table 2

| X | Y | Z |
|---|---|---|
| a | b | c |`;

		const html = fromMarkdown(markdown);

		// Both tables should be rendered
		expect(html).toContain("<th>A</th>");
		expect(html).toContain("<th>B</th>");
		expect(html).toContain("<th>X</th>");
		expect(html).toContain("<th>Y</th>");
		expect(html).toContain("<th>Z</th>");
		expect(html).toContain("<td>1</td>");
		expect(html).toContain("<td>a</td>");
	});
});

describe("Integration - Full Pipeline", () => {
	it("should handle complete streaming diff scenario", () => {
		const oldText = "# Old Title\n\nOld content here.";
		const newText = `# New Title

New content here.

| Status | Value |
| --- | --- |
| Active | Yes |`;

		// Step 1: Generate diff
		const diffResult = diffPartialText(oldText, newText, true);

		// Step 2: Convert to HTML
		const html = fromMarkdown(diffResult);

		// Verify the output
		expect(html).toContain("<h1>");
		expect(html).toMatch(/<table\b/);
		expect(html).toContain("<th>Status</th>");

		// Step 3: Strip diff markup for saving
		const cleanHtml = stripDiffMarkup(html);
		expect(cleanHtml).not.toContain("<em>");
		expect(cleanHtml).not.toContain("<s>");
	});
});

// Word-level diff used to place ADD/DEL markers on lines in positions that
// broke MarkdownIt's block-level recognition, so headings/lists/HRs rendered
// as paragraphs with literal prefix chars; on save Turndown escaped those
// chars and the corruption persisted.
describe("fromMarkdown - block-prefix diff regression", () => {
	const stripDiffOnly = (html: string) =>
		html
			.replace(/<ins\b[^>]*>/gi, "")
			.replace(/<\/ins>/gi, "")
			.replace(/<del\b[^>]*>[\s\S]*?<\/del>/gi, "");

	it("renders heading-level change (## → ###) as a heading, not literal ###", () => {
		const diff = diffPartialText(
			"## My Heading\n\nbody",
			"### My Heading\n\nbody",
			true,
		);
		const html = fromMarkdown(diff);
		const clean = stripDiffOnly(html);
		expect(clean).toContain("<h3>My Heading</h3>");
		// Must not leak literal hashes into a paragraph.
		expect(clean).not.toMatch(/<p>[^<]*###/);
		expect(clean).not.toMatch(/<p>[^<]*##[^#]/);
	});

	it("renders newly-added bullet on an existing line as a list item, not literal -", () => {
		const diff = diffPartialText(
			"Item one\nItem two",
			"- Item one\n- Item two",
			true,
		);
		const html = fromMarkdown(diff);
		const clean = stripDiffOnly(html);
		expect(clean).toContain("<ul>");
		expect(clean).toContain("<li>Item one</li>");
		expect(clean).toContain("<li>Item two</li>");
		// Must not leak literal dashes into a paragraph.
		expect(clean).not.toMatch(/<p>[^<]*- Item/);
	});

	it("regression: continues to render a brand-new heading on its own line as a heading", () => {
		const diff = diffPartialText(
			"para1.\n\npara2.",
			"para1.\n\n### New\n\npara2.",
			true,
		);
		const html = fromMarkdown(diff);
		const clean = stripDiffOnly(html);
		expect(clean).toContain("<h3>New</h3>");
	});

	it("renders a removed bullet as a paragraph in the new content", () => {
		const diff = diffPartialText(
			"- Item one\n- Item two",
			"Item one\n- Item two",
			true,
		);
		const html = fromMarkdown(diff);
		const clean = stripDiffOnly(html);
		// New version: first line is plain text, second is still a list item.
		expect(clean).toContain("Item one");
		expect(clean).toContain("<li>Item two</li>");
		// First line must NOT render as a list item in the new view.
		expect(clean).not.toContain("<li>Item one</li>");
	});

	it("renders a newly-added horizontal rule as <hr>, not literal ---", () => {
		const diff = diffPartialText(
			"para1\n\npara2",
			"para1\n\n---\n\npara2",
			true,
		);
		const html = fromMarkdown(diff);
		const clean = stripDiffOnly(html);
		expect(clean).toContain("<hr>");
		// Must not leak literal --- into a paragraph.
		expect(clean).not.toMatch(/<p>[^<]*---/);
	});

	it("renders multi-emphasis adds as two separate <strong> spans", () => {
		// Reviewer regression: previously, two bold spans on the same line
		// (`**a** **b**`) either corrupted into a nested <strong> with
		// literal `** **` inside, or fell back to literal `**` text that
		// Turndown then escaped to `\*\*a\*\* \*\*b\*\*` on save.
		// The fix pre-splits the middle ADD block so each emphasis pair
		// fuses independently into its own <strong>.
		const diff = diffPartialText("a b", "**a** **b**", true);
		const html = fromMarkdown(diff);
		expect((html.match(/<strong>/g) || []).length).toBe(2);
		expect(html).not.toMatch(/<strong>[^<]*<ins[^>]*>/);
		expect(html).not.toContain("**");
	});

	it("renders three-emphasis adds as three separate <strong> spans", () => {
		const diff = diffPartialText("x y z", "**x** **y** **z**", true);
		const html = fromMarkdown(diff);
		expect((html.match(/<strong>/g) || []).length).toBe(3);
		expect(html).not.toContain("**");
	});

	it("removing emphasis from multi-bold preserves the underlying text", () => {
		// Reviewer regression: applying middle-split + emphasis fusion to
		// DEL blocks fused unchanged text into a single <del>**a**</del>,
		// which stripDiffTags then dropped entirely on accept — so the
		// surrounding text disappeared. DEL-side fusion is removed.
		const diff = diffPartialText("**a** **b**", "a b", true);
		const html = fromMarkdown(diff);
		// stripDiffTags removes <del>...</del> entirely; the kept text is
		// what survives. Both `a` and `b` must remain after strip.
		const stripped = html
			.replace(/<del\b[^>]*>[\s\S]*?<\/del>/gi, "")
			.replace(/<\s*\/?\s*ins[^>]*>/gi, "");
		expect(stripped).toContain("a");
		expect(stripped).toContain("b");
	});

	it("removing emphasis from single bold preserves the underlying text", () => {
		const diff = diffPartialText("**text**", "text", true);
		const html = fromMarkdown(diff);
		const stripped = html
			.replace(/<del\b[^>]*>[\s\S]*?<\/del>/gi, "")
			.replace(/<\s*\/?\s*ins[^>]*>/gi, "");
		expect(stripped).toContain("text");
	});

	it("renders **[label]** inside an ADD block as bold, not literal **", () => {
		// Reviewer regression: `**[Needs Verification]** rest of line` inside
		// a single ADD block had its asterisks adjacent to the marker
		// boundary on the inner side, which broke MarkdownIt's emphasis
		// flanking. Fix landed in DIFF_*_START/END boundary chars (NBSP).
		const oldText = "## Assumptions\n\n- Existing assumption.";
		const newText =
			"## Assumptions\n\n- **[Needs Verification]** Slack bot code can be adapted.\n- Existing assumption.";
		const diff = diffPartialText(oldText, newText, true);
		const html = fromMarkdown(diff);
		const clean = stripDiffOnly(html);
		expect(clean).toContain("<strong>");
		expect(clean).toContain("[Needs Verification]");
		expect(clean).not.toMatch(/\*\*\[Needs/);
	});

	it("regression: inline bold add does not leak literal asterisks", () => {
		// MarkdownIt interleaves <strong> with diff <ins> tags, so we
		// assert the `**` is consumed rather than the strong's position.
		const diff = diffPartialText(
			"make this text",
			"make this **text**",
			true,
		);
		const html = fromMarkdown(diff);
		const clean = stripDiffOnly(html);
		expect(clean).toContain("<strong>");
		expect(clean).toContain("text");
		expect(clean).not.toMatch(/\*\*text\*\*/);
	});
});

// Reviewer regression: an earlier attempt to suppress streaming-time phantom
// diffs by always normalizing both sides also stripped intentional escapes
// from unchanged user content, causing fromMarkdown to render a literal
// `\#` paragraph as a real heading. Keep streaming on raw text — escapes
// in unchanged regions must round-trip through diffPartialText untouched.
describe("diffPartialText - preserves intentional escapes", () => {
	it("preserves intentional \\# on lines unchanged across streaming", () => {
		const oldText = "\\# Not heading\n\nbody";
		const newText = "\\# Not heading\n\nbody";
		const result = diffPartialText(oldText, newText, false);
		expect(result).toBe("\\# Not heading\n\nbody");
	});

	it("preserves intentional \\# on lines unchanged at completion", () => {
		// Pre-fix, normalizeMarkdownForDiff stripped `\#` for both sides at
		// isComplete=true and emitted the unescaped form for unchanged
		// regions, causing the editor to render a literal `\#` paragraph
		// as a real heading on accept.
		const oldText = "\\# Not heading\n\nbody";
		const newText = "\\# Not heading\n\nbody";
		const result = diffPartialText(oldText, newText, true);
		expect(result).toBe("\\# Not heading\n\nbody");
	});

	it("merges \\# vs # phantom escape diff into unchanged escaped form", () => {
		// Turndown wrote `\#` defensively on the editor baseline; AI emits
		// clean `#`. Visual change is zero — keep the escaped form so the
		// preview matches the editor.
		const oldText = "\\# Heading\n\nshared body";
		const newText = "# Heading\n\nshared body";
		const result = diffPartialText(oldText, newText, true);
		expect(result).not.toContain("​​ADD_START​ ");
		expect(result).not.toContain("​​DEL_START​ ");
		expect(result).toContain("\\# Heading");
	});

	it("still surfaces a real heading-level change", () => {
		// `## Title` → `### Title` is a real semantic change. The phantom
		// merge must not swallow it.
		const oldText = "## Title\n\nbody";
		const newText = "### Title\n\nbody";
		const result = diffPartialText(oldText, newText, true);
		expect(result).toContain("​​ADD_START​ ");
	});

	it("surfaces an added escape (heading → literal) as a real diff", () => {
		// `# Heading` → `\# Heading` converts a real <h1> to a literal-#
		// paragraph. Reviewer regression: the directional phantom merge
		// must NOT swallow added escapes — only removed ones.
		const oldText = "# Heading\n\nbody";
		const newText = "\\# Heading\n\nbody";
		const result = diffPartialText(oldText, newText, true);
		expect(result).toContain("​​ADD_START​ ");
	});
});

describe("diffPartialText - a link or image is diffed whole (Fizzy #2946)", () => {
	/** The text between each start marker and its end marker, in order. */
	function runs(diff: string, start: string, end: string): string[] {
		return diff
			.split(start)
			.slice(1)
			.map((run) => run.slice(0, run.indexOf(end)));
	}
	const deletions = (diff: string) =>
		runs(diff, DIFF_DEL_START, DIFF_DEL_END);
	const insertions = (diff: string) =>
		runs(diff, DIFF_ADD_START, DIFF_ADD_END);
	const destinations = (diff: string) =>
		[...diff.matchAll(/\]\(([^)]*)\)/g)].map((match) => match[1]);

	it.each([
		{ path: "complete", isComplete: true },
		{ path: "streaming", isComplete: false },
	])(
		"marks a URL-only change as the whole old link and the whole new one ($path)",
		({ isComplete }) => {
			const diff = diffPartialText(
				"See [the docs](https://example.com/old) for details.",
				"See [the docs](https://example.com/new) for details.",
				isComplete,
			);

			expect(deletions(diff)).toEqual([
				"[the docs](https://example.com/old)",
			]);
			expect(insertions(diff)).toEqual([
				"[the docs](https://example.com/new)",
			]);
			// No marker between `(` and `)`.
			expect(destinations(diff)).toEqual([
				"https://example.com/old",
				"https://example.com/new",
			]);
		},
	);

	it("leaves a stored escaped link the agent echoed unescaped out of the diff", () => {
		const diff = diffPartialText(
			"Sources: [\\[S2\\]](https://example.com/s2) are listed.",
			"Sources: [[S2]](https://example.com/s2) are cited.",
			true,
		);

		expect(deletions(diff)).toEqual(["listed"]);
		expect(insertions(diff)).toEqual(["cited"]);
		expect(diff).toContain(
			"Sources: [\\[S2\\]](https://example.com/s2) are ",
		);
	});

	it("does not read an escaped bracket as the start of a link", () => {
		const diff = diffPartialText(
			"\\[S1\\] is documented in [Docs](https://example.com/docs).",
			"\\[S1\\] is documented in [Docs](https://example.com/docs2).",
			true,
		);

		expect(diff.startsWith("\\[S1\\] is documented in ")).toBe(true);
		expect(deletions(diff)).toEqual(["[Docs](https://example.com/docs)"]);
		expect(insertions(diff)).toEqual(["[Docs](https://example.com/docs2)"]);
	});

	it("keeps literal text after an escaped bracket on the word diff", () => {
		// `\[S1](…)` is text, not a link. Read as one, its markers would leave
		// the `\` outside them and the review would render a live link.
		const diff = diffPartialText(
			"Cited as \\[S1](https://example.com/s1) here.",
			"Cited as \\[S1](https://example.com/s2) here.",
			true,
		);

		expect(deletions(diff)).toEqual(["s1"]);
		expect(insertions(diff)).toEqual(["s2"]);
	});
});

describe("diffPartialText - a streaming cut never splits a placeholder (Fizzy #2946)", () => {
	// While streaming, the old text is cut at the new text's length. A cut
	// inside a placeholder used to leave its two halves in the review as
	// literal text, and a confirm can save a streaming render.
	const PLACEHOLDER_FRAGMENT = /xDIFF|xGFM|xHTML|xENDx/;

	it("keeps a link the cut falls inside whole in the old text's tail", () => {
		const oldText =
			"Intro [the docs](https://example.com/docs) and more text here.";
		const result = diffPartialText(oldText, "Intro [the d", false);

		expect(result).not.toMatch(PLACEHOLDER_FRAGMENT);
		// The begun link is held back, so nothing shows as changed.
		expect(result).toBe(oldText);
	});

	it("leaves a cut that ends at a link's start as it was", () => {
		const oldText =
			"Intro [the docs](https://example.com/docs) and more text here.";

		expect(diffPartialText(oldText, "Intro ", false)).toBe(oldText);
	});

	it("keeps a table the cut falls inside whole in the old text's tail", () => {
		const oldText =
			"Intro\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\nAfter.";
		const result = diffPartialText(oldText, "Intro\n\n| A |", false);

		expect(result).not.toMatch(PLACEHOLDER_FRAGMENT);
		expect(result).toContain("| A | B |\n| --- | --- |\n| 1 | 2 |");
	});

	it("keeps an HTML table the cut falls inside whole in the old text's tail", () => {
		const table = "<table><tr><td>A</td><td>B</td></tr></table>";
		const oldText = `Intro\n\n${table}\n\nAfter.`;
		// 23 characters: the cut falls inside the table's placeholder.
		const result = diffPartialText(
			oldText,
			"Intro\n\n<table><tr><td>A",
			false,
		);

		expect(result).not.toMatch(PLACEHOLDER_FRAGMENT);
		expect(result).toContain(`${table}\n\nAfter.`);
	});
});

describe("diffPartialText - a stored link-shaped text the agent echoed unescaped (Fizzy #2946)", () => {
	// The agent reads the document with Turndown's bracket escapes removed, so
	// it echoes a stored `\[Docs\](url)` text as `[Docs](url)`. That is no
	// change: accepting it must not turn the text into a link.
	const STORED = "See \\[Docs\\](https://example.com/d) here.";

	it.each([
		{ path: "complete", isComplete: true },
		{ path: "streaming", isComplete: false },
	])("leaves it out of the diff ($path)", ({ isComplete }) => {
		expect(
			diffPartialText(STORED, toAgentDocument(STORED), isComplete),
		).toBe(STORED);
	});

	it("still shows a link the agent turned into escaped text", () => {
		const diff = diffPartialText(
			"See [Docs](https://example.com/d) here.",
			STORED,
			true,
		);

		expect(diff).toContain(DIFF_DEL_START);
		expect(diff).toContain(DIFF_ADD_START);
	});
});

describe("diffPartialText - link scan time on hostile input (Fizzy #2946)", () => {
	// docs/solutions/security-issues/redos-in-preview-markdown-strip.md: one
	// long line and a hard time budget. The link scan runs over the whole
	// document on every streaming chunk.
	const fixtures = {
		"unclosed link text": "[a".repeat(20000),
		"unclosed destinations": "[a](b".repeat(20000),
		"unclosed escaped link text": "\\[a\\](b".repeat(15000),
		"unclosed image tags": "<img ".repeat(20000),
		"unbalanced image tag quotes": '<img a="'.repeat(15000),
		"nested brackets": "[[[[a]".repeat(15000),
		"unclosed anchors": '<a href="x">y'.repeat(15000),
		"unbalanced anchor quotes": '<a href="'.repeat(15000),
		"unclosed mention spans": '<span data-type="mention">@a'.repeat(15000),
	};

	it.each(Object.entries(fixtures))(
		"stays linear on %s",
		(_name, fixture) => {
			expect(fixture).not.toContain("\n");
			const started = performance.now();
			diffPartialText(fixture, fixture, true);
			diffPartialText(
				fixture,
				fixture.slice(0, fixture.length / 2),
				false,
			);
			expect(performance.now() - started).toBeLessThan(500);
		},
	);
});

describe("diffPartialText - an unchanged link while it streams (Fizzy #2946)", () => {
	// Until a link's text has streamed in whole it is no link yet; diffed as
	// text, the unchanged link beside it flickered as a deletion.
	const STORED =
		"See [the docs](https://example.com/guide) for details and more.";

	it.each([4, 6, 10, 20, 30, 45, 50, 58])(
		"shows no change when the stream has reached %i characters",
		(length) => {
			expect(
				diffPartialText(STORED, STORED.slice(0, length), false),
			).toBe(STORED);
		},
	);
});

describe("diffPartialText - text that looks like a link placeholder (Fizzy #2946)", () => {
	it("leaves an unchanged document that holds the placeholder's spelling as it is", () => {
		const stored =
			"Note xDIFFLINKx0xENDx and [Docs](https://example.com/d) here.";

		expect(diffPartialText(stored, stored, true)).toBe(stored);
		expect(diffPartialText(stored, stored.slice(0, 30), false)).toBe(
			stored,
		);
	});
});

describe("diffPartialText - reference link scan time on hostile input (Fizzy #2946)", () => {
	// With a definition present, every paragraph is scanned for references
	// on every streaming chunk.
	const DEFINITION = "[a]: https://example.com/a\n\n";
	const fixtures = {
		"unclosed brackets": "[a".repeat(20000),
		"bracket pairs each opening a label": "[a][".repeat(20000),
		"unclosed code spans of many lengths": Array.from(
			{ length: 4000 },
			(_, index) => `${"`".repeat((index % 40) + 1)}a`,
		).join(""),
		"unclosed inline link tails": "[a](b".repeat(20000),
		"definition-shaped text": "[a]: b ".repeat(15000),
	};

	it.each(Object.entries(fixtures))(
		"stays linear on %s",
		(_name, fixture) => {
			const text = `${DEFINITION}${fixture}`;
			const started = performance.now();
			diffPartialText(text, text, true);
			diffPartialText(text, text.slice(0, text.length / 2), false);
			expect(performance.now() - started).toBeLessThan(500);
		},
	);

	it("stays linear on many definition lines", () => {
		const text = `${"[a]: https://example.com/a\n".repeat(20000)}\nSee [a].`;
		const started = performance.now();
		diffPartialText(text, text, true);
		diffPartialText(text, text.slice(0, text.length / 2), false);
		expect(performance.now() - started).toBeLessThan(500);
	});

	// A changed definition takes the slow path: the texts are parsed, their
	// usages rewritten, and every label written in brackets is checked.
	it.each(
		Object.entries({
			...fixtures,
			"many definition lines": `${"[a]: https://example.com/a\n".repeat(20000)}\nSee [a].`,
		}),
	)("stays linear with a changed definition on %s", (_name, fixture) => {
		const before = `[a]: https://example.com/old\n\n${fixture}`;
		const after = `[a]: https://example.com/new\n\n${fixture}`;
		const started = performance.now();
		diffPartialText(before, after, true);
		diffPartialText(before, after.slice(0, after.length / 2), false);
		expect(performance.now() - started).toBeLessThan(500);
	});
});

describe("diffPartialText - an unchanged reference document while it streams (Fizzy #2946)", () => {
	// Definitions usually arrive last. Rewriting every reference link made
	// each one show as a change until its definition had streamed in.
	const STORED = [
		"See [the guide][guide] and the [faq] first.",
		"",
		"Then read on.",
		"",
		"[guide]: https://example.com/guide",
		'[faq]: https://example.com/faq "Questions"',
	].join("\n");
	const guide = STORED.indexOf("[guide]:");
	const faq = STORED.indexOf("[faq]:");

	it.each([
		["before any definition", 20],
		["at the first definition", guide],
		["inside the first destination", guide + 18],
		["after the first definition", faq],
		["inside the last title", STORED.length - 4],
		["at the end", STORED.length],
	])("shows no change %s", (_where, length) => {
		expect(diffPartialText(STORED, STORED.slice(0, length), false)).toBe(
			STORED,
		);
	});

	it("shows no change while a title on the next line or a quoted definition streams in", () => {
		const stored = [
			"See [the guide][guide] and the [faq] first.",
			"",
			"[guide]: https://example.com/guide",
			'"The guide"',
			"",
			"> [faq]: https://example.com/faq",
		].join("\n");

		for (let length = 0; length <= stored.length; length++) {
			expect(
				diffPartialText(stored, stored.slice(0, length), false),
			).toBe(stored);
		}
	});
});

describe("diffPartialText - the line break beside a changed table (Fizzy #2946)", () => {
	// A changed part that holds a table and a line break gave the break a
	// marker pair of its own, a change around no text that the renderer had
	// to drop again.
	const table = (name: string) =>
		`| Name | Link |\n| --- | --- |\n| ${name} | [guide] |`;
	const emptyPair = new RegExp(
		`(?:${DIFF_ADD_START}\\s*${DIFF_ADD_END}|${DIFF_DEL_START}\\s*${DIFF_DEL_END})`,
	);

	it.each([
		["a definition", "[guide]: https://example.com/guide"],
		["a paragraph", "More text here."],
	])("marks no line break of its own before %s", (_name, after) => {
		const diff = diffPartialText(
			`${table("Pay")}\n\n${after}`,
			`${table("Pay now")}\n\n${after}`,
			true,
		);

		expect(diff).not.toMatch(emptyPair);
		expect(diff).toMatch(new RegExp(`\\n\\n${escapeForRegExp(after)}$`));
	});
});

function escapeForRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("diffPartialText - a plain-text review (Fizzy #2946)", () => {
	// A prompt is reviewed and saved as raw text, not rendered as Markdown:
	// its definition-shaped lines are not rewritten as links, and marker
	// bytes in it are not resolved.
	const ENC_DEL_START = "%E2%80%8B%E2%80%8BDEL_START%E2%80%8B%C2%A0";
	const ENC_DEL_END = "%C2%A0%E2%80%8BDEL_END%E2%80%8B%E2%80%8B";
	const acceptAll = (diff: string) =>
		diff
			.replace(
				new RegExp(`${DIFF_DEL_START}[\\s\\S]*?${DIFF_DEL_END}`, "g"),
				"",
			)
			.replaceAll(DIFF_ADD_START, "")
			.replaceAll(DIFF_ADD_END, "");
	const rejectAll = (diff: string) =>
		diff
			.replace(
				new RegExp(`${DIFF_ADD_START}[\\s\\S]*?${DIFF_ADD_END}`, "g"),
				"",
			)
			.replaceAll(DIFF_DEL_START, "")
			.replaceAll(DIFF_DEL_END, "");

	it("shows a changed definition-shaped line as text", () => {
		const stored = "Reply in the [Format] below.\n\n[Format]: markdown";
		const proposed = "Reply in the [Format] below.\n\n[Format]: json";
		const diff = diffPartialText(stored, proposed, true, {
			markdown: false,
		});

		expect(diff).toContain("Reply in the [Format] below.");
		expect(diff).toContain("[Format]: ");
		expect(diff).toContain(`${DIFF_DEL_START}markdown${DIFF_DEL_END}`);
		expect(diff).toContain(`${DIFF_ADD_START}json${DIFF_ADD_END}`);
		expect(acceptAll(diff)).toBe(proposed);
		expect(rejectAll(diff)).toBe(stored);
	});

	it("leaves encoded marker bytes in the text as they are", () => {
		const stored = `Fetch https://example.com/a${ENC_DEL_START}b${ENC_DEL_END}/c and summarize it.`;
		const proposed = `${stored} Keep it short.`;
		const diff = diffPartialText(stored, proposed, true, {
			markdown: false,
		});

		expect(diff).toContain(`/a${ENC_DEL_START}b${ENC_DEL_END}/c`);
		expect(acceptAll(diff)).toBe(proposed);
	});
});
