import { Extension } from "@tiptap/core";
import {
	DOMSerializer,
	type Fragment,
	DOMParser as ProseDOMParser,
	type Node as ProseMirrorNode,
} from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

// ---- Types ----

interface StoredSuggestion {
	sId: string;
	targetBlockId: string;
	/** HTML content of the suggestion (the new content). */
	content: string;
	/** Original HTML of the block before the suggestion was applied. */
	originalContent: string;
}

interface SuggestionPluginState {
	stored: Map<string, StoredSuggestion>;
	highlightedId: string | null;
	decorationSet: DecorationSet;
}

// ---- Transaction metadata keys ----

const META_APPLY = "applySuggestion";
const META_ACCEPT = "acceptSuggestion";
const META_REJECT = "rejectSuggestion";
const META_HIGHLIGHT = "setHighlightedSuggestion";

// ---- Plugin key (exported for external access) ----

const instructionSuggestionPluginKey = new PluginKey<SuggestionPluginState>(
	"instructionSuggestion",
);

// ---- Helpers ----

/**
 * Walk the document to find a node whose `block-id` attribute matches
 * the given blockId. Returns the node and its position, or null.
 */
function findBlockByBlockId(
	doc: ProseMirrorNode,
	blockId: string,
): { pos: number; node: ProseMirrorNode } | null {
	let found: { pos: number; node: ProseMirrorNode } | null = null;
	doc.descendants((node, pos) => {
		if (found) {
			return false;
		}
		if (node.attrs["block-id"] === blockId) {
			found = { pos, node };
			return false;
		}
	});
	return found;
}

/**
 * Build a DecorationSet that wraps the content range of each stored
 * suggestion in an inline decoration with the appropriate CSS classes
 * and data attributes.
 */
function buildDecorations(
	doc: ProseMirrorNode,
	stored: Map<string, StoredSuggestion>,
	highlightedId: string | null,
): DecorationSet {
	if (stored.size === 0) {
		return DecorationSet.empty;
	}

	const decorations: Decoration[] = [];

	for (const [sId, suggestion] of stored) {
		const block = findBlockByBlockId(doc, suggestion.targetBlockId);
		if (!block) {
			continue;
		}

		// Content range inside the block node
		const from = block.pos + 1;
		const to = block.pos + block.node.nodeSize - 1;
		if (from >= to) {
			continue;
		}

		const isDimmed = highlightedId !== null && highlightedId !== sId;
		const classes = [
			"suggestion-addition",
			isDimmed ? "suggestion-dimmed" : "",
		]
			.filter(Boolean)
			.join(" ");

		decorations.push(
			Decoration.inline(from, to, {
				class: classes,
				"data-suggestion-id": sId,
				"data-kind": "add",
			}),
		);
	}

	return DecorationSet.create(doc, decorations);
}

/**
 * Serialize a ProseMirror block node's inner content to an HTML string.
 * Used to capture original content before a suggestion replaces it.
 */
function serializeBlockContent(node: ProseMirrorNode): string {
	const serializer = DOMSerializer.fromSchema(node.type.schema);
	const fragment = document.createDocumentFragment();

	node.content.forEach((child: ProseMirrorNode) => {
		const domNode = serializer.serializeNode(child);
		fragment.appendChild(domNode);
	});

	const container = document.createElement("div");
	container.appendChild(fragment);
	return container.innerHTML;
}

/**
 * Parse an HTML string into a ProseMirror fragment using the given
 * schema. The content is sanitized through ProseMirror's schema-aware
 * DOM parser, which only accepts elements matching the schema spec.
 */
function parseHtmlToFragment(
	html: string,
	targetNode: ProseMirrorNode,
): Fragment {
	const schema = targetNode.type.schema;
	const parser = ProseDOMParser.fromSchema(schema);

	const container = document.createElement("div");
	container.innerHTML = html;
	const parsed = parser.parse(container);

	let fragment = parsed.content;

	// If the parsed result is a single block matching the target type,
	// unwrap to get just the inner content for replacement.
	if (
		fragment.childCount === 1 &&
		fragment.firstChild &&
		fragment.firstChild.type === targetNode.type
	) {
		fragment = fragment.firstChild.content;
	}

	return fragment;
}

// ---- Command type declarations ----

declare module "@tiptap/core" {
	interface Commands<ReturnType> {
		instructionSuggestion: {
			/**
			 * Apply a suggestion: replace the content of the target block
			 * and wrap it in a visual diff decoration.
			 */
			applySuggestion: (
				sId: string,
				content: string,
				targetBlockId: string,
			) => ReturnType;
			/**
			 * Accept a suggestion: remove the decoration, keep the new content.
			 */
			acceptSuggestion: (sId: string) => ReturnType;
			/**
			 * Reject a suggestion: revert the block to its original content
			 * and remove the decoration.
			 */
			rejectSuggestion: (sId: string) => ReturnType;
			/**
			 * Set (or clear) which suggestion is visually highlighted.
			 * Pass null to clear the highlight.
			 */
			setHighlightedSuggestion: (sId: string | null) => ReturnType;
		};
	}
}

// ---- Extension ----

