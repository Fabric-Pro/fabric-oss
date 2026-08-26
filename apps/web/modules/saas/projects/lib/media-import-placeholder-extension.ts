/**
 * Style the pull ingester's failed-media placeholders.
 *
 * When an image or file attachment cannot be downloaded from a PM tool, the
 * ingester substitutes a bracketed text token — `[Image could not be imported
 * from Azure DevOps: shot.png]` — rather than leaving a URL the browser cannot
 * authenticate (which would render as a broken icon; Fizzy card 2027).
 *
 * That token is presented as a styled block instead of bare italic text. Two
 * constraints shape how:
 *
 *  1. The token TEXT must survive byte-for-byte. The push pipeline strips
 *     these tokens by matching their exact wording
 *     (`stripFailedMediaPlaceholders`), and a placeholder that round-trips
 *     back to the PM tool overwrites the real attachment reference there —
 *     permanent data loss. So this never rewrites the document.
 *  2. The styling must survive re-render. Writing a class straight onto the
 *     paragraph DOM is undone the moment ProseMirror re-renders that
 *     paragraph from doc state, which happens on the next transaction.
 *
 * A decoration satisfies both: it is derived from doc state on every
 * transaction and lives outside the document, so it neither mutates nor
 * persists into a save.
 */

import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { buildMediaUnavailableMessage } from "./media-unavailable-message";

/** The exact shape the ingester emits, anchored to the whole paragraph. */
const PLACEHOLDER_TEXT =
	/^\[((?:Image|Attachment)) (could not be imported\b[^\]]*)\]$/;

/**
 * Turn the stored token into wording meant for a person.
 *
 * `[Image could not be imported from Azure DevOps: shot.png]` becomes
 * `Image unavailable — could not be imported from Azure DevOps: shot.png`,
 * which opens on the same two words as the broken-image fallback so the two
 * states read as one. The brackets exist only because the push pipeline strips
 * the token by exact wording; that is an implementation constraint and has no
 * business being shown to a reader.
 *
 * Returns null when the paragraph is not a placeholder.
 */
function describeImportFailure(text: string): string | null {
	const match = PLACEHOLDER_TEXT.exec(text.trim());
	if (!match) {
		return null;
	}
	const [, kind, reason] = match;
	return `${kind} unavailable — ${reason}`;
}

function buildDecorations(doc: ProseMirrorNode): DecorationSet {
	const decorations: Decoration[] = [];
	doc.descendants((node, pos) => {
		if (node.type.name !== "paragraph") {
			return;
		}
		const message = describeImportFailure(node.textContent);
		if (!message) {
			return;
		}
		// Hides the stored token; the message below stands in for it. The text
		// itself is untouched — see the byte-for-byte guard in the tests.
		decorations.push(
			Decoration.node(pos, pos + node.nodeSize, {
				class: "media-unavailable-raw",
			}),
		);
		decorations.push(
			Decoration.widget(
				pos + node.nodeSize,
				() => {
					const element = buildMediaUnavailableMessage(message);
					element.setAttribute("data-media-import-error", "true");
					return element;
				},
				{ side: 1 },
			),
		);
	});
	return DecorationSet.create(doc, decorations);
}

export const MediaImportPlaceholder = Extension.create({
	name: "mediaImportPlaceholder",

	addProseMirrorPlugins() {
		return [
			new Plugin({
				key: new PluginKey("mediaImportPlaceholder"),
				props: {
					decorations(state) {
						return buildDecorations(state.doc);
					},
				},
			}),
		];
	},
});
