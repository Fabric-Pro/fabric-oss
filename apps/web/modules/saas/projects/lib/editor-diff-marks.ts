import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode, ResolvedPos } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";

/**
 * An assistant proposal under review in the editor, as its changes sit in
 * the body: what the review bar steps through, accepts and rejects, and what
 * a proposal nobody answers any more is rejected by (Fizzy #2946).
 */

/** The marks an assistant proposal under review carries in the editor. */
const DIFF_MARK_NAMES = new Set(["diffInsert", "diffDelete"]);

/** One change of a proposal under review. */
export interface DiffRange {
	from: number;
	to: number;
	type: "addition" | "deletion";
	/** A whole table the AI added or removed, carried as the table's `diff` attribute. */
	table?: boolean;
}

/**
 * Scan the editor document for diff-specific marks only.
 * Uses diffInsert/diffDelete (rendered as <ins>/<del>) so that
 * ordinary italic and strikethrough formatting is never mistaken
 * for a pending AI change. Added and removed tables carry no marks,
 * so they are found by the table node's `diff` attribute.
 *
 * The marks sit on every inline node of a change, not only its text: an
 * image (inline in this editor, even on a line of its own) and a hard break
 * carry them too. Counting only text left an image change off the bar, and
 * split a link holding a hard break into several changes whose marked breaks
 * no accept or reject ever reached (Fizzy #2946).
 */
export function findDiffRanges(doc: ProseMirrorNode): DiffRange[] {
	const ranges: DiffRange[] = [];

	doc.descendants((node, pos) => {
		if (!node.isText && !node.isInline) {
			const diff = node.type.name === "table" ? node.attrs.diff : null;
			if (diff !== "added" && diff !== "deleted") {
				return;
			}
			ranges.push({
				from: pos,
				to: pos + node.nodeSize,
				type: diff === "added" ? "addition" : "deletion",
				table: true,
			});
			return false;
		}
		for (const mark of node.marks) {
			if (mark.type.name === "diffInsert") {
				ranges.push({
					from: pos,
					to: pos + node.nodeSize,
					type: "addition",
				});
			} else if (mark.type.name === "diffDelete") {
				ranges.push({
					from: pos,
					to: pos + node.nodeSize,
					type: "deletion",
				});
			}
		}
	});

	// Merge adjacent ranges of the same type
	const merged: DiffRange[] = [];
	for (const range of ranges) {
		const prev = merged[merged.length - 1];
		if (
			prev &&
			!prev.table &&
			!range.table &&
			prev.type === range.type &&
			prev.to === range.from
		) {
			prev.to = range.to;
		} else {
			merged.push({ ...range });
		}
	}

	return merged;
}

/**
 * Whether an editor's body holds an assistant proposal still waiting for its
 * answer (Fizzy #2946): text, an image or a diagram's source marked
 * `diffInsert` or `diffDelete`, or a table proposed for addition or
 * deletion, which carries no marks but a `diff` attribute on the table node
 * (`data-diff` in HTML). The same shapes `findDiffRanges` steps through and
 * `stripDiffTags` resolves on save.
 *
 * In a collaborative room the marks live in the shared body, so an editor
 * that reviews nothing can find them there: a proposal whose reviewer went
 * without answering it. Saved as it stands, the marked text would be
 * written as if it had been accepted.
 */
export function editorHoldsDiffMarks(
	doc: ProseMirrorNode | null | undefined,
): boolean {
	if (!doc) {
		return false;
	}
	let found = false;
	doc.descendants((node) => {
		if (found) {
			return false;
		}
		if (node.type.name === "table") {
			const diff = node.attrs.diff;
			if (diff === "added" || diff === "deleted") {
				found = true;
				return false;
			}
		}
		if (node.marks.some((mark) => DIFF_MARK_NAMES.has(mark.type.name))) {
			found = true;
			return false;
		}
		return true;
	});
	return found;
}

/**
 * The depth of the block to remove with the textblock at `$from`, whose
 * content an accept or a reject is about to delete in full: the textblock
 * itself, or the list item, list or quote that held nothing but it, which
 * would otherwise be left empty. `null` keeps the emptied textblock: its parent
 * holds other content the textblock cannot go without (a list item's
 * paragraph before its nested list), it is the document's only block, or it
 * sits in a table cell, which keeps its place in the table.
 */
