import { slugifyHeadline } from "@shared/lib/content";

/**
 * Table-of-contents extraction for TipTap documents.
 *
 * The ToC is derived from the ProseMirror document tree (not the rendered
 * DOM), so it works for local edits, collaborative Yjs transactions and
 * streaming generation alike, and `#` lines inside code blocks never show
 * up as headings. Each item carries the node's ProseMirror position —
 * navigation resolves headings by position, so duplicate heading titles
 * are unambiguous. The slug `id` is a stable identity (React keys,
 * announcements, tests), not a DOM anchor.
 */

export interface DocumentTocItem {
	/** Deterministic slug, deduped with -1/-2 suffixes for repeated titles. */
	id: string;
	text: string;
	/** Heading level clamped to 1–6. */
	level: number;
	/** ProseMirror position immediately before the heading node. */
	pos: number;
}

/**
 * Structural subset of a ProseMirror node/document so the extractor can be
 * unit-tested with plain objects and stays free of TipTap imports.
 */
export interface TocSourceNode {
	type: { name: string };
	attrs?: Record<string, unknown>;
	textContent: string;
}

export interface TocSourceDoc {
	descendants(
		callback: (node: TocSourceNode, pos: number) => boolean | undefined,
	): void;
}

export const DOCUMENT_TOC_STORAGE_KEY = "fabric-document-toc-expanded";
export const DOCUMENT_TOC_DEBOUNCE_MS = 200;

export function extractDocumentToc(doc: TocSourceDoc): DocumentTocItem[] {
	const items: DocumentTocItem[] = [];
	const usedIds = new Set<string>();

	doc.descendants((node, pos) => {
		if (node.type.name !== "heading") {
			return true;
		}

		const rawLevel = Number(node.attrs?.level);
		const level = Number.isFinite(rawLevel)
			? Math.min(6, Math.max(1, rawLevel))
			: 1;
		const text = node.textContent.replace(/\s+/g, " ").trim();

		// The while-guard also covers manufactured collisions, e.g. a literal
		// "Overview 1" heading occupying the slot a duplicate "Overview"
		// would otherwise dedupe into.
		const base = slugifyHeadline(text) || "section";
		let id = base;
		let suffix = 0;
		while (usedIds.has(id)) {
			suffix += 1;
			id = `${base}-${suffix}`;
		}
		usedIds.add(id);

		items.push({ id, text, level, pos });
		// Headings only contain inline content — no nested headings to visit.
		return false;
	});

	return items;
}

export interface DocumentTocTreeNode {
	item: DocumentTocItem;
	children: DocumentTocTreeNode[];
}

/**
 * Nest a flat heading list by level so the panel can render real nested
 * lists — indentation alone conveys hierarchy to sighted users only, and
 * with duplicate titles a flat list is genuinely ambiguous to a screen
 * reader (WCAG 1.3.1).
 *
 * Skipped levels are tolerated: an H3 following an H1 nests under it, and
 * a document whose first heading is an H3 still yields a root entry.
 */
export function buildDocumentTocTree(
	items: DocumentTocItem[],
): DocumentTocTreeNode[] {
	const roots: DocumentTocTreeNode[] = [];
	const ancestors: DocumentTocTreeNode[] = [];

	for (const item of items) {
		const node: DocumentTocTreeNode = { item, children: [] };
		while (
			ancestors.length > 0 &&
			ancestors[ancestors.length - 1].item.level >= item.level
		) {
			ancestors.pop();
		}
		if (ancestors.length === 0) {
			roots.push(node);
		} else {
			ancestors[ancestors.length - 1].children.push(node);
		}
		ancestors.push(node);
	}

	return roots;
}

/**
 * Structural equality ignoring `pos`: typing in a paragraph shifts every
 * position after it, but the panel only needs to re-render when a heading's
 * identity, title or level actually changes. Fresh positions are kept in a
 * ref by the hook.
 */
export function tocItemsEqual(
	a: DocumentTocItem[],
	b: DocumentTocItem[],
): boolean {
	if (a.length !== b.length) {
		return false;
	}
	for (let i = 0; i < a.length; i++) {
		if (
			a[i].id !== b[i].id ||
			a[i].text !== b[i].text ||
			a[i].level !== b[i].level
		) {
			return false;
		}
	}
	return true;
}
