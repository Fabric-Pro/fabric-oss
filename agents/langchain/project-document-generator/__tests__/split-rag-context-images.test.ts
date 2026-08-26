/**
 * Unit tests for splitRagContextImages — the function that peels base64
 * image data URLs out of `ragContexts` markdown entries and returns them
 * separately so the agent can re-attach them as `image_url` content parts
 * on the user message.
 */

import { describe, expect, it } from "vitest";
import { splitRagContextImages } from "../nodes/chat-node";

const PNG_DATA_URL =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const JPEG_DATA_URL =
	"data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD//gA7Q1JFQVRPUjogZ2QtanBlZyB2MS4wICh1c2luZyBJSkcgSlBFRyB2NjIpLCBxdWFsaXR5ID0gOTAK/9sAQwADAg=";

describe("splitRagContextImages", () => {
	it("returns empty arrays for undefined input", () => {
		const result = splitRagContextImages(undefined);
		expect(result.images).toEqual([]);
		expect(result.textOnlyContexts).toEqual([]);
	});

	it("returns empty arrays for empty input", () => {
		const result = splitRagContextImages([]);
		expect(result.images).toEqual([]);
		expect(result.textOnlyContexts).toEqual([]);
	});

	it("extracts a single PNG data URL from a markdown context entry", () => {
		const entry = `[Uploaded Image: wireframe.png]\n![wireframe.png](${PNG_DATA_URL})`;
		const { textOnlyContexts, images } = splitRagContextImages([entry]);

		expect(images).toHaveLength(1);
		expect(images[0]).toEqual({
			filename: "wireframe.png",
			dataUrl: PNG_DATA_URL,
		});

		// The persisted-output safety guarantee: the cleaned text must NOT
		// contain markdown image syntax (`![...](...)`) — if the model echoes
		// the placeholder into document output, we want it to render as plain
		// text, not as a broken-image link.
		expect(textOnlyContexts[0]).not.toMatch(/!\[[^\]]*\]\(/);
		expect(textOnlyContexts[0]).toContain(
			"[attached image: wireframe.png]",
		);
	});

	it("extracts a JPEG data URL", () => {
		const entry = `![screen.jpg](${JPEG_DATA_URL})`;
		const { images } = splitRagContextImages([entry]);
		expect(images).toHaveLength(1);
		expect(images[0].dataUrl).toBe(JPEG_DATA_URL);
		expect(images[0].filename).toBe("screen.jpg");
	});

	it("extracts multiple images from a single entry", () => {
		const entry = `![a.png](${PNG_DATA_URL}) and ![b.jpg](${JPEG_DATA_URL})`;
		const { images, textOnlyContexts } = splitRagContextImages([entry]);
		expect(images).toHaveLength(2);
		expect(images[0].filename).toBe("a.png");
		expect(images[1].filename).toBe("b.jpg");
		expect(textOnlyContexts[0]).toContain("[attached image: a.png]");
		expect(textOnlyContexts[0]).toContain("[attached image: b.jpg]");
	});

	it("passes through non-image markdown unchanged", () => {
		const entry = "Some text with [a link](https://example.com).";
		const { images, textOnlyContexts } = splitRagContextImages([entry]);
		expect(images).toEqual([]);
		expect(textOnlyContexts[0]).toBe(entry);
	});

	it("preserves the surrounding text around the placeholder", () => {
		const entry = `Header\n![logo.png](${PNG_DATA_URL})\nFooter`;
		const { textOnlyContexts } = splitRagContextImages([entry]);
		expect(textOnlyContexts[0]).toBe(
			"Header\n[attached image: logo.png]\nFooter",
		);
	});

	it("uses a fallback filename when alt text is empty", () => {
		const entry = `![](${PNG_DATA_URL})`;
		const { images, textOnlyContexts } = splitRagContextImages([entry]);
		expect(images[0].filename).toBe("image");
		expect(textOnlyContexts[0]).toBe("[attached image: image]");
	});
});

describe("AC-15 — persistence safety contract", () => {
	// These tests lock the two persistence-safety invariants the spec relies
	// on: (1) the placeholder format is stable across refactors, and (2) the
	// regex matches ONLY the markdown image form — legitimate text mentions
	// of the literal `data:image/` substring (e.g., quoted documentation)
	// must survive untouched. A future change that broadens the regex would
	// silently corrupt user-authored prose, so a tripwire here is load-bearing.

	it("never leaks a `data:image/` substring into textOnlyContexts when only the markdown form carries the data URL", () => {
		// Input mixes a real markdown image with a legitimate sentence
		// mentioning the literal string "data:image/" (e.g., documentation).
		const input = `Doc: ![Hero](${PNG_DATA_URL}). We use data:image/* for inline images in docs.`;
		const result = splitRagContextImages([input]);
		// The markdown form is replaced
		expect(result.textOnlyContexts[0]).toContain("[attached image: Hero]");
		// But the legitimate text occurrence stays — the regex matches only
		// the markdown form, not bare `data:image/...` substrings in prose.
		expect(result.textOnlyContexts[0]).toContain(
			"data:image/* for inline images",
		);
		// No actual base64 payloads remain in the persisted text.
		expect(result.textOnlyContexts[0]).not.toContain("base64,iVBOR");
	});

	it("locks the placeholder format as `[attached image: <name>]`", () => {
		const input = `![Hero shot](${PNG_DATA_URL})`;
		const result = splitRagContextImages([input]);
		expect(result.textOnlyContexts[0]).toBe("[attached image: Hero shot]");
	});

	it("uses fallback name `image` when alt text is empty", () => {
		const input = `![](${JPEG_DATA_URL})`;
		const result = splitRagContextImages([input]);
		expect(result.textOnlyContexts[0]).toBe("[attached image: image]");
	});
});