function emptiedBlockDepth($from: ResolvedPos): number | null {
	for (let depth = $from.depth; depth > 0; depth--) {
		const parent = $from.node(depth - 1);
		const index = $from.index(depth - 1);
		if (parent.canReplace(index, index + 1)) {
			return depth;
		}
		if (
			depth - 1 === 0 ||
			parent.childCount !== 1 ||
			parent.type.spec.isolating === true
		) {
			return null;
		}
	}
	return null;
}

/**
 * Delete a change's text. A code block or diagram that held nothing else goes
 * with it: a removed or added fence is reviewed as one mark over its whole
 * content, and accepting its removal or rejecting its addition would otherwise
 * leave an empty block in the editor.
 *
 * A paragraph, heading or list item whose whole content is one change goes
 * with it too (Fizzy #2946): one the proposal added whole, when that
 * addition is rejected, and one it deleted whole, when that deletion is
 * accepted. Deleting only the text left an empty paragraph in the document
 * and the room. A change that covers only part of a block, its other text
 * unmarked or marked the other way, leaves the block in place.
 */
function deleteChangeText(tr: Transaction, from: number, to: number) {
	const $from = tr.doc.resolve(from);
	const block = $from.parent;
	const codeLike =
		block.type.spec.code === true || block.type.name === "mermaidBlock";
	const wholeBlock =
		$from.depth > 0 && from === $from.start() && to === $from.end();
	if (wholeBlock && codeLike) {
		tr.delete($from.before(), $from.after());
		return;
	}
	const depth = wholeBlock ? emptiedBlockDepth($from) : null;
	if (depth === null) {
		tr.delete(from, to);
	} else {
		tr.delete($from.before(depth), $from.after(depth));
	}
}

/**
 * Accept a change into `tr`:
 * - Addition (diffInsert / <ins>): remove the mark, keep the text
 * - Deletion (diffDelete / <del>): delete the text entirely, and the block
 *   it emptied when the proposal deleted that block whole
 */
function acceptRange(tr: Transaction, range: DiffRange) {
	if (range.table) {
		if (range.type === "addition") {
			tr.setNodeAttribute(range.from, "diff", null);
		} else {
			tr.delete(range.from, range.to);
		}
	} else if (range.type === "addition") {
		const mark = tr.doc.type.schema.marks.diffInsert;
		if (mark) {
			tr.removeMark(range.from, range.to, mark);
		}
	} else {
		deleteChangeText(tr, range.from, range.to);
	}
}

/**
 * Reject a change into `tr`:
 * - Addition (diffInsert / <ins>): delete the text entirely, and the block
 *   it filled when the proposal added that block whole
 * - Deletion (diffDelete / <del>): remove the mark, keep the text
 */
function rejectRange(tr: Transaction, range: DiffRange) {
	if (range.table) {
		if (range.type === "addition") {
			tr.delete(range.from, range.to);
		} else {
			tr.setNodeAttribute(range.from, "diff", null);
		}
	} else if (range.type === "addition") {
		deleteChangeText(tr, range.from, range.to);
	} else {
		const mark = tr.doc.type.schema.marks.diffDelete;
		if (mark) {
			tr.removeMark(range.from, range.to, mark);
		}
	}
}

/** Accept a single change of the proposal under review in `editor`. */
export function acceptChange(editor: Editor, range: DiffRange) {
	const { tr } = editor.state;
	acceptRange(tr, range);
	editor.view.dispatch(tr);
}

/** Reject a single change of the proposal under review in `editor`. */
export function rejectChange(editor: Editor, range: DiffRange) {
	const { tr } = editor.state;
	rejectRange(tr, range);
	editor.view.dispatch(tr);
}

/**
 * Reject every change of the proposal `editor` holds, in one transaction
 * (Fizzy #2946): what it proposed to add goes, what it proposed to delete
 * stays, unmarked. Everything else in the body — text typed meanwhile,
 * changes already accepted one by one, which carry no marks any more — is
 * left as it is. The changes go from the last to the first, so the
 * positions of the ones still to go do not move. In a room, two editors
 * doing this at once write the same deletions and mark removals, which the
 * room merges into one. Says whether anything was rejected.
 */
export function rejectAllChanges(editor: Editor): boolean {
	const ranges = findDiffRanges(editor.state.doc);
	if (ranges.length === 0) {
		return false;
	}
	const { tr } = editor.state;
	for (const range of [...ranges].reverse()) {
		rejectRange(tr, range);
	}
	editor.view.dispatch(tr);
	return true;
}
