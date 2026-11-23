import { moveTag } from "@repo/utils/diff-markers";
import type { FenceRole } from "@repo/utils/glossy/outline";
import { listFenceRoles } from "@repo/utils/proposal-update-summary";
import { type ArrayChange, diffArrays } from "diff";

/**
 * List lines the line-by-line review diff (`diffByLines` in `diff-utils`)
 * shows moved to another level: the lines that move with each, and how the
 * changed run holding them is laid out. The editor reads both sides of a
 * moved block as one list, so the layout keeps every line under its own
 * parent whichever way the move is answered.
 */

/** A line with no content past its list marker, which no marker wraps. */
const BARE_LIST_MARKER_RE = /^\s*(?:\d+[.)]|[-*+])\s*$/;

/**
 * A line that is only a table the diff took out as one token
 * (`extractGfmTablesForDiff` and `extractHtmlTablesForDiff` in
 * `diff-utils`): the table gets a marker pair of its own, with its block's
 * tag (`wrapPartWithMarkers`).
 */
const TABLE_PLACEHOLDER_LINE_RE = /^\s*x(?:GFMTABLE|HTMLBLOCK)x\d+xENDx\s*$/;

/**
 * `text`, a side of moved block `block`, with each of its lines tagged
 * (`moveTag`) at its very start. The tag only rides there until
 * `splitMultilineDiffBlocks` in `diff-utils` gives the line its own marker
 * pair: it then goes right after the start marker, behind whatever list
 * marker, heading or quote prefix the line keeps outside it. A blank line,
 * a fence line and a table are left as they are: a code block and a
 * table take the tag of the lines around them.
 */
export function tagMovedLines(text: string, block: number): string {
	const lines = text.split("\n");
	const roles = listFenceRoles(lines);
	return lines
		.map((line, index) =>
			roles[index] !== null ||
			line.trim() === "" ||
			BARE_LIST_MARKER_RE.test(line) ||
			TABLE_PLACEHOLDER_LINE_RE.test(line)
				? line
				: `${moveTag(block)}${line}`,
		)
		.join("\n");
}

/** The aligned units of one text: line key, list depth and fence role. */
export type ListUnits = {
	keys: string[];
	depths: number[];
	roles: FenceRole[];
};

/** Unit indexes of the old text (`before`) and of the new (`after`). */
type UnitSet = { before: Set<number>; after: Set<number> };

/** Units `oFrom` to `oTo` of the old text and `nFrom` to `nTo` of the new. */
type Span = { oFrom: number; oTo: number; nFrom: number; nTo: number };

/** One step of the laid-out diff, counted in units. */
type LineChunk =
	| { kind: "same" | "removed" | "added"; count: number }
	| { kind: "moved"; removed: number; added: number; removedFirst: boolean };

/** Each unit's alignment key: its line key at its list depth. */
function depthKeys(units: ListUnits): string[] {
	return units.keys.map((key, index) => `${units.depths[index]}:${key}`);
}

/**
 * The run of changed chunks that starts at `from`: the chunk after it, and
 * how many units it removes and adds.
 */
function changedRun(
	chunks: ArrayChange<string>[],
	from: number,
): { end: number; removed: number; added: number } {
	let end = from;
	let removed = 0;
	let added = 0;
	while (end < chunks.length && (chunks[end].added || chunks[end].removed)) {
		if (chunks[end].added) {
			added += chunks[end].value.length;
		} else {
			removed += chunks[end].value.length;
		}
		end += 1;
	}
	return { end, removed, added };
}

/**
 * The units of the list lines moved to another level, on each side. A moved
 * line is a unit removed at one depth and added with the same text at
 * another, in the same changed run. The lines nested under it move with it,
 * on either side, and so do their counterparts on the other side: the lines
 * the move gives another parent.
 */
export function movedListUnits(before: ListUnits, after: ListUnits): UnitSet {
	const moved: UnitSet = { before: new Set(), after: new Set() };
	// Each unit's counterpart on the other side: the unit aligned with it,
	// or for a moved line, the line it moved to or from.
	const counterpart = {
		before: new Map<number, number>(),
		after: new Map<number, number>(),
	};
	const pair = (old: number, next: number) => {
		counterpart.before.set(old, next);
		counterpart.after.set(next, old);
	};
	const pending: { side: keyof UnitSet; at: number }[] = [];
	const chunks = diffArrays(depthKeys(before), depthKeys(after));
	let beforeAt = 0;
	let afterAt = 0;
	let i = 0;
	while (i < chunks.length) {
		const count = chunks[i].value.length;
		if (!chunks[i].added && !chunks[i].removed) {
			for (let k = 0; k < count; k++) {
				pair(beforeAt + k, afterAt + k);
			}
			beforeAt += count;
			afterAt += count;
			i += 1;
			continue;
		}
		const run = changedRun(chunks, i);
		const paired = new Set<number>();
		for (let old = beforeAt; old < beforeAt + run.removed; old++) {
			for (let next = afterAt; next < afterAt + run.added; next++) {
				if (
					!paired.has(next) &&
					before.roles[old] === null &&
					after.roles[next] === null &&
					before.keys[old] === after.keys[next] &&
					before.depths[old] !== after.depths[next]
				) {
					paired.add(next);
					pair(old, next);
					pending.push({ side: "before", at: old });
					break;
				}
			}
		}
		beforeAt += run.removed;
		afterAt += run.added;
		i = run.end;
	}
	for (let item = pending.pop(); item; item = pending.pop()) {
		const { side, at } = item;
		if (moved[side].has(at)) {
			continue;
		}
		moved[side].add(at);
		const across = counterpart[side].get(at);
		if (across !== undefined) {
			pending.push({
				side: side === "before" ? "after" : "before",
				at: across,
			});
		}
		const depths = side === "before" ? before.depths : after.depths;
		for (let next = at + 1; depths[next] > depths[at]; next++) {
			pending.push({ side, at: next });
		}
	}
	return moved;
}

