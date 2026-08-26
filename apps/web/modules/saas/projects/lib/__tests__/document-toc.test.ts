import { describe, expect, it } from "vitest";
import {
	buildDocumentTocTree,
	type DocumentTocItem,
	type DocumentTocTreeNode,
	extractDocumentToc,
	type TocSourceDoc,
	type TocSourceNode,
	tocItemsEqual,
} from "../document-toc";

interface FakeNode {
	name: string;
	text?: string;
	level?: number;
	children?: FakeNode[];
}

/**
 * Minimal stand-in for a ProseMirror document: walks the tree depth-first,
 * assigns increasing positions, and honors the callback's return value the
 * way `Node.descendants` does (false → skip children).
 */
function docFromNodes(nodes: FakeNode[]): TocSourceDoc {
	return {
		descendants(callback) {
			let pos = 0;
			const visit = (node: FakeNode) => {
				const sourceNode: TocSourceNode = {
					type: { name: node.name },
					attrs:
						node.level !== undefined ? { level: node.level } : {},
					textContent: node.text ?? "",
				};
				const nodePos = pos;
				pos += (node.text?.length ?? 0) + 2;
				const descend = callback(sourceNode, nodePos);
				if (descend !== false) {
					for (const child of node.children ?? []) {
						visit(child);
					}
				}
			};
			for (const node of nodes) {
				visit(node);
			}
		},
	};
}

function heading(text: string, level = 2): FakeNode {
	return { name: "heading", text, level };
}

describe("extractDocumentToc", () => {
	it("extracts headings in document order with level, text and position", () => {
		const doc = docFromNodes([
			heading("Overview", 1),
			{ name: "paragraph", text: "Some intro text." },
			heading("Use Cases", 2),
			heading("UC1: Navigation", 3),
		]);

		const items = extractDocumentToc(doc);

		expect(items.map((item) => item.text)).toEqual([
			"Overview",
			"Use Cases",
			"UC1: Navigation",
		]);
		expect(items.map((item) => item.level)).toEqual([1, 2, 3]);
		expect(items.map((item) => item.id)).toEqual([
			"overview",
			"use-cases",
			"uc1-navigation",
		]);
		// Positions are strictly increasing (document order).
		expect(items[0].pos).toBeLessThan(items[1].pos);
		expect(items[1].pos).toBeLessThan(items[2].pos);
	});

	it("ignores non-heading nodes, including markdown-looking code blocks", () => {
		const doc = docFromNodes([
			heading("Real Heading", 1),
			{ name: "codeBlock", text: "# not a heading" },
			{ name: "paragraph", text: "## also not a heading" },
		]);

		const items = extractDocumentToc(doc);

		expect(items).toHaveLength(1);
		expect(items[0].text).toBe("Real Heading");
	});

	it("returns an empty list for a document with no headings", () => {
		const doc = docFromNodes([
			{ name: "paragraph", text: "Just prose." },
			{ name: "codeBlock", text: "# comment" },
		]);

		expect(extractDocumentToc(doc)).toEqual([]);
	});

	it("dedupes duplicate heading titles with -1/-2 suffixes", () => {
		const doc = docFromNodes([
			heading("Overview"),
			heading("Overview"),
			heading("Overview"),
		]);

		expect(extractDocumentToc(doc).map((item) => item.id)).toEqual([
			"overview",
			"overview-1",
			"overview-2",
		]);
	});

	it("skips over manufactured collisions from literal numbered titles", () => {
		const doc = docFromNodes([
			heading("Overview"),
			heading("Overview 1"),
			heading("Overview"),
		]);

		expect(extractDocumentToc(doc).map((item) => item.id)).toEqual([
			"overview",
			"overview-1",
			"overview-2",
		]);
	});

	it("falls back to 'section' for headings that slugify to nothing", () => {
		const doc = docFromNodes([heading("!!!"), heading("   "), heading("")]);

		expect(extractDocumentToc(doc).map((item) => item.id)).toEqual([
			"section",
			"section-1",
			"section-2",
		]);
	});

	it("clamps heading levels to the 1-6 range and defaults missing levels to 1", () => {
		const doc = docFromNodes([
			heading("Too low", 0),
			heading("Too high", 9),
			{ name: "heading", text: "No level" },
		]);

		expect(extractDocumentToc(doc).map((item) => item.level)).toEqual([
			1, 6, 1,
		]);
	});

	it("normalizes internal whitespace in heading text", () => {
		const doc = docFromNodes([heading("  Hello \t  World  ", 2)]);

		const [item] = extractDocumentToc(doc);
		expect(item.text).toBe("Hello World");
		expect(item.id).toBe("hello-world");
	});

	it("does not descend into heading children", () => {
		const doc = docFromNodes([
			{
				name: "heading",
				text: "Parent",
				level: 1,
				children: [
					{ name: "heading", text: "Impossible child", level: 2 },
				],
			},
		]);

		const items = extractDocumentToc(doc);
		expect(items).toHaveLength(1);
		expect(items[0].text).toBe("Parent");
	});

	it("is deterministic across repeated extractions", () => {
		const doc = docFromNodes([
			heading("Alpha"),
			heading("Alpha"),
			heading("Beta"),
		]);

		expect(extractDocumentToc(doc)).toEqual(extractDocumentToc(doc));
	});

	it("extracts 150 headings well within the 200ms budget", () => {
		const doc = docFromNodes(
			Array.from({ length: 150 }, (_, i) =>
				heading(`Section ${i % 10}`, (i % 6) + 1),
			),
		);

		const start = performance.now();
		const items = extractDocumentToc(doc);
		const elapsed = performance.now() - start;

		expect(items).toHaveLength(150);
		expect(new Set(items.map((item) => item.id)).size).toBe(150);
		expect(elapsed).toBeLessThan(200);
	});
});

