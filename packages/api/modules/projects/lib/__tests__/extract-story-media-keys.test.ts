import { describe, expect, it } from "vitest";
import { extractStoryMediaKeysFromContent } from "../extract-story-media-keys";

describe("extractStoryMediaKeysFromContent", () => {
	it("returns [] for empty, null, or undefined input", () => {
		expect(extractStoryMediaKeysFromContent("")).toEqual([]);
		expect(extractStoryMediaKeysFromContent(null)).toEqual([]);
		expect(extractStoryMediaKeysFromContent(undefined)).toEqual([]);
	});

	it("returns [] for input with no story-media substring", () => {
		const html = "<p>Plain text with no images or attachments.</p>";
		expect(extractStoryMediaKeysFromContent(html)).toEqual([]);

		const markdown = "## Heading\n\nSome paragraph text. No attachments.";
		expect(extractStoryMediaKeysFromContent(markdown)).toEqual([]);

		const otherKeyspace =
			'<img data-s3-key="document-media/p1/d1/k1" src="https://x/document-media/p1/d1/k1">';
		expect(extractStoryMediaKeysFromContent(otherKeyspace)).toEqual([]);
	});

	it("extracts a single key from the HTML data-s3-key form", () => {
		const html =
			'<p><img data-s3-key="story-media/p1/s1/k1" src="https://x.cloudfront.net/story-media/p1/s1/k1?signed=abc" alt=""></p>';
		// The HTML carries the key in BOTH the attribute and the src URL — the
		// helper must dedupe and return it exactly once.
		expect(extractStoryMediaKeysFromContent(html)).toEqual([
			"story-media/p1/s1/k1",
		]);
	});

	it("extracts a single key from the markdown URL form", () => {
		const markdown =
			"Here is an image:\n\n![](https://x.cloudfront.net/story-media/p1/s1/k1?signed=abc)\n";
		expect(extractStoryMediaKeysFromContent(markdown)).toEqual([
			"story-media/p1/s1/k1",
		]);
	});

	it("preserves left-to-right insertion order across mixed HTML and markdown forms", () => {
		// Layout (left-to-right by character offset):
		//   k1 (HTML attribute) — first
		//   k2 (markdown URL)    — second
		//   k3 (markdown URL)    — third
		//   k4 (HTML attribute) — fourth
		// The helper must walk the string by document position, NOT
		// "all HTML matches then all markdown matches".
		const content = [
			'<p><img data-s3-key="story-media/p1/s1/k1" src="https://cdn/story-media/p1/s1/k1?signed=1" alt=""></p>',
			"",
			"![](https://cdn/story-media/p1/s1/k2?signed=2)",
			"",
			"Some prose between attachments.",
			"",
			"![](https://cdn/story-media/p1/s1/k3?signed=3)",
			"",
			'<p><img data-s3-key="story-media/p1/s1/k4" src="https://cdn/story-media/p1/s1/k4?signed=4" alt=""></p>',
		].join("\n");

		expect(extractStoryMediaKeysFromContent(content)).toEqual([
			"story-media/p1/s1/k1",
			"story-media/p1/s1/k2",
			"story-media/p1/s1/k3",
			"story-media/p1/s1/k4",
		]);
	});

	it("dedupes the same key across HTML and markdown forms", () => {
		const content = [
			'<img data-s3-key="story-media/p1/s1/k1" src="https://cdn/story-media/p1/s1/k1?signed=1" alt="">',
			"",
			"![](https://cdn/story-media/p1/s1/k1?signed=2)",
			"",
			'<img data-s3-key="story-media/p1/s1/k1" src="https://cdn/story-media/p1/s1/k1?signed=3" alt="">',
		].join("\n");

		expect(extractStoryMediaKeysFromContent(content)).toEqual([
			"story-media/p1/s1/k1",
		]);
	});

	it("is idempotent on the reinjected ## Attachments block", () => {
		// Original description contains two attachments (k1, k2). The
		// stage-transition guard reinjects a dropped key (k3) by appending an
		// "## Attachments" section with `![](signed-url)` markdown. Running
		// the extractor on the augmented description must yield the full set,
		// AND running the extractor on the extractor's own output (a second
		// pass) must yield the same set — i.e. no growth, no reordering.
		const original = [
			'<p><img data-s3-key="story-media/p1/s1/k1" src="https://cdn/story-media/p1/s1/k1?signed=1" alt=""></p>',
			"",
			"![](https://cdn/story-media/p1/s1/k2?signed=2)",
		].join("\n");

		const reinjectedAttachments = [
			"",
			"## Attachments",
			"",
			"![](https://cdn/story-media/p1/s1/k3?signed=3-reinjected)",
		].join("\n");

		const withReinject = original + reinjectedAttachments;

		const firstPass = extractStoryMediaKeysFromContent(withReinject);
		expect(firstPass).toEqual([
			"story-media/p1/s1/k1",
			"story-media/p1/s1/k2",
			"story-media/p1/s1/k3",
		]);

		// Idempotency: running again on the same input yields the same array.
		const secondPass = extractStoryMediaKeysFromContent(withReinject);
		expect(secondPass).toEqual(firstPass);

		// The original (pre-reinject) and the augmented version share the keys
		// that survived; the reinjected block only adds k3.
		const originalKeys = extractStoryMediaKeysFromContent(original);
		expect(originalKeys).toEqual([
			"story-media/p1/s1/k1",
			"story-media/p1/s1/k2",
		]);
		expect(firstPass.slice(0, originalKeys.length)).toEqual(originalKeys);
	});
});
