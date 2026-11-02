/**
 * What of Main's own markup the Proposal export carries (Fizzy #2946), the
 * rules both writers share: which links stay links, which raw HTML is an
 * uploaded image, and what becomes of any other raw HTML; which title the
 * document prints under, which cover details and cover letter it has, and
 * which tables print wide or without their header row.
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

import {
	COVER_LANGUAGE,
	type CoverDetails,
	parseCover,
} from "@repo/utils/proposal-artifact/cover-fence";
import { coverLetterLabel } from "@repo/utils/proposal-artifact/cover-letter-heading";
import {
	STORAGE_REFERENCE,
	withoutStorageReferences,
} from "@repo/utils/proposal-artifact/storage-references";
import type {
	Code,
	Heading,
	Nodes,
	Paragraph,
	Root,
	RootContent,
	Table,
} from "mdast";
import { eachNode } from "./markdown";
import { isImageParagraph, plainText } from "./print-markup";

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

/**
 * Whether a node prints something a reader sees: text, an image, a footnote
 * call, or raw HTML printed as its text. A line break, a comment or a
 * storage reference prints nothing.
 */
function printsSomething(node: Nodes): boolean {
	let something = false;
	eachNode(node, (child) => {
		switch (child.type) {
			case "text":
			case "inlineCode":
				something ||= child.value.trim() !== "";
				break;
			case "image":
			case "imageReference":
			case "footnoteReference":
				something = true;
				break;
			case "html": {
				const fallback = rawHtmlFallback(child.value);
				something ||=
					readUploadedImageTag(child.value) !== null ||
					fallback.kind === "external-image" ||
					fallback.kind === "text";
				break;
			}
		}
	});
	return something;
}

/**
 * Whether a table's header row is empty: every cell holds no text and no
 * image. Print then leaves the row out, and Word does too, so a table
 * written with a blank header reads as plain rows, as the reader meant.
 */
export function hasEmptyHeaderRow(node: Table): boolean {
	const [head] = node.children;
	return head?.children.every((cell) => !printsSomething(cell)) ?? false;
}

/**
 * The rows a data table writes: all of them, or all but a header row with
 * nothing in it, which is left out as print leaves it out.
 */
export function writtenRows(table: Table): Table["children"] {
	return hasEmptyHeaderRow(table) ? table.children.slice(1) : table.children;
}

/**
 * The H1 Main opens with, when it is the document's printed title: it is
 * Main's first block, Main has sections (an H2) after it, and it has text of
 * its own. Then the cover, the contents page, the running furniture and the
 * file's own title show its text, and the body leaves it out, so it never
 * prints alone on a page. Otherwise null, and an H1 prints in the body as
 * written. Read from the prepared tree, so storage references and citations
 * are already gone from it.
 */
function leadingTitleHeading(root: Root): Heading | null {
	const [first] = root.children;
	if (first?.type !== "heading" || first.depth !== 1) {
		return null;
	}
	if (
		!root.children.some(
			(node) => node.type === "heading" && node.depth === 2,
		)
	) {
		return null;
	}
	return plainText(first) === "" ? null : first;
}

/**
 * The title the document prints under: the text of Main's leading H1 when
 * it is the title, or else the record's own title. The H1 wins when they
 * differ: it is the client-facing title the page shows, while the record
 * title names the file in the workspace (and still names the download).
 */
export function printedTitle(
	root: Root,
	recordTitle: string,
): { heading: Heading | null; text: string } {
	const heading = leadingTitleHeading(root);
	return {
		heading,
		text: heading ? plainText(heading) : recordTitle.trim(),
	};
}

/** Whether Main has sections: a root-level H2. */
function hasSections(root: Root): boolean {
	return root.children.some(
		(node) => node.type === "heading" && node.depth === 2,
	);
}

/** The `cover` fence a cover reads its details from, and those details. */
export interface CoverFence {
	/** The fence itself, which neither body prints. */
	node: Code;
	details: CoverDetails;
}

/**
 * The cover details Main's preamble sets: its first `cover` fence, when the
 * parser takes it. The preamble is the one the cover's lead and key figures
 * come from: what comes before the first heading, past one H1 that opens
 * Main, and only when Main has sections at all. The first `cover` fence
 * there decides, as the first stat tiles block does: a refused one sets
 * nothing. Neither body prints a fence the parser takes, read or not (see
 * `isCoverFence`); a refused one prints as code, as a fence without a form
 * of its own does, so its author sees it was not used.
 */
export function coverFence(root: Root): CoverFence | null {
	if (!hasSections(root)) {
		return null;
	}
	const opener = root.children[0];
	const start = opener?.type === "heading" && opener.depth === 1 ? 1 : 0;
	for (const node of root.children.slice(start)) {
		if (node.type === "heading") {
			return null;
		}
		if (node.type === "code" && node.lang === COVER_LANGUAGE) {
			const parsed = parseCover(node.value);
			return parsed.ok
				? {
						node,
						details: {
							eyebrow: parsed.eyebrow,
							organization: parsed.organization,
							forLines: parsed.forLines,
							byLines: parsed.byLines,
							version: parsed.version,
						},
					}
				: null;
		}
	}
	return null;
}

