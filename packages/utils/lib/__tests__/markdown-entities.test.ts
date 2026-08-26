/**
 * `decodeMarkdownQuoteEntities` — undoes the entity escaping a model emits into
 * markdown bodies, including the compounding that makes it worse on every pass.
 *
 * The numbers in these tests come from a real staging observation: a ticket
 * enriched twice went from 0 entities, to 15 `&#x27;`, to 27 `&amp;#x27;`.
 */

import { describe, expect, it } from "vitest";
import { decodeMarkdownQuoteEntities } from "../markdown-entities";

describe("decodeMarkdownQuoteEntities", () => {
	it("decodes the escaped apostrophe a model emits into prose", () => {
		expect(decodeMarkdownQuoteEntities("it&#x27;s ready")).toBe(
			"it's ready",
		);
		expect(decodeMarkdownQuoteEntities("it&#39;s ready")).toBe(
			"it's ready",
		);
		expect(decodeMarkdownQuoteEntities("it&apos;s ready")).toBe(
			"it's ready",
		);
	});

	it("decodes zero-padded numeric forms", () => {
		// `&#039;` is what htmlspecialchars-style escapers emit, and models
		// reach for it as readily as the unpadded form. Before this was
		// handled, such a body compounded forever and `&amp;#039;` came out
		// half-processed.
		expect(decodeMarkdownQuoteEntities("it&#039;s ready")).toBe(
			"it's ready",
		);
		expect(decodeMarkdownQuoteEntities("it&#x027;s ready")).toBe(
			"it's ready",
		);
		expect(decodeMarkdownQuoteEntities("it&amp;#039;s ready")).toBe(
			"it's ready",
		);
		expect(decodeMarkdownQuoteEntities("say &#034;hi&#034;")).toBe(
			'say "hi"',
		);
	});

	it("decodes escaped double quotes", () => {
		expect(decodeMarkdownQuoteEntities("say &quot;hello&quot;")).toBe(
			'say "hello"',
		);
		expect(decodeMarkdownQuoteEntities("say &#x22;hi&#x22;")).toBe(
			'say "hi"',
		);
	});

	it("unwinds one round of compounding in a single call", () => {
		// The state a ticket reaches after a second enrichment.
		expect(decodeMarkdownQuoteEntities("it&amp;#x27;s")).toBe("it's");
	});

	it("unwinds several rounds of compounding", () => {
		// A ticket enriched four times, if nothing ever decoded it.
		expect(decodeMarkdownQuoteEntities("it&amp;amp;amp;#x27;s")).toBe(
			"it's",
		);
	});

	it("is idempotent, so applying it every pass is safe", () => {
		const once = decodeMarkdownQuoteEntities("it&amp;#x27;s fine");
		expect(decodeMarkdownQuoteEntities(once)).toBe(once);
		expect(once).toBe("it's fine");
	});

	it("leaves a literal ampersand alone", () => {
		// `&amp;` that is NOT wrapping an entity is a real escaped ampersand and
		// must survive — decoding it would change meaning, not restore it.
		expect(decodeMarkdownQuoteEntities("Tom &amp; Jerry")).toBe(
			"Tom &amp; Jerry",
		);
		expect(decodeMarkdownQuoteEntities("R&D and Q&A")).toBe("R&D and Q&A");
	});

	it("leaves angle-bracket entities alone", () => {
		// A body showing literal markup needs these; turning them into real
		// angle brackets is the one change that could alter meaning.
		expect(decodeMarkdownQuoteEntities("use &lt;div&gt; here")).toBe(
			"use &lt;div&gt; here",
		);
	});

	it("returns short-circuit values untouched", () => {
		expect(decodeMarkdownQuoteEntities("")).toBe("");
		expect(decodeMarkdownQuoteEntities("no entities here")).toBe(
			"no entities here",
		);
	});

	it("handles a body with many occurrences, as a real ticket does", () => {
		const body = Array.from(
			{ length: 27 },
			(_, i) => `Section ${i}: the team&amp;#x27;s decision.`,
		).join("\n\n");

		const decoded = decodeMarkdownQuoteEntities(body);

		expect(decoded).not.toMatch(/&#x27;|&amp;/);
		expect((decoded.match(/team's/g) || []).length).toBe(27);
	});
});

describe("decodeMarkdownQuoteEntities — large and adversarial input", () => {
	it("terminates and returns a long non-entity run unchanged", () => {
		// A run of `&amp;` that never resolves to an entity: every one is a
		// literal ampersand and must survive untouched, however long the run.
		const hostile = "&amp;".repeat(20_000);
		expect(decodeMarkdownQuoteEntities(hostile)).toBe(hostile);
	});

	it("stops unwinding at the pass bound instead of looping", () => {
		// Deeper compounding than MAX_UNWIND_PASSES can peel. The contract is
		// that it terminates and makes progress — not that it fully cleans an
		// input no real body can reach (each enrichment adds one level).
		const deep = `${"&amp;".repeat(40)}#x27;`;
		const out = decodeMarkdownQuoteEntities(deep);

		expect(out.length).toBeLessThan(deep.length);
		expect(out).toContain("amp;");
	});
});
