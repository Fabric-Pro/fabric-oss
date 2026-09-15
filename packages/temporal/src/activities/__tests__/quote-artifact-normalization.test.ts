/**
 * `normalizeQuoteArtifacts` — tilde-prefixed typographic-quote hygiene.
 *
 * The corrupt runs asserted here are taken verbatim from a production document
 * (Fizzy #2210), where every typographic quote carried a leading tilde and the
 * runs had lengths 1, 2 and 4 — doubling with each regeneration. Synthetic
 * examples would have missed the doubling, which is the property that makes the
 * naive fix (strip the tildes) wrong: `~“~“` stripped leaves `““`.
 *
 * The idempotence test is the load-bearing one. A transform that is not a fixed
 * point is what turns a cosmetic defect into a compounding one.
 */

import { normalizeQuoteArtifacts } from "@repo/utils/quote-artifacts";
import { describe, expect, it } from "vitest";

describe("normalizeQuoteArtifacts", () => {
	// Each case carries a doubled run, because a single pair on its own is not
	// evidence of corruption — see the isolated-pair test below.
	it("collapses a single tilde-quote pair in a damaged document", () => {
		expect(normalizeQuoteArtifacts("~“~“ a ~“b")).toBe("“ a “b");
		expect(normalizeQuoteArtifacts("~”~” a ~”b")).toBe("” a ”b");
		expect(normalizeQuoteArtifacts("~’~’ hasn~’t")).toBe("’ hasn’t");
	});

	it("collapses a doubled run to ONE quote, not two", () => {
		// The whole point: stripping tildes would yield `““`, doubling the damage.
		expect(normalizeQuoteArtifacts("a ~“~“b")).toBe("a “b");
		expect(normalizeQuoteArtifacts("a ~”~”b")).toBe("a ”b");
	});

	it("collapses a quadrupled run to one quote", () => {
		expect(normalizeQuoteArtifacts("a ~“~“~“~“b")).toBe("a “b");
		expect(normalizeQuoteArtifacts("hasn~~’~’~’~’t")).toBe("hasn’t");
		expect(normalizeQuoteArtifacts("a ~”~”~~”~”b")).toBe("a ”b");
	});

	it("repairs the exact runs found in the affected production document", () => {
		const corrupted =
			"business case (Reference 6), ~“~“~“~“despite using AI every day, delivery hasn~~’~’~’~’t actually";
		expect(normalizeQuoteArtifacts(corrupted)).toBe(
			"business case (Reference 6), “despite using AI every day, delivery hasn’t actually",
		);
	});

	it("is a fixed point after one application", () => {
		const corrupted = "~“a~” and ~“~“b~”~” and hasn~~’~’~’~’t and ~‘c~’";
		const once = normalizeQuoteArtifacts(corrupted);
		expect(normalizeQuoteArtifacts(once)).toBe(once);
		// And a second pass over already-clean prose changes nothing.
		expect(normalizeQuoteArtifacts(once)).not.toContain("~“");
		expect(normalizeQuoteArtifacts(once)).not.toContain("~’");
	});

	// Regression: the first implementation matched a maximal run of ANY
	// tilde-quote pairs and kept the last quote character, on the assumption that
	// every quote in a run is the same. It is not — a closing quote abutting an
	// opening one is two corrupt runs, not one — and collapsing them deleted a
	// character from the customer's document while claiming to repair it.
	it("keeps both characters when two different quotes abut", () => {
		// Damaged document (the `~“~“` proves it), so the singles collapse — but
		// each keeps its OWN character. The first implementation kept the run's
		// last quote and deleted the rest, unbalancing the quotation.
		expect(normalizeQuoteArtifacts("~“~“x a ~“~’b")).toBe("“x a “’b");
		expect(normalizeQuoteArtifacts("~”~” said ~“hi~”~“bye~”")).toBe(
			"” said “hi”“bye”",
		);
	});

	it("collapses same-character runs independently on either side of a boundary", () => {
		expect(normalizeQuoteArtifacts("~“~“x~”~”")).toBe("“x”");
	});

	it("returns an empty string unchanged", () => {
		expect(normalizeQuoteArtifacts("")).toBe("");
	});

	it("does not join a run across a newline", () => {
		expect(normalizeQuoteArtifacts("~“~“\na ~“\nb ~“c")).toBe(
			"“\na “\nb “c",
		);
	});

	it("collapses a run longer than any observed in production", () => {
		expect(normalizeQuoteArtifacts(`a ${"~“".repeat(8)}b`)).toBe("a “b");
	});

	it("preserves balanced GFM strikethrough around a quoted phrase", () => {
		// The opening `~~“` has exactly the shape the rule targets. Damaging it
		// would silently drop one delimiter and leave a stray `~~` rendering.
		const markup = "a ~~“scare quote”~~ b";
		expect(normalizeQuoteArtifacts(markup)).toBe(markup);
	});

	// The reason a document-level signature exists rather than a local shape rule.
	// Every one of these is legitimate prose or markup that a local rule would
	// have silently rewritten in a document that was never corrupted.
	it("leaves an isolated tilde-quote alone in an undamaged document", () => {
		expect(normalizeQuoteArtifacts("~’90s were great")).toBe(
			"~’90s were great",
		);
		expect(normalizeQuoteArtifacts("see Table~“A”")).toBe("see Table~“A”");
		expect(normalizeQuoteArtifacts("a ~“struck”~ b")).toBe(
			"a ~“struck”~ b",
		);
	});

	it("collapses isolated pairs once the document proves it is damaged", () => {
		// The doubled run is the evidence; the single pair beside it is then
		// corruption too, and the production document was full of both.
		expect(normalizeQuoteArtifacts("a ~“~“b and ~’c")).toBe("a “b and ’c");
	});

	it("preserves ordinary strikethrough and unrelated tildes", () => {
		expect(normalizeQuoteArtifacts("a ~~struck~~ b")).toBe(
			"a ~~struck~~ b",
		);
		expect(normalizeQuoteArtifacts("approx ~2 seconds")).toBe(
			"approx ~2 seconds",
		);
		expect(normalizeQuoteArtifacts("path/to~file")).toBe("path/to~file");
	});

	it("leaves clean typographic quotes untouched", () => {
		const clean = "He said “hello”, and she didn’t reply.";
		expect(normalizeQuoteArtifacts(clean)).toBe(clean);
	});

	it("returns content with no quotes at all unchanged", () => {
		const plain = "# Heading\n\nA paragraph with no smart quotes.\n";
		expect(normalizeQuoteArtifacts(plain)).toBe(plain);
	});
});

