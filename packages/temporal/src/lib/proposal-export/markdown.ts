/**
 * Main as both export writers read it (Fizzy #2946): size-checked, visual
 * slot tags and the citation apparatus removed, parsed once into mdast.
 *
 * The citation apparatus is removed twice. The line scrubber (the same one
 * the Markdown download runs) works on text, before parsing; it pairs fences
 * by a simpler rule than the parser does, so a fence left open inside a list
 * item would hide everything after it from that scrubber. So the parsed tree
 * is scrubbed again by the same rules, where block boundaries are exact:
 * Source Index sections at the top level, citation markers in text, and links
 * whose whole text is a marker.
 *
 * Text and code, fences and diagrams included, lose any token that refers
 * to a stored object (an upload's media path or a presigned URL), so a link
 * pasted into Main never hands the file's reader an object or the
 * document's ids.
 *
 * An uploaded image tag the parser could not read as HTML (the editor
 * writes `alt` unescaped, so a quote in a file name breaks the tag) would
 * otherwise reach the writers as a paragraph of text, storage key and
 * signed URL included. The tree pass hands such a paragraph back as the raw
 * HTML it is, so the rules for raw HTML apply to it as to any other.
 *
 * The print page and the DOCX writer walk the same tree, and both look a
 * diagram fence up in `diagramIndex` rather than counting fences as they go,
 * so the two can never pair a fence with another fence's render.
 */

import { stripVisualSlots } from "@repo/utils/glossy/visual-slots";
import {
	isSourceIndexHeading,
	scrubCitationText,
	scrubProposalExport,
} from "@repo/utils/proposal-artifact/export-scrub";
import { parseMarkdownAst } from "@repo/utils/proposal-artifact/markdown-ast";
import { isDiagramFence } from "@repo/utils/proposal-artifact/section-hash";
import {
	readDiagramCaption,
	withDiagramCaption,
} from "@repo/utils/proposal-artifact/visual-identity";
import type { Code, Html, Nodes, Root, RootContent } from "mdast";
import {
	STORAGE_REFERENCE,
	withoutStorageReferences,
} from "./document-content";
import { exportFailure } from "./failures";
import { PROPOSAL_EXPORT_LIMITS } from "./types";

export interface PreparedExportMarkdown {
	root: Root;
	/**
	 * Each diagram fence's source, in document order, without its caption
	 * line: the caption prints under the figure, from the fence itself.
	 */
	diagramSources: string[];
	/** A diagram fence's position in `diagramSources`. */
	diagramIndex: ReadonlyMap<Code, number>;
}

/**
 * Scrub and parse Main for export. Main larger than one export reads fails
 * the export before anything is parsed; it is never cut, because a silently
 * shortened client document is worse than an error.
 */
export function prepareExportMarkdown(content: string): PreparedExportMarkdown {
	if (content.length > PROPOSAL_EXPORT_LIMITS.maxMarkdownLength) {
		throw exportFailure("DOCUMENT_TOO_LARGE");
	}
	const scrubbed = scrubProposalExport(stripVisualSlots(content)).markdown;
	let root: Root;
	try {
		root = parseMarkdownAst(scrubbed);
	} catch (error) {
		// The parser recurses per nesting level, so thousands of nested
		// quotes or emphasis runs overflow the stack. No retry parses it
		// either: it is a document too deep to export, not a failure.
		if (error instanceof RangeError) {
			throw exportFailure("DOCUMENT_TOO_LARGE");
		}
		throw error;
	}
	scrubTree(root, scrubbed);

	const diagramSources: string[] = [];
	const diagramIndex = new Map<Code, number>();
	eachNode(root, (node) => {
		if (node.type === "code" && isDiagramFence(node.lang, node.value)) {
			diagramIndex.set(node, diagramSources.length);
			diagramSources.push(withDiagramCaption(node.value, null));
		}
	});
	return { root, diagramSources, diagramIndex };
}

/** A link whose whole text is a citation label: `[S3](#…)`, `[cite](…)`. */
const MARKER_LINK_TEXT =
	/^\s*(?:S\d{1,4}(?:\s{0,2}[,;–—-]\s{0,2}S?\d{1,4}){0,20}|cite\b[^\n]{0,80})\s*$/i;

/** The start of an image tag, whether or not the rest is well formed. */
const IMAGE_TAG_START = /^\s*<img\s/i;

/**
 * The tree scrubbed by the line scrubber's rules: top-level Source Index
 * sections (the heading and everything up to the next heading of the same
 * or a higher level), citation markers in text, and marker links. Storage
 * references leave text and code, links to stored objects keep only
 * their text, and a paragraph that is an image tag the parser could not
 * read becomes raw HTML.
 */
