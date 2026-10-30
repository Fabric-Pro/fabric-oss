/**
 * Shared editor → markdown serializer.
 *
 * This is the SINGLE source of truth for converting TipTap editor HTML back to
 * markdown when saving a document/feature. Three editors use it:
 *   - DocumentEditor.tsx        (project Documents / PRDs / Proposals)
 *   - StoryWorkspace.tsx        (Feature / UserStory editor)
 *   - DocumentGeneratorEditor.tsx (agent document generator)
 *
 * Previously each component carried its own copy of this logic, and the copies
 * had drifted: the Feature editor's copy was missing the custom `tiptapTable`
 * rule, so tables saved from it were emitted as a raw `<table>` HTML blob instead
 * of a GFM pipe table. Consolidating into one module is what prevents that class
 * of drift — a fix here applies everywhere.
 */

import {
	readDiagramCaption,
	withDiagramCaption,
} from "@repo/utils/proposal-artifact/visual-identity";
import type { Editor } from "@tiptap/core";
import TurndownService from "turndown";
// @ts-expect-error - turndown-plugin-gfm has no types
import { gfm } from "turndown-plugin-gfm";
import { stripResidualDiffMarkers } from "./diff-utils";
import {
	applyGfmStrikethroughFix,
	collapseAdjacentBoldSpans,
	disableEmphasisEscape,
	excalidrawAwareBlankReplacement,
	stripDiffTags,
} from "./editor-save-utils";

/**
 * Turndown rule for TipTap's Highlight mark (`<mark>`).
 *
 * Markdown has no highlight syntax, so the tag is emitted verbatim and read
 * back by `fromMarkdown` (MarkdownIt runs with `html: true`). `multicolor` is
 * on, so a toolbar highlight carries `data-color` plus an inline
 * `background-color` style; the colour is normalized onto `data-color` here so
 * the round trip does not depend on the style attribute surviving.
 *
 * Defined ONCE and registered on BOTH Turndown services — the main one and the
 * inline table-cell one. Registering it only on the main service is what
 * silently destroyed every highlight inside a table cell: cell content is
 * serialized by a separate service, whose default rule for an unknown inline
 * element keeps the text and drops the tag.
 */
const highlightMarkRule: TurndownService.Rule = {
	filter: (node: any) => node.nodeName === "MARK",
	replacement: (content: string, node: any) => {
		const el = node as HTMLElement;
		const color =
			el.getAttribute("data-color") || el.style?.backgroundColor;
		if (color) {
			return `<mark data-color="${color}">${content}</mark>`;
		}
		return `<mark>${content}</mark>`;
	},
};

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

function isDiffDeletion(node: Node): boolean {
	return (
		node.nodeName === "DEL" &&
		Boolean((node as Element).classList?.contains("diff-del"))
	);
}

/**
 * What `node` shows once the save has dropped the diff's deletions: any
 * text, else an image, else nothing.
 */
function visibleContent(node: Node): "text" | "image" | null {
	let image = false;
	for (const child of Array.from(node.childNodes)) {
		if (child.nodeType === TEXT_NODE) {
			if ((child.textContent ?? "").trim()) {
				return "text";
			}
			continue;
		}
		if (child.nodeType !== ELEMENT_NODE || isDiffDeletion(child)) {
			continue;
		}
		if (child.nodeName === "IMG") {
			image = true;
			continue;
		}
		const inner = visibleContent(child);
		if (inner === "text") {
			return "text";
		}
		image ||= inner === "image";
	}
	return image ? "image" : null;
}

