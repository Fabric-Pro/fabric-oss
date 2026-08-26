import { describe, expect, it } from "vitest";
import {
	resolveStoryMediaUrlsInContent,
	rewriteStoryMediaToSignedImgTags,
} from "../resolve-story-media-urls-in-content";

const KEY = "story-media/p/s/a.png";
const SIGNED = "https://cdn.example/story-media/p/s/a.png?sig=ok";
const MAP = new Map([[KEY, SIGNED]]);

describe("rewriteStoryMediaToSignedImgTags", () => {
	it("converts bare markdown image to a keyed <img> with signed src + alt", () => {
		expect(rewriteStoryMediaToSignedImgTags(`![image](${KEY})`, MAP)).toBe(
			`<img src="${SIGNED}" data-s3-key="${KEY}" alt="image">`,
		);
	});

	it("omits the alt attribute when the markdown alt is empty", () => {
		expect(rewriteStoryMediaToSignedImgTags(`![](${KEY})`, MAP)).toBe(
			`<img src="${SIGNED}" data-s3-key="${KEY}">`,
		);
	});

	it("adds data-s3-key to a bare relative <img src> and re-signs it", () => {
		expect(
			rewriteStoryMediaToSignedImgTags(`<img src="${KEY}">`, MAP),
		).toBe(`<img data-s3-key="${KEY}" src="${SIGNED}">`);
	});

	it("re-signs an already-keyed <img>, preserving data-s3-key", () => {
		const input = `<img src="https://old/story-media/p/s/a.png?Sig=stale" data-s3-key="${KEY}">`;
		expect(rewriteStoryMediaToSignedImgTags(input, MAP)).toBe(
			`<img src="${SIGNED}" data-s3-key="${KEY}">`,
		);
	});

	it("leaves references with no map entry untouched", () => {
		const input = "![image](story-media/p/s/other.png)";
		expect(rewriteStoryMediaToSignedImgTags(input, MAP)).toBe(input);
	});

	it("leaves non-story-media markdown images untouched", () => {
		const input = "![x](https://example.com/cat.png)";
		expect(rewriteStoryMediaToSignedImgTags(input, MAP)).toBe(input);
	});

	it("is idempotent — a second pass with the same map is stable", () => {
		const once = rewriteStoryMediaToSignedImgTags(`![image](${KEY})`, MAP);
		const twice = rewriteStoryMediaToSignedImgTags(once, MAP);
		expect(twice).toBe(once);
	});

	it("returns content unchanged when the map is empty", () => {
		const input = `![image](${KEY})`;
		expect(rewriteStoryMediaToSignedImgTags(input, new Map())).toBe(input);
	});
});

describe("resolveStoryMediaUrlsInContent", () => {
	const sign = async (key: string) => `https://cdn.example/${key}?sig=ok`;

	it("returns null/undefined/empty content untouched", async () => {
		expect(
			await resolveStoryMediaUrlsInContent(null, "p", "s", {
				signUrl: sign,
			}),
		).toBe(null);
		expect(
			await resolveStoryMediaUrlsInContent(undefined, "p", "s", {
				signUrl: sign,
			}),
		).toBe(undefined);
		expect(
			await resolveStoryMediaUrlsInContent("", "p", "s", {
				signUrl: sign,
			}),
		).toBe("");
	});

	it("resolves keys scoped to the story's keyspace into keyed <img> tags", async () => {
		const out = await resolveStoryMediaUrlsInContent(
			"body\n\n![image](story-media/p/s/a.png)",
			"p",
			"s",
			{ signUrl: sign },
		);
		expect(out).toBe(
			'body\n\n<img src="https://cdn.example/story-media/p/s/a.png?sig=ok" data-s3-key="story-media/p/s/a.png" alt="image">',
		);
	});

	it("does NOT resolve keys outside the {projectId}/{storyId} keyspace", async () => {
		// Same project, different story — must not be signed/rewritten.
		const input = "![image](story-media/p/OTHER/a.png)";
		const out = await resolveStoryMediaUrlsInContent(input, "p", "s", {
			signUrl: sign,
		});
		expect(out).toBe(input);
	});

	it("leaves a reference untouched when its signer returns null", async () => {
		const input = "![image](story-media/p/s/a.png)";
		const out = await resolveStoryMediaUrlsInContent(input, "p", "s", {
			signUrl: async () => null,
		});
		expect(out).toBe(input);
	});

	it("returns the original content when the signer throws (best-effort)", async () => {
		const input = "![image](story-media/p/s/a.png)";
		const out = await resolveStoryMediaUrlsInContent(input, "p", "s", {
			signUrl: async () => {
				throw new Error("boom");
			},
		});
		expect(out).toBe(input);
	});
});
