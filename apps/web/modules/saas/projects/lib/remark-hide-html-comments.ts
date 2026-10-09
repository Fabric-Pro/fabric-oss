type MarkdownNode = {
	type: string;
	value?: string;
	children?: MarkdownNode[];
};

const OPEN = "<!--";
const CLOSE = "-->";

/** Removes every complete `<!-- … -->` span from one raw HTML value. */
function stripComments(value: string): string {
	let out = "";
	let at = 0;
	while (at < value.length) {
		const start = value.indexOf(OPEN, at);
		if (start === -1) {
			break;
		}
		const close = value.indexOf(CLOSE, start + OPEN.length);
		if (close === -1) {
			break;
		}
		out += value.slice(at, start);
		at = close + CLOSE.length;
	}
	return out + value.slice(at);
}

function visit(node: MarkdownNode) {
	if (!node.children) {
		return;
	}
	node.children = node.children.filter((child) => {
		if (child.type !== "html" || typeof child.value !== "string") {
			visit(child);
			return true;
		}
		const next = stripComments(child.value);
		if (next === child.value) {
			return true;
		}
		if (next.trim() === "") {
			return false;
		}
		child.value = next;
		return true;
	});
}

/**
 * Hides HTML comments from the rendered Markdown. The renderer does not run
 * raw HTML, so a comment would otherwise appear as visible text. As in
 * CommonMark, a comment is a span inside ONE raw `html` node: only those
 * nodes are read, and only the comment span is removed from them. A node
 * left empty is dropped on its own; no parent (paragraph, table cell, row)
 * is ever removed or merged, so a comment-only table cell stays a cell.
 * `text` nodes are never touched, so an entity-escaped `&lt;!--` and prose
 * the parser did not treat as a comment stay visible, and an opener in one
 * node never pairs with a closer in another. Code is not HTML and is never
 * read.
 */
export function remarkHideHtmlComments() {
	return (tree: MarkdownNode) => {
		visit(tree);
	};
}
