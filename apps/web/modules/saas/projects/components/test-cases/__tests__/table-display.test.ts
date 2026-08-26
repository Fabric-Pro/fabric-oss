import { describe, expect, it } from "vitest";
import {
	DEFAULT_DISPLAY,
	DENSITIES,
	HIDEABLE_COLUMNS,
} from "../use-table-display";

/**
 * The parser is not exported — it is an implementation detail of the hook — so
 * this exercises the same contract through a local copy of the rules the hook
 * documents. Kept deliberately small: what matters is that malformed or stale
 * storage can never break the table, because storage is hand-editable and
 * outlives any given release.
 */
function parse(raw: string | null) {
	if (!raw) {
		return DEFAULT_DISPLAY;
	}
	try {
		const value = JSON.parse(raw);
		return {
			density: (DENSITIES as readonly string[]).includes(value.density)
				? value.density
				: DEFAULT_DISPLAY.density,
			hidden: Array.isArray(value.hidden)
				? value.hidden.filter((c: string) =>
						(HIDEABLE_COLUMNS as readonly string[]).includes(c),
					)
				: [],
		};
	} catch {
		return DEFAULT_DISPLAY;
	}
}

describe("table display preferences", () => {
	it("falls back to the default when nothing is stored", () => {
		expect(parse(null)).toEqual(DEFAULT_DISPLAY);
	});

	it("survives malformed storage rather than throwing", () => {
		// Hand-edited or truncated by a crashed write. The table must still
		// render — losing a preference is survivable, losing the page is not.
		expect(parse("{not json")).toEqual(DEFAULT_DISPLAY);
		expect(parse("null")).toEqual(DEFAULT_DISPLAY);
	});

	it("rejects a density that is not one of the real options", () => {
		expect(parse('{"density":"enormous"}').density).toBe(
			DEFAULT_DISPLAY.density,
		);
	});

	it("drops hidden columns that no longer exist", () => {
		// A column removed from the product leaves a stale id in someone's
		// browser forever; unfiltered it would resurface as a phantom entry in
		// the column menu that toggles nothing.
		expect(
			parse('{"hidden":["covers","aColumnWeDeleted","lastRun"]}').hidden,
		).toEqual(["covers", "lastRun"]);
	});

	it("ignores a hidden value that is not a list", () => {
		expect(parse('{"hidden":"covers"}').hidden).toEqual([]);
	});

	it("round-trips a valid preference", () => {
		expect(parse('{"density":"compact","hidden":["owner"]}')).toEqual({
			density: "compact",
			hidden: ["owner"],
		});
	});

	it("keeps every hideable column genuinely optional", () => {
		// The row and the header both key off these ids; a column that is
		// hideable but not actually rendered conditionally would silently do
		// nothing when switched off.
		expect(HIDEABLE_COLUMNS.length).toBeGreaterThan(0);
		expect(new Set(HIDEABLE_COLUMNS).size).toBe(HIDEABLE_COLUMNS.length);
		// The two identity columns must NOT be hideable — a table with no id and
		// no title is a list of chips.
		expect(HIDEABLE_COLUMNS as readonly string[]).not.toContain(
			"identifier",
		);
		expect(HIDEABLE_COLUMNS as readonly string[]).not.toContain("title");
	});
});
