/**
 * Unit tests for the Fabric back-link helpers used by createStory and
 * bulkCreateStories. Pure functions — no DB / Prisma involvement, so
 * vitest can run them in isolation. The integration with createStory is
 * exercised by the staging smoke test (see plan).
 */

import { describe, expect, it } from "vitest";
import {
	appendFabricBackLink,
	formatBackLinkForProvider,
	normalizeBackLinkFromProvider,
} from "../prisma/queries/projects/fabric-url";

describe("appendFabricBackLink", () => {
	const URL = "https://app.fabric.pro/app/acme/projects/p123/stories/s456";
	const ANCHOR = `<p><a href="${URL}">View in Fabric</a></p>`;

	it("emits the HTML anchor for an empty description (no leading separator)", () => {
		expect(appendFabricBackLink("", URL)).toBe(ANCHOR);
	});

	it("emits the HTML anchor when description is null", () => {
		expect(appendFabricBackLink(null, URL)).toBe(ANCHOR);
	});

	it("emits the HTML anchor when description is undefined", () => {
		expect(appendFabricBackLink(undefined, URL)).toBe(ANCHOR);
	});

	it("appends the HTML anchor to plain-text user content with a single newline", () => {
		// Manual Fabric story: empty/plain text → DB stored as plain. Anchor
		// gets appended; user content is NOT transformed.
		const result = appendFabricBackLink("Story body here.", URL);
		expect(result).toBe(`Story body here.\n${ANCHOR}`);
		// Important: user's "Story body here." text survives byte-for-byte.
		expect(result.startsWith("Story body here.")).toBe(true);
	});

	it("appends the HTML anchor to HTML user content", () => {
		// Pulled from ADO: description is HTML. Anchor appended verbatim.
		const html = "<div>line 1</div><div>line 2</div>";
		const result = appendFabricBackLink(html, URL);
		expect(result).toBe(`${html}\n${ANCHOR}`);
		expect(result.startsWith(html)).toBe(true);
	});

	it("appends the HTML anchor to markdown user content (NEVER transforms it)", () => {
		// Edge case: if upstream stored markdown, we still don't touch it.
		// The user's markdown stays markdown; only our anchor is added.
		const md = "# Heading\n\n- item 1\n- item 2";
		const result = appendFabricBackLink(md, URL);
		expect(result).toBe(`${md}\n${ANCHOR}`);
		// Markdown content not converted to HTML — it's the user's content.
		expect(result).toContain("# Heading");
		expect(result).toContain("- item 1");
	});

	it("is idempotent: returns the input unchanged when 'View in Fabric' already appears anywhere", () => {
		const already = `Pre-existing body\n${ANCHOR}`;
		expect(appendFabricBackLink(already, URL)).toBe(already);
	});

	it("idempotency check is substring-based and survives different URL targets", () => {
		// Older record may have a back-link to a different URL (e.g. before
		// we relocated the domain). We still don't double-up.
		const oldUrlBody = `Body\n<p><a href="https://different.example.com/stories/old">View in Fabric</a></p>`;
		expect(appendFabricBackLink(oldUrlBody, URL)).toBe(oldUrlBody);
	});

	it("idempotency works whether the prior link was HTML or markdown form", () => {
		const oldMdForm = `Body\n\n[View in Fabric](${URL})`;
		expect(appendFabricBackLink(oldMdForm, URL)).toBe(oldMdForm);
	});

	it("escapes double quotes in the URL inside the href attribute", () => {
		const evilUrl = `https://example.com/x"onclick="alert(1)`;
		const result = appendFabricBackLink("<p>x</p>", evilUrl);
		// Double quotes inside the href become &quot; — attribute boundary
		// stays intact (defensive — real Fabric URLs don't contain quotes).
		expect(result).toContain(
			'href="https://example.com/x&quot;onclick=&quot;alert(1)"',
		);
	});

	it("preserves arbitrary trailing whitespace / formatting in the input", () => {
		const body = "Body line.\n\n## Section\n\n- item 1\n- item 2";
		const result = appendFabricBackLink(body, URL);
		// The first N bytes equal the input verbatim — no trimming, no
		// reflow, no transformation.
		expect(result.slice(0, body.length)).toBe(body);
		expect(result.endsWith(ANCHOR)).toBe(true);
	});
});

// =============================================================================
// F-1219 — per-provider back-link format split
//
// `appendFabricBackLink` writes an HTML anchor to the DB. Most PM tools
// render HTML; Fizzy stores it verbatim and shows raw `<p><a>…</a></p>` to
// the end user. The two helpers below split the format at the sync site —
// `formatBackLinkForProvider` on push (Fabric → external), and
// `normalizeBackLinkFromProvider` on pull (external → Fabric). Both treat
// every provider except Fizzy as identity, and both never touch any byte
// outside the literal `View in Fabric` anchor span.
// =============================================================================

