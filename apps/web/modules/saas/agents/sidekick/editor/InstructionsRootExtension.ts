import { INSTRUCTIONS_ROOT_BLOCK_ID } from "@repo/ai/sidekick/constants";
import { Node } from "@tiptap/core";

/**
 * InstructionsRootExtension — a custom TipTap Node that wraps the entire
 * instructions document in a single container with a fixed
 * `data-block-id="instructions-root"`. This allows the Sidekick LLM to
 * target the whole document for a full rewrite.
 *
 * Schema integration: the default `doc` node's content spec is overridden
 * to `"instructionsRoot"` via a custom Document extension (see
 * InstructionsEditor.tsx). This ensures ALL block content lives inside
 * the instructionsRoot wrapper.
 */
export const InstructionsRootExtension = Node.create({
	name: "instructionsRoot",
	group: "block",
	content: "block+",
	defining: true,

	addAttributes() {
		return {
			"block-id": {
				default: INSTRUCTIONS_ROOT_BLOCK_ID,
				// Always force the sentinel ID regardless of parsed HTML
				parseHTML: () => INSTRUCTIONS_ROOT_BLOCK_ID,
				renderHTML: () => ({
					"data-block-id": INSTRUCTIONS_ROOT_BLOCK_ID,
				}),
			},
		};
	},

	parseHTML() {
		return [{ tag: `div[data-type="instructions-root"]` }];
	},

	renderHTML({ HTMLAttributes }) {
		return [
			"div",
			{ ...HTMLAttributes, "data-type": "instructions-root" },
			0,
		];
	},
});