/**
 * ASCII quotes: deliberately NOT repaired.
 *
 * A later report showed the identical artifact built from straight quotes, and
 * widening the character class to cover it was tried and reverted. These tests
 * pin the reverted state so the next person to notice the gap finds the reason
 * instead of the temptation.
 *
 * The document-level signature makes the SHAPE safe — a run must be
 * contiguous — but it says nothing about WHERE the run sits, and this function
 * cannot see a code fence. Curly quotes essentially never sit beside a tilde
 * inside code; ASCII quotes do constantly. In a document the signature has
 * already condemned, `cd ~"$HOME"` inside a fenced block loses its tilde, and
 * so does `col ~'regex'` and `rm -rf ~'/tmp'` — silently, and indistinguishably
 * from a repair.
 *
 * Under-repairing prose is recoverable. Rewriting someone's shell command is
 * not. Covering ASCII needs fence-aware scanning first, not a wider class.
 */
describe("normalizeQuoteArtifacts — ASCII quotes are out of scope", () => {
	it("leaves an ASCII-quote artifact run untouched", () => {
		const ascii = 'own the ~"~"~"project-level idea~~"~"~~" label';
		expect(normalizeQuoteArtifacts(ascii)).toBe(ascii);
	});

	it("leaves ASCII runs alone even beside genuine curly damage", () => {
		// The curly run IS repaired; the ASCII one in the same string is not.
		expect(normalizeQuoteArtifacts('~\u201C~\u201Ca and ~"~"b')).toBe(
			'\u201Ca and ~"~"b',
		);
	});

	// The reason the class stays narrow, stated as executable cases.
	it("never disturbs a tilde inside code, even in a damaged document", () => {
		const withCode =
			"cmd: `rm -rf ~'/tmp'` and `cd ~\"$HOME\"` and ~\u201C~\u201Cdamaged";
		expect(normalizeQuoteArtifacts(withCode)).toBe(
			"cmd: `rm -rf ~'/tmp'` and `cd ~\"$HOME\"` and \u201Cdamaged",
		);
	});
});
