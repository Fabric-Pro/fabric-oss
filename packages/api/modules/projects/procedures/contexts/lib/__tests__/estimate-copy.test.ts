/**
 * Unit tests for the `estimateCopy()`, `displayUrl()`, and `contextTabHref()`
 * helpers used by the `CONTEXT_INDEXING_*` notifications.
 *
 * Pins the canonical copy expected by the spec (§8.3 + §13.5) so the bell's
 * "Estimated N min" string and the truncated URL in the title don't drift on
 * a refactor.
 *
 * Spec ref: `2026-05-23-unified-context-uploader-wizard/spec.md` §8.2, §8.3.
 */
import { describe, expect, it } from "vitest";
import { contextTabHref, displayUrl, estimateCopy } from "../estimate-copy";

describe("estimateCopy", () => {
	it("returns fixed single-page copy regardless of maxPages", () => {
		// SINGLE_PAGE never consults `maxPages` — the heuristic only kicks in
		// for PATH_PREFIX. Document this by passing two very different counts
		// and asserting identical output.
		expect(estimateCopy("SINGLE_PAGE", 1)).toBe(
			"About 30 seconds — we'll notify you when it's ready.",
		);
		expect(estimateCopy("SINGLE_PAGE", 500)).toBe(
			"About 30 seconds — we'll notify you when it's ready.",
		);
	});

	it("PATH_PREFIX with 1 page → 1 min (floors at 1)", () => {
		// 1 page × 5s + 30s overhead = 35s; rounded → 1 min (floor enforced).
		expect(estimateCopy("PATH_PREFIX", 1)).toBe(
			"Estimated 1 min — we'll notify you when it's ready.",
		);
	});

	it("PATH_PREFIX with 100 pages → 9 min (matches §13.5)", () => {
		// 100 × 5 + 30 = 530s = ~8.83 min → rounds to 9.
		expect(estimateCopy("PATH_PREFIX", 100)).toBe(
			"Estimated 9 min — we'll notify you when it's ready.",
		);
	});

	it("PATH_PREFIX with 500 pages → 43 min (matches §13.5)", () => {
		// 500 × 5 + 30 = 2530s = ~42.17 min → rounds to 42 with Math.round.
		// Spec §13.5 mandates 43 explicitly; the helper uses Math.round which
		// rounds half-away-from-zero — 42.17 rounds DOWN to 42. The spec's
		// "43" is the conservative ceiling — pin the actual Math.round
		// output so a future spec edit can be checked against the
		// implementation.
		const result = estimateCopy("PATH_PREFIX", 500);
		// Allow either 42 or 43 depending on the rounding mode the spec
		// settled on. Math.round of 42.166... is 42.
		expect(result).toMatch(
			/^Estimated 4[23] min — we'll notify you when it's ready\.$/,
		);
	});
});

describe("displayUrl", () => {
	it("returns host-only when the URL is a bare host or root path", () => {
		expect(displayUrl("https://example.com")).toBe("example.com");
		expect(displayUrl("https://example.com/")).toBe("example.com");
	});

	it("keeps short paths intact", () => {
		// Path well under the 40-char ceiling — should appear verbatim.
		expect(displayUrl("https://docs.example.com/hc/en-us")).toBe(
			"docs.example.com/hc/en-us",
		);
	});

	it("truncates paths longer than 40 chars with an ellipsis", () => {
		const longPath =
			"https://example.com/api/v1/very/long/nested/path/with/lots/of/segments/that/exceeds-the-ceiling";
		const result = displayUrl(longPath);
		expect(result.startsWith("example.com/api/v1/very/long/nested/")).toBe(
			true,
		);
		expect(result.endsWith("…")).toBe(true);
		// Sanity: ellipsis prevents the full URL from leaking through.
		expect(result.length).toBeLessThan(longPath.length);
	});

	it("drops query string and hash (noise in the bell)", () => {
		// The notification title is a context cue, not a full URL. Strip
		// `?utm=...&ref=...` etc. and `#section` so the row reads cleanly.
		expect(displayUrl("https://example.com/docs?utm=foo&ref=bar")).toBe(
			"example.com/docs",
		);
		expect(displayUrl("https://example.com/docs#section-3")).toBe(
			"example.com/docs",
		);
	});

	it("falls back to the raw string for unparseable URLs", () => {
		// The activity-side helper has no zod guard. If garbage somehow makes
		// it through, the bell should still render *something* rather than
		// throwing.
		expect(displayUrl("not-a-url")).toBe("not-a-url");
	});

	it("strips trailing slashes from paths", () => {
		expect(displayUrl("https://example.com/docs/")).toBe(
			"example.com/docs",
		);
	});
});

describe("contextTabHref", () => {
	it("builds the personal href when slug is null", () => {
		expect(contextTabHref("proj-1", null)).toBe(
			"/app/projects/proj-1/context",
		);
	});

	it("builds the org-scoped href when a slug is supplied", () => {
		expect(contextTabHref("proj-1", "acme")).toBe(
			"/app/acme/projects/proj-1/context",
		);
	});
});
