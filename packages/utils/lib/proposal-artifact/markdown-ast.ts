/**
 * The one Markdown parser for Proposal section identity (Fizzy #2946).
 *
 * Section keys and prose hashes are computed in the worker, the API and the
 * editor bundle, and must agree to the bit, so all three parse with this one
 * `unified` + `remark-parse` + `remark-gfm` processor rather than each
 * picking a parser. GFM is on because model-written Proposals use its
 * tables, strikethrough, task items and bare URLs, and the editor's save
 * writes GFM tables back.
 *
 * Parse only: no transform plugins run, so the tree is exactly what
 * CommonMark plus GFM reads from the text, with positions.
 *
 * No Node built-ins: the editor bundle and jsdom tests import it.
 */

import type { Root } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { type Processor, unified } from "unified";

type MarkdownProcessor = Processor<Root, Root, Root>;

// `unified()` builds a fresh processor per call; one frozen instance is
// enough because parsing keeps no state between documents.
let processor: MarkdownProcessor | null = null;

function getProcessor(): MarkdownProcessor {
	if (!processor) {
		processor = unified()
			.use(remarkParse)
			.use(remarkGfm)
			.freeze() as unknown as MarkdownProcessor;
	}
	return processor;
}

/**
 * The mdast tree of `markdown`, with 1-based line positions on every node.
 * The caller normalises line endings first when it needs line numbers that
 * match a `\n` split of the same text.
 */
export function parseMarkdownAst(markdown: string): Root {
	return getProcessor().parse(markdown);
}
