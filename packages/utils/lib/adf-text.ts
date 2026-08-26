/**
 * Atlassian Document Format (ADF) text helpers.
 *
 * Atlassian products (Jira via Rovo, Confluence) return rich content as an ADF
 * document (`{ type: "doc", version, content: [...] }`), not a plain string.
 * When that value reaches a consumer expecting text — a sync-conflict preview,
 * a project-context ingestion path — the object must be flattened or it renders
 * as "(empty)".
 *
 * These helpers are intentionally pure and dependency-free so they can run in
 * any environment, including a `"use client"` browser bundle. They live in
 * `@repo/utils` (rather than a Temporal activities path) so both the server-side
 * PM-integration code and the client-side context ingestion can share them
 * without dragging server-only siblings into the client bundle.
 *
 * `extractTextFromAdf` keeps block structure (paragraphs, headings, list items)
 * by separating block nodes with blank lines, which reads far better in a diff
 * than collapsing the whole document onto one line. It is intentionally lossy:
 * marks (bold, code), list bullets, and link targets are dropped — we only need
 * legible text, not a faithful Markdown round-trip.
 */

/** ADF node types that introduce a block boundary in the flattened output. */
const BLOCK_TYPES = new Set([
	"paragraph",
	"heading",
	"blockquote",
	"listItem",
	"codeBlock",
	"panel",
	"rule",
	"mediaSingle",
	"tableRow",
]);

/** True when `value` looks like an ADF document (`{ type: "doc", ... }`). */
export function isAdfDocument(value: unknown): boolean {
	return (
		!!value &&
		typeof value === "object" &&
		(value as { type?: unknown }).type === "doc"
	);
}

/**
 * Flatten an ADF node to plain text, separating block-level nodes with blank
 * lines. Returns `""` for a node with no extractable text. Never throws.
 */
export function extractTextFromAdf(node: unknown): string {
	const blocks: string[] = [];
	let current: string[] = [];

	const flush = () => {
		if (current.length > 0) {
			const text = current.join("").trim();
			if (text.length > 0) {
				blocks.push(text);
			}
			current = [];
		}
	};

	const traverse = (n: unknown) => {
		if (!n || typeof n !== "object") {
			return;
		}
		const obj = n as Record<string, unknown>;
		const type = obj.type;

		if (type === "text" && typeof obj.text === "string") {
			current.push(obj.text);
		} else if (type === "hardBreak") {
			current.push("\n");
		}

		if (Array.isArray(obj.content)) {
			for (const child of obj.content) {
				traverse(child);
			}
		}

		if (typeof type === "string" && BLOCK_TYPES.has(type)) {
			flush();
		}
	};

	traverse(node);
	flush();
	return blocks.join("\n\n");
}

/**
 * Coerce a PM-supplied description field to text. Strings pass through; ADF
 * documents are flattened; anything else yields `undefined` so callers can fall
 * through to the next candidate field.
 */
export function descriptionToText(value: unknown): string | undefined {
	if (typeof value === "string") {
		return value;
	}
	if (isAdfDocument(value)) {
		return extractTextFromAdf(value);
	}
	return undefined;
}
