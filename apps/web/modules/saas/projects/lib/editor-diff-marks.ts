import type { Editor } from "@tiptap/core";
import {
	Fragment,
	type Node as ProseMirrorNode,
	type ResolvedPos,
} from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";

/**
 * An assistant proposal under review in the editor, as its changes sit in
 * the body: what the review bar steps through, accepts and rejects, and what
 * a proposal nobody answers any more is rejected by (Fizzy #2946).
 */

/**
 * The marks an assistant proposal under review carries in the editor, and
 * the kind of change each marks.
 */
const DIFF_MARK_TYPES = new Map<string, DiffRange["type"]>([
	["diffInsert", "addition"],
	["diffDelete", "deletion"],
]);

/**
 * The meta key of a transaction that answers changes under review. The
 * editor marks what a transaction inserts as an addition the reviewer typed;
 * an answer inserts too, when it moves the items a removed line held
 * (`liftNestedItems`), and those items are not new text.
 */
export const DIFF_ANSWER_META = "diffAnswer";

/** One change of a proposal under review. */
export interface DiffRange {
	from: number;
	to: number;
	type: "addition" | "deletion";
	/** A whole table the AI added or removed, carried as the table's `diff` attribute. */
	table?: boolean;
	/**
	 * A list block moved to another level: the whole-line deletions and
	 * additions it is shown as, answered together as one change. The range
	 * spans them all, and `type` is its first line's.
	 */
	moved?: DiffRange[];
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
 *
 * A list block moved to another level is one change (`withMovedBlocks`).
 */
export function findDiffRanges(doc: ProseMirrorNode): DiffRange[] {
	const ranges: MarkedRange[] = [];

	doc.descendants((node, pos) => {
		if (!node.isText && !node.isInline) {
			const diff = node.type.name === "table" ? node.attrs.diff : null;
			if (diff !== "added" && diff !== "deleted") {
				return;
			}
			const { move } = node.attrs;
			ranges.push({
				from: pos,
				to: pos + node.nodeSize,
				type: diff === "added" ? "addition" : "deletion",
				table: true,
				move: typeof move === "string" ? move : null,
			});
			return false;
		}
		for (const mark of node.marks) {
			const type = DIFF_MARK_TYPES.get(mark.type.name);
			if (type !== undefined) {
				const { move } = mark.attrs;
				ranges.push({
					from: pos,
					to: pos + node.nodeSize,
					type,
					move: typeof move === "string" ? move : null,
				});
			}
		}
	});

	// Merge adjacent ranges of the same type, and of the same moved block
	const merged: MarkedRange[] = [];
	for (const range of ranges) {
		const prev = merged[merged.length - 1];
		if (
			prev &&
			!prev.table &&
			!range.table &&
			prev.type === range.type &&
			prev.move === range.move &&
			prev.to === range.from
		) {
			prev.to = range.to;
		} else {
			merged.push({ ...range });
		}
	}

	return withMovedBlocks(doc, merged);
}

/** A change found in the document, with the moved block it is part of. */
type MarkedRange = DiffRange & { move: string | null };

/** Whether `doc` holds inline content between `from` and `to`. */
function inlineBetween(
	doc: ProseMirrorNode,
	from: number,
	to: number,
): boolean {
	let found = false;
	doc.nodesBetween(from, to, (node) => {
		if (node.isInline) {
			found = true;
		}
		return !found;
	});
	return found;
}

/**
 * `ranges` with each list block moved to another level taken as one change:
 * the ranges in a row whose marks carry the same `move`, the block the
 * review diff planned (`planLineChunks` in `diff-list-moves`) and tagged
 * its lines with. Answered line by line, a line that stays could be left
 * under one that goes. A block's lines are all marked, so text left
 * unmarked between two ranges ends it: a document seeded from two diffs
 * can hold two blocks of the same number.
 */
function withMovedBlocks(
	doc: ProseMirrorNode,
	ranges: MarkedRange[],
): DiffRange[] {
	const result: DiffRange[] = [];
	let block: {
		move: string;
		range: DiffRange & { moved: DiffRange[] };
	} | null = null;
	for (const { move, ...range } of ranges) {
		if (
			block !== null &&
			move === block.move &&
			!inlineBetween(doc, block.range.to, range.from)
		) {
			block.range.moved.push(range);
			block.range.to = range.to;
			continue;
		}
		block = null;
		if (move === null) {
			result.push(range);
			continue;
		}
		const created = { ...range, moved: [range] };
		block = { move, range: created };
		result.push(created);
	}
	return result;
}

const LIST_ITEM_NAMES = new Set(["listItem", "taskItem"]);

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
		if (node.marks.some((mark) => DIFF_MARK_TYPES.has(mark.type.name))) {
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
 * paragraph before its nested list, see `liftNestedItems`), it is the
 * document's only block, or it sits in a table cell, which keeps its place
 * in the table.
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

/** Whether `node` is a list: a block of list items only. */
function isList(node: ProseMirrorNode): boolean {
	let items = node.childCount > 0;
	node.forEach((child) => {
		if (!LIST_ITEM_NAMES.has(child.type.name)) {
			items = false;
		}
	});
	return items;
}

/**
 * Delete the line of the list item at `$from` and keep the items nested in
 * it where the other side of the diff has them. Each nested line is a change
 * of its own, or none: deleting the line it sits under decides nothing for
 * it, and must not leave it under an empty bullet, or move it.
 *
 * A nested list the diff leaves unmarked has the same depth on both sides,
 * so where this line is absent its items sit under the item before it: they
 * join that item's nested list (`nestUnderPrevious`). Only an item first in
 * its list has no item before it, and its nested items take its place, one
 * level out. Says whether it did: not when the line is not its item's first
 * block, the item holds more than its line and nested lists, or the list
 * cannot hold the items.
 */
function liftNestedItems(tr: Transaction, $from: ResolvedPos): boolean {
	const itemDepth = $from.depth - 1;
	if (itemDepth < 2 || $from.index(itemDepth) !== 0) {
		return false;
	}
	const item = $from.node(itemDepth);
	if (!LIST_ITEM_NAMES.has(item.type.name) || item.childCount < 2) {
		return false;
	}
	const lists: ProseMirrorNode[] = [];
	for (let index = 1; index < item.childCount; index++) {
		const child = item.child(index);
		if (!isList(child)) {
			return false;
		}
		lists.push(child);
	}
	const list = $from.node(itemDepth - 1);
	const index = $from.index(itemDepth - 1);
	const from = $from.before(itemDepth);
	const to = $from.after(itemDepth);
	if (index > 0) {
		return nestUnderPrevious(tr, list.child(index - 1), from, to, lists);
	}
	let nested = Fragment.empty;
	for (const child of lists) {
		nested = nested.append(child.content);
	}
	if (!list.canReplace(index, index + 1, nested)) {
		return false;
	}
	tr.replaceWith(from, to, nested);
	return true;
}

/**
 * Delete the list item at `from`..`to` and append its nested `lists` to
 * `previous`, the item right before it: the first one's items to the end of
 * `previous`'s own nested list of that kind, when it ends with one, and the
 * rest as nested lists of its own. Says whether `previous` could hold them.
 */
function nestUnderPrevious(
	tr: Transaction,
	previous: ProseMirrorNode,
	from: number,
	to: number,
	lists: ProseMirrorNode[],
): boolean {
	const last = previous.lastChild;
	const [first, ...rest] = lists;
	const end = previous.childCount;
	if (
		last !== null &&
		last.type === first.type &&
		last.canReplace(last.childCount, last.childCount, first.content) &&
		previous.canReplace(end, end, Fragment.from(rest))
	) {
		tr.delete(from, to);
		// `from` is where `previous` ends: one back is the end of its content,
		// and two back the end of its last nested list's.
		if (rest.length > 0) {
			tr.insert(from - 1, Fragment.from(rest));
		}
		tr.insert(from - 2, first.content);
		return true;
	}
	if (!previous.canReplace(end, end, Fragment.from(lists))) {
		return false;
	}
	tr.delete(from, to);
	tr.insert(from - 1, Fragment.from(lists));
	return true;
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
 * unmarked or marked the other way, leaves the block in place. A list
 * item's whole line goes from an item with lists nested in it, and their
 * items stay where the other side has them (`liftNestedItems`).
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
	if (depth !== null) {
		tr.delete($from.before(depth), $from.after(depth));
	} else if (!wholeBlock || !liftNestedItems(tr, $from)) {
		tr.delete(from, to);
	}
}

/**
 * Accept a change into `tr`:
 * - Addition (diffInsert / <ins>): remove the mark, keep the text
 * - Deletion (diffDelete / <del>): delete the text entirely, and the block
 *   it emptied when the proposal deleted that block whole
 * - A moved list block: each of its lines, as above
 */
function acceptRange(tr: Transaction, range: DiffRange) {
	if (range.moved) {
		answerLastToFirst(tr, range.moved, acceptRange);
	} else if (range.table) {
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
 * - A moved list block: each of its lines, as above
 */
function rejectRange(tr: Transaction, range: DiffRange) {
	if (range.moved) {
		answerLastToFirst(tr, range.moved, rejectRange);
	} else if (range.table) {
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

/**
 * Answer `ranges` into `tr` from the last to the first, so the positions of
 * the ones still to go do not move.
 */
function answerLastToFirst(
	tr: Transaction,
	ranges: DiffRange[],
	answer: (tr: Transaction, range: DiffRange) => void,
) {
	for (const range of [...ranges].reverse()) {
		answer(tr, range);
	}
}

/** Accept a single change of the proposal under review in `editor`. */
export function acceptChange(editor: Editor, range: DiffRange) {
	const { tr } = editor.state;
	acceptRange(tr, range);
	editor.view.dispatch(tr.setMeta(DIFF_ANSWER_META, true));
}

/** Reject a single change of the proposal under review in `editor`. */
export function rejectChange(editor: Editor, range: DiffRange) {
	const { tr } = editor.state;
	rejectRange(tr, range);
	editor.view.dispatch(tr.setMeta(DIFF_ANSWER_META, true));
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
	return answerAllChanges(editor, rejectRange);
}

/**
 * Accept every change of the proposal `editor` holds, in one transaction,
 * the counterpart of {@link rejectAllChanges}: what it proposed to add stays
 * unmarked, what it proposed to delete goes. Says whether anything was
 * accepted.
 */
export function acceptAllChanges(editor: Editor): boolean {
	return answerAllChanges(editor, acceptRange);
}

/**
 * The document `editor` would hold once every change still under review is
 * rejected: the changes already accepted, and none of the undecided ones.
 * The editor is not changed.
 */
export function documentWithoutUndecidedChanges(
	editor: Editor,
): ProseMirrorNode {
	const { tr } = editor.state;
	answerEveryRange(tr, rejectRange);
	return tr.doc;
}

/** Answer every change of `tr`'s document into it, last to first. */
function answerEveryRange(
	tr: Transaction,
	answer: (tr: Transaction, range: DiffRange) => void,
): number {
	const ranges = findDiffRanges(tr.doc);
	answerLastToFirst(tr, ranges, answer);
	return ranges.length;
}

/** Answer every change in one transaction, from the last to the first. */
function answerAllChanges(
	editor: Editor,
	answer: (tr: Transaction, range: DiffRange) => void,
): boolean {
	const { tr } = editor.state;
	if (answerEveryRange(tr, answer) === 0) {
		return false;
	}
	editor.view.dispatch(tr.setMeta(DIFF_ANSWER_META, true));
	return true;
}