/**
 * Whether a fence is a `cover` block the parser takes. Neither body prints
 * one: the cover reads the first in the preamble, and the editor shows any
 * other as a summary card, so printing it as code would show the reader a
 * source the page never does. A refused block is not one, and prints as
 * code beside the editor's reason.
 */
export function isCoverFence(node: Code): boolean {
	return node.lang === COVER_LANGUAGE && parseCover(node.value).ok;
}

/** A version written with its own word or letter, such as "v2" or "Version 3". */
const WRITTEN_VERSION = /^v/i;

/**
 * A cover version as the date line prints it: "Version 12" for a bare
 * value, and a value that already names itself ("v2.1", "Version 3", in any
 * case) as written.
 */
export function coverVersionLabel(version: string): string {
	return WRITTEN_VERSION.test(version) ? version : `Version ${version}`;
}

/** Main's cover letter: its first section, when that section is one. */
export interface CoverLetter {
	/** The letter's H2, which no contents lists and no opener prints. */
	heading: Heading;
	/** The heading's text without its number, for the letter's label. */
	label: string;
	/** The root-level blocks after the heading, up to the next H2. */
	nodes: RootContent[];
}

/**
 * The cover letter: Main's first H2 when its text, a typed number aside,
 * is "Cover letter" or "Anschreiben" in any case (`coverLetterLabel`), with
 * what follows it up to the next H2. Only the first H2 can open one, so a
 * later section of that name prints as a section. Both writers print it
 * after the cover and before the contents, as a letter, never as a numbered
 * section, and the visuals step reads the same rule, so the letter never
 * gets a diagram and no section loses one.
 */
export function coverLetter(root: Root): CoverLetter | null {
	const children = root.children;
	const start = children.findIndex(
		(node) => node.type === "heading" && node.depth === 2,
	);
	const heading = children[start];
	if (heading?.type !== "heading") {
		return null;
	}
	const label = coverLetterLabel(plainText(heading));
	if (label === null) {
		return null;
	}
	const nodes: RootContent[] = [];
	for (const node of children.slice(start + 1)) {
		if (node.type === "heading" && node.depth === 2) {
			break;
		}
		nodes.push(node);
	}
	return { heading, label, nodes };
}

/**
 * What a paragraph of the cover letter is, beyond prose: the date, the
 * subject line, the signer's name and the line under it.
 */
export type LetterRole = "date" | "subject" | "signer" | "signerRole";

/** The longest letter paragraph, in characters, read as its date. */
const LETTER_DATE_MAX_CHARACTERS = 40;

/**
 * A digit, which every written date has; without one, a short first line
 * is the salutation ("Dear Jordan Example,"), not the date.
 */
const LETTER_DATE_DIGIT = /\p{Nd}/u;

/** A subject line: "Re:" in any case. */
const LETTER_SUBJECT = /^re:/i;

/** Whether a paragraph is written on one line: no break, hard or soft. */
function isOneLine(node: Paragraph): boolean {
	let oneLine = true;
	eachNode(node, (child) => {
		if (
			child.type === "break" ||
			(child.type === "text" && /[\r\n]/.test(child.value))
		) {
			oneLine = false;
		}
	});
	return oneLine;
}

/** Whether a paragraph is bold text and nothing else. */
function isWhollyBold(node: Paragraph): boolean {
	const meaningful = node.children.filter(
		(child) => !(child.type === "text" && child.value.trim() === ""),
	);
	return (
		meaningful.length > 0 &&
		meaningful.every((child) => child.type === "strong") &&
		plainText(node) !== ""
	);
}

/**
 * The roles of a cover letter's root-level paragraphs, as both writers set
 * them:
 *
 * - its first block, when that is a paragraph of one line, at most 40
 *   characters and with a digit in it, is the date;
 * - a paragraph starting "Re:" is the subject line, and never the date or
 *   the signer;
 * - the last paragraph that is bold and nothing else is the signer's name,
 *   and a paragraph right after it is the line under it.
 *
 * Any other paragraph, and every other block, is the letter's prose.
 */
export function letterRoles(
	nodes: readonly RootContent[],
): Map<Paragraph, LetterRole> {
	const roles = new Map<Paragraph, LetterRole>();
	for (const node of nodes) {
		if (node.type === "paragraph" && LETTER_SUBJECT.test(plainText(node))) {
			roles.set(node, "subject");
		}
	}
	const first = nodes[0];
	if (first?.type === "paragraph" && !roles.has(first)) {
		const text = plainText(first);
		if (
			Array.from(text).length <= LETTER_DATE_MAX_CHARACTERS &&
			LETTER_DATE_DIGIT.test(text) &&
			isOneLine(first) &&
			!isImageParagraph(first)
		) {
			roles.set(first, "date");
		}
	}
	for (let index = nodes.length - 1; index >= 0; index--) {
		const node = nodes[index];
		if (
			node?.type === "paragraph" &&
			!roles.has(node) &&
			isWhollyBold(node)
		) {
			roles.set(node, "signer");
			const next = nodes[index + 1];
			if (next?.type === "paragraph" && !roles.has(next)) {
				roles.set(next, "signerRole");
			}
			break;
		}
	}
	return roles;
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

// The rule lives in @repo/utils, where the browser's Markdown download of
// the same document applies it too; the export's modules read it here.
export { STORAGE_REFERENCE, withoutStorageReferences };

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
