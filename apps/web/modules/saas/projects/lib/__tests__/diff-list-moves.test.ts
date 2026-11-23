/**
 * How the line-by-line review diff lays out a list block moved to another
 * level: where the block starts and which side of it goes first.
 */

import type { FenceRole } from "@repo/utils/glossy/outline";
import { diffArrays } from "diff";
import { describe, expect, it } from "vitest";
import {
	alignmentKeys,
	type ListUnits,
	movedListUnits,
	planLineChunks,
} from "../diff-list-moves";

/** Units from `[line key, list depth, fence role]` triples. */
function units(lines: [string, number, FenceRole][]): ListUnits {
	return {
		keys: lines.map(([key]) => key),
		depths: lines.map(([, depth]) => depth),
		roles: lines.map(([, , role]) => role),
	};
}

/** The plan `diffByLines` lays the two texts' units out by. */
function planOf(before: ListUnits, after: ListUnits) {
	const moved = movedListUnits(before, after);
	return planLineChunks(
		diffArrays(
			alignmentKeys(before, moved.before, "before"),
			alignmentKeys(after, moved.after, "after"),
		),
		before,
		after,
		moved,
	);
}

describe("planLineChunks", () => {
	it("starts a block with the change before it when no line between closes it", () => {
		// `- p\n  - k\n  - a\n- b` → `- P\n  - k\n  - b\n- a`, then a closing
		// paragraph: only `k` lies between the edit and the swap, and it is
		// nested, so the block takes in the edit and starts the document.
		const plan = planOf(
			units([
				["p", 0, null],
				["k", 1, null],
				["a", 1, null],
				["b", 0, null],
				["Notes", 0, null],
			]),
			units([
				["P", 0, null],
				["k", 1, null],
				["b", 1, null],
				["a", 0, null],
				["Notes", 0, null],
			]),
		);

		expect(plan).toEqual([
			{ kind: "moved", removed: 4, added: 4, removedFirst: true },
			{ kind: "same", count: 1 },
		]);
	});

	it("never takes a line of code for the line that closes a block", () => {
		// The unit before the swap is a code line, as shallow as the block:
		// the block starts at the line before it instead.
		const plan = planOf(
			units([
				["r", 0, null],
				["code", 0, "inside"],
				["a", 1, null],
				["b", 0, null],
			]),
			units([
				["r", 0, null],
				["code", 0, "inside"],
				["b", 1, null],
				["a", 0, null],
			]),
		);

		expect(plan).toEqual([
			{ kind: "moved", removed: 4, added: 4, removedFirst: true },
		]);
	});
});
