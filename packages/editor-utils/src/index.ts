/**
 * @repo/editor-utils
 *
 * Shared utilities for document editors
 * Includes markdown conversion, diff rendering, and focus management
 */

export { diffPartialText, stripDiffMarkup } from "./diff";
export {
	type EditorLike,
	focusOnAnchor,
	focusOnFirstDiff,
	focusOnLastDiff,
} from "./focus";
export { fromMarkdown } from "./markdown";
