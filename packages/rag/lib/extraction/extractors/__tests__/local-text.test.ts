import { describe, expect, it } from "vitest";
import { LocalHtmlExtractor } from "../local-html";
import { LocalTextExtractor } from "../local-text";

/**
 * ~2,125 levels of nesting overflow `html-to-text`'s recursive walk. At 24 KB
 * this is orders of magnitude below MAX_HTML_EXTRACTION_BYTES, so no size cap
 * catches it and the factory falls through to LocalTextExtractor.
 */
const DEEP_NESTING_PAYLOAD = `${"<div>".repeat(2200)}<script>SECRETPAYLOAD</script><style>.x{color:LEAKEDSTYLE}</style>${"</div>".repeat(2200)}`;

describe("LocalTextExtractor", () => {
	const extractor = new LocalTextExtractor();

	it("claims the excalidraw vendor mime", () => {
		expect(extractor.supportedMimeTypes).toContain(
			"application/vnd.excalidraw+json",
		);
	});

	it("extracts the raw utf-8 text of an excalidraw json buffer", async () => {
		const doc = JSON.stringify({ type: "excalidraw", elements: [] });
		const res = await extractor.extract(
			Buffer.from(doc, "utf-8"),
			"board.excalidraw",
		);
		expect(res.text).toBe(doc);
		expect(res.extractorUsed).toBe("local-text");
		expect(res.cost).toBe(0);
	});

	/**
	 * AE2 / R4 — the boundary the chat-side character budget must not cross.
	 *
	 * The four Temporal ingestion activities that reach this extractor pass no
	 * options, and they must keep receiving whole documents: ingestion text goes
	 * to chunking and embedding, where a cut document embeds its own truncation
	 * marker into the vector store as though it were content. This pins the
	 * behaviour so a later refactor cannot push the chat budget down into the
	 * shared reader — which would look like consolidation and would silently cut
	 * every knowledge-base document at the same limit.
	 */
	it("returns the full text for a caller that supplies no budget", async () => {
		const huge = "x".repeat(500_000);

		const res = await extractor.extract(
			Buffer.from(huge, "utf-8"),
			"big.txt",
		);

		expect(res.text).toHaveLength(500_000);
		expect(res.text).not.toContain("truncated");
	});

	it("still returns the full text when a caller passes unrelated options", async () => {
		// The signature accepts options and ignores them. A caller that starts
		// forwarding chat bounds here gets everything anyway — until someone
		// wires them up, at which point this test is the one that should fail.
		const huge = "y".repeat(300_000);

		const res = await extractor.extract(
			Buffer.from(huge, "utf-8"),
			"big.txt",
			{
				extractedTextBudgetChars: 1_000,
			},
		);

		expect(res.text).toHaveLength(300_000);
	});

	describe("text/html raw-text fallback", () => {
		it("does not emit the script body of html that defeated the parser", async () => {
			const res = await extractor.extract(
				Buffer.from(DEEP_NESTING_PAYLOAD, "utf-8"),
				"deep.html",
				{ mimeType: "text/html" },
			);

			expect(res.text).not.toContain("SECRETPAYLOAD");
			expect(res.text).not.toContain("<script");
		});

		it("does not emit style bodies either", async () => {
			const res = await extractor.extract(
				Buffer.from(DEEP_NESTING_PAYLOAD, "utf-8"),
				"deep.html",
				{ mimeType: "text/html" },
			);

			expect(res.text).not.toContain("LEAKEDSTYLE");
			expect(res.text).not.toContain("<style");
		});

		it("strips an unterminated trailing script tag", async () => {
			// Truncated markup is precisely what reaches this path, so the strip
			// cannot depend on finding a closing tag.
			const res = await extractor.extract(
				Buffer.from("<p>keep</p><script>TRAILINGSECRET", "utf-8"),
				"truncated.html",
				{ mimeType: "text/html" },
			);

			expect(res.text).toContain("keep");
			expect(res.text).not.toContain("TRAILINGSECRET");
		});

		it("keeps the surviving prose rather than blanking the document", async () => {
			// The reason this is a strip and not html-to-text's maxDepth: a
			// document that degrades to "..." passes the empty-text guard and is
			// stored COMPLETED-but-useless. Stripped text still carries content.
			const res = await extractor.extract(
				Buffer.from(
					"<h1>Quarterly Revenue</h1><script>drop()</script>",
					"utf-8",
				),
				"report.html",
				{ mimeType: "text/html" },
			);

			expect(res.text).toContain("Quarterly Revenue");
		});

		/**
		 * The guard against over-stripping. Every other MIME this extractor
		 * claims — txt, md, csv, json, excalidraw, xml, svg — is an exact
		 * passthrough, and a plain-text file that happens to discuss a script tag
		 * must survive byte-identical.
		 */
		it("leaves a text/plain buffer containing script markup exactly as-is", async () => {
			const source =
				"Docs: use <script>keepme</script> and <style>.a{}</style> in your page.";

			const res = await extractor.extract(
				Buffer.from(source, "utf-8"),
				"notes.txt",
				{ mimeType: "text/plain" },
			);

			expect(res.text).toBe(source);
		});

		it("leaves an svg buffer with an inline script exactly as-is", async () => {
			const source = "<svg><script>keepme</script><rect /></svg>";

			const res = await extractor.extract(
				Buffer.from(source, "utf-8"),
				"icon.svg",
				{ mimeType: "image/svg+xml" },
			);

			expect(res.text).toBe(source);
		});

		it("leaves the text untouched when no mime is supplied at all", async () => {
			// The four Temporal ingestion activities call through the factory,
			// which always stamps a MIME. A direct caller that supplies none gets
			// the historical passthrough.
			const source = "<script>keepme</script>";

			const res = await extractor.extract(
				Buffer.from(source, "utf-8"),
				"unknown.bin",
			);

			expect(res.text).toBe(source);
		});
	});
});

