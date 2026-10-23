/**
 * What of Main's own markup the Proposal export carries (Fizzy #2946), the
 * rules both writers share: which links stay links, which raw HTML is an
 * uploaded image, and what becomes of any other raw HTML.
 *
 * An uploaded image is the one raw HTML form the export reads. The editor
 * saves it as
 *
 *   <img src="…" alt="…" width="320" data-s3-key="document-media/…" data-caption="…" />
 *
 * with `alt` written unescaped, so quote balance proves nothing: each
 * attribute is read with its own pattern, an attribute that appears twice
 * refuses the tag, and the key must sit under this document's own media
 * prefix (the guard `resolve-media-urls` applies). `src` is never read: the
 * bytes come from storage by key, never from a URL.
 */

import type { Table } from "mdast";

/**
 * A table with more columns than this prints on a landscape page of its own,
 * in the PDF and in the Word file alike.
 */
export const PORTRAIT_MAX_COLUMNS = 6;

/** Whether a table is too wide for a portrait page. */
export function isWideTable(table: Table): boolean {
	const columns = Math.max(
		table.align?.length ?? 0,
		...table.children.map((row) => row.children.length),
	);
	return columns > PORTRAIT_MAX_COLUMNS;
}

/** `<br>`, `<br/>` and `<br />`, in any case. */
const LINE_BREAK_TAG = /^<br\s*\/?>$/i;

/** Whether raw HTML is a line break, the one tag both writers draw. */
export function isLineBreakTag(html: string): boolean {
	return LINE_BREAK_TAG.test(html.trim());
}

/** Longest href the export keeps as a link. */
const MAX_HREF_LENGTH = 2048;

/** A same-document fragment: `#`, then an id-like name. */
const FRAGMENT_HREF = /^#[A-Za-z0-9._~:-]{0,200}$/;

/**
 * A reference to a stored object: the key prefix of a document's media, a
 * project's or an organization's brand assets, a story's media or attachments, a workspace file
 * or an export, or a presigned URL's signature, which grants whoever holds
 * it the object. Exported files carry neither. Only prefixes no ordinary
 * prose or public URL path uses are listed (not `projects/` or `docs/`).
 */
export const STORAGE_REFERENCE =
	/(?:document-media|project-brand|organization-brand|story-media|story-attachments|workspace-files|proposal-exports)\/|X-Amz-(?:Signature|Credential)=/i;

/**
 * A run of URL characters that holds a storage reference. It stops at the
 * quotes, brackets and angle brackets a URL is written between, so removing
 * it leaves the Markdown, code or diagram syntax around it intact.
 */
const STORAGE_REFERENCE_TOKEN = new RegExp(
	`[^\\s"'<>()\\[\\]{}\`]*(?:${STORAGE_REFERENCE.source})[^\\s"'<>()\\[\\]{}\`]*`,
	"gi",
);

/** Text with every token that refers to a stored object removed. */
export function withoutStorageReferences(text: string): string {
	return text.replace(STORAGE_REFERENCE_TOKEN, "");
}

/**
 * The href a link keeps, or null when it is printed as its text only. Kept:
 * `http:`, `https:` and `mailto:` URLs without credentials, and `#fragment`
 * links. Everything else (`javascript:`, `file:`, `data:`, UNC paths,
 * relative paths, a URL to a stored object, anything unparseable) loses
 * its link.
 */
export function safeLinkHref(url: string | null | undefined): string | null {
	if (typeof url !== "string") {
		return null;
	}
	const trimmed = url.trim();
	if (trimmed === "" || trimmed.length > MAX_HREF_LENGTH) {
		return null;
	}
	// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing them is the point
	if (/[\u0000- \u007f\\]/.test(trimmed)) {
		return null;
	}
	if (trimmed.startsWith("#")) {
		return FRAGMENT_HREF.test(trimmed) ? trimmed : null;
	}
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		return null;
	}
	if (parsed.protocol === "mailto:") {
		return parsed.href;
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return null;
	}
	if (STORAGE_REFERENCE.test(trimmed)) {
		return null;
	}
	if (parsed.username !== "" || parsed.password !== "" || !parsed.hostname) {
		return null;
	}
	return parsed.href;
}

/** The storage prefix of one document's uploaded media. */
export function documentMediaPrefix(
	projectId: string,
	documentId: string,
): string {
	return `document-media/${projectId}/${documentId}/`;
}

/** A file name under the media prefix: no separators, no dot segments. */
const MEDIA_FILE_NAME =
	/^[A-Za-z0-9][A-Za-z0-9_-]{0,200}(?:\.[A-Za-z0-9]{1,10})?$/;

