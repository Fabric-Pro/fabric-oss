import { describe, expect, it } from "vitest";
import {
	CASES_COL_COVERS,
	CASES_COL_LASTRUN,
	CASES_FULL_COLS,
	CASES_GRID_COLS,
	CASES_NO_COVERS_COLS,
	CASES_NO_LASTRUN_COLS,
} from "../cases-table";

/** The `gap-x-2` the grid classes apply, in px. */
const GAP = 8;

type Tier = { breakpoint: number; tracks: string[] };

/**
 * Pull the three `@[Npx]:grid-cols-[...]` templates back out of the class
 * string, so the test reads the SAME source the browser does rather than a
 * hand-copied duplicate that could quietly drift from it.
 */
function parseTiers(): Tier[] {
	const tiers: Tier[] = [];
	for (const m of CASES_GRID_COLS.matchAll(
		/@\[(\d+)px\]:grid-cols-\[([^\]]+)\]/g,
	)) {
		tiers.push({
			breakpoint: Number(m[1]),
			tracks: m[2].split("_"),
		});
	}
	return tiers.sort((a, b) => a.breakpoint - b.breakpoint);
}

/** Narrowest width a track can occupy: `minmax(a,b)` → a, `123px` → 123. */
function trackMin(track: string): number {
	const minmax = track.match(/^minmax\((\d+)px,/);
	if (minmax) {
		return Number(minmax[1]);
	}
	const fixed = track.match(/^(\d+)px$/);
	if (!fixed) {
		throw new Error(`unhandled grid track: ${track}`);
	}
	return Number(fixed[1]);
}

describe("cases grid tiers", () => {
	const tiers = parseTiers();

	it("declares one template per documented breakpoint", () => {
		expect(tiers.map((t) => t.breakpoint)).toEqual([
			CASES_NO_COVERS_COLS,
			CASES_NO_LASTRUN_COLS,
			CASES_FULL_COLS,
		]);
	});

	/**
	 * The invariant the whole redesign turns on. A tier whose columns add up to
	 * more than the container width it activates at does not clip and does not
	 * scroll — CSS grid lays the surplus tracks out past the card's right edge
	 * and they are simply gone. That is exactly what shipped: the row wanted
	 * 938px inside an 800px card, and "Last run" plus the row menu vanished for
	 * every window between roughly 1024px and 1240px.
	 */
	it.each(parseTiers().map((t) => [t.breakpoint, t] as const))(
		"fits inside its own %ipx breakpoint",
		(breakpoint, tier) => {
			const content = tier.tracks.reduce(
				(sum, t) => sum + trackMin(t),
				0,
			);
			const gaps = (tier.tracks.length - 1) * GAP;
			expect(content + gaps).toBeLessThanOrEqual(breakpoint);
		},
	);

	it("adds exactly one column per tier as the container widens", () => {
		expect(tiers.map((t) => t.tracks.length)).toEqual([8, 9, 10]);
	});

	/**
	 * The header and the row both import these, so a column cannot be dropped
	 * from one and kept in the other — which would slide every cell after it
	 * under the wrong heading while still looking like a table.
	 */
	it("reveals the two optional columns at the tiers their tracks appear in", () => {
		expect(CASES_COL_COVERS).toContain(
			`@[${CASES_NO_LASTRUN_COLS}px]:flex`,
		);
		expect(CASES_COL_LASTRUN).toContain(`@[${CASES_FULL_COLS}px]:flex`);
		// Both hide again at the narrowest grid tier...
		expect(CASES_COL_COVERS).toContain(
			`@[${CASES_NO_COVERS_COLS}px]:hidden`,
		);
		expect(CASES_COL_LASTRUN).toContain(
			`@[${CASES_NO_COVERS_COLS}px]:hidden`,
		);
		// ...but are visible while the row is stacked, where width is free.
		expect(CASES_COL_COVERS.startsWith("flex")).toBe(true);
		expect(CASES_COL_LASTRUN.startsWith("flex")).toBe(true);
	});
});
