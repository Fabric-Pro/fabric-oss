import type MarkdownIt from "markdown-it";
import type StateInline from "markdown-it/lib/rules_inline/state_inline.mjs";

const MENTION_OPEN = /^<span\b[^>]*\bdata-type=("|')mention\1[^>]*>/i;
const MENTION_CLOSE = /<\/span>/i;
const CLOSE_TAG_LEN = "</span>".length;

/**
 * Emits inline `<span data-type="mention" ...>...</span>` as `html_inline`
 * tokens so the chip survives `createMarkdownIt()` rendering.
 *
 * Why this exists: TipTap mention chips serialize to spans with
 * `data-type="mention"`. On document save the editor's Turndown service
 * keeps the span verbatim; on load this plugin must emit it back as an
 * `html_inline` token (otherwise MarkdownIt's `text` rule would consume
 * the `<` and escape it).
 *
 * Note on security context: `createMarkdownIt()` in `diff-utils.ts` runs
 * with `html: true` to allow the diff renderer's `<ins>`/`<del>` tags.
 * That setting already lets generic inline HTML through — this plugin
 * does NOT tighten that surface. Its sole job is to claim the mention
 * span token before MarkdownIt's `text` rule does so, which guarantees
 * the chip lands as a single html_inline token regardless of the
 * surrounding markdown.
 */
export function mentionSpanInlinePlugin(md: MarkdownIt): void {
	md.inline.ruler.before(
		"text",
		"mention_span",
		(state: StateInline, silent: boolean) => {
			if (state.src.charCodeAt(state.pos) !== 0x3c /* "<" */) {
				return false;
			}

			const slice = state.src.slice(state.pos);
			const openMatch = slice.match(MENTION_OPEN);
			if (!openMatch) {
				return false;
			}

			const afterOpen = state.pos + openMatch[0].length;
			const rest = state.src.slice(afterOpen);
			const closeIdx = rest.search(MENTION_CLOSE);
			if (closeIdx === -1) {
				return false;
			}

			const closeEnd = afterOpen + closeIdx + CLOSE_TAG_LEN;

			if (!silent) {
				const token = state.push("html_inline", "", 0);
				token.content = state.src.slice(state.pos, closeEnd);
			}

			state.pos = closeEnd;
			return true;
		},
	);
}