/** Whether `key` is one of this document's own uploaded media objects. */
export function isDocumentMediaKey(
	key: string,
	projectId: string,
	documentId: string,
): boolean {
	const prefix = documentMediaPrefix(projectId, documentId);
	return (
		key.startsWith(prefix) && MEDIA_FILE_NAME.test(key.slice(prefix.length))
	);
}

/** An uploaded image as Main places it. */
export interface UploadedImageTag {
	/** The storage key, not yet checked against any document's prefix. */
	key: string;
	/** Alternative text, decoded, possibly empty. */
	alt: string;
	/** The caption, decoded, or null. */
	caption: string | null;
	/** The width the editor set, `320px` or `50%`, or null. */
	width: string | null;
}

/**
 * Exactly one `<img …>` or `<img … />` tag and nothing else. A quoted value
 * may hold `<` and `>` (an alt or caption such as "Before -> after").
 */
const SINGLE_IMG_TAG = /^<img\s(?:[^"<>]|"[^"]*")*>$/i;

function attributeValues(tag: string, name: string): string[] {
	const pattern = new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`, "gi");
	return Array.from(tag.matchAll(pattern), (match) => match[1] ?? "");
}

/** A complete HTML comment, which the live page never shows. */
const HTML_COMMENT = /<!--[\s\S]*?-->/g;

/** The start of an image tag, whether or not the rest is well formed. */
const IMAGE_TAG_START = /^<img\s/i;

/**
 * Whether raw HTML names a stored object: an uploaded image or file link
 * carries its storage key, its media path or a signed URL. Such HTML is
 * never printed as its text; when it is not an uploaded image the export
 * accepts, it is left out.
 */
export function namesStoredObject(html: string): boolean {
	return /\sdata-s3-key\s*=/i.test(html) || STORAGE_REFERENCE.test(html);
}

/**
 * What a writer does with raw HTML that is not an uploaded image it
 * accepts:
 * - `break`: a `<br>`, the one tag both writers draw;
 * - `omit`: nothing at all, for a comment and for HTML that names a stored
 *   object (the image reader has already reported a refused upload);
 * - `external-image`: nothing, for an image tag with no stored upload, which
 *   the export never fetches by URL, reported as `EXTERNAL_IMAGE_DROPPED`;
 * - `text`: anything else, printed as written, less any comments it holds.
 */
export type RawHtmlFallback =
	| { kind: "break" }
	| { kind: "omit" }
	| { kind: "external-image" }
	| { kind: "text"; text: string };

export function rawHtmlFallback(html: string): RawHtmlFallback {
	const value = html.trim();
	if (isLineBreakTag(value)) {
		return { kind: "break" };
	}
	if (namesStoredObject(value)) {
		return { kind: "omit" };
	}
	if (IMAGE_TAG_START.test(value)) {
		return { kind: "external-image" };
	}
	const text = html.replace(HTML_COMMENT, "");
	return text.trim() === "" ? { kind: "omit" } : { kind: "text", text };
}

function decodeEntities(text: string): string {
	return text
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&");
}

/**
 * The uploaded image a block of raw HTML is, or null when it is anything
 * else: more than one tag, no storage key, or a key, width or caption
 * written twice. Its alt and caption are printed, so they lose any storage
 * reference written into them.
 */
export function readUploadedImageTag(html: string): UploadedImageTag | null {
	const tag = html.trim();
	if (!SINGLE_IMG_TAG.test(tag)) {
		return null;
	}
	const keys = attributeValues(tag, "data-s3-key");
	const captions = attributeValues(tag, "data-caption");
	const widths = attributeValues(tag, "width");
	if (keys.length !== 1 || captions.length > 1 || widths.length > 1) {
		return null;
	}
	const key = keys[0] ?? "";
	if (key === "") {
		return null;
	}
	const width = widths[0]?.trim() ?? "";
	const caption =
		captions[0] === undefined
			? null
			: withoutStorageReferences(decodeEntities(captions[0]));
	return {
		key,
		alt: withoutStorageReferences(
			decodeEntities(attributeValues(tag, "alt")[0] ?? ""),
		),
		caption: caption?.trim() ? caption.trim() : null,
		width: /^\d{1,4}(?:px)?$/.test(width)
			? `${Number.parseInt(width, 10)}px`
			: /^\d{1,3}%$/.test(width) && Number.parseInt(width, 10) <= 100
				? width
				: null,
	};
}