export const InstructionSuggestionExtension = Extension.create({
	name: "instructionSuggestion",

	addProseMirrorPlugins() {
		return [
			new Plugin<SuggestionPluginState>({
				key: instructionSuggestionPluginKey,

				state: {
					init(): SuggestionPluginState {
						return {
							stored: new Map(),
							highlightedId: null,
							decorationSet: DecorationSet.empty,
						};
					},

					apply(
						tr: Transaction,
						value: SuggestionPluginState,
					): SuggestionPluginState {
						// ---- applySuggestion ----
						const applyMeta = tr.getMeta(META_APPLY) as
							| StoredSuggestion
							| undefined;
						if (applyMeta) {
							const nextStored = new Map(value.stored);
							nextStored.set(applyMeta.sId, applyMeta);
							return {
								stored: nextStored,
								highlightedId: value.highlightedId,
								decorationSet: buildDecorations(
									tr.doc,
									nextStored,
									value.highlightedId,
								),
							};
						}

						// ---- acceptSuggestion ----
						const acceptMeta = tr.getMeta(META_ACCEPT) as
							| string
							| undefined;
						if (acceptMeta) {
							const nextStored = new Map(value.stored);
							nextStored.delete(acceptMeta);
							const nextHighlighted =
								value.highlightedId === acceptMeta
									? null
									: value.highlightedId;
							return {
								stored: nextStored,
								highlightedId: nextHighlighted,
								decorationSet: buildDecorations(
									tr.doc,
									nextStored,
									nextHighlighted,
								),
							};
						}

						// ---- rejectSuggestion ----
						const rejectMeta = tr.getMeta(META_REJECT) as
							| string
							| undefined;
						if (rejectMeta) {
							const nextStored = new Map(value.stored);
							nextStored.delete(rejectMeta);
							const nextHighlighted =
								value.highlightedId === rejectMeta
									? null
									: value.highlightedId;
							return {
								stored: nextStored,
								highlightedId: nextHighlighted,
								decorationSet: buildDecorations(
									tr.doc,
									nextStored,
									nextHighlighted,
								),
							};
						}

						// ---- setHighlightedSuggestion ----
						const highlightMeta = tr.getMeta(META_HIGHLIGHT) as
							| { sId: string | null }
							| undefined;
						if (highlightMeta) {
							return {
								stored: value.stored,
								highlightedId: highlightMeta.sId,
								decorationSet: buildDecorations(
									tr.doc,
									value.stored,
									highlightMeta.sId,
								),
							};
						}

						// ---- Default: remap decorations if doc changed ----
						if (tr.docChanged) {
							if (value.stored.size === 0) {
								return value;
							}
							return {
								stored: value.stored,
								highlightedId: value.highlightedId,
								decorationSet: value.decorationSet.map(
									tr.mapping,
									tr.doc,
								),
							};
						}

						return value;
					},
				},

				props: {
					decorations(state) {
						return instructionSuggestionPluginKey.getState(state)
							?.decorationSet;
					},
				},
			}),
		];
	},

	addCommands() {
		return {
			applySuggestion:
				(sId: string, content: string, targetBlockId: string) =>
				({ tr }) => {
					const { doc } = tr;

					// Find the target block by block-id attribute
					const block = findBlockByBlockId(doc, targetBlockId);
					if (!block) {
						return false;
					}

					// Capture original content before replacement
					const originalContent = serializeBlockContent(block.node);

					// Parse new content through the schema-aware DOM parser
					const fragment = parseHtmlToFragment(content, block.node);

					// Replace the block's inner content
					const from = block.pos + 1;
					const to = block.pos + block.node.nodeSize - 1;
					tr.replaceWith(from, to, fragment);

					// Store suggestion metadata for the plugin
					tr.setMeta(META_APPLY, {
						sId,
						targetBlockId,
						content,
						originalContent,
					} satisfies StoredSuggestion);

					return true;
				},

			acceptSuggestion:
				(sId: string) =>
				({ tr }) => {
					// Content is already in place; just remove the decoration
					tr.setMeta(META_ACCEPT, sId);
					return true;
				},

			rejectSuggestion:
				(sId: string) =>
				({ tr, editor }) => {
					const state = instructionSuggestionPluginKey.getState(
						editor.state,
					);
					const suggestion = state?.stored.get(sId);

					if (!suggestion) {
						return false;
					}

					// Find the current block to revert
					const block = findBlockByBlockId(
						tr.doc,
						suggestion.targetBlockId,
					);
					if (!block) {
						// Block gone — clean up the stored entry
						tr.setMeta(META_REJECT, sId);
						return true;
					}

					// Parse the original content back through the DOM parser
					const fragment = parseHtmlToFragment(
						suggestion.originalContent,
						block.node,
					);

					// Replace with original content
					const from = block.pos + 1;
					const to = block.pos + block.node.nodeSize - 1;
					tr.replaceWith(from, to, fragment);

					tr.setMeta(META_REJECT, sId);
					return true;
				},

			setHighlightedSuggestion:
				(sId: string | null) =>
				({ tr }) => {
					tr.setMeta(META_HIGHLIGHT, { sId });
					return true;
				},
		};
	},
});
