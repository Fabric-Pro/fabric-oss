/**
 * Tests for `findEmbedNodeByConfigId` — the FR-9 lookup helper.
 *
 * Spec § 9 / FR-9 require that re-clicking the Insert button when the
 * embed is still present in the doc scrolls to it instead of inserting
 * a second copy. The helper here is the lookup primitive that makes
 * that idempotency work.
 *
 * Uses a real in-memory ProseMirror editor + the actual
 * `ExcalidrawEmbed` extension so the schema-level attribute name is
 * locked exactly the same way the existing extension test locks it.
 */

import { Editor } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { describe, expect, it, vi } from "vitest";

// Same React-NodeView stub the extension's own tests use — `useEditor`
// is a heavy import that we don't need for schema-level walking.
vi.mock("@tiptap/react", () => ({
	NodeViewWrapper: () => null,
	ReactNodeViewRenderer: () => () => null,
}));

vi.mock("../../../../../components/ai-elements/ExcalidrawPreview", () => ({
	ExcalidrawPreview: () => null,
}));

const { ExcalidrawEmbed } = await import(
	"../../../lib/tiptap-excalidraw-embed-extension"
);
const { findEmbedNodeByConfigId } = await import("../findEmbedNodeByConfigId");

function makeEditor(html: string) {
	const editor = new Editor({
		extensions: [StarterKit, ExcalidrawEmbed],
		content: html,
	});
	return editor;
}

describe("findEmbedNodeByConfigId — exact matching", () => {
	it("returns the matching node + position when present", () => {
		const editor = makeEditor(
			`<p>Before</p>
			<excalidraw-embed data-resource-uri="ui://excalidraw/abc"
				data-config-id="cfg_target"
				data-checkpoint-id="cp_target"></excalidraw-embed>
			<p>After</p>`,
		);
		// Cast to the @tiptap/react Editor type the helper expects.
		const result = findEmbedNodeByConfigId(
			editor as unknown as import("@tiptap/react").Editor,
			"cfg_target",
		);
		expect(result).not.toBeNull();
		expect(result?.node.attrs["data-config-id"]).toBe("cfg_target");
		expect(typeof result?.pos).toBe("number");
		editor.destroy();
	});

	it("returns null when no node matches", () => {
		const editor = makeEditor(
			`<excalidraw-embed data-config-id="cfg_other"></excalidraw-embed>`,
		);
		const result = findEmbedNodeByConfigId(
			editor as unknown as import("@tiptap/react").Editor,
			"cfg_missing",
		);
		expect(result).toBeNull();
		editor.destroy();
	});

	it("returns null on an empty document", () => {
		const editor = makeEditor("<p></p>");
		const result = findEmbedNodeByConfigId(
			editor as unknown as import("@tiptap/react").Editor,
			"cfg_x",
		);
		expect(result).toBeNull();
		editor.destroy();
	});

	it("returns null for an empty configId argument", () => {
		// Defensive guard — empty string never matches a meaningful node.
		const editor = makeEditor(
			`<excalidraw-embed data-config-id=""></excalidraw-embed>`,
		);
		const result = findEmbedNodeByConfigId(
			editor as unknown as import("@tiptap/react").Editor,
			"",
		);
		expect(result).toBeNull();
		editor.destroy();
	});

	it("does NOT match on a substring of the configId", () => {
		const editor = makeEditor(
			`<excalidraw-embed data-config-id="cfg_long_value"></excalidraw-embed>`,
		);
		const result = findEmbedNodeByConfigId(
			editor as unknown as import("@tiptap/react").Editor,
			"cfg_long",
		);
		expect(result).toBeNull();
		editor.destroy();
	});

	it("returns the FIRST matching node when the document has duplicates", () => {
		const editor = makeEditor(
			`<excalidraw-embed data-config-id="cfg_dup" data-checkpoint-id="cp_1"></excalidraw-embed>
			<p>spacer</p>
			<excalidraw-embed data-config-id="cfg_dup" data-checkpoint-id="cp_2"></excalidraw-embed>`,
		);
		const result = findEmbedNodeByConfigId(
			editor as unknown as import("@tiptap/react").Editor,
			"cfg_dup",
		);
		expect(result).not.toBeNull();
		// First match -> the embed with checkpoint cp_1 (document order).
		expect(result?.node.attrs["data-checkpoint-id"]).toBe("cp_1");
		editor.destroy();
	});
});