/** A link's destination and title, as Turndown's own link rule writes them. */
function linkTarget(link: Element): string {
	const href = (link.getAttribute("href") ?? "").replace(/([()])/g, "\\$1");
	const title = (link.getAttribute("title") ?? "")
		.replace(/(\n+\s*)+/g, "\n")
		.replace(/"/g, '\\"');
	return title ? `${href} "${title}"` : href;
}

/**
 * Turndown rule for a link with no visible text (Fizzy #2946).
 *
 * Turndown keeps an empty `<a>` (it counts as meaningful when blank), so it
 * would save `[](url)`. One reaches the save when an accepted AI change
 * deletes a linked phrase: the diff marks the deleted text inside the link,
 * and stripping the deletion leaves the link with nothing in it. Saved, the
 * empty link keeps the destination the change removed — a finding revision's
 * accept is then refused, since its signed section fingerprint counts link
 * destinations. Such a link gives way to what it holds (a `<br>`, say).
 * Text inside a diff deletion is not counted, as the save drops it.
 *
 * A link around an image is kept, on one line: the image rule pads its
 * output with blank lines, which would split `[`…`](url)` apart.
 *
 * Registered on BOTH Turndown services, as the highlight rule is: a table
 * cell's content goes through the inline cell service.
 */
const emptyLinkRule: TurndownService.Rule = {
	filter: (node: any) =>
		node.nodeName === "A" && visibleContent(node) !== "text",
	replacement: (content: string, node: any) =>
		visibleContent(node) === "image" && node.getAttribute("href")
			? `[${content.trim()}](${linkTarget(node)})`
			: content,
};

// Inline Turndown service used to serialize the CONTENT of a single table cell.
// It is built from the SAME overrides as the main service (disableEmphasisEscape
// + applyGfmStrikethroughFix) so in-cell `**bold**`, `*italic*`, `code`, links,
// and `~~strikethrough~~` survive. A bare `new TurndownService()` would re-escape
// `*`/`_` and emit single-tilde strikethrough — re-introducing the exact corruption
// this fix removes, only inside cells. It deliberately has NO table rule (cells are
// never themselves tables) so there is no re-entrancy.
let inlineCellServiceSingleton: TurndownService | null = null;
function getInlineCellService(): TurndownService {
	if (inlineCellServiceSingleton) {
		return inlineCellServiceSingleton;
	}
	const service = new TurndownService({
		headingStyle: "atx",
		bulletListMarker: "-",
		emDelimiter: "*",
	});
	service.use(gfm);
	applyGfmStrikethroughFix(service);
	disableEmphasisEscape(service);
	// Highlights inside a cell go through this service, not the main one.
	service.addRule("highlightMark", highlightMarkRule);
	service.addRule("emptyLink", emptyLinkRule);
	inlineCellServiceSingleton = service;
	return service;
}

/**
 * Serialize a table cell's rich content to single-line inline markdown suitable
 * for a GFM table cell. Preserves inline marks, collapses any newlines (e.g. a
 * multi-paragraph cell) to a single space, and escapes pipe characters — including
 * pipes inside inline code — so they cannot split the row.
 */
function serializeTableCell(cell: HTMLElement): string {
	const inline = getInlineCellService().turndown(cell.innerHTML);
	return inline
		.replace(/\s*\n+\s*/g, " ")
		.trim()
		.replace(/\|/g, "\\|");
}

/**
 * Build a fully-configured Turndown service (GFM + project overrides + custom
 * rules for tables, fenced code, inline code, images, figures and mentions).
 *
 * Exported so tests can drive a fresh instance; production goes through the
 * memoized {@link getTurndownService} singleton.
 */
export function createTurndownService(): TurndownService {
	const service = new TurndownService({
		headingStyle: "atx",
		codeBlockStyle: "fenced",
		bulletListMarker: "-",
		emDelimiter: "*",
		// `---` is the form normalizeMarkdownForDiff rewrites every rule to, so
		// a saved rule matches the diff baseline instead of flipping spelling.
		hr: "---",
		// Preserve `<excalidraw-embed>` (an atomic, text-less node Turndown would
		// otherwise treat as blank and drop). See excalidrawAwareBlankReplacement.
		blankReplacement: excalidrawAwareBlankReplacement,
	});
	// GitHub Flavored Markdown: tables, strikethrough, task lists
	service.use(gfm);
	applyGfmStrikethroughFix(service);
	disableEmphasisEscape(service);

	// Custom rule for ALL tables - converts to GFM table format. This rule handles
	// all HTML tables, not just TipTap-specific ones, because:
	// 1. Tables from MarkdownIt→TipTap parsing may not have a tiptap-table class
	// 2. Tables may not have colgroup elements if not created through TipTap UI
	// 3. The GFM plugin's table handling doesn't work well with TipTap's HTML output
	service.addRule("tiptapTable", {
		filter: (node: any) => {
			return node.nodeName === "TABLE";
		},
		replacement: (_content: string, node: any) => {
			const rows = Array.from(
				node.querySelectorAll("tr"),
			) as HTMLElement[];
			if (rows.length === 0) {
				return "";
			}

			const tableRows: string[][] = [];
			let maxCols = 0;

			// Extract cell content from each row, preserving inline formatting.
			for (const row of rows) {
				const cells = Array.from(
					row.querySelectorAll("th, td"),
				) as HTMLElement[];
				const rowData: string[] = [];
				for (const cell of cells) {
					rowData.push(serializeTableCell(cell));
				}
				if (rowData.length > maxCols) {
					maxCols = rowData.length;
				}
				tableRows.push(rowData);
			}

			if (tableRows.length === 0 || maxCols === 0) {
				return "";
			}

			// Build markdown table
			let result = "\n";

			// First row (header)
			const headerRow = tableRows[0] || [];
			while (headerRow.length < maxCols) {
				headerRow.push("");
			}
			result += `| ${headerRow.join(" | ")} |\n`;

			// Separator row
			result += `| ${Array(maxCols).fill("---").join(" | ")} |\n`;

			// Data rows
			for (let i = 1; i < tableRows.length; i++) {
				const dataRow = tableRows[i] || [];
				while (dataRow.length < maxCols) {
					dataRow.push("");
				}
				result += `| ${dataRow.join(" | ")} |\n`;
			}

			return `${result}\n`;
		},
	});

	// Fenced code blocks with language (including mermaid)
	service.addRule("fencedCodeBlocks", {
		filter: (node: any) => {
			return (
				node.nodeName === "PRE" &&
				node.firstChild &&
				node.firstChild.nodeName === "CODE"
			);
		},
		replacement: (_content: string, node: any) => {
			const codeEl = node.firstChild as HTMLElement;
			const className = codeEl.getAttribute("class") || "";
			const match = className.match(/language-([a-z0-9+-]+)/i);
			const lang = match ? match[1] : "";
			let code = (codeEl.textContent || "").replace(/\s+$/g, "");
			// A diagram's caption is its `%% caption:` line. One an older
			// document kept as the node's attribute is written into the
			// body here, unless the body already has one.
			const legacyCaption = node.getAttribute?.("data-caption");
			if (
				lang === "mermaid" &&
				legacyCaption &&
				!readDiagramCaption(code)
			) {
				code = withDiagramCaption(code, legacyCaption);
			}
			return `\n\`\`\`${lang}\n${code}\n\`\`\`\n\n`;
		},
	});
	// Preserve inline code backticks
	service.addRule("inlineCodeTicks", {
		filter: (node: any) => node.nodeName === "CODE",
		replacement: (content: string) => `\`${content}\``,
	});

	// Preserve image width + caption in markdown using HTML <img> tags.
	// Standard markdown ![alt](src) loses the width attribute.
	// MarkdownIt with html:true will pass <img> tags through to TipTap.
	const buildImgTag = (imgEl: HTMLElement) => {
		const src = imgEl.getAttribute("src") || "";
		const alt = imgEl.getAttribute("alt") || "";
		const width =
			imgEl.getAttribute("data-width") ||
			imgEl.getAttribute("width") ||
			imgEl.style?.width ||
			"";
		const caption = imgEl.getAttribute("data-caption") || "";
		const s3Key = imgEl.getAttribute("data-s3-key") || "";

		// If no metadata to preserve, use standard markdown syntax
		if (!width && !caption && !s3Key) {
			return `\n\n![${alt}](${src})\n\n`;
		}

		const attrs = [`src="${src}"`, `alt="${alt}"`];
		if (width) {
			attrs.push(`width="${width}"`);
		}
		if (s3Key) {
			attrs.push(`data-s3-key="${s3Key}"`);
		}
		if (caption) {
			attrs.push(`data-caption="${caption.replace(/"/g, "&quot;")}"`);
		}
		return `\n\n<img ${attrs.join(" ")} />\n\n`;
	};

	service.addRule("imageWithWidth", {
		filter: (node: any) =>
			node.nodeName === "IMG" && node.getAttribute("src"),
		replacement: (_content: string, node: any) => buildImgTag(node),
	});
	// Handle figure > img + figcaption
	service.addRule("figureWithCaption", {
		filter: (node: any) =>
			node.nodeName === "FIGURE" && node.querySelector("img"),
		replacement: (_content: string, node: any) => {
			const img = node.querySelector("img") as HTMLImageElement | null;
			if (!img) {
				return "";
			}
			// Transfer figcaption text to data-caption on the img for serialization
			const figcaption = node.querySelector("figcaption");
			const caption = figcaption?.textContent?.trim() || "";
			if (caption && !img.getAttribute("data-caption")) {
				img.setAttribute("data-caption", caption);
			}
			// A linked image: the editor writes `<p><a><figure><img>`, and
			// parsing that HTML moves the figure out of the paragraph, with
			// the link rebuilt inside it around the image. A link around
			// the whole figure is written by the link rule instead.
			const link = img.closest("a[href]");
			if (link && node.contains(link)) {
				return `\n\n[${buildImgTag(img).trim()}](${linkTarget(link)})\n\n`;
			}
			return buildImgTag(img);
		},
	});
	service.addRule("mentionSpan", {
		filter: (node: any) =>
			node.nodeName === "SPAN" &&
			(node as HTMLElement).getAttribute("data-type") === "mention",
		replacement: (_content: string, node: any) =>
			(node as HTMLElement).outerHTML,
	});
	service.addRule("highlightMark", highlightMarkRule);
	service.addRule("emptyLink", emptyLinkRule);

	return service;
}

let turndownServiceSingleton: TurndownService | null = null;
/** Memoized shared Turndown service used by the save path. */
export function getTurndownService(): TurndownService {
	if (!turndownServiceSingleton) {
		turndownServiceSingleton = createTurndownService();
	}
	return turndownServiceSingleton;
}

/**
 * Convert the current editor HTML to Markdown for saving: strip diff tags, run
 * Turndown (GFM + custom rules), then drop any leftover diff marker characters.
 *
 * Returns `null` when the editor is absent or serialization throws — Fizzy
 * #1987: this used to return `""`, and callers wrote that straight to the DB as
 * `description: null`, so one Turndown exception wiped the document. `""` is
 * still returned for a genuinely empty document; callers MUST distinguish the
 * two and refuse to save on `null`.
 */
export function getEditorMarkdownForSave(
	editor: Pick<Editor, "getHTML"> | null,
): string | null {
	if (!editor) {
		return null;
	}
	try {
		const html = editor.getHTML();
		if (!html) {
			return "";
		}
		const sanitized = stripDiffTags(html);
		return stripResidualDiffMarkers(
			collapseAdjacentBoldSpans(getTurndownService().turndown(sanitized)),
		);
	} catch (error) {
		console.error("[editor-markdown-save] serialization failed", error);
		return null;
	}
}
