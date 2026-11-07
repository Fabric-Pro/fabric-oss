import { parseMarkdownAst } from "@repo/utils/proposal-artifact/markdown-ast";

const escape = (value: string) =>
	value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/=/g, "&#61;");
type Node = {
	type: string;
	value?: string;
	depth?: number;
	ordered?: boolean;
	url?: string;
	children?: Node[];
};

/** Structural GFM rendering for static print. Authored HTML is text; remote images never load. */
export function renderFrameMarkdown(markdown: string): string {
	const render = (node: Node): string => {
		const children = () => (node.children ?? []).map(render).join("");
		switch (node.type) {
			case "root":
				return children();
			case "text":
			case "html":
			case "inlineCode":
				return node.type === "inlineCode"
					? `<code>${escape(node.value ?? "")}</code>`
					: escape(node.value ?? "");
			case "heading": {
				const depth = Math.min(6, Math.max(1, node.depth ?? 1));
				return `<h${depth}>${children()}</h${depth}>`;
			}
			case "paragraph":
				return `<p>${children()}</p>`;
			case "strong":
				return `<strong>${children()}</strong>`;
			case "emphasis":
				return `<em>${children()}</em>`;
			case "delete":
				return `<del>${children()}</del>`;
			case "list":
				return node.ordered
					? `<ol>${children()}</ol>`
					: `<ul>${children()}</ul>`;
			case "listItem":
				return `<li>${children()}</li>`;
			case "blockquote":
				return `<blockquote>${children()}</blockquote>`;
			case "code":
				return `<pre><code>${escape(node.value ?? "")}</code></pre>`;
			case "thematicBreak":
				return "<hr>";
			case "break":
				return "<br>";
			case "link":
				return node.url && /^(https?:|mailto:|#)/i.test(node.url)
					? `<a href="${escape(node.url)}">${children()}</a>`
					: children();
			case "image":
				return "";
			case "table":
				return `<table>${(node.children ?? []).map((row, index) => `<${index === 0 ? "thead" : "tbody"}><tr>${(row.children ?? []).map((cell) => `<${index === 0 ? "th" : "td"}>${(cell.children ?? []).map(render).join("")}</${index === 0 ? "th" : "td"}>`).join("")}</tr></${index === 0 ? "thead" : "tbody"}>`).join("")}</table>`;
			default:
				return children();
		}
	};
	return render(parseMarkdownAst(markdown) as Node);
}
