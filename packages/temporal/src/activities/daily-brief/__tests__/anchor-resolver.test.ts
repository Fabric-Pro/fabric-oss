import { describe, expect, it } from "vitest";
import { attachAnchor, resolveQuoteAnchor } from "../anchor-resolver";

const CONTENT = [
	"# Sprint Review", // line 1
	"", // line 2
	"Avery Diaz: welcome everyone, let's get started.", // line 3
	"Alice Anderson: about the ingestion pipeline — we decided to keep VTT parsing.", // line 4
	"Bob Brennan: I'll take the anchor links story, done by Friday.", // line 5
].join("\n");

describe("resolveQuoteAnchor", () => {
	it("resolves an exact substring to its 1-based line", () => {
		expect(
			resolveQuoteAnchor(CONTENT, "we decided to keep VTT parsing"),
		).toBe(4);
	});

	it("resolves with case/whitespace/punctuation drift (normalized fallback)", () => {
		expect(
			resolveQuoteAnchor(CONTENT, "We decided,  to keep   VTT parsing!"),
		).toBe(4);
	});

	it("returns the first match when the quote appears twice", () => {
		const dup = `${CONTENT}\nBob: we decided to keep VTT parsing.`;
		expect(resolveQuoteAnchor(dup, "we decided to keep VTT parsing")).toBe(
			4,
		);
	});

	it("returns null when the quote is not in the content", () => {
		expect(resolveQuoteAnchor(CONTENT, "we chose Postgres")).toBeNull();
	});

	it("returns null for empty or too-short quotes", () => {
		expect(resolveQuoteAnchor(CONTENT, "")).toBeNull();
		expect(resolveQuoteAnchor(CONTENT, "we")).toBeNull();
	});

	it("returns null for empty content", () => {
		expect(resolveQuoteAnchor("", "we decided")).toBeNull();
	});

	it("handles non-ASCII letters via unicode normalization", () => {
		const ru = "Алексей: якорные ссылки готовы к релизу в пятницу";
		expect(resolveQuoteAnchor(ru, "якорные ссылки готовы")).toBe(1);
	});
});

describe("attachAnchor", () => {
	const item = { text: "Keep VTT parsing" };

	it("adds sourceQuote and anchorLine on a match", () => {
		expect(
			attachAnchor(item, "we decided to keep VTT parsing", CONTENT),
		).toEqual({
			text: "Keep VTT parsing",
			sourceQuote: "we decided to keep VTT parsing",
			anchorLine: 4,
		});
	});

	it("returns the item unchanged when the quote does not match", () => {
		expect(attachAnchor(item, "we chose Postgres", CONTENT)).toEqual(item);
	});

	it("returns the item unchanged when content is null (fallback-source guard)", () => {
		expect(
			attachAnchor(item, "we decided to keep VTT parsing", null),
		).toEqual(item);
	});

	it("returns the item unchanged when sourceQuote is undefined", () => {
		expect(attachAnchor(item, undefined, CONTENT)).toEqual(item);
	});
});

describe("resolveQuoteAnchor — normalized offsets index the original string", () => {
	// Regression for the offset-mapping bug: offsets were recorded against the
	// toLowerCase() string but used to index the original. A char whose
	// lowercase form differs in length (İ → i̇, two code units) shifted every
	// later offset, so the normalized-fallback path could resolve to the wrong
	// line. Offsets must reference the original string.
	it("resolves a punctuation-drifted match on a line after a length-changing lowercase char", () => {
		const content = [
			"İstanbul: opening remarks and İ İ İ notes", // line 1 (İ.toLowerCase() is 2 units)
			"Bob: we decided to keep VTT parsing", // line 2
		].join("\n");
		// The comma is absent from the source, so exact indexOf misses and the
		// normalized fallback (which uses the offset map) runs.
		expect(
			resolveQuoteAnchor(content, "we decided, to keep VTT parsing"),
		).toBe(2);
	});

	it("resolves a normalized non-Latin (Cyrillic) match via the fallback path", () => {
		const content = "Алексей: якорные, ссылки готовы к пятнице";
		// Punctuation drift (comma removed) forces the normalized path rather
		// than exact indexOf.
		expect(resolveQuoteAnchor(content, "якорные ссылки готовы")).toBe(1);
	});
});
