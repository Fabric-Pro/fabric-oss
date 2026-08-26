/**
 * Tests for the Document Save/Load Flow
 *
 * This test suite verifies the complete round-trip:
 * 1. AI generates markdown with GFM tables
 * 2. fromMarkdown converts to HTML for TipTap
 * 3. getTurndown converts HTML back to markdown for saving
 * 4. The saved markdown should still have proper GFM tables
 *
 * This ensures tables aren't lost during the editing cycle.
 */

import { describe, expect, it } from "vitest";
import { fromMarkdown } from "../diff-utils";
import { createTurndownService } from "../editor-markdown-save";
import {
	excalidrawAwareBlankReplacement,
	stripDiffTags,
} from "../editor-save-utils";

// Mirror the production save path (HTML → markdown) using the shared serializer
// so this test exercises the real `createTurndownService` instead of a private
// copy that could drift from it.
function simulateEditorSave(html: string): string {
	const sanitized = stripDiffTags(html);
	return createTurndownService().turndown(sanitized);
}

describe("Save/Load Flow - Table Preservation", () => {
	describe("basic table round-trip", () => {
		it("should preserve a simple table through save/load cycle", () => {
			const originalMarkdown = `## Features

| Feature | Status |
|---------|--------|
| Login | Done |
| Dashboard | WIP |

End of document.`;

			// Step 1: Load into editor (markdown -> HTML)
			const html = fromMarkdown(originalMarkdown);

			// Verify HTML has table
			expect(html).toContain("<table>");
			expect(html).toContain("<th>");
			expect(html).toContain("<td>");
			expect(html).toContain("Login");
			expect(html).toContain("Done");

			// Step 2: Save from editor (HTML -> markdown)
			const savedMarkdown = simulateEditorSave(html);

			// Verify saved markdown has GFM table
			expect(savedMarkdown).toContain("| Feature | Status |");
			expect(savedMarkdown).toContain("|");
			expect(savedMarkdown).toContain("---");
			expect(savedMarkdown).toContain("Login");
			expect(savedMarkdown).toContain("Done");
			expect(savedMarkdown).toContain("Dashboard");
			expect(savedMarkdown).toContain("WIP");
		});

		it("should preserve table with multiple columns", () => {
			const originalMarkdown = `| Feature | Description | Priority | Status |
|---------|-------------|----------|--------|
| SSO | Google sign-in | High | Done |
| JWT | Token auth | High | WIP |
| RBAC | Role-based access | Medium | Planned |`;

			const html = fromMarkdown(originalMarkdown);
			const savedMarkdown = simulateEditorSave(html);

			// All columns should be preserved
			expect(savedMarkdown).toContain("Feature");
			expect(savedMarkdown).toContain("Description");
			expect(savedMarkdown).toContain("Priority");
			expect(savedMarkdown).toContain("Status");
			expect(savedMarkdown).toContain("SSO");
			expect(savedMarkdown).toContain("RBAC");
			// Table structure should be preserved
			expect(savedMarkdown).toMatch(/\|[^|]+\|[^|]+\|[^|]+\|[^|]+\|/);
		});
	});

	describe("AI-generated document round-trip", () => {
		it("should preserve tables in full PRD document", () => {
			// Simplified version of actual AI output
			const originalMarkdown = `## Executive Summary

This PRD defines the BuildTrack Construction Management System.

## Functional Requirements

### Feature: User Authentication

| Feature | Description | Priority |
|---------|-------------|----------|
| SSO with Google | OAuth 2.0 integration | High |
| JWT tokens | Token-based API access | High |
| MFA | Multi-factor auth | Medium |

### Feature: Project Management

| Capability | Status |
|------------|--------|
| Task creation | Done |
| Gantt charts | WIP |

## Non-Functional Requirements

| Area | Requirement |
|------|-------------|
| Performance | Load time < 2s |
| Security | TLS 1.3 |

## Milestones

| Milestone | Date |
|-----------|------|
| Alpha | 2026-03-01 |
| Beta | 2026-04-01 |
| GA | 2026-05-01 |`;

			const html = fromMarkdown(originalMarkdown);
			const savedMarkdown = simulateEditorSave(html);

			// Count tables - should have 4
			const tableMatches = savedMarkdown.match(/\| --- \|/g) || [];
			expect(tableMatches.length).toBeGreaterThanOrEqual(4);

			// Verify specific content from each table
			expect(savedMarkdown).toContain("SSO with Google");
			expect(savedMarkdown).toContain("OAuth 2.0");
			expect(savedMarkdown).toContain("Gantt charts");
			expect(savedMarkdown).toContain("Performance");
			expect(savedMarkdown).toContain("Load time");
			expect(savedMarkdown).toContain("Alpha");
			expect(savedMarkdown).toContain("2026-03-01");
		});

		it("should handle table with special characters", () => {
			const originalMarkdown = `| Area | Requirement |
|------|-------------|
| API Rate Limiting | 1000 req/min |
| Encryption | AES-256 at rest; TLS 1.3 in transit |
| OAuth 2.0 / JWT | Token expiry: 15 minutes |`;

			const html = fromMarkdown(originalMarkdown);
			const savedMarkdown = simulateEditorSave(html);

			expect(savedMarkdown).toContain("1000 req/min");
			expect(savedMarkdown).toContain("AES-256");
			expect(savedMarkdown).toContain("TLS 1.3");
			expect(savedMarkdown).toContain("OAuth 2.0");
			expect(savedMarkdown).toContain("15 minutes");
		});
	});

	describe("multiple save/load cycles", () => {
		it("should preserve table through multiple cycles", () => {
			const originalMarkdown = `| A | B | C |
|---|---|---|
| 1 | 2 | 3 |
| 4 | 5 | 6 |`;

			// Cycle 1
			let html = fromMarkdown(originalMarkdown);
			let markdown = simulateEditorSave(html);

			// Cycle 2
			html = fromMarkdown(markdown);
			markdown = simulateEditorSave(html);

			// Cycle 3
			html = fromMarkdown(markdown);
			markdown = simulateEditorSave(html);

			// After 3 cycles, table should still be intact
			expect(markdown).toContain("| A | B | C |");
			expect(markdown).toContain("| 1 | 2 | 3 |");
			expect(markdown).toContain("| 4 | 5 | 6 |");
			expect(markdown).toMatch(/\| --- \| --- \| --- \|/);
		});
	});

	describe("edge cases", () => {
		it("should handle empty document", () => {
			const html = fromMarkdown("");
			const markdown = simulateEditorSave(html);
			expect(markdown).toBe("");
		});

		it("should handle document with only text (no tables)", () => {
			const originalMarkdown = `## Heading

Just some regular text without any tables.

More paragraphs here.`;

			const html = fromMarkdown(originalMarkdown);
			const savedMarkdown = simulateEditorSave(html);

			expect(savedMarkdown).toContain("Heading");
			expect(savedMarkdown).toContain("regular text");
			expect(savedMarkdown).not.toContain("<table>");
		});

		it("should preserve code blocks alongside tables", () => {
			const originalMarkdown = `## API Reference

| Endpoint | Method |
|----------|--------|
| /api/users | GET |
| /api/login | POST |

Example request:

\`\`\`javascript
fetch('/api/users')
  .then(res => res.json())
\`\`\``;

			const html = fromMarkdown(originalMarkdown);
			const savedMarkdown = simulateEditorSave(html);

			// Table preserved
			expect(savedMarkdown).toContain("Endpoint");
			expect(savedMarkdown).toContain("/api/users");
			expect(savedMarkdown).toContain("GET");

			// Code block preserved
			expect(savedMarkdown).toContain("```");
			expect(savedMarkdown).toContain("fetch");
		});
	});

	// Regression coverage for the single-tilde strikethrough bug.
	// turndown-plugin-gfm@1.0.2 serialized <del>/<s>/<strike> as `~X~` (single
	// tilde), which is NOT valid GFM. Our getTurndown() override fixes this by
	// dropping class-tagged diff deletions (<del class="diff-del">) entirely
	// and serializing bare <del>/<s>/<strike> as `~~...~~` so pasted user
	// strikethrough round-trips correctly.
	describe("strikethrough serialization (turndown-plugin-gfm tilde fix)", () => {
		it("drops <del class='diff-del'> tags that leak past stripDiffTags instead of emitting literal tildes", () => {
			const html =
				'<p>teams <del class="diff-del">and</del>, product managers, and engineers</p>';
			// Bypass stripDiffTags to prove the turndown layer is also safe.
			const markdown = createTurndownService().turndown(html);

			expect(markdown).not.toContain("~and~");
			expect(markdown).toContain("teams");
			expect(markdown).toContain("product managers");
			// Diff-del content is dropped entirely.
			expect(markdown).not.toContain("and,");
			expect(markdown).toContain(", product managers");
		});

		it("preserves pasted bare <del> as user strikethrough (valid GFM ~~...~~)", () => {
			// Pasted HTML from Google Docs / GitHub may use bare <del> for
			// strikethrough. These must round-trip as `~~...~~`, NOT be
			// dropped and NOT be wrapped in a single tilde.
			const html =
				"<p>Keep <del>pasted strike</del> intact for round-trip.</p>";
			const markdown = createTurndownService().turndown(html);

			expect(markdown).toContain("~~pasted strike~~");
			expect(markdown).not.toMatch(/(?<!~)~pasted strike~(?!~)/);
			expect(markdown).toContain("Keep");
			expect(markdown).toContain("intact");
		});

		it("serializes user-authored <s> strikethrough as valid GFM double-tilde", () => {
			const html = "<p>Keep <s>deprecated</s> this text.</p>";
			const markdown = createTurndownService().turndown(html);

			// Must use double tilde (valid GFM), not the buggy plugin's single.
			expect(markdown).toContain("~~deprecated~~");
			// And must not use a LONE single-tilde wrapper (would be invalid
			// GFM that round-trips as literal text).
			expect(markdown).not.toMatch(/(?<!~)~deprecated~(?!~)/);
		});

		it('does not wrap quoted words in `~"~"` when deleted content contains quotes', () => {
			// Exact reproduction of the screenshot: deleted content wraps
			// quoted words; the bug made them render as `~"~"Nexus~"~"`.
			const html =
				'<p>manage <del class="diff-del">"Nexus"</del> and <del class="diff-del">"Orchestrator"</del></p>';
			const markdown = createTurndownService().turndown(html);

			expect(markdown).not.toContain('~"~"');
			expect(markdown).not.toContain('~"Nexus"~');
			// Diff-del content is dropped entirely, leaving clean prose.
			expect(markdown).toContain("manage");
			expect(markdown).toContain("and");
		});

		it("round-trips <s> strikethrough through multiple save/load cycles", () => {
			const originalMarkdown = "Keep ~~deprecated~~ this text.";

			// Cycle 1
			let html = fromMarkdown(originalMarkdown);
			let markdown = simulateEditorSave(html);
			expect(markdown).toContain("~~deprecated~~");

			// Cycle 2 — must still be valid GFM
			html = fromMarkdown(markdown);
			markdown = simulateEditorSave(html);
			expect(markdown).toContain("~~deprecated~~");
			expect(markdown).not.toMatch(/(?<!~)~deprecated~(?!~)/);
		});
	});
});

