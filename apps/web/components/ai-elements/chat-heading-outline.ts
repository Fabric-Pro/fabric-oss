import MarkdownIt from "markdown-it";

const parser = new MarkdownIt();

/** Normalize answer headings before Streamdown splits blocks, preserving code verbatim. */
export function normalizeChatHeadingOutline(markdown: string): string {
	const outline: { original: number; rendered: number }[] = [];
	const lines = markdown.split("\n");
	for (const token of parser.parse(markdown, {})) {
		if (token.type !== "heading_open" || !token.map) {
			continue;
		}
		const [start, end] = token.map;
		const original = Number(token.tag.slice(1));
		while (
			outline.length &&
			outline[outline.length - 1].original >= original
		) {
			outline.pop();
		}
		const parent = outline[outline.length - 1];
		const rendered = parent ? Math.min(6, parent.rendered + 1) : 2;
		outline.push({ original, rendered });
		if (token.markup.startsWith("#")) {
			// Parser line maps distinguish real headings from fenced or indented code.
			lines[start] = lines[start].replace(/#{1,6}(?=[ \t]|$)/, () =>
				"#".repeat(rendered),
			);
		} else if (end === start + 2) {
			// A Setext heading is converted without changing the number of source lines.
			lines[start] = lines[start].replace(
				/^(\s*(?:>\s*)*)/,
				(_match, prefix) => `${prefix}${"#".repeat(rendered)} `,
			);
			lines[start + 1] = "";
		}
	}
	return lines.join("\n");
}
