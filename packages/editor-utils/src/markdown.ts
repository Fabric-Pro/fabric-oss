/**
 * Markdown utilities
 */

import MarkdownIt from "markdown-it";

/**
 * Convert markdown text to HTML
 */
export function fromMarkdown(text: string | undefined): string {
	if (!text) {
		return "";
	}
	const md = new MarkdownIt({
		typographer: true,
		html: true,
	});

	return md.render(text);
}