/**
 * End-to-end over the pair, not either extractor alone: the leak was a property
 * of the fallback *chain*. local-html throws on the deep payload, the factory
 * catches and reaches local-text, and the script body must not survive that
 * hand-off. Asserting only on local-text would stay green if local-html were
 * later "fixed" to return raw markup instead of throwing.
 */
describe("html fallback chain", () => {
	it("cannot deliver the script body of deeply nested html", async () => {
		const htmlExtractor = new LocalHtmlExtractor();
		const textExtractor = new LocalTextExtractor();
		const buffer = Buffer.from(DEEP_NESTING_PAYLOAD, "utf-8");

		let delivered: string;
		try {
			delivered = (
				await htmlExtractor.extract(buffer, "deep.html", {
					mimeType: "text/html",
				})
			).text;
		} catch {
			delivered = (
				await textExtractor.extract(buffer, "deep.html", {
					mimeType: "text/html",
				})
			).text;
		}

		expect(delivered).not.toContain("SECRETPAYLOAD");
		expect(delivered).not.toContain("LEAKEDSTYLE");
	});

	it("confirms the parser really does fail on this payload", async () => {
		// If html-to-text ever gains an iterative walk this goes red, and the
		// test above stops proving anything about the fallback path.
		await expect(
			new LocalHtmlExtractor().extract(
				Buffer.from(DEEP_NESTING_PAYLOAD, "utf-8"),
				"deep.html",
			),
		).rejects.toThrow(/HTML extraction failed/i);
	});
});

/**
 * A PERFORMANCE guard, not a correctness one — the assertions above already
 * cover what the strip must remove. This pins that the strip stays LINEAR.
 *
 * The regexes' open-tag attribute span is bounded (`[^>]{0,4096}`). Unbounded,
 * input carrying many `<script ` openings that never close with `>` costs a
 * fresh forward scan at every occurrence, which is quadratic: measured 4x per
 * doubling — 0.2 s at 73 KB, 3.4 s at 261 KB, 13.7 s at 511 KB, 58 s at 1 MB.
 * `UPLOAD_SIZE_LIMITS.DOCUMENT` permits 20 MB and `local-text` enforces no byte
 * cap of its own, so unbounded this is an availability bug, not a slow test:
 * `String.replace` is synchronous, and `local-text` ignores
 * `extractionDeadlineMs`, so no Temporal activity timeout can pre-empt it. The
 * worker stalls rather than the activity failing.
 *
 * The threshold is deliberately loose. Bounded, this payload strips in ~0.4 s
 * on an idle machine; unbounded it takes ~13.7 s. 3 s sits roughly midway in
 * ratio terms (7x headroom for a loaded CI box, 4.5x margin before a regression
 * escapes), so the test neither flakes nor stops biting.
 */
describe("html strip cost", () => {
	it("stays linear on many unclosed script openings", async () => {
		// A real script first, so the assertion below proves the strip actually
		// ran rather than bailing out early. Then the pathological run: every
		// `<script ` is a match start whose scan for `>` never succeeds, because
		// no `>` occurs anywhere after it. That is what makes an unbounded
		// attribute span restart a full forward scan at every position.
		//
		// The trailing run must stay free of `>`. Add one and the first opening
		// simply matches through to it, collapsing the whole region into a
		// single match — fast under either regex, and the guard stops guarding.
		const pathological = `${"<div>".repeat(2200)}<script>SECRETPAYLOAD</script>${"<script ".repeat(64_000)}`;
		expect(pathological.length).toBeGreaterThan(500_000);

		const startedAt = performance.now();
		const res = await new LocalTextExtractor().extract(
			Buffer.from(pathological, "utf-8"),
			"pathological.html",
			{ mimeType: "text/html" },
		);
		const elapsedMs = performance.now() - startedAt;

		// Generous on purpose. This is a LINEARITY guard, not a latency budget:
		// the failure it exists to catch is a quadratic attribute-span rescan,
		// which on 64k openings across a 500KB input is billions of operations —
		// tens of seconds at least, and in practice it blows the 60s timeout
		// below rather than landing just over a threshold. Anything in the low
		// seconds is linear behaviour on a busy machine.
		//
		// It was 3_000, which is roughly 10x the local cost of this call and so
		// read as comfortable. It is not: shared CI runners are routinely 10-30x
		// slower than a dev box under contention, and it failed twice in a row on
		// unrelated PRs at 3_071ms and 3_955ms — close enough to the line to be
		// pure scheduling noise. A flaky guard gets re-run until green, which is
		// strictly worse than no guard, because it trains people to ignore it.
		expect(elapsedMs).toBeLessThan(30_000);
		expect(res.text).not.toContain("SECRETPAYLOAD");
	}, 60_000);
});