describe("formatBackLinkForProvider", () => {
	const URL = "https://app.fabric.pro/app/acme/projects/p123/stories/s456";
	const HTML_ANCHOR = `<p><a href="${URL}">View in Fabric</a></p>`;
	const MD_ANCHOR = `[View in Fabric](${URL})`;

	it("returns identity for non-fizzy providers", () => {
		for (const provider of [
			"azure-devops",
			"jira",
			"github",
			"gitlab",
			"linear",
			"manual",
			undefined,
			null,
			"",
		]) {
			expect(
				formatBackLinkForProvider(
					`User body\n${HTML_ANCHOR}`,
					provider,
				),
			).toBe(`User body\n${HTML_ANCHOR}`);
		}
	});

	it("swaps HTML anchor for markdown link when provider is fizzy", () => {
		const input = `User body\n${HTML_ANCHOR}`;
		expect(formatBackLinkForProvider(input, "fizzy")).toBe(
			`User body\n${MD_ANCHOR}`,
		);
	});

	it("provider match is case-insensitive (Fizzy / FIZZY)", () => {
		const input = `body\n${HTML_ANCHOR}`;
		expect(formatBackLinkForProvider(input, "Fizzy")).toBe(
			`body\n${MD_ANCHOR}`,
		);
		expect(formatBackLinkForProvider(input, "FIZZY")).toBe(
			`body\n${MD_ANCHOR}`,
		);
	});

	it("returns identity when no anchor is present (user removed it / never added)", () => {
		expect(formatBackLinkForProvider("plain body", "fizzy")).toBe(
			"plain body",
		);
		expect(formatBackLinkForProvider("", "fizzy")).toBe("");
		expect(formatBackLinkForProvider(null, "fizzy")).toBe("");
		expect(formatBackLinkForProvider(undefined, "fizzy")).toBe("");
	});

	it("is idempotent — re-running on already-markdown form is a no-op", () => {
		const md = `body\n${MD_ANCHOR}`;
		expect(formatBackLinkForProvider(md, "fizzy")).toBe(md);
	});

	it("tolerates single-quoted href, extra attrs, and internal whitespace", () => {
		const variants = [
			`<p><a href='${URL}'>View in Fabric</a></p>`,
			`<p>  <a   href="${URL}"   target="_blank" rel="noopener">  View in Fabric  </a>  </p>`,
			`<p><A href="${URL}">View in Fabric</A></p>`, // case-insensitive tag
		];
		for (const html of variants) {
			expect(formatBackLinkForProvider(`body\n${html}`, "fizzy")).toBe(
				`body\n${MD_ANCHOR}`,
			);
		}
	});

	it("preserves the actual href value (not a hardcoded URL)", () => {
		const altUrl =
			"https://staging.fabric.pro/app/acme/projects/x/stories/y";
		const alt = `<p><a href="${altUrl}">View in Fabric</a></p>`;
		expect(formatBackLinkForProvider(alt, "fizzy")).toBe(
			`[View in Fabric](${altUrl})`,
		);
	});
});

describe("normalizeBackLinkFromProvider", () => {
	const URL = "https://app.fabric.pro/app/acme/projects/p123/stories/s456";
	const HTML_ANCHOR = `<p><a href="${URL}">View in Fabric</a></p>`;
	const MD_ANCHOR = `[View in Fabric](${URL})`;

	it("returns identity for non-fizzy providers", () => {
		for (const provider of [
			"azure-devops",
			"jira",
			"github",
			"gitlab",
			"linear",
			"manual",
			undefined,
			null,
			"",
		]) {
			expect(
				normalizeBackLinkFromProvider(
					`User body\n${MD_ANCHOR}`,
					provider,
				),
			).toBe(`User body\n${MD_ANCHOR}`);
		}
	});

	it("swaps markdown link for HTML anchor when provider is fizzy", () => {
		const input = `User body\n${MD_ANCHOR}`;
		expect(normalizeBackLinkFromProvider(input, "fizzy")).toBe(
			`User body\n${HTML_ANCHOR}`,
		);
	});

	it("returns identity when no markdown anchor is present (already HTML / never added)", () => {
		expect(normalizeBackLinkFromProvider(HTML_ANCHOR, "fizzy")).toBe(
			HTML_ANCHOR,
		);
		expect(normalizeBackLinkFromProvider("plain body", "fizzy")).toBe(
			"plain body",
		);
		expect(normalizeBackLinkFromProvider("", "fizzy")).toBe("");
		expect(normalizeBackLinkFromProvider(null, "fizzy")).toBe("");
	});

	it("escapes double quotes in the URL inside the href (defensive)", () => {
		// Real Fabric URLs are CUIDs and never contain quotes; this test is
		// defensive. Markdown link syntax `[label](url)` does not allow
		// literal `)` inside the URL (matches up to the first `)`), so the
		// stress URL here is `"`-only.
		const evilUrl = `https://example.com/x"onclick="alert`;
		const result = normalizeBackLinkFromProvider(
			`[View in Fabric](${evilUrl})`,
			"fizzy",
		);
		expect(result).toContain(
			'href="https://example.com/x&quot;onclick=&quot;alert"',
		);
	});

	it("round-trip is byte-stable: normalize(format(html, fizzy), fizzy) === html", () => {
		// Alone
		expect(
			normalizeBackLinkFromProvider(
				formatBackLinkForProvider(HTML_ANCHOR, "fizzy"),
				"fizzy",
			),
		).toBe(HTML_ANCHOR);

		// With surrounding user content
		const withBody = `User body that may contain words.\n${HTML_ANCHOR}`;
		expect(
			normalizeBackLinkFromProvider(
				formatBackLinkForProvider(withBody, "fizzy"),
				"fizzy",
			),
		).toBe(withBody);

		// Plain-text body (no anchor) — both transforms are identity, so
		// round-trip is trivially stable.
		expect(
			normalizeBackLinkFromProvider(
				formatBackLinkForProvider("just a description", "fizzy"),
				"fizzy",
			),
		).toBe("just a description");
	});
});