describe("buildDocumentTocTree", () => {
	const entry = (id: string, level: number, pos = 0): DocumentTocItem => ({
		id,
		text: id,
		level,
		pos,
	});

	const shape = (nodes: DocumentTocTreeNode[]): unknown =>
		nodes.map((node) => ({
			id: node.item.id,
			children: shape(node.children),
		}));

	it("nests each heading under the closest shallower heading", () => {
		const tree = buildDocumentTocTree([
			entry("h1", 1),
			entry("h2a", 2),
			entry("h3", 3),
			entry("h2b", 2),
		]);

		expect(shape(tree)).toEqual([
			{
				id: "h1",
				children: [
					{ id: "h2a", children: [{ id: "h3", children: [] }] },
					{ id: "h2b", children: [] },
				],
			},
		]);
	});

	it("tolerates skipped levels", () => {
		const tree = buildDocumentTocTree([entry("h1", 1), entry("h4", 4)]);

		expect(shape(tree)).toEqual([
			{ id: "h1", children: [{ id: "h4", children: [] }] },
		]);
	});

	it("treats a deeper opening heading as a root", () => {
		const tree = buildDocumentTocTree([entry("h3", 3), entry("h3b", 3)]);

		expect(shape(tree)).toEqual([
			{ id: "h3", children: [] },
			{ id: "h3b", children: [] },
		]);
	});

	it("starts a new root when the level climbs back out", () => {
		const tree = buildDocumentTocTree([
			entry("h2", 2),
			entry("h3", 3),
			entry("h1", 1),
		]);

		expect(shape(tree)).toEqual([
			{ id: "h2", children: [{ id: "h3", children: [] }] },
			{ id: "h1", children: [] },
		]);
	});

	it("keeps duplicate titles as separate nodes", () => {
		const tree = buildDocumentTocTree([
			{ id: "overview", text: "Overview", level: 2, pos: 0 },
			{ id: "overview-1", text: "Overview", level: 2, pos: 50 },
		]);

		expect(tree).toHaveLength(2);
		expect(tree.map((node) => node.item.id)).toEqual([
			"overview",
			"overview-1",
		]);
	});

	it("returns an empty array for no headings", () => {
		expect(buildDocumentTocTree([])).toEqual([]);
	});
});

describe("tocItemsEqual", () => {
	const item = (overrides: Partial<DocumentTocItem>): DocumentTocItem => ({
		id: "overview",
		text: "Overview",
		level: 1,
		pos: 0,
		...overrides,
	});

	it("treats position-only changes as equal", () => {
		expect(tocItemsEqual([item({ pos: 10 })], [item({ pos: 999 })])).toBe(
			true,
		);
	});

	it("detects changed text, level, id and length", () => {
		expect(tocItemsEqual([item({})], [item({ text: "Renamed" })])).toBe(
			false,
		);
		expect(tocItemsEqual([item({})], [item({ level: 3 })])).toBe(false);
		expect(tocItemsEqual([item({})], [item({ id: "other" })])).toBe(false);
		expect(tocItemsEqual([item({})], [])).toBe(false);
	});

	it("treats two empty lists as equal", () => {
		expect(tocItemsEqual([], [])).toBe(true);
	});
});
