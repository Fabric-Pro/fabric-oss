/**
 * What of Main's own markup the Proposal export carries (Fizzy #2946): the
 * link allowlist, the document's media prefix, the one raw HTML form the
 * export reads (an uploaded image tag as the editor saves it), and what
 * becomes of any other raw HTML.
 */

import { describe, expect, it } from "vitest";
import {
	isDocumentMediaKey,
	namesStoredObject,
	rawHtmlFallback,
	readUploadedImageTag,
	safeLinkHref,
} from "../document-content";

const PROJECT = "project-example-1";
const DOCUMENT = "document-example-1";
const KEY = `document-media/${PROJECT}/${DOCUMENT}/1760000000000_abc123.png`;

describe("safeLinkHref", () => {
	it.each([
		["https://example.com/plan", "https://example.com/plan"],
		["http://example.com", "http://example.com/"],
		["mailto:dev@example.com", "mailto:dev@example.com"],
		["#pricing", "#pricing"],
	])("keeps %s", (url, href) => {
		expect(safeLinkHref(url)).toBe(href);
	});

	it.each([
		"javascript:alert(1)",
		"file:///etc/passwd",
		"data:text/html,<script>",
		"\\\\server\\share",
		"/relative/path",
		"https://user:secret@example.com/",
		"https://example.com/a b",
		`https://example.com/${"a".repeat(2050)}`,
		"https://storage.example.com/document-media/p/d/x.png?X-Amz-Signature=abc",
		"https://storage.example.com/document-media/p/d/x.png",
		"https://storage.example.com/project-brand/project-example/recipient-brand/current/logo.png",
		"https://storage.example.com/organization-brand/org-example/hero/hero.png",
		"https://storage.example.com/x.pdf?x-amz-credential=abc&x-amz-signature=def",
		"#bad fragment",
		"",
	])("refuses %s", (url) => {
		expect(safeLinkHref(url)).toBeNull();
	});
});

describe("isDocumentMediaKey", () => {
	it("accepts only this document's own media", () => {
		expect(isDocumentMediaKey(KEY, PROJECT, DOCUMENT)).toBe(true);
		for (const key of [
			`document-media/${PROJECT}/document-example-2/x.png`,
			`document-media/${PROJECT}/${DOCUMENT}/../document-example-2/x.png`,
			`document-media/${PROJECT}/${DOCUMENT}/nested/x.png`,
			`document-media/${PROJECT}/${DOCUMENT}/`,
			"organization-logos/example-org.png",
		]) {
			expect(isDocumentMediaKey(key, PROJECT, DOCUMENT)).toBe(false);
		}
	});
});

describe("readUploadedImageTag", () => {
	it("reads the editor's saved tag, decoding entities", () => {
		expect(
			readUploadedImageTag(
				`<img src="https://storage.example.com/x?sig" alt="Team &amp; partners" width="320" data-s3-key="${KEY}" data-caption="Our &quot;core&quot; team" />`,
			),
		).toEqual({
			key: KEY,
			alt: "Team & partners",
			caption: 'Our "core" team',
			width: "320px",
		});
	});

	it("drops storage references written into alt and caption", () => {
		expect(
			readUploadedImageTag(
				`<img src="x" alt="Plan https://storage.example.com/${KEY}?X-Amz-Signature=a" data-s3-key="${KEY}" data-caption="See ${KEY} now" />`,
			),
		).toMatchObject({ alt: "Plan ", caption: "See  now" });
	});

	it("reads < and > inside quoted values", () => {
		expect(
			readUploadedImageTag(
				`<img src="x" alt="Before -> after" data-s3-key="${KEY}" data-caption="1 < 2" />`,
			),
		).toMatchObject({ alt: "Before -> after", caption: "1 < 2" });
	});

	it.each([
		[
			"a key written twice",
			`<img src="x" data-s3-key="${KEY}" data-s3-key="${KEY}" />`,
		],
		[
			"a caption written twice",
			`<img src="x" data-s3-key="${KEY}" data-caption="a" data-caption="b" />`,
		],
		[
			"a width written twice",
			`<img src="x" width="1" width="2" data-s3-key="${KEY}" />`,
		],
		["no key", '<img src="x" alt="y" />'],
		[
			"two tags",
			`<img data-s3-key="${KEY}" /><img data-s3-key="${KEY}" />`,
		],
		["text around the tag", `Look: <img data-s3-key="${KEY}" />`],
		["an unbalanced quote", `<img alt="a "b" data-s3-key="${KEY}" />`],
	])("refuses %s", (_label, html) => {
		expect(readUploadedImageTag(html)).toBeNull();
	});

	it.each([
		["50%", "50%"],
		["100%", "100%"],
		["640px", "640px"],
		["101%", null],
		["auto", null],
		["9999999", null],
	])("reads width %s as %s", (width, expected) => {
		expect(
			readUploadedImageTag(
				`<img width="${width}" data-s3-key="${KEY}" />`,
			)?.width,
		).toBe(expected);
	});
});

describe("raw HTML that is not an accepted upload", () => {
	it("draws a line break", () => {
		expect(rawHtmlFallback(" <br /> ")).toEqual({ kind: "break" });
	});

	it.each([
		["a comment", "<!-- note -->"],
		["a multi-line comment", "  <!-- a\nmulti-line note -->  "],
		["two comments", "<!-- a --> <!-- b -->"],
		[
			"a refused upload",
			`<img src="x" data-s3-key="${KEY}" data-s3-key="${KEY}" />`,
		],
		[
			"a file link that names its key",
			`<a href="x" data-s3-key="${KEY}">brief.pdf</a>`,
		],
		[
			"an image by signed URL with no key",
			'<img src="https://storage.example.com/document-media/p/d/x.png?X-Amz-Signature=abc" />',
		],
	])("prints nothing for %s", (_label, html) => {
		expect(rawHtmlFallback(html)).toEqual({ kind: "omit" });
	});

	it("leaves out an image tag with no stored upload, as an external image", () => {
		expect(
			rawHtmlFallback(
				'<img src="https://example.com/team.png" alt="Team" />',
			),
		).toEqual({ kind: "external-image" });
	});

	it("prints a bare <img> as text: a tag with no attributes names no image", () => {
		expect(rawHtmlFallback("<img>")).toEqual({
			kind: "text",
			text: "<img>",
		});
	});

	it("prints other HTML as written, less its comments", () => {
		expect(rawHtmlFallback("<u>Note</u>")).toEqual({
			kind: "text",
			text: "<u>Note</u>",
		});
		expect(rawHtmlFallback("<!-- draft --> visible")).toEqual({
			kind: "text",
			text: " visible",
		});
	});

	it("recognises HTML that names a stored object", () => {
		expect(namesStoredObject(`<a href="x" data-s3-key="${KEY}">`)).toBe(
			true,
		);
		expect(namesStoredObject(`<img DATA-S3-KEY="${KEY}">`)).toBe(true);
		expect(
			namesStoredObject(`<img src="https://storage.example.com/${KEY}">`),
		).toBe(true);
		expect(
			namesStoredObject(
				'<img src="https://cdn.example.com/x.png?X-Amz-Credential=a">',
			),
		).toBe(true);
		expect(
			namesStoredObject(
				'<img src="https://storage.example.com/project-brand/project-example/recipient-brand/current/logo.png">',
			),
		).toBe(true);
		expect(namesStoredObject('<a href="https://example.com">')).toBe(false);
	});
});
