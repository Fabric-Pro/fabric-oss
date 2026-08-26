import { describe, expect, it } from "vitest";
import { normalizeReportHtmlToLight } from "../src/workflows/template-instance-execution";

describe("normalizeReportHtmlToLight", () => {
	it("removes a dark block that follows a light :root, leaving the light :root untouched", () => {
		const input = `<!DOCTYPE html>
<html>
<head>
  <meta name="color-scheme" content="light">
  <style>
    :root {
      --bg-primary: #fafaf9;
      --text-primary: #1c1917;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg-primary: #18181b;
        --text-primary: #fafaf9;
      }
    }
    body { background: var(--bg-primary); color: var(--text-primary); }
  </style>
</head>
<body><h1>Report</h1></body>
</html>`;

		const result = normalizeReportHtmlToLight(input);

		// Dark trigger is gone.
		expect(result).not.toContain("prefers-color-scheme: dark");
		expect(result).not.toContain("#18181b");
		// The light :root tokens are preserved.
		expect(result).toContain("--bg-primary: #fafaf9;");
		expect(result).toContain("--text-primary: #1c1917;");
		// The CSS that followed the dark block is preserved.
		expect(result).toContain(
			"body { background: var(--bg-primary); color: var(--text-primary); }",
		);
	});

	it("removes a dark block with nested rules via balanced braces — no stray brace, no eaten light rule", () => {
		const input = `<!DOCTYPE html>
<head><meta name="color-scheme" content="light"></head>
<style>
.card { background: #ffffff; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #18181b; }
  .card { background: #1c1c1e; }
  .badge { color: #fafaf9; }
}
.footer { color: #57534e; }
</style>`;

		const result = normalizeReportHtmlToLight(input);

		// Entire dark block (including all nested rules) is removed.
		expect(result).not.toContain("prefers-color-scheme: dark");
		expect(result).not.toContain("#18181b");
		expect(result).not.toContain("#1c1c1e");
		// Surrounding light rules — both before and after the block — survive.
		expect(result).toContain(".card { background: #ffffff; }");
		expect(result).toContain(".footer { color: #57534e; }");
		// No unbalanced brace was left behind: braces must balance.
		const open = (result.match(/\{/g) ?? []).length;
		const close = (result.match(/\}/g) ?? []).length;
		expect(open).toBe(close);
	});

	it("removes multiple dark blocks (e.g. token override + logo swap)", () => {
		const input = `<head><meta name="color-scheme" content="light"></head>
<style>
.logo-dark { display: none; }
@media (prefers-color-scheme: dark) {
  .logo-light { display: none; }
  .logo-dark { display: block; }
}
:root { --bg: #fafaf9; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #18181b; }
}
.body { color: #1c1917; }
</style>`;

		const result = normalizeReportHtmlToLight(input);

		expect(result).not.toContain("prefers-color-scheme: dark");
		expect(result).not.toContain("#18181b");
		expect(result).not.toContain("display: block;");
		// Non-dark rules are preserved.
		expect(result).toContain(".logo-dark { display: none; }");
		expect(result).toContain(":root { --bg: #fafaf9; }");
		expect(result).toContain(".body { color: #1c1917; }");
	});

	it("tolerates irregular whitespace inside the media query prelude", () => {
		const input = `<head><meta name="color-scheme" content="light"></head>
<style>
.a { color: #000; }
@media   (  prefers-color-scheme : dark  )  {
  .a { color: #fff; }
}
.b { color: #111; }
</style>`;

		const result = normalizeReportHtmlToLight(input);

		expect(result).not.toMatch(/prefers-color-scheme/i);
		expect(result).toContain(".a { color: #000; }");
		expect(result).toContain(".b { color: #111; }");
	});

	it("is idempotent and preserves already light-only input with a color-scheme signal", () => {
		const input = `<!DOCTYPE html>
<html>
<head>
  <meta name="color-scheme" content="light">
  <style>
    :root { --bg-primary: #fafaf9; --text-primary: #1c1917; }
    body { background: var(--bg-primary); }
  </style>
</head>
<body><h1>Report</h1></body>
</html>`;

		const once = normalizeReportHtmlToLight(input);
		const twice = normalizeReportHtmlToLight(once);

		// Already light-only with a color-scheme signal → unchanged.
		expect(once).toBe(input);
		// Running twice equals running once.
		expect(twice).toBe(once);
	});

	it("injects the color-scheme meta exactly once when missing, and does not re-inject on re-run", () => {
		const input = `<!DOCTYPE html>
<html>
<head>
  <title>Report</title>
  <style>
    :root { --bg-primary: #fafaf9; }
    @media (prefers-color-scheme: dark) {
      :root { --bg-primary: #18181b; }
    }
  </style>
</head>
<body></body>
</html>`;

		const once = normalizeReportHtmlToLight(input);
		const twice = normalizeReportHtmlToLight(once);

		// A color-scheme=light meta is now present.
		expect(once).toMatch(/<meta\s+name="color-scheme"\s+content="light">/i);
		// Dark block removed.
		expect(once).not.toContain("prefers-color-scheme: dark");
		// Injected exactly once.
		const metaCount = (
			once.match(/name="color-scheme"\s+content="light"/gi) ?? []
		).length;
		expect(metaCount).toBe(1);
		// Re-running does not inject a second meta.
		expect(twice).toBe(once);
	});

	it("does not inject a meta when a color-scheme: light CSS declaration already exists", () => {
		const input = `<!DOCTYPE html>
<html>
<head>
  <style>
    :root { color-scheme: light; --bg-primary: #fafaf9; }
    @media (prefers-color-scheme: dark) {
      :root { --bg-primary: #18181b; }
    }
  </style>
</head>
<body></body>
</html>`;

		const result = normalizeReportHtmlToLight(input);

		// The CSS color-scheme signal counts — no meta should be added.
		expect(result).not.toContain('<meta name="color-scheme"');
		// Dark block still removed.
		expect(result).not.toContain("prefers-color-scheme: dark");
		// Light declaration preserved.
		expect(result).toContain("color-scheme: light;");
	});

	it("leaves non-report input (plain wrapped markdown, no dark block) unchanged", () => {
		// Mirrors the shape of wrapInHtml() output: a light-only document with a
		// <head> but no color-scheme signal and no dark media query.
		const input = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Weekly Report</title>
  <style>
    body { font-family: system-ui, sans-serif; color: #1a1a1a; background: #fff; }
    h1 { color: #111; }
  </style>
</head>
<body>
<h1>Weekly Report</h1>
<p>Some markdown-derived content.</p>
</body>
</html>`;

		const result = normalizeReportHtmlToLight(input);

		// No dark block to strip, so content is preserved verbatim aside from the
		// injected color-scheme meta (which is the only mutation for such input).
		expect(result).toContain('<meta name="color-scheme" content="light">');
		expect(result).toContain("<h1>Weekly Report</h1>");
		expect(result).toContain("<p>Some markdown-derived content.</p>");
		expect(result).toContain(
			"body { font-family: system-ui, sans-serif; color: #1a1a1a; background: #fff; }",
		);
		// Idempotent for this input too.
		expect(normalizeReportHtmlToLight(result)).toBe(result);
	});

	it("is a safe no-op for a fragment with no <head> and no dark block", () => {
		const input = "<section><h2>Status</h2><p>On track.</p></section>";
		const result = normalizeReportHtmlToLight(input);
		expect(result).toBe(input);
	});

	it("strips a dark block even from a fragment without a <head> (no meta injected)", () => {
		const input = `<style>
.x { color: #000; }
@media (prefers-color-scheme: dark) {
  .x { color: #fff; }
}
.y { color: #111; }
</style>`;

		const result = normalizeReportHtmlToLight(input);

		expect(result).not.toContain("prefers-color-scheme: dark");
		expect(result).toContain(".x { color: #000; }");
		expect(result).toContain(".y { color: #111; }");
		// No <head> → no meta injected.
		expect(result).not.toContain("<meta");
	});

	it("returns empty input unchanged", () => {
		expect(normalizeReportHtmlToLight("")).toBe("");
	});
});