/**
 * Alignment keys with the moved units taken out of the alignment: each gets
 * a key of its own, so it is replaced rather than matched.
 */
export function alignmentKeys(
	units: ListUnits,
	moved: Set<number>,
	side: keyof UnitSet,
): string[] {
	return depthKeys(units).map((key, index) =>
		moved.has(index) ? `${side}\u0000${index}` : key,
	);
}

/** The smallest list depth of units `from` to `to`, `Infinity` for none. */
function minDepth(units: ListUnits, from: number, to: number): number {
	let depth = Number.POSITIVE_INFINITY;
	for (let at = from; at < to; at++) {
		depth = Math.min(depth, units.depths[at]);
	}
	return depth;
}

/**
 * The part of the changed run `run` to replace whole for the lines moved in
 * it, and whether its old side goes first. A side goes first only when no
 * line of the other would nest under it, and the lines before and after
 * the block must not nest under it either, or answering the move would
 * leave them under a line that went. Until that holds, the block takes in
 * the run's other changes, then the unchanged units around the run, up to
 * `room` of them on each side. `"earlier"` when the block must start before
 * that room, at a line past the change before the run: the two runs are
 * then laid out as one (`planLineChunks`).
 */
function movedBlock(
	before: ListUnits,
	after: ListUnits,
	moved: UnitSet,
	run: Span,
	room: { back: number; ahead: number },
): (Span & { removedFirst: boolean }) | "earlier" | null {
	if (run.oFrom === run.oTo || run.nFrom === run.nTo) {
		return null;
	}
	const movedIn = (set: Set<number>, from: number, to: number) => {
		const found: number[] = [];
		for (let at = from; at < to; at++) {
			if (set.has(at)) {
				found.push(at);
			}
		}
		return found;
	};
	const oldMoved = movedIn(moved.before, run.oFrom, run.oTo);
	const newMoved = movedIn(moved.after, run.nFrom, run.nTo);
	if (oldMoved.length === 0 && newMoved.length === 0) {
		return null;
	}
	const block: Span = { ...run };
	if (oldMoved.length > 0 && newMoved.length > 0) {
		block.oFrom = oldMoved[0];
		block.oTo = oldMoved[oldMoved.length - 1] + 1;
		block.nFrom = newMoved[0];
		block.nTo = newMoved[newMoved.length - 1] + 1;
	}
	const blockMin = () => {
		const old = minDepth(before, block.oFrom, block.oTo);
		return Math.min(old, minDepth(after, block.nFrom, block.nTo));
	};
	// An unchanged unit, the same on both sides, that closes every list
	// item of the block: no fence line, and no deeper than any of its lines.
	const closes = (at: number) =>
		before.roles[at] === null && before.depths[at] <= blockMin();
	for (;;) {
		const prefix = block.oFrom > run.oFrom || block.nFrom > run.nFrom;
		const suffix = block.oTo < run.oTo || block.nTo < run.nTo;
		const prefixMin = Math.min(
			minDepth(before, run.oFrom, block.oFrom),
			minDepth(after, run.nFrom, block.nFrom),
		);
		const starts = Math.max(
			before.depths[block.oFrom],
			after.depths[block.nFrom],
		);
		if (prefix && starts > prefixMin) {
			block.oFrom = run.oFrom;
			block.nFrom = run.nFrom;
			continue;
		}
		const next = Math.max(
			block.oTo < run.oTo ? before.depths[block.oTo] : 0,
			block.nTo < run.nTo ? after.depths[block.nTo] : 0,
		);
		if (suffix && next > blockMin()) {
			block.oTo = run.oTo;
			block.nTo = run.nTo;
			continue;
		}
		if (!suffix) {
			const left = room.ahead - (block.oTo - run.oTo);
			let ahead = 0;
			while (ahead < left && !closes(block.oTo + ahead)) {
				ahead += 1;
			}
			if (ahead > 0) {
				block.oTo += ahead;
				block.nTo += ahead;
				continue;
			}
		}
		const oldMin = minDepth(before, block.oFrom, block.oTo);
		const newMin = minDepth(after, block.nFrom, block.nTo);
		if (oldMin >= after.depths[block.nFrom]) {
			return { ...block, removedFirst: true };
		}
		if (newMin >= before.depths[block.oFrom]) {
			return { ...block, removedFirst: false };
		}
		if (prefix) {
			block.oFrom = run.oFrom;
			block.nFrom = run.nFrom;
			continue;
		}
		// Neither side can go first: start both with the unchanged line
		// before the run that closes every item of the block.
		const behind = room.back - (run.oFrom - block.oFrom);
		let back = 1;
		while (back <= behind && !closes(block.oFrom - back)) {
			back += 1;
		}
		if (back > behind) {
			if (block.oFrom > behind || block.nFrom > behind) {
				// No line between the change before this run and the block
				// closes it: the block starts with that change.
				return "earlier";
			}
			if (behind === 0) {
				return { ...block, removedFirst: true };
			}
			// The document's first line: no line before it to nest under.
			back = behind;
		}
		block.oFrom -= back;
		block.nFrom -= back;
	}
}

