/**
 * Tests for `truncateContent` — HTML strip + truncate used to shrink raw
 * Teams message bodies (a third-party Graph payload) before they reach an
 * LLM prompt.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
	db: {
		workflowIntegration: {
			findFirst: vi.fn(),
			update: vi.fn(),
		},
	},
}));

vi.mock("@repo/utils", () => ({
	decryptApiKey: (v: string) => v,
	encryptApiKey: (v: string) => v,
}));

// `@repo/ai` is reached via static import in `microsoft/index.ts` for the
// excerpt extractor; stub it out to avoid loading the real LLM stack.
vi.mock("@repo/ai", () => ({
	extractRelevantExcerpts: vi.fn(),
}));

import { truncateContent } from "../index";

describe("truncateContent", () => {
	it("strips tags and decodes common entities, then truncates to maxLength", () => {
		const html = "<p>Ship it &amp; go &lt;home&gt;</p>";
		expect(truncateContent(html, 500)).toBe("Ship it & go <home>");
	});

	it("returns empty string for undefined content", () => {
		expect(truncateContent(undefined)).toBe("");
	});

	it("does not re-create markup from a double-escaped body", () => {
		// A sender whose message text literally reads `&lt;script&gt;` arrives
		// from Graph as `&amp;lt;script&amp;gt;`. Decoding `&amp;` before `&lt;`
		// would collapse that back into a real `<script>` tag. js/double-escaping
		const html =
			"<p>&amp;lt;script&amp;gt;alert(1)&amp;lt;/script&amp;gt;</p>";
		expect(truncateContent(html, 500)).toBe(
			"&lt;script&gt;alert(1)&lt;/script&gt;",
		);
	});

	it("appends the truncation marker only when the stripped text exceeds maxLength", () => {
		const short = truncateContent("<p>short</p>", 500);
		expect(short).not.toContain("[truncated]");

		const long = truncateContent(`<p>${"a".repeat(600)}</p>`, 500);
		expect(long.endsWith("... [truncated]")).toBe(true);
		expect(long.startsWith("a".repeat(500))).toBe(true);
	});

	it("only scans a bounded prefix of a pathologically long body (redos bound)", () => {
		// Beyond the 20_000-char bound, the tag-strip regex never sees the rest
		// of the string, so an unclosed tag far out doesn't affect the result —
		// it just never reaches the strip pass at all.
		const filler = "<".repeat(25_000);
		const out = truncateContent(filler, 500);
		expect(out.length).toBeLessThanOrEqual(500 + "... [truncated]".length);
	});
});