describe("user content invariants — only the View-in-Fabric anchor is ever touched", () => {
	const URL = "https://app.fabric.pro/app/acme/projects/p123/stories/s456";
	const HTML_ANCHOR = `<p><a href="${URL}">View in Fabric</a></p>`;
	const MD_ANCHOR = `[View in Fabric](${URL})`;

	it("formatBackLinkForProvider leaves unrelated <a> tags untouched", () => {
		const userBody =
			'<p>See the <a href="https://docs.example.com">Reference doc</a> for details.</p>';
		const input = `${userBody}\n${HTML_ANCHOR}`;
		const result = formatBackLinkForProvider(input, "fizzy");
		expect(result).toBe(`${userBody}\n${MD_ANCHOR}`);
		// User's anchor survives byte-for-byte.
		expect(result).toContain(
			'<a href="https://docs.example.com">Reference doc</a>',
		);
	});

	it("normalizeBackLinkFromProvider leaves unrelated markdown links untouched", () => {
		const userBody =
			"See the [Spec](https://example.com) and [See ticket](https://tracker.example.com) for details.";
		const input = `${userBody}\n${MD_ANCHOR}`;
		const result = normalizeBackLinkFromProvider(input, "fizzy");
		expect(result).toBe(`${userBody}\n${HTML_ANCHOR}`);
		// User's markdown links survive byte-for-byte.
		expect(result).toContain("[Spec](https://example.com)");
		expect(result).toContain("[See ticket](https://tracker.example.com)");
	});

	it("does not match the plain prose 'view in fabric' (case-sensitive label)", () => {
		// Label literal is case-sensitive; only the wrapping HTML / whitespace
		// is case-insensitive. The user's lowercase phrase is plain prose.
		const userBody =
			"To view in fabric the linked dashboard, click the link below.";
		expect(formatBackLinkForProvider(userBody, "fizzy")).toBe(userBody);
		expect(normalizeBackLinkFromProvider(userBody, "fizzy")).toBe(userBody);
	});

	it("does not transform the literal phrase 'View in Fabric' outside an anchor structure", () => {
		const userBody =
			"The phrase View in Fabric appears here as plain text.";
		expect(formatBackLinkForProvider(userBody, "fizzy")).toBe(userBody);
		expect(normalizeBackLinkFromProvider(userBody, "fizzy")).toBe(userBody);
	});

	it("preserves surrounding Tiptap-emitted nested HTML", () => {
		// Realistic Tiptap output: heading + list + bold around the back-link.
		const richHtml = [
			"<h2>Summary</h2>",
			"<p>Refactor the <strong>billing</strong> module to support multi-tenant.</p>",
			"<ul><li>Spec link</li><li>Owner: Alex</li></ul>",
			HTML_ANCHOR,
		].join("\n");
		const result = formatBackLinkForProvider(richHtml, "fizzy");
		const expected = [
			"<h2>Summary</h2>",
			"<p>Refactor the <strong>billing</strong> module to support multi-tenant.</p>",
			"<ul><li>Spec link</li><li>Owner: Alex</li></ul>",
			MD_ANCHOR,
		].join("\n");
		expect(result).toBe(expected);
		// Each surrounding block survives byte-for-byte.
		expect(result).toContain("<h2>Summary</h2>");
		expect(result).toContain(
			"<p>Refactor the <strong>billing</strong> module to support multi-tenant.</p>",
		);
		expect(result).toContain(
			"<ul><li>Spec link</li><li>Owner: Alex</li></ul>",
		);
	});
});
