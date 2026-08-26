/**
 * Find an existing `<excalidraw-embed>` node in a TipTap editor by its
 * `data-config-id` attribute (which carries the MCP config id — the
 * idempotency key per spec FR-9).
 *
 * Pure / editor-instance-scoped: the caller passes the editor, the
 * function walks its document. No global lookup, no React, no module
 * state — safe to call from SSR boundaries (caller still has to
 * guarantee an editor instance exists).
 *
 * Used by the button hook (D1) on re-click in the `inserted` state:
 * if the embed is still present in the doc, scroll to it; otherwise
 * insert a fresh embed (spec § 9 FR-9 "re-insert path").
 *
 * Spec sections:
 *   - § 9    FR-9 path — lookup by `data-config-id`
 *   - § 10.1 Idempotency key (entry carries `configId`)
 *   - § 22.1 The schema-level attribute name is locked by the existing
 *            test at `tiptap-excalidraw-embed-extension.test.ts` (AC1).
 */

import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { Editor } from "@tiptap/react";

/** A located embed with its document position + raw ProseMirror node. */
export interface FoundEmbedNode {
	/** Absolute position in the document (suitable for `setNodeSelection`). */
	pos: number;
	/** The matched ProseMirror node — `attrs["data-config-id"]` is asserted. */
	node: ProseMirrorNode;
}

/**
 * Walk the editor's document tree and return the FIRST node whose
 * `attrs["data-config-id"]` exactly matches the supplied `configId`.
 *
 * The walk uses ProseMirror's `descendants` traversal API, which
 * visits every node in document order (top-down, depth-first). A
 * shallow match is enough — `<excalidraw-embed>` is a block-level
 * atom (`atom: true` in `tiptap-excalidraw-embed-extension.tsx:219`)
 * so it never nests inside another embed.
 *
 * @param editor   The TipTap editor instance to search.
 * @param configId The MCP config id to match exactly. Substring matches
 *                 are NOT accepted — caller is responsible for passing
 *                 the canonical cuid string.
 * @returns The first matching node + its document position, or `null`.
 */
export function findEmbedNodeByConfigId(
	editor: Editor,
	configId: string,
): FoundEmbedNode | null {
	// Defensive: empty configId would match a node whose attr is the
	// empty string, which is never meaningful in production. Reject.
	if (!configId) {
		return null;
	}

	let found: FoundEmbedNode | null = null;
	editor.state.doc.descendants((node, pos) => {
		if (found) {
			// Short-circuit the rest of the walk by returning false from
			// the visitor — ProseMirror stops descending into this node.
			// We've already saved the match; further iterations are wasted
			// work that on long documents can be measurable.
			return false;
		}
		const attrs = node.attrs as Record<string, unknown> | undefined;
		if (!attrs) {
			return true;
		}
		const candidate = attrs["data-config-id"];
		if (typeof candidate === "string" && candidate === configId) {
			found = { pos, node };
			return false;
		}
		return true;
	});

	return found;
}
