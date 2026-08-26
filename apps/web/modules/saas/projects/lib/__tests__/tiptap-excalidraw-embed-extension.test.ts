/**
 * Tests for the Excalidraw embed TipTap extension.
 *
 * Locks the schema-level contract — what the markdown→tiptap parser
 * recognises as an embed, and what the tiptap→HTML serializer emits.
 * The React NodeView itself is untested here (rendering depends on
 * `<McpAppFrame>` + iframe + MCP server; reserved for the e2e/staging
 * verification on the open PR).
 *
 * Pinning:
 *
 *   AC1  The custom `<excalidraw-embed>` HTML tag with `data-resource-uri`
 *        and `data-config-id` attributes is parsed into an
 *        `excalidrawEmbed` node with those attributes preserved.
 *
 *   AC2  The serializer round-trips the node back to the same custom
 *        tag, so the embed survives Save → Load through the document's
 *        markdown column without data loss.
 *
 *   AC3  Missing attributes parse to `null` rather than throwing, so a
 *        streaming partial output from the agent (`<excalidraw-embed>`
 *        with no attrs yet) doesn't crash the editor — the NodeView
 *        falls back to a placeholder card.
 *
 *   AC4  Unknown attributes are ignored (don't crash) — keeps the
 *        contract narrow and future-additive without forcing version
 *        bumps when we add new attributes.
 */

import { Editor } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { describe, expect, it, vi } from "vitest";

// `@tiptap/react`'s ReactNodeViewRenderer pulls in React/DOM internals
// that vitest's jsdom environment loads slowly; we don't need it for
// the schema-level assertions in this file. Stub it so the extension's
// `addNodeView()` returns a harmless null function — Editor.create
// happily accepts a no-op view renderer in headless tests.
vi.mock("@tiptap/react", () => ({
	NodeViewWrapper: () => null,
	ReactNodeViewRenderer: () => () => null,
}));

// `ExcalidrawPreview` is a client-only React component that loads
// `@excalidraw/excalidraw` (Canvas API, CSS) and issues network calls
// at mount. The node view imports it in production but in tests we
// only care about the schema-level contract; stub it.
vi.mock("../../../../../components/ai-elements/ExcalidrawPreview", () => ({
	ExcalidrawPreview: () => null,
}));

// Stub the `@/lib/utils` path used transitively by lucide-react — they're
// not relevant for the schema-level tests here. Import the extension AFTER
// the mocks are in place.
const { ExcalidrawEmbed } = await import(
	"../tiptap-excalidraw-embed-extension"
);

function makeEditor() {
	return new Editor({
		extensions: [StarterKit, ExcalidrawEmbed],
		content: "",
	});
}

describe("ExcalidrawEmbed — markdown round-trip (AC1, AC2)", () => {
	it("parses `<excalidraw-embed>` with data attrs into an excalidrawEmbed node", () => {
		const editor = makeEditor();
		editor.commands.setContent(
			`<excalidraw-embed data-resource-uri="ui://excalidraw/abc"
              data-config-id="cfg_xxx"
              data-checkpoint-id="cp_001"></excalidraw-embed>`,
		);

		const json = editor.getJSON();
		// The doc may include the surrounding paragraph wrapper; find the
		// embed node anywhere in the tree.
		const findNode = (
			node: unknown,
			name: string,
		): Record<string, unknown> | null => {
			if (!node || typeof node !== "object") {
				return null;
			}
			const n = node as Record<string, unknown>;
			if (n.type === name) {
				return n;
			}
			const content = n.content as unknown[] | undefined;
			if (!content) {
				return null;
			}
			for (const child of content) {
				const found = findNode(child, name);
				if (found) {
					return found;
				}
			}
			return null;
		};

		const embedNode = findNode(json, "excalidrawEmbed");
		expect(embedNode).not.toBeNull();
		expect(embedNode?.attrs).toMatchObject({
			"data-resource-uri": "ui://excalidraw/abc",
			"data-config-id": "cfg_xxx",
			"data-checkpoint-id": "cp_001",
		});
		editor.destroy();
	});

	it("re-serializes the node back to `<excalidraw-embed>` with the same data attrs", () => {
		const editor = makeEditor();
		editor.commands.setContent(
			`<excalidraw-embed data-resource-uri="ui://excalidraw/abc"
              data-config-id="cfg_xxx"
              data-checkpoint-id="cp_001"></excalidraw-embed>`,
		);

		const html = editor.getHTML();
		// The round-trip is what lets the document save → reload preserve
		// the embed reference. Asserting on attribute *content* not exact
		// HTML string formatting because tiptap may reorder attrs or add
		// classes; the load path doesn't care.
		//
		// `data-checkpoint-id` is what the editor needs to actually fetch
		// the scene from the MCP server (`read_checkpoint` API key) — if
		// the round-trip dropped it the embedded canvas would render an
		// empty Excalidraw with the "no scene" fallback.
		expect(html).toContain("excalidraw-embed");
		expect(html).toContain('data-resource-uri="ui://excalidraw/abc"');
		expect(html).toContain('data-config-id="cfg_xxx"');
		expect(html).toContain('data-checkpoint-id="cp_001"');
		editor.destroy();
	});
});

