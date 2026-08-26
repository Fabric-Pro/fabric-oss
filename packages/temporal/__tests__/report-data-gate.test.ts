import { describe, expect, it } from "vitest";
import {
	countAgenticRecords,
	hasNoUsableData,
	mapAgenticGatheredData,
} from "../src/activities/template-instance/report-data-gate";

describe("countAgenticRecords", () => {
	it("counts array length", () => {
		expect(countAgenticRecords([{ id: 1 }, { id: 2 }])).toBe(2);
		expect(countAgenticRecords([])).toBe(0);
	});
	it("treats null/undefined as zero", () => {
		expect(countAgenticRecords(null)).toBe(0);
		expect(countAgenticRecords(undefined)).toBe(0);
	});
	it("treats wrapper-empty objects (incl. zero/false metadata) as zero (Codex finding 4)", () => {
		expect(countAgenticRecords({})).toBe(0);
		expect(countAgenticRecords({ items: [] })).toBe(0);
		expect(countAgenticRecords({ data: [] })).toBe(0);
		expect(countAgenticRecords({ results: [], total: 0 })).toBe(0);
		expect(countAgenticRecords({ items: [], count: 0 })).toBe(0);
		expect(countAgenticRecords({ data: { items: [] } })).toBe(0); // nested wrapper-empty
		expect(countAgenticRecords({ ok: false, error: null })).toBe(0);
	});
	it("counts an object with real content as one record", () => {
		expect(countAgenticRecords({ name: "Board A" })).toBe(1);
		expect(countAgenticRecords({ items: [{ id: 1 }] })).toBe(1);
		expect(countAgenticRecords({ results: [], total: 5 })).toBe(1); // non-zero metadata = content
	});
	it("counts a truthy primitive as one, falsy as zero", () => {
		expect(countAgenticRecords("x")).toBe(1);
		expect(countAgenticRecords(0)).toBe(0);
		expect(countAgenticRecords("")).toBe(0);
	});
});

describe("hasNoUsableData", () => {
	it("fails an incomplete run with zero usable records", () => {
		expect(hasNoUsableData(true, 0)).toBe(true);
	});
	it("passes an incomplete run that gathered records", () => {
		expect(hasNoUsableData(true, 12)).toBe(false);
	});
	it("passes a complete run even with zero records (empty board)", () => {
		expect(hasNoUsableData(false, 0)).toBe(false);
	});
});

describe("mapAgenticGatheredData (gate input — Codex finding 3)", () => {
	const opts = {
		toolToSourceId: { fizzy_get_cards: "ds_cards" },
		provider: "fizzy",
	};

	it("sums usable records and maps tool names to source ids", () => {
		const { results, totalRecords } = mapAgenticGatheredData(
			{
				fizzy_get_cards: [{ id: 1 }, { id: 2 }],
				fizzy_get_board: { name: "B" },
			},
			opts,
		);
		expect(totalRecords).toBe(3); // 2 cards + 1 board object
		expect(
			results.find((r) => r.sourceId === "ds_cards")?.recordCount,
		).toBe(2);
		expect(
			results.find((r) => r.sourceId === "agentic_fizzy_get_board"),
		).toBeDefined();
	});

	it("reports zero total for a salvage of only wrapper-empty data (gate must fail it)", () => {
		const { results, totalRecords } = mapAgenticGatheredData(
			{ fizzy_get_cards: [], fizzy_get_board: { items: [], total: 0 } },
			opts,
		);
		expect(results.length).toBe(2); // entries still present...
		expect(totalRecords).toBe(0); // ...but zero usable records => hasNoUsableData(true,0) === true
		expect(hasNoUsableData(true, totalRecords)).toBe(true);
	});

	it("forwards `_`-prefixed metadata keys but counts them as zero records", () => {
		const { results, totalRecords } = mapAgenticGatheredData(
			{
				fizzy_get_cards: [{ id: 1 }, { id: 2 }, { id: 3 }],
				_coverage: {
					fizzy_get_cards: {
						total_count: 611,
						pages_fetched: [1, 2],
						has_more_at_last_page: true,
					},
				},
				// A second metadata key: the rule is the `_` prefix, not the
				// specific name, so a new marker never has to be allow-listed.
				_board_fix: { partial: true, coverage: "unknown" },
			},
			opts,
		);

		const coverage = results.find(
			(r) => r.sourceId === "agentic__coverage",
		);
		expect(coverage).toBeDefined(); // still emitted to the report prompt
		expect(coverage?.recordCount).toBe(0);
		const boardFix = results.find(
			(r) => r.sourceId === "agentic__board_fix",
		);
		expect(boardFix).toBeDefined();
		expect(boardFix?.recordCount).toBe(0);
		expect(totalRecords).toBe(3); // only the real cards count
	});

	it("still fails the gate when only `_coverage` metadata was gathered", () => {
		const { totalRecords } = mapAgenticGatheredData(
			{ _coverage: { fizzy_get_cards: { total_count: 611 } } },
			opts,
		);
		expect(totalRecords).toBe(0);
		expect(hasNoUsableData(true, totalRecords)).toBe(true);
	});
});