describe("Save/Load Flow - Excalidraw embed preservation", () => {
	// Regression guard. An accepted Excalidraw diagram used to vanish from the
	// document on save: the `<excalidraw-embed>` node is atomic with no text,
	// so Turndown classified it as "blank" and dropped it before any addRule
	// could fire — only the surrounding prose persisted. The fix overrides
	// Turndown's blankReplacement (excalidrawAwareBlankReplacement) to emit the
	// tag verbatim. These tests pin both the save pass and the full round-trip.
	const EMBED =
		'<excalidraw-embed data-resource-uri="ui://excalidraw/abc" data-config-id="cfg_1" data-checkpoint-id="chk_1" data-organization-id="org_1"></excalidraw-embed>';

	it("preserves the embed tag and all data attrs through SAVE (HTML→markdown)", () => {
		const html = `<h2>Login Flow</h2><p>The diagram below shows it.</p>${EMBED}<p>More text.</p>`;
		const markdown = simulateEditorSave(html);
		expect(markdown).toContain("<excalidraw-embed");
		expect(markdown).toContain('data-config-id="cfg_1"');
		expect(markdown).toContain('data-checkpoint-id="chk_1"');
		expect(markdown).toContain('data-organization-id="org_1"');
		// Surrounding prose must survive alongside the embed.
		expect(markdown).toContain("Login Flow");
		expect(markdown).toContain("The diagram below shows it.");
		expect(markdown).toContain("More text.");
	});

	it("survives a full markdown→HTML→markdown round-trip (load + save)", () => {
		const originalMarkdown = `## Login Flow\n\nThe diagram below shows it.\n\n${EMBED}\n\nMore text.`;
		// Load: markdown -> HTML for the editor.
		const html = fromMarkdown(originalMarkdown);
		expect(html).toContain("<excalidraw-embed");
		expect(html).toContain('data-config-id="cfg_1"');
		// Save: HTML -> markdown.
		const savedMarkdown = simulateEditorSave(html);
		expect(savedMarkdown).toContain("<excalidraw-embed");
		expect(savedMarkdown).toContain('data-config-id="cfg_1"');
		expect(savedMarkdown).toContain('data-checkpoint-id="chk_1"');
	});

	it("does NOT drop the embed even when it is the only block content", () => {
		const markdown = simulateEditorSave(EMBED);
		expect(markdown).toContain("<excalidraw-embed");
		expect(markdown).toContain('data-checkpoint-id="chk_1"');
	});
});