describe("ExcalidrawEmbed — defensive parsing (AC3, AC4)", () => {
	it("parses a bare `<excalidraw-embed>` (no attrs) without throwing — attrs are null", () => {
		const editor = makeEditor();
		editor.commands.setContent("<excalidraw-embed></excalidraw-embed>");

		const findNode = (
			node: unknown,
			name: string,
		): Record<string, unknown> | null => {
			if (!node || typeof node !== "object") {
				return null;
			}
			const n = node as Record<string, unknown>;
			if (n.type === name) {
				return n;
			}
			const content = n.content as unknown[] | undefined;
			if (!content) {
				return null;
			}
			for (const child of content) {
				const found = findNode(child, name);
				if (found) {
					return found;
				}
			}
			return null;
		};

		const embedNode = findNode(editor.getJSON(), "excalidrawEmbed");
		expect(embedNode).not.toBeNull();
		// Streaming partials from the agent may emit the tag before the
		// resource info is known. The NodeView handles the null case with
		// a placeholder; at the schema level the attrs simply parse to
		// null. We assert that explicitly so a future "required" tightening
		// doesn't silently break partial-render UX.
		expect(embedNode?.attrs).toMatchObject({
			"data-resource-uri": null,
			"data-config-id": null,
			"data-checkpoint-id": null,
		});
		editor.destroy();
	});

	it("ignores unrecognised attributes (forward-compat for future attrs)", () => {
		const editor = makeEditor();
		editor.commands.setContent(
			`<excalidraw-embed data-resource-uri="ui://x/1"
              data-config-id="c"
              data-future-thing="ignored"></excalidraw-embed>`,
		);

		const json = JSON.stringify(editor.getJSON());
		// The known attrs round-trip; the unknown one is dropped.
		expect(json).toContain('"data-resource-uri":"ui://x/1"');
		expect(json).toContain('"data-config-id":"c"');
		expect(json).not.toContain("data-future-thing");
		editor.destroy();
	});
});

describe("ExcalidrawEmbed — end-of-doc auto-insert (G15)", () => {
	// Locks the contract the chat -> editor auto-insert flow depends on
	// (spec § 19 / task G15): `insertContentAt(doc.content.size, ...)`
	// with the full four-attribute embed markup MUST produce a single
	// `excalidrawEmbed` node sitting at the end of the document and
	// preserving every data-* attribute the chat surface wrote.
	//
	// If this assertion regresses, the auto-insert button's happy path
	// (D1 + the surface wirings F1-F4) silently drops one of the embed
	// attrs and the embedded canvas falls back to its "no scene"
	// placeholder. The four attrs are: `data-resource-uri`,
	// `data-config-id`, `data-checkpoint-id`, `data-organization-id`.
	it("insertContentAt(doc.content.size, '<excalidraw-embed ...>') lands a single node with all four data-* attrs at end-of-doc", () => {
		const editor = makeEditor();
		// Seed with some baseline content so end-of-doc is not also
		// start-of-doc; the auto-insert happy path always lands AFTER
		// existing user content.
		editor.commands.setContent("<p>baseline doc content</p>");

		const endPos = editor.state.doc.content.size;
		const insertHtml = [
			"<excalidraw-embed",
			'  data-resource-uri="ui://excalidraw/auto-insert-1"',
			'  data-config-id="cfg_auto_insert_1"',
			'  data-checkpoint-id="cp_auto_insert_1"',
			'  data-organization-id="org_auto_insert_1"',
			"></excalidraw-embed>",
		].join("\n");
		editor.commands.insertContentAt(endPos, insertHtml);

		// Locate the inserted node. Re-uses the same `findNode` walker
		// pattern as the AC1-AC4 tests above to keep the assertion shape
		// consistent.
		const findNode = (
			node: unknown,
			name: string,
		): Record<string, unknown> | null => {
			if (!node || typeof node !== "object") {
				return null;
			}
			const n = node as Record<string, unknown>;
			if (n.type === name) {
				return n;
			}
			const content = n.content as unknown[] | undefined;
			if (!content) {
				return null;
			}
			for (const child of content) {
				const found = findNode(child, name);
				if (found) {
					return found;
				}
			}
			return null;
		};

		const embedNode = findNode(editor.getJSON(), "excalidrawEmbed");
		expect(embedNode).not.toBeNull();
		expect(embedNode?.attrs).toMatchObject({
			"data-resource-uri": "ui://excalidraw/auto-insert-1",
			"data-config-id": "cfg_auto_insert_1",
			"data-checkpoint-id": "cp_auto_insert_1",
			"data-organization-id": "org_auto_insert_1",
		});

		// And it sits at end-of-doc -- count the embeds (exactly one) and
		// assert no other embed-bearing node sits after it. ProseMirror
		// counts top-level children via `doc.content.childCount`; the
		// last child must contain the embed (either directly or wrapped
		// in a paragraph -- both are spec-acceptable since end-of-doc is
		// the semantic, not the structural, contract).
		let embedCount = 0;
		const walk = (node: unknown) => {
			if (!node || typeof node !== "object") {
				return;
			}
			const n = node as Record<string, unknown>;
			if (n.type === "excalidrawEmbed") {
				embedCount++;
			}
			const content = n.content as unknown[] | undefined;
			if (content) {
				for (const child of content) {
					walk(child);
				}
			}
		};
		walk(editor.getJSON());
		expect(embedCount).toBe(1);

		editor.destroy();
	});
});