function scrubTree(root: Root, markdown: string): void {
	const kept: RootContent[] = [];
	let droppingFrom: number | null = null;
	for (const [index, node] of root.children.entries()) {
		if (node.type === "heading") {
			if (droppingFrom !== null && node.depth <= droppingFrom) {
				droppingFrom = null;
			}
			if (
				droppingFrom === null &&
				isSourceIndexHeading(
					plainText(node),
					firstLineOf(root.children[index + 1], markdown),
				)
			) {
				droppingFrom = node.depth;
				continue;
			}
		}
		if (droppingFrom === null) {
			kept.push(node);
		}
	}
	root.children = kept;

	eachNode(root, (node) => {
		if (node.type === "text") {
			node.value = withoutStorageReferences(
				scrubCitationText(node.value).text,
			);
		} else if (node.type === "inlineCode" || node.type === "code") {
			node.value = withoutStorageReferences(node.value);
		} else if ("children" in node) {
			const children = node.children as Nodes[];
			let changed = false;
			const remaining: Nodes[] = [];
			for (const child of children) {
				if (
					child.type === "link" &&
					MARKER_LINK_TEXT.test(plainText(child))
				) {
					changed = true;
					continue;
				}
				// A link or definition to a stored object keeps only its text.
				if (
					child.type === "link" &&
					STORAGE_REFERENCE.test(child.url)
				) {
					changed = true;
					remaining.push(...(child.children as Nodes[]));
					continue;
				}
				if (
					child.type === "definition" &&
					STORAGE_REFERENCE.test(child.url)
				) {
					changed = true;
					continue;
				}
				const unread = unreadImageTag(child, markdown);
				changed ||= unread !== child;
				remaining.push(unread);
			}
			if (changed) {
				(node as { children: Nodes[] }).children = remaining;
			}
		}
	});
}

/**
 * A paragraph whose source opens with an image tag but which the parser
 * read as text, as the raw HTML it is; any other node as it was. A
 * paragraph that opens with a tag the parser did read (an inline uploaded
 * image followed by words) is left alone.
 */
function unreadImageTag(node: Nodes, markdown: string): Nodes {
	if (node.type !== "paragraph" || node.children[0]?.type === "html") {
		return node;
	}
	const start = node.position?.start.offset;
	const end = node.position?.end.offset;
	if (start === undefined || end === undefined) {
		return node;
	}
	const source = markdown.slice(start, end);
	if (!IMAGE_TAG_START.test(source)) {
		return node;
	}
	const html: Html = { type: "html", value: source, position: node.position };
	return html;
}

/** The first line of a node's source, or null when there is none. */
function firstLineOf(
	node: RootContent | undefined,
	markdown: string,
): string | null {
	const start = node?.position?.start.offset;
	const end = node?.position?.end.offset;
	if (start === undefined || end === undefined) {
		return null;
	}
	return markdown.slice(start, end).split("\n")[0] ?? null;
}

/**
 * A subtree's text as both writers print a heading or a contents entry:
 * text and code, a hard break as a space, no markup and no raw HTML.
 */
export function flatText(node: Nodes): string {
	const parts: string[] = [];
	eachNode(node, (child) => {
		if (
			child.type === "text" ||
			child.type === "inlineCode" ||
			child.type === "code"
		) {
			parts.push(child.value);
		} else if (child.type === "break") {
			parts.push(" ");
		}
	});
	return parts.join("");
}

/**
 * A node's text as the line scrubber reads a heading: its text and inline
 * code, run together.
 */
function plainText(node: Nodes): string {
	let text = "";
	eachNode(node, (child) => {
		if (child.type === "text" || child.type === "inlineCode") {
			text += child.value;
		}
	});
	return text;
}

/**
 * Every node, depth first, in document order, each before its children.
 * Iterative, so a deeply nested tree the parser did accept cannot overflow
 * the stack here.
 */
export function eachNode(root: Nodes, visit: (node: Nodes) => void): void {
	const stack: Nodes[] = [root];
	while (stack.length > 0) {
		const node = stack.pop() as Nodes;
		visit(node);
		if ("children" in node) {
			for (let index = node.children.length - 1; index >= 0; index--) {
				stack.push(node.children[index] as Nodes);
			}
		}
	}
}

/**
 * A diagram's caption as an export prints it: without citation markers, by
 * the rule prose follows, so no `[S#]` reaches a client document. Null when
 * the fence has no caption or nothing is left of it.
 */
export function exportDiagramCaption(source: string): string | null {
	const caption = readDiagramCaption(source);
	if (caption === null) {
		return null;
	}
	const scrubbed = scrubCitationText(caption).text.trim();
	return scrubbed === "" ? null : scrubbed;
}