/**
 * A run of changed chunks: its units, its chunks (`first` up to `end`), and
 * the unchanged units after it.
 */
type Run = { span: Span; first: number; end: number; ahead: number };

/** The runs of changed chunks of `chunks`, in order. */
function changedRuns(chunks: ArrayChange<string>[]): Run[] {
	const runs: Run[] = [];
	let beforeAt = 0;
	let afterAt = 0;
	let i = 0;
	while (i < chunks.length) {
		const count = chunks[i].value.length;
		if (!chunks[i].added && !chunks[i].removed) {
			beforeAt += count;
			afterAt += count;
			i += 1;
			continue;
		}
		const run = changedRun(chunks, i);
		runs.push({
			span: {
				oFrom: beforeAt,
				oTo: beforeAt + run.removed,
				nFrom: afterAt,
				nTo: afterAt + run.added,
			},
			first: i,
			end: run.end,
			ahead: chunks[run.end]?.value.length ?? 0,
		});
		beforeAt += run.removed;
		afterAt += run.added;
		i = run.end;
	}
	return runs;
}

/** How far a plan was laid out: its length, and the units it took. */
type PlanMark = { length: number; oldDone: number; newDone: number };

/**
 * The aligned `chunks` laid out as the diff emits them: a changed run that
 * holds a moved list line gets its moved block (see `movedBlock`), replaced
 * whole, and its other changes stay removals and additions around it. A
 * block that must start before the change ahead of its run is laid out
 * again with that change, and the unchanged units between, as one run.
 */
export function planLineChunks(
	chunks: ArrayChange<string>[],
	before: ListUnits,
	after: ListUnits,
	moved: UnitSet,
): LineChunk[] {
	const plan: LineChunk[] = [];
	// The units laid out so far, on each side.
	let oldDone = 0;
	let newDone = 0;
	const keep = (count: number) => {
		if (count > 0) {
			plan.push({ kind: "same", count });
			oldDone += count;
			newDone += count;
		}
	};
	const change = (removed: number, added: number) => {
		if (removed > 0) {
			plan.push({ kind: "removed", count: removed });
		}
		if (added > 0) {
			plan.push({ kind: "added", count: added });
		}
		oldDone += removed;
		newDone += added;
	};
	const runs = changedRuns(chunks);
	// The runs laid out so far, in groups laid out together: each group's
	// first run, and where the plan stood before it.
	const groups: (PlanMark & { first: number })[] = [];
	for (const [index, run] of runs.entries()) {
		let first = index;
		let start: PlanMark = { length: plan.length, oldDone, newDone };
		for (;;) {
			const span: Span = {
				oFrom: runs[first].span.oFrom,
				oTo: run.span.oTo,
				nFrom: runs[first].span.nFrom,
				nTo: run.span.nTo,
			};
			const block = movedBlock(before, after, moved, span, {
				back: span.oFrom - start.oldDone,
				ahead: run.ahead,
			});
			// The first group's room reaches the document's start, so a
			// block asks for an earlier start only after another group.
			const previous = block === "earlier" ? groups.pop() : undefined;
			if (previous) {
				first = previous.first;
				start = previous;
				continue;
			}
			plan.length = start.length;
			oldDone = start.oldDone;
			newDone = start.newDone;
			groups.push({ ...start, first });
			if (block === null || block === "earlier") {
				keep(span.oFrom - oldDone);
				for (const chunk of chunks.slice(runs[first].first, run.end)) {
					const length = chunk.value.length;
					if (chunk.added || chunk.removed) {
						change(
							chunk.removed ? length : 0,
							chunk.added ? length : 0,
						);
					} else {
						keep(length);
					}
				}
				break;
			}
			keep(Math.min(block.oFrom, span.oFrom) - oldDone);
			change(block.oFrom - oldDone, block.nFrom - newDone);
			plan.push({
				kind: "moved",
				removed: block.oTo - block.oFrom,
				added: block.nTo - block.nFrom,
				removedFirst: block.removedFirst,
			});
			oldDone = block.oTo;
			newDone = block.nTo;
			change(
				Math.max(span.oTo - oldDone, 0),
				Math.max(span.nTo - newDone, 0),
			);
			break;
		}
	}
	keep(before.keys.length - oldDone);
	return plan;
}