describe("excalidrawAwareBlankReplacement (unit)", () => {
	it("returns the outerHTML for an excalidraw-embed node", () => {
		const node = {
			nodeName: "EXCALIDRAW-EMBED",
			outerHTML:
				'<excalidraw-embed data-config-id="c"></excalidraw-embed>',
			isBlock: true,
		} as unknown as Node;
		expect(excalidrawAwareBlankReplacement("", node)).toContain(
			'<excalidraw-embed data-config-id="c">',
		);
	});

	it("digs the embed out of a blank wrapper paragraph", () => {
		const embedEl = {
			outerHTML:
				'<excalidraw-embed data-checkpoint-id="k"></excalidraw-embed>',
		};
		const wrapper = {
			nodeName: "P",
			isBlock: true,
			querySelectorAll: (s: string) =>
				s === "excalidraw-embed" ? [embedEl] : [],
		} as unknown as Node;
		expect(excalidrawAwareBlankReplacement("", wrapper)).toContain(
			'data-checkpoint-id="k"',
		);
	});

	it("falls back to Turndown's default for other blank block nodes", () => {
		const blockNode = {
			nodeName: "DIV",
			isBlock: true,
			querySelectorAll: () => [],
		} as unknown as Node;
		expect(excalidrawAwareBlankReplacement("", blockNode)).toBe("\n\n");
	});

	it("falls back to empty string for blank inline nodes", () => {
		const inlineNode = {
			nodeName: "SPAN",
			isBlock: false,
		} as unknown as Node;
		expect(excalidrawAwareBlankReplacement("", inlineNode)).toBe("");
	});
});
