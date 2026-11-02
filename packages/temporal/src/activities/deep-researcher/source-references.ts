import type { Nodes, Root } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

const processor = unified().use<[], string, Root>(remarkParse).use(remarkGfm);

/** Model-reported web references; retrieved workspace sources are merged separately. */
export function extractResearchSourceUrls(text: string): string[] {
	const sources = new Set<string>();
	const collect = (node: Nodes): void => {
		if (sources.size === 20) {
			return;
		}
		if (node.type === "link" || node.type === "definition") {
			let url: URL;
			try {
				url = new URL(node.url);
			} catch {
				return;
			}
			if (url.protocol === "http:" || url.protocol === "https:") {
				sources.add(url.href);
			}
			return;
		}
		if (
			node.type === "code" ||
			node.type === "inlineCode" ||
			node.type === "html"
		) {
			return;
		}
		if ("children" in node) {
			for (const child of node.children) {
				collect(child);
			}
		}
	};
	collect(processor.parse(text));
	return [...sources];
}
