/**
 * Tests for fromMarkdown GFM table conversion
 *
 * These tests verify that GFM (GitHub Flavored Markdown) tables
 * are properly converted to HTML tables by the fromMarkdown function.
 */

import { describe, expect, it } from "vitest";
import {
	diffPartialText,
	fromMarkdown,
	normalizeMarkdownContent,
} from "../diff-utils";
import { stripDiffTags } from "../editor-save-utils";

describe("fromMarkdown - GFM table conversion", () => {
	describe("basic table conversion", () => {
		it("should convert a simple GFM table to HTML", () => {
			const markdown = `| Feature | Description | Priority |
|---------|-------------|----------|
| Login | User authentication | High |
| Dashboard | Project overview | Medium |`;

			const html = fromMarkdown(markdown);

			expect(html).toContain("<table>");
			expect(html).toContain("</table>");
			expect(html).toContain("<th>");
			expect(html).toContain("<td>");
			expect(html).toContain("Feature");
			expect(html).toContain("Login");
			expect(html).toContain("Dashboard");
			// Should NOT have pipe characters outside of code blocks
			expect(html).not.toMatch(/\|(?![^<]*<\/code>)/);
		});

		it("should convert a table with alignment markers", () => {
			const markdown = `| Left | Center | Right |
|:-----|:------:|------:|
| L1 | C1 | R1 |
| L2 | C2 | R2 |`;

			const html = fromMarkdown(markdown);

			expect(html).toContain("<table>");
			// Headers may have style attributes for alignment
			expect(html).toMatch(/<th[^>]*>/);
			expect(html).toMatch(/<td[^>]*>/);
			expect(html).toContain("Left");
			expect(html).toContain("Center");
			expect(html).toContain("Right");
		});

		it("should handle table with special characters in cells", () => {
			const markdown = `| Feature | Description |
|---------|-------------|
| API Rate Limiting | 1000 req/min |
| OAuth 2.0 / JWT | Token-based auth |`;

			const html = fromMarkdown(markdown);

			expect(html).toContain("<table>");
			expect(html).toContain("1000 req/min");
			expect(html).toContain("OAuth 2.0 / JWT");
		});
	});

	describe("table with surrounding content", () => {
		it("should convert table within a document", () => {
			const markdown = `## Functional Requirements

Here are the requirements:

| Feature | Description | Priority |
|---------|-------------|----------|
| SSO | Google Workspace SSO | High |
| JWT | Token-based API access | High |

This is the paragraph after the table.`;

			const html = fromMarkdown(markdown);

			expect(html).toContain("<h2>");
			expect(html).toContain("<table>");
			expect(html).toContain("</table>");
			expect(html).toContain("<th>");
			expect(html).toContain("SSO");
			expect(html).toContain("paragraph after the table");
		});

		it("should convert multiple tables in same document", () => {
			const markdown = `## Table 1

| Col A | Col B |
|-------|-------|
| A1 | B1 |

## Table 2

| Col X | Col Y |
|-------|-------|
| X1 | Y1 |`;

			const html = fromMarkdown(markdown);

			// Count table occurrences
			const tableCount = (html.match(/<table>/g) || []).length;
			expect(tableCount).toBe(2);
			expect(html).toContain("A1");
			expect(html).toContain("X1");
		});
	});

	describe("real AI-generated content", () => {
		it("should convert actual AI-generated PRD table", () => {
			// This is actual content from the AI document generation
			const markdown = `### Feature: User Authentication & Security

| Feature | Description | Priority | Acceptance Criteria |
|---------|-------------|----------|--------------------|
| SSO with Google Workspace | Authenticate users via Google Workspace SSO and provision RBAC roles. | High | - Google SSO redirects to Google sign-in; - JWT issued with proper scopes; - RBAC enforces permissions; - MFA available for admins; - Session expires per policy |
| JWT-based API access | Use OAuth 2.0 / JWT tokens for all API requests; token expiry enforced. | High | - Tokens issued with 15-minute expiry; - Refresh tokens rotate; - Invalid tokens rejected with 401; - Access-control per resource |
| RBAC | Role-based access control model with project-level permissions. | High | - Roles: Admin, PM, Foreman, SafetyOfficer, FinOps; - Permissions bound to resources; - Audit logs capture role changes |`;

			const html = fromMarkdown(markdown);

			expect(html).toContain("<table>");
			expect(html).toContain("</table>");
			expect(html).toContain("<th>");
			expect(html).toContain("<td>");
			expect(html).toContain("SSO with Google Workspace");
			expect(html).toContain("JWT-based API access");
			expect(html).toContain("RBAC");
			// Should NOT have raw pipe characters visible
			expect(html).not.toMatch(/\|\s*Feature\s*\|/);
		});

		it("should convert Non-Functional Requirements table", () => {
			const markdown = `## Non-Functional Requirements

| Area | Requirement |
|------|-------------|
| Performance | Page load times < 2 seconds; real-time dashboards < 5 seconds |
| Availability | 99.5% uptime; automated backups every 4 hours with 30-day retention |
| Security | AES-256 at rest; TLS 1.3 in transit; SOC 2 Type II readiness |`;

			const html = fromMarkdown(markdown);

			expect(html).toContain("<table>");
			expect(html).toContain("Performance");
			expect(html).toContain("Page load times");
			expect(html).toContain("AES-256 at rest");
		});

		it("should convert Milestones table with dates", () => {
			const markdown = `## Milestones & Timeline

| Milestone | Description | Target Date | Lead |
|-----------|-------------|-------------|------|
| MVP Scope Definition | Finalize scope and acceptance criteria | 2026-02-15 | Product Lead |
| Alpha Release | Internal testing with beta customers | 2026-03-01 | Eng Lead |
| Beta Release | Public pilot with 3-5 projects | 2026-04-01 | PMO |
| GA Release | General availability | 2026-05-01 | Program Manager |`;

			const html = fromMarkdown(markdown);

			expect(html).toContain("<table>");
			expect(html).toContain("MVP Scope Definition");
			expect(html).toContain("2026-02-15");
			expect(html).toContain("Product Lead");
		});

		it("should reconstruct collapsed single-line GFM tables", () => {
			const markdown =
				"| Technology | Purpose | |-------------|----------------------------------------|| React | Frontend development || Next.js | Server-side rendering and routing || TypeScript | Static type checking |";

			const normalized = normalizeMarkdownContent(markdown);
			const html = fromMarkdown(markdown);

			expect(normalized).toContain("| Technology | Purpose |");
			expect(normalized).toContain(
				"| ------------- | ---------------------------------------- |",
			);
			expect(normalized).toContain("| React | Frontend development |");
			expect(normalized).toContain(
				"| Next.js | Server-side rendering and routing |",
			);
			expect(html).toContain("<table>");
			expect(html).toContain("<th>Technology</th>");
			expect(html).toContain("<td>TypeScript</td>");
		});

		// Documents damaged before the diff pipeline was fixed still hold the
		// collapsed pipe blob that a failed table render left behind. They heal
		// on load, so opening the document is enough to get the table back.
		it("reconstructs a collapsed table that contains empty cells", () => {
			const markdown =
				"| Area | Owner | Notes | | --- | --- | --- | | API |  | needs review | | UI | Bob |  |";

			const normalized = normalizeMarkdownContent(markdown);
			const html = fromMarkdown(markdown);

			expect(normalized).toContain("| Area | Owner | Notes |");
			expect(normalized).toContain("| API |  | needs review |");
			expect(normalized).toContain("| UI | Bob |  |");
			expect(html).toContain("<table>");
			expect(html).toContain("<th>Notes</th>");
			expect(html).toContain("<td>needs review</td>");
		});

		it("reconstructs a collapsed table with only one body row", () => {
			const markdown = "| Key | Value | | --- | --- | | env | prod |";

			const html = fromMarkdown(markdown);

			expect(html).toContain("<table>");
			expect(html).toContain("<th>Key</th>");
			expect(html).toContain("<td>prod</td>");
		});

		it("reconstructs a collapsed header-and-separator table with no body rows", () => {
			// Valid GFM: a table may have a header and separator only. The
			// separator run gives the column count, so two reconstructed rows
			// are enough to rebuild safely.
			const markdown = "| Key | Value | | --- | --- |";

			const html = fromMarkdown(markdown);

			expect(html).toContain("<table>");
			expect(html).toContain("<th>Key</th>");
			expect(html).toContain("<th>Value</th>");
			expect(html).not.toMatch(/<p>[^<]*\|\s*-{3}/);
		});

		it("splits a collapsed table off the prose it was glued to", () => {
			const markdown =
				"See the matrix below. | Role | Owner | | --- | --- | | PM | Alice |";

			const normalized = normalizeMarkdownContent(markdown);
			const html = fromMarkdown(markdown);

			expect(normalized).toMatch(/^See the matrix below\.$/m);
			expect(html).toContain("<table>");
			expect(html).toContain("<th>Role</th>");
			expect(html).toContain("<td>Alice</td>");
		});

		it("leaves pipe-containing prose alone", () => {
			const markdown =
				"Use the `a | b` syntax, or the --- separator, whichever reads better.";

			const normalized = normalizeMarkdownContent(markdown);

			expect(normalized).toContain("Use the `a | b` syntax");
			expect(fromMarkdown(markdown)).not.toContain("<table>");
		});
	});

	describe("edge cases", () => {
		it("should handle table with empty cells", () => {
			const markdown = `| A | B | C |
|---|---|---|
| 1 |   | 3 |
|   | 2 |   |`;

			const html = fromMarkdown(markdown);

			expect(html).toContain("<table>");
			expect(html).toContain("<td>");
		});

		it("should handle table with inline formatting", () => {
			const markdown = `| Feature | Status |
|---------|--------|
| **Bold** | *Italic* |
| \`code\` | Normal |`;

			const html = fromMarkdown(markdown);

			expect(html).toContain("<table>");
			expect(html).toContain("<strong>Bold</strong>");
			expect(html).toContain("<em>Italic</em>");
			expect(html).toContain("<code>code</code>");
		});

		it("should NOT treat pipe in regular text as table", () => {
			const markdown = `This is regular text with a | pipe character.

But not a table.`;

			const html = fromMarkdown(markdown);

			expect(html).not.toContain("<table>");
			// Pipe should remain as text
			expect(html).toContain("|");
		});

		it("should handle Windows line endings (CRLF)", () => {
			const markdown = "| A | B |\r\n|---|---|\r\n| 1 | 2 |\r\n| 3 | 4 |";

			const html = fromMarkdown(markdown);

			expect(html).toContain("<table>");
			expect(html).toContain("<th>");
			expect(html).toContain("<td>");
		});
	});

	describe("TipTap compatibility", () => {
		it("should NOT have thead/tbody wrappers", () => {
			const markdown = `| A | B |
|---|---|
| 1 | 2 |`;

			const html = fromMarkdown(markdown);

			expect(html).toContain("<table>");
			expect(html).not.toContain("<thead>");
			expect(html).not.toContain("</thead>");
			expect(html).not.toContain("<tbody>");
			expect(html).not.toContain("</tbody>");
		});

		it("should have flat table structure for TipTap", () => {
			const markdown = `| Header1 | Header2 |
|---------|---------|
| Cell1 | Cell2 |`;

			const html = fromMarkdown(markdown);

			// Should be: <table><tr><th>...</th></tr><tr><td>...</td></tr></table>
			// NOT: <table><thead><tr>...</tr></thead><tbody><tr>...</tr></tbody></table>
			expect(html).toMatch(/<table>\s*<tr>/);
		});

		it("should NOT wrap plain tables in diff-table-added div", () => {
			// Plain markdown without diff markers should NOT get wrapped
			const markdown = `## Features

| Feature | Status |
|---------|--------|
| Login | Done |
| Dashboard | WIP |

More content here.`;

			const html = fromMarkdown(markdown);

			// Should have table but NOT the diff wrapper
			expect(html).toContain("<table>");
			expect(html).toContain("Login");
			expect(html).toContain("Done");
			// The critical check: NO diff wrapper for plain tables
			expect(html).not.toContain("diff-table-added");
			expect(html).not.toContain("diff-table-deleted");
		});
	});

	describe("corrupted separator row repair", () => {
		it("should render tables with em-dash separators", () => {
			const markdown = `| Feature | Status |
|\u2014\u2014\u2014|\u2014\u2014\u2014|
| Login | Done |`;

			const html = fromMarkdown(markdown);
			expect(html).toContain("<table>");
			expect(html).toContain("<th>");
			expect(html).toContain("Login");
		});

		it("should render tables with en-dash separators", () => {
			const markdown = `| Name | Role |
|\u2013\u2013\u2013|\u2013\u2013\u2013|
| Alice | Engineer |`;

			const html = fromMarkdown(markdown);
			expect(html).toContain("<table>");
			expect(html).toContain("<th>");
			expect(html).toContain("Alice");
		});

		it("should render tables with mixed dash corruption", () => {
			const markdown = `| Col A | Col B |
|\u2014\u2013-|\u2013\u2014-|
| val1 | val2 |`;

			const html = fromMarkdown(markdown);
			expect(html).toContain("<table>");
			expect(html).toContain("val1");
		});

		it("should render tables with backslash-escaped dashes", () => {
			const markdown = `| Header | Value |
| \\-\\-\\- | \\-\\-\\- |
| data | content |`;

			const html = fromMarkdown(markdown);
			expect(html).toContain("<table>");
			expect(html).toContain("data");
		});

		it("should not affect non-separator lines with em-dashes", () => {
			const markdown = "This is a line with an em-dash \u2014 in prose.";

			const html = fromMarkdown(markdown);
			expect(html).toContain("\u2014");
		});
	});

	// Issue #714: when the saved doc contains TipTap-serialized HTML tables,
	// diffPartialText must treat each table as one atomic token so diff
	// markers can never land inside an attribute value.
	describe("HTML table preservation through diffPartialText (issue #714)", () => {
		const HTML_TABLE = `<table class="tiptap-table" style="min-width: 75px;"><colgroup><col style="min-width: 25px;"><col style="min-width: 25px;"></colgroup><tbody><tr><th colspan="1" rowspan="1"><p>Field</p></th><th colspan="1" rowspan="1"><p>Value</p></th></tr><tr><td colspan="1" rowspan="1"><p>Title</p></td><td colspan="1" rowspan="1"><p>Old Title</p></td></tr></tbody></table>`;

		it("does not inject diff markers inside an unchanged HTML table when prose around it changes", () => {
			const oldText = `# Title\n\n## Document Control\n\n${HTML_TABLE}\n\n## Notes\n\nOriginal note text here.`;
			const newText = `# Title\n\n## Document Control\n\n${HTML_TABLE}\n\n## Notes\n\nUpdated note text here.`;

			const diff = diffPartialText(oldText, newText, true);

			// The HTML table must survive intact \u2014 no DIFF markers should
			// appear inside the table's attribute values or tag soup.
			expect(diff).toContain(HTML_TABLE);

			const html = fromMarkdown(diff);
			// No `<ins` or `<del` artifacts injected into attribute values.
			expect(html).not.toMatch(/colspan="[^"]*<ins\b/i);
			expect(html).not.toMatch(/colspan="[^"]*<\/ins\b/i);
			expect(html).not.toMatch(/colspan="[^"]*<del\b/i);
			expect(html).not.toMatch(/colspan="[^"]*<\/del\b/i);
			expect(html).not.toMatch(/style="[^"]*<ins\b/i);
			expect(html).not.toMatch(/style="[^"]*<del\b/i);
		});

		it("wraps an HTML table in diff-table-deleted when it is part of a larger removed run", () => {
			// Reviewer scenario: a section that contains a table PLUS trailing
			// prose is deleted in one shot. The whole region becomes a single
			// DEL diff part. extractDiffWrappedHtmlTables only matches when
			// markers tightly wrap `<table>…</table>`, so we must split the
			// part on table boundaries before applying DIFF markers.
			const oldText = `# Title\n\n## Section A\n\n${HTML_TABLE}\n\nTrailing paragraph that goes too.\n\n## Section B\n\nKeep me.`;
			const newText = "# Title\n\n## Section B\n\nKeep me.";

			const diff = diffPartialText(oldText, newText, true);
			const html = fromMarkdown(diff);

			// Table must be rendered as the diff-table-deleted wrapper, not
			// embedded inside a `<del class="diff-del">…<table>…</table></del>`.
			expect(html).toContain('<div class="diff-table-deleted">');
			expect(html).not.toMatch(
				/<del[^>]*class="[^"]*diff-del[^"]*"[^>]*>\s*<table\b/i,
			);
		});

		it("handles uppercase <TABLE> tags in a larger removed run", () => {
			// The split path uses a case-insensitive regex; the guard must
			// match. Mixed-case HTML coming from imported content would
			// otherwise skip the split and render as `<del><TABLE>…</TABLE></del>`.
			const UPPER_TABLE = HTML_TABLE.replace(/<table\b/gi, "<TABLE")
				.replace(/<\/table>/gi, "</TABLE>")
				.replace(/<colgroup>/gi, "<COLGROUP>")
				.replace(/<\/colgroup>/gi, "</COLGROUP>")
				.replace(/<col\b/gi, "<COL")
				.replace(/<tbody>/gi, "<TBODY>")
				.replace(/<\/tbody>/gi, "</TBODY>")
				.replace(/<tr>/gi, "<TR>")
				.replace(/<\/tr>/gi, "</TR>")
				.replace(/<th\b/gi, "<TH")
				.replace(/<\/th>/gi, "</TH>")
				.replace(/<td\b/gi, "<TD")
				.replace(/<\/td>/gi, "</TD>");

			const oldText = `# Title\n\n${UPPER_TABLE}\n\nTrailing text.\n\n## Section B`;
			const newText = "# Title\n\n## Section B";

			const diff = diffPartialText(oldText, newText, true);
			const html = fromMarkdown(diff);

			expect(html).toContain('<div class="diff-table-deleted">');
			expect(html).not.toMatch(
				/<del[^>]*class="[^"]*diff-del[^"]*"[^>]*>\s*<TABLE\b/i,
			);
		});

		it("wraps a wholesale-replaced HTML table in diff-table div containers", () => {
			const NEW_TABLE = HTML_TABLE.replace("Old Title", "New Title");
			const oldText = `# Title\n\n${HTML_TABLE}\n`;
			const newText = `# Title\n\n${NEW_TABLE}\n`;

			const diff = diffPartialText(oldText, newText, true);
			const html = fromMarkdown(diff);

			// Both deleted and added tables get rendered with the standard
			// diff-table wrapper classes that stripDiffTags handles on save.
			expect(html).toContain('<div class="diff-table-deleted">');
			expect(html).toContain('<div class="diff-table-added">');
			// Attribute corruption check: no <ins/<del/</ins/</del inside
			// any HTML attribute value.
			expect(html).not.toMatch(/="[^"]*<\/?ins\b/i);
			expect(html).not.toMatch(/="[^"]*<\/?del\b/i);
		});
	});

	// GFM pipe tables are what `getEditorMarkdownForSave` actually persists, so
	// they need the same atomic treatment HTML tables got in #714. Without it,
	// `diffWords` drops markers inside the `| --- | --- |` separator row, the
	// table stops parsing, and the accept-save round trip bakes a paragraph of
	// literal pipes into the stored document.
	describe("GFM table preservation through diffPartialText", () => {
		const GFM_TABLE = `| Role | Owner | Status |
|------|-------|--------|
| PM | Alice | **Active** |
| Eng | Bob | Pending |`;

		// The four diff marker tokens, spelled exactly as diff-utils emits them
		// (ZWSP-wrapped inner token, NBSP on the side facing inline content).
		const ADD_START = "​​ADD_START​ ";
		const ADD_END = " ​ADD_END​​";
		const DEL_START = "​​DEL_START​ ";
		const DEL_END = " ​DEL_END​​";

		const hasMarkerResidue = (value: string) => /​| /.test(value);

		it("leaves an unchanged table untouched when prose around it changes", () => {
			const oldText = `# Plan\n\n${GFM_TABLE}\n\n## Notes\n\nOriginal note text.`;
			const newText = `# Plan\n\n${GFM_TABLE}\n\n## Notes\n\nUpdated note text.`;

			const diff = diffPartialText(oldText, newText, true);

			// Every row survives with no marker in it. (The separator row is
			// re-spaced to `| --- |` by normalizeMarkdownForDiff, on both sides
			// equally, so it never shows up as a change.)
			expect(diff).toContain("| Role | Owner | Status |");
			expect(diff).toContain("| PM | Alice | **Active** |");
			expect(diff).toContain("| Eng | Bob | Pending |");
			expect(diff).toMatch(/^\|[\s\-:|]+\|$/m);
			expect(
				hasMarkerResidue(diff.slice(0, diff.indexOf("## Notes"))),
			).toBe(false);

			const html = fromMarkdown(diff);
			expect(html).toContain("<table>");
			// The symptom: a paragraph holding the raw separator row.
			expect(html).not.toMatch(/<p>[^<]*\|\s*-{3}/);
		});

		it("wraps both sides in diff-table divs when a cell is edited", () => {
			const newText = GFM_TABLE.replace("Pending", "Blocked");

			const diff = diffPartialText(GFM_TABLE, newText, true);
			const html = fromMarkdown(diff);

			expect(html).toContain('<div class="diff-table-deleted">');
			expect(html).toContain('<div class="diff-table-added">');
			expect(html).toMatch(/<div class="diff-table-deleted">\s*<table\b/);
			expect(html).toMatch(/<div class="diff-table-added">\s*<table\b/);
			// The attribute is what survives ProseMirror, so the save path can
			// still tell the two tables apart after the wrapper div is dropped.
			expect(html).toMatch(/<table[^>]*data-diff="deleted"/);
			expect(html).toMatch(/<table[^>]*data-diff="added"/);
			expect(html).toContain("Blocked");
			expect(hasMarkerResidue(html)).toBe(false);
		});

		it("keeps the table parseable when a row is added", () => {
			const newText = `${GFM_TABLE}\n| QA | Carol | Active |`;

			const diff = diffPartialText(GFM_TABLE, newText, true);
			const html = fromMarkdown(diff);

			expect(html).toContain('<div class="diff-table-added">');
			expect(html).toContain("Carol");
			expect(html).not.toMatch(/<p>[^<]*\|\s*-{3}/);
		});

		it("wraps a GFM table in diff-table-deleted inside a larger removed run", () => {
			const oldText = `# Title\n\n## Section A\n\n${GFM_TABLE}\n\nTrailing paragraph that goes too.\n\n## Section B\n\nKeep me.`;
			const newText = "# Title\n\n## Section B\n\nKeep me.";

			const diff = diffPartialText(oldText, newText, true);
			const html = fromMarkdown(diff);

			expect(html).toContain('<div class="diff-table-deleted">');
			expect(html).not.toMatch(
				/<del[^>]*class="[^"]*diff-del[^"]*"[^>]*>[^<]*\|\s*-{3}/i,
			);
		});

		it("wraps a brand-new GFM table added inside a larger ADD region", () => {
			const oldText = "# Title\n\n## Section B\n\nKeep me.";
			const newText = `# Title\n\n## Section A\n\n${GFM_TABLE}\n\nFresh trailing paragraph.\n\n## Section B\n\nKeep me.`;

			const diff = diffPartialText(oldText, newText, true);
			const html = fromMarkdown(diff);

			expect(html).toContain('<div class="diff-table-added">');
			expect(html).toMatch(/<table\b/);
			expect(html).not.toMatch(/<p>[^<]*\|\s*-{3}/);
		});

		it("does not rewrite a pipe table that lives inside a code fence", () => {
			const fenced = `# Docs\n\n\`\`\`markdown\n${GFM_TABLE}\n\`\`\`\n\nProse tail.`;
			const newText = fenced.replace(
				"Prose tail.",
				"Prose tail updated.",
			);

			const diff = diffPartialText(fenced, newText, true);

			expect(diff).toContain(`\`\`\`markdown\n${GFM_TABLE}\n\`\`\``);
		});

		it("survives CRLF line endings", () => {
			const crlfTable = GFM_TABLE.replace(/\n/g, "\r\n");
			const newText = crlfTable.replace("Pending", "Blocked");

			const diff = diffPartialText(crlfTable, newText, true);
			const html = fromMarkdown(diff);

			expect(html).toMatch(/<table\b/);
			expect(html).toContain("Blocked");
			expect(html).not.toMatch(/<p>[^<]*\|\s*-{3}/);
		});

		it("renders a table whose separator row already carries diff markers", () => {
			// Defense in depth: content that reached fromMarkdown with markers
			// already inside the separator row (the pre-fix corruption shape)
			// must still parse as a table rather than a paragraph of pipes.
			const corrupted = `| Role | Owner | ${ADD_START}Notes ${ADD_END}|
${ADD_START}| ${ADD_END}--- | --- | ${ADD_START}--- ${ADD_END}|
${ADD_START}| ${ADD_END}PM | Alice | ${ADD_START}lead ${ADD_END}|`;

			const html = fromMarkdown(corrupted);

			expect(html).toContain("<table>");
			expect(html).not.toMatch(/<p>[^<]*\|\s*-{3}/);
			expect(html).not.toContain("ADD_START");
			expect(html).not.toContain("ADD_END");
		});

		it("strips the orphaned partner when a marker pair spans row and separator", () => {
			// A DEL pair that opens in the header row and closes inside the
			// separator row. Dropping the separator's DEL_END alone leaves the
			// header's DEL_START unpaired — it renders as an unclosed <del>
			// that swallows the cell, and the accept-time strip then deletes
			// "Owner" even though it was never a real deletion.
			const corrupted = `| Role | ${DEL_START}Owner |
| --- ${DEL_END}| --- |
| PM | Alice |`;

			const html = fromMarkdown(corrupted);

			expect(html).toMatch(/<table\b/);
			expect(html).not.toContain("DEL_START");
			expect(html).not.toContain("DEL_END");
			// The orphaned DEL_START must not survive as a <del> swallowing the
			// cell — ProseMirror would auto-close it and the accept-time strip
			// would then delete "Owner" although it was never a real deletion.
			expect(html).not.toMatch(/<del\b[^>]*>[^<]*Owner/);
			// Every emitted del/ins is balanced.
			expect((html.match(/<del\b/g) ?? []).length).toBe(
				(html.match(/<\/del>/g) ?? []).length,
			);
			// Kept content survives the accept-time strip.
			expect(stripDiffTags(html)).toContain("Owner");
		});

		it("keeps markers out of the separator row when a whole block is wrapped", () => {
			// wrapLine fallback: a multi-line ADD region covering prose plus a
			// table is split per line, so the per-line wrapper must never put a
			// marker in front of the leading pipe of a separator row.
			const block = `${ADD_START}Intro sentence.

| Role | Owner |
|------|-------|
| PM | Alice |${ADD_END}`;

			const html = fromMarkdown(block);

			expect(html).toMatch(/<table\b/);
			expect(html).toMatch(/<th>Role<\/th>/);
			expect(html).not.toMatch(/<p>[^<]*\|\s*-{3}/);
			expect(html).not.toContain("ADD_START");
		});
	});
});
