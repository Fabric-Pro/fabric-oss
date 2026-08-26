/**
 * Unit tests for buildCopyLinkPayload.
 *
 * These tests exercise all acceptance criteria that are expressible as pure
 * data transformations (AC-1 through AC-4), with no DOM or clipboard
 * involvement.
 */

import { describe, expect, it } from "vitest";
import { buildCopyLinkPayload } from "../../../lib/story-copy-link";

const URL = "https://app.fabric.ai/app/acme/projects/proj_1/stories/story_abc";

describe("buildCopyLinkPayload", () => {
	// ── AC-1: Feature with identifier ──────────────────────────────────────
	describe("AC-1: identifier present", () => {
		it("uses 'F-001 Title' as the label", () => {
			const { label } = buildCopyLinkPayload(
				"F-001",
				"Feature Title",
				URL,
			);
			expect(label).toBe("F-001 Feature Title");
		});

		it("sets the anchor text to the full label", () => {
			const { htmlContent } = buildCopyLinkPayload(
				"F-001",
				"Feature Title",
				URL,
			);
			expect(htmlContent).toContain(">F-001 Feature Title<");
		});

		it("sets the href to the url", () => {
			const { htmlContent } = buildCopyLinkPayload(
				"F-001",
				"Feature Title",
				URL,
			);
			expect(htmlContent).toContain(`href="${URL}"`);
		});

		it("formats the plain-text fallback as 'label — url'", () => {
			const { textContent } = buildCopyLinkPayload(
				"F-001",
				"Feature Title",
				URL,
			);
			expect(textContent).toBe(`F-001 Feature Title — ${URL}`);
		});

		it("produces a well-formed anchor tag", () => {
			const { htmlContent } = buildCopyLinkPayload("F-001", "Title", URL);
			expect(htmlContent).toMatch(/^<a href="[^"]+">.*<\/a>$/);
		});
	});

	// ── AC-2: No identifier (non-feature work item) ─────────────────────────
	describe("AC-2: identifier is null", () => {
		it("uses only the title as the label", () => {
			const { label } = buildCopyLinkPayload(
				null,
				"My Document Title",
				URL,
			);
			expect(label).toBe("My Document Title");
		});

		it("formats the plain-text fallback without an identifier prefix", () => {
			const { textContent } = buildCopyLinkPayload(
				null,
				"My Document Title",
				URL,
			);
			expect(textContent).toBe(`My Document Title — ${URL}`);
		});

		it("uses title as anchor text when identifier is undefined", () => {
			const { htmlContent } = buildCopyLinkPayload(
				undefined,
				"My Document Title",
				URL,
			);
			expect(htmlContent).toContain(">My Document Title<");
		});
	});

	// ── AC-3: Newly created feature — identifier is empty string ────────────
	describe("AC-3: identifier is empty string", () => {
		it("falls back to title-only label", () => {
			const { label } = buildCopyLinkPayload("", "New Feature", URL);
			expect(label).toBe("New Feature");
		});

		it("does not produce a leading space in the label", () => {
			const { label } = buildCopyLinkPayload("", "New Feature", URL);
			expect(label).not.toMatch(/^ /);
		});
	});

	// ── AC-4: HTML special characters ───────────────────────────────────────
	describe("AC-4: HTML special characters in title", () => {
		it("escapes & in the anchor text", () => {
			const { htmlContent } = buildCopyLinkPayload("F-001", "A & B", URL);
			expect(htmlContent).toContain("A &amp; B");
			expect(htmlContent).not.toContain("A & B");
		});

		it("escapes < in the anchor text", () => {
			const { htmlContent } = buildCopyLinkPayload("F-001", "A < B", URL);
			expect(htmlContent).toContain("A &lt; B");
		});

		it("escapes > in the anchor text", () => {
			const { htmlContent } = buildCopyLinkPayload("F-001", "A > B", URL);
			expect(htmlContent).toContain("A &gt; B");
		});

		it('escapes " in the anchor text', () => {
			const { htmlContent } = buildCopyLinkPayload(
				"F-001",
				'Say "hello"',
				URL,
			);
			expect(htmlContent).toContain("Say &quot;hello&quot;");
		});

		it("does NOT escape characters in the plain-text payload", () => {
			const { textContent } = buildCopyLinkPayload(
				"F-001",
				'A < B & C > D "E"',
				URL,
			);
			expect(textContent).toContain('A < B & C > D "E"');
		});

		it("escapes & in the URL when it appears in the href", () => {
			const urlWithQuery = "https://app.fabric.ai/app/projects/p?a=1&b=2";
			const { htmlContent } = buildCopyLinkPayload(
				"F-001",
				"T",
				urlWithQuery,
			);
			expect(htmlContent).toContain("a=1&amp;b=2");
		});

		it("escapes all four special characters in a single title", () => {
			const nasty = `<script>alert("x & y")</script>`;
			const { htmlContent } = buildCopyLinkPayload("F-001", nasty, URL);
			expect(htmlContent).not.toContain("<script>");
			expect(htmlContent).toContain(
				"&lt;script&gt;alert(&quot;x &amp; y&quot;)&lt;/script&gt;",
			);
		});
	});
});
