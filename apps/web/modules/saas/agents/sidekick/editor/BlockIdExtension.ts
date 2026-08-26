import { UniqueID } from "@tiptap/extension-unique-id";

/**
 * Generate 8-char alphanumeric IDs for block nodes.
 * These stable IDs allow the Sidekick LLM to target specific blocks
 * when suggesting prompt edits via `data-block-id` attributes.
 */
function generateShortBlockId(): string {
	const chars =
		"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
	let id = "";
	for (let i = 0; i < 8; i++) {
		id += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return id;
}

/**
 * BlockIdExtension — adds stable `data-block-id` attributes to block-level
 * nodes (heading, paragraph, bulletList, orderedList). Built on top of the
 * official `@tiptap/extension-unique-id` extension.
 *
 * The attribute serialises as `data-block-id` in HTML output, which is how
 * the Sidekick LLM targets specific blocks for prompt edits.
 */
export const BlockIdExtension = UniqueID.configure({
	types: ["heading", "paragraph", "bulletList", "orderedList"],
	attributeName: "block-id",
	generateID: () => generateShortBlockId(),
});
