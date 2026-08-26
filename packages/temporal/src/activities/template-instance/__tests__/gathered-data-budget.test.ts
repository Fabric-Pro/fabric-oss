import { describe, expect, it } from "vitest";
import {
	boundGatheredData,
	capRenderedReport,
	DEFAULT_GATHERED_DATA_MAX_BYTES,
	MIN_GATHERED_DATA_BUDGET_BYTES,
} from "../gathered-data-budget";
import { countAgenticRecords } from "../report-data-gate";

/** UTF-8 byte length of a value's JSON, mirroring the helper's own metric. */
function jsonBytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");
}

/** A JSON string of roughly `n` ASCII bytes. */
function bigString(n: number): string {
	return "x".repeat(n);
}

describe("boundGatheredData", () => {
	it("returns the input unchanged when already under budget", () => {
		const data = { fizzy_get_cards: [{ id: "1", title: "a" }] };
		const result = boundGatheredData(data, { maxBytes: 1_000_000 });

		expect(result.trimmed).toBe(false);
		expect(result.data).toBe(data); // same reference — no clone on the fast path
		expect(result.notes).toEqual([]);
		expect(result.finalBytes).toBe(result.originalBytes);
		expect(result.finalBytes).toBeLessThanOrEqual(1_000_000);
	});

	it("default budget is a safe margin under Temporal's 2 MiB blob limit", () => {
		expect(DEFAULT_GATHERED_DATA_MAX_BYTES).toBeLessThan(2 * 1024 * 1024);
		expect(DEFAULT_GATHERED_DATA_MAX_BYTES).toBeGreaterThan(1_000_000);
	});

	it("Stage A: truncates long string fields, preserving short/id fields", () => {
		const data = {
			fizzy_get_cards: Array.from({ length: 20 }, (_, i) => ({
				id: `card-${i}`,
				status: "In Progress",
				title: `Card ${i}`,
				description_html: bigString(4000),
			})),
		};
		// Budget is loose enough that truncating the heavy field alone (Stage A)
		// fits — so all rows survive and only Stage A runs.
		const result = boundGatheredData(data, {
			maxBytes: 20_000,
			maxFieldChars: 500,
		});

		expect(result.trimmed).toBe(true);
		expect(result.finalBytes).toBeLessThanOrEqual(20_000);
		const cards = result.data.fizzy_get_cards as Array<
			Record<string, unknown>
		>;
		// All 20 cards retained (only their heavy field was truncated)
		expect(cards).toHaveLength(20);
		for (const card of cards) {
			expect(card.id).toMatch(/^card-\d+$/); // ids preserved
			expect(card.status).toBe("In Progress"); // short fields preserved
			expect(String(card.description_html).length).toBeLessThanOrEqual(
				600,
			);
			expect(String(card.description_html)).toContain("truncated");
		}
		expect(result.notes.join(" ")).toMatch(/truncat/i);
	});

	it("Stage B: caps arrays of many small records that can't be string-trimmed", () => {
		const data = {
			fizzy_get_cards: Array.from({ length: 5000 }, (_, i) => ({
				id: `c${i}`,
				status: "Done",
			})),
		};
		const result = boundGatheredData(data, { maxBytes: 8_000 });

		expect(result.trimmed).toBe(true);
		expect(result.finalBytes).toBeLessThanOrEqual(8_000);
		const cards = result.data.fizzy_get_cards as unknown[];
		expect(cards.length).toBeLessThan(5000); // capped
		expect(cards.length).toBeGreaterThan(0); // but not emptied
		expect(result.notes.join(" ")).toMatch(/cap|omit|5000/i);
	});

	it("Stage C: drops the largest key when a non-array giant can't be shrunk", () => {
		// A single object with thousands of SHORT fields — Stage A can't truncate
		// (each field < maxFieldChars) and Stage B can't cap (not an array).
		const bigObj: Record<string, string> = {};
		for (let i = 0; i < 3000; i++) {
			bigObj[`f${i}`] = "shortval";
		}
		const data = {
			keep_me: [{ id: "1" }],
			huge_blob: bigObj,
		};
		const result = boundGatheredData(data, {
			maxBytes: 4_000,
			maxFieldChars: 1000,
		});

		expect(result.trimmed).toBe(true);
		expect(result.finalBytes).toBeLessThanOrEqual(4_000);
		expect(result.data.keep_me).toBeDefined(); // smaller key retained
		expect(result.data.huge_blob).toBeUndefined(); // largest key dropped
		expect(result.notes.join(" ")).toMatch(/drop.*huge_blob|huge_blob/i);
	});

	it("Stage C: drops `_`-prefixed metadata before the data it describes", () => {
		// One fat card that survives Stage A (every field < maxFieldChars) and
		// Stage B (an array is never reduced below one item), so Stage C fires.
		const fatCard: Record<string, string> = { id: "c1" };
		for (let i = 0; i < 300; i++) {
			fatCard[`f${i}`] = "shortval";
		}
		const data = {
			fizzy_get_cards: [fatCard, { ...fatCard, id: "c2" }],
			_coverage: {
				fizzy_get_cards: {
					total_count: 611,
					pages_fetched: [1],
					has_more_at_last_page: true,
				},
			},
		};
		const result = boundGatheredData(data, {
			maxBytes: 1_500,
			maxFieldChars: 1000,
		});

		expect(result.trimmed).toBe(true);
		expect(result.finalBytes).toBeLessThanOrEqual(1_500);
		// `_coverage` is far SMALLER than the card array — size-only ordering
		// would have dropped the cards and kept a total_count describing records
		// that are no longer there.
		expect(result.data._coverage).toBeUndefined();
		expect(result.data.fizzy_get_cards).toBeDefined();
		expect(result.notes.join(" ")).toMatch(/dropped key _coverage/);
	});

	it("never leaves `_coverage` behind once its records were dropped", () => {
		// Several oversized data keys plus metadata: whatever else the cascade
		// drops, metadata must never outlive the records it describes.
		const bigObj: Record<string, string> = {};
		for (let i = 0; i < 2000; i++) {
			bigObj[`f${i}`] = "shortval";
		}
		const data = {
			fizzy_get_cards: bigObj,
			fizzy_get_boards: bigObj,
			_coverage: { fizzy_get_cards: { total_count: 611 } },
		};
		const result = boundGatheredData(data, {
			maxBytes: 2_000,
			maxFieldChars: 1000,
		});

		expect(result.finalBytes).toBeLessThanOrEqual(2_000);
		const coverageSurvived = result.data._coverage !== undefined;
		const cardsSurvived = result.data.fizzy_get_cards !== undefined;
		expect(coverageSurvived && !cardsSurvived).toBe(false);
		expect(result.data._coverage).toBeUndefined();
	});

	it("guarantees finalBytes <= maxBytes for adversarial inputs", () => {
		const inputs: Record<string, unknown>[] = [
			// all long strings
			{ a: bigString(5000), b: bigString(5000), c: bigString(5000) },
			// all arrays
			{
				arr1: Array.from({ length: 2000 }, (_, i) => ({ id: i })),
				arr2: Array.from({ length: 2000 }, (_, i) => ({ id: i })),
			},
			// one giant scalar string
			{ only: bigString(50_000) },
			// deeply nested
			{
				root: {
					level1: { level2: { level3: { blob: bigString(20_000) } } },
				},
			},
			// multi-byte UTF-8 (emoji ≈ 4 bytes each)
			{ emoji: "🎉".repeat(5000) },
			// mixed
			{
				fizzy_get_cards: Array.from({ length: 500 }, (_, i) => ({
					id: `c${i}`,
					description_html: bigString(2000),
				})),
				meta: { note: bigString(3000) },
			},
		];
		for (const input of inputs) {
			const result = boundGatheredData(input, { maxBytes: 2_000 });
			expect(result.finalBytes).toBeLessThanOrEqual(2_000);
			// The reported finalBytes matches the actual serialized size.
			expect(result.finalBytes).toBe(jsonBytes(result.data));
		}
	});

	it("is deterministic — identical input yields byte-identical output", () => {
		const make = () => ({
			fizzy_get_cards: Array.from({ length: 300 }, (_, i) => ({
				id: `c${i}`,
				description_html: bigString(1500),
			})),
			fizzy_get_board: { id: "b1", name: bigString(3000) },
		});
		const a = boundGatheredData(make(), { maxBytes: 5_000 });
		const b = boundGatheredData(make(), { maxBytes: 5_000 });
		expect(JSON.stringify(a.data)).toBe(JSON.stringify(b.data));
		expect(a.finalBytes).toBe(b.finalBytes);
	});

	it("does not mutate the caller's input object", () => {
		const data = {
			fizzy_get_cards: Array.from({ length: 100 }, (_, i) => ({
				id: `c${i}`,
				description_html: bigString(2000),
			})),
		};
		const snapshot = JSON.stringify(data);
		boundGatheredData(data, { maxBytes: 3_000 });
		expect(JSON.stringify(data)).toBe(snapshot); // untouched
	});

	it("reports accurate originalBytes and finalBytes", () => {
		const data = { only: bigString(20_000) };
		const result = boundGatheredData(data, { maxBytes: 2_000 });
		expect(result.originalBytes).toBe(jsonBytes(data));
		expect(result.finalBytes).toBe(jsonBytes(result.data));
		expect(result.finalBytes).toBeLessThan(result.originalBytes);
	});

	it("never trims a data-bearing payload down to zero usable records", () => {
		// A large board that MUST be aggressively trimmed. Trimming for size must
		// not zero the records — else the workflow's hasNoUsableData(isPartial, 0)
		// gate would hard-fail a run that actually gathered abundant data (#1750).
		const data = {
			fizzy_get_cards: Array.from({ length: 3000 }, (_, i) => ({
				id: `c${i}`,
				status: "Done",
				description_html: bigString(3000),
			})),
		};
		const result = boundGatheredData(data, { maxBytes: 50_000 });

		expect(result.trimmed).toBe(true);
		expect(result.finalBytes).toBeLessThanOrEqual(50_000);
		const cards = result.data.fizzy_get_cards as unknown[];
		expect(cards.length).toBeGreaterThanOrEqual(1);
		// The value the no-usable-data gate would see is non-zero.
		let totalRecords = 0;
		for (const value of Object.values(result.data)) {
			totalRecords += countAgenticRecords(value);
		}
		expect(totalRecords).toBeGreaterThanOrEqual(1);
	});

	it("compacts a single over-budget key to a marker instead of emptying the payload", () => {
		// One giant non-array object with short fields — Stage A can't truncate,
		// Stage B can't cap, and Stage C must not delete the only key.
		const bigObj: Record<string, string> = {};
		for (let i = 0; i < 5000; i++) {
			bigObj[`f${i}`] = "shortvalue";
		}
		const result = boundGatheredData(
			{ huge_blob: bigObj },
			{ maxBytes: 3_000 },
		);

		expect(result.finalBytes).toBeLessThanOrEqual(3_000);
		expect(Object.keys(result.data)).toHaveLength(1); // not emptied
		expect(
			(result.data.huge_blob as { _truncated?: boolean })._truncated,
		).toBe(true);
		// A marker still counts as one usable record for the gate.
		expect(
			countAgenticRecords(result.data.huge_blob),
		).toBeGreaterThanOrEqual(1);
	});

	it("honors finalBytes <= effective budget even for a pathologically tiny maxBytes", () => {
		// A budget below the ~81 B minimal marker can't hold one contentful record;
		// the effective budget is floored (MIN_GATHERED_DATA_BUDGET_BYTES) so the
		// guarantee still holds and the payload is never emptied. (Prod clamps to
		// ≥100 KB; this only guards direct/pathological callers.)
		const data = {
			fizzy_get_cards: Array.from({ length: 200 }, (_, i) => ({
				id: `c${i}`,
				description_html: bigString(2000),
			})),
		};
		const result = boundGatheredData(data, { maxBytes: 2 });

		expect(result.trimmed).toBe(true);
		expect(result.finalBytes).toBe(jsonBytes(result.data)); // reported size is real
		expect(result.finalBytes).toBeLessThanOrEqual(
			MIN_GATHERED_DATA_BUDGET_BYTES,
		);
		expect(Object.keys(result.data).length).toBeGreaterThanOrEqual(1); // never emptied
		let totalRecords = 0;
		for (const value of Object.values(result.data)) {
			totalRecords += countAgenticRecords(value);
		}
		expect(totalRecords).toBeGreaterThanOrEqual(1);
	});
});

describe("capRenderedReport", () => {
	it("returns the input unchanged when under budget", () => {
		const text = "# Report\n\nSome content.";
		const result = capRenderedReport(text, { maxBytes: 1_000_000 });
		expect(result.truncated).toBe(false);
		expect(result.text).toBe(text);
		expect(result.finalBytes).toBe(result.originalBytes);
	});

	it("truncates over-budget markdown and appends a notice, staying under budget", () => {
		const text = `${"line of report content\n".repeat(2000)}`;
		const result = capRenderedReport(text, {
			maxBytes: 5_000,
			isHtml: false,
		});
		expect(result.truncated).toBe(true);
		expect(result.finalBytes).toBeLessThanOrEqual(5_000);
		expect(result.text).toContain("Report truncated");
		expect(result.originalBytes).toBeGreaterThan(5_000);
	});

	it("uses an HTML notice for HTML output", () => {
		const text = `${"<tr><td>cell</td></tr>\n".repeat(2000)}`;
		const result = capRenderedReport(text, {
			maxBytes: 5_000,
			isHtml: true,
		});
		expect(result.truncated).toBe(true);
		expect(result.finalBytes).toBeLessThanOrEqual(5_000);
		expect(result.text).toContain('class="report-partial-notice"');
	});

	it("never splits a multi-byte character when truncating", () => {
		const text = "🎉".repeat(5000); // 4 bytes each = 20 000 bytes
		const result = capRenderedReport(text, {
			maxBytes: 2_000,
			isHtml: false,
		});
		expect(result.truncated).toBe(true);
		expect(result.finalBytes).toBeLessThanOrEqual(2_000);
		// No U+FFFD replacement char from a split surrogate pair in the body.
		expect(result.text).not.toContain("�");
	});

	it("stays under budget even when the budget is smaller than the notice itself", () => {
		// Pathologically tiny budget (< the ~206 B truncation notice). The result
		// must still be ≤ maxBytes — the contract cannot depend on the notice
		// happening to fit. Guards against a future longer notice silently
		// reintroducing the size-limit failure.
		const text = "line of report content\n".repeat(2000);
		for (const isHtml of [false, true]) {
			const result = capRenderedReport(text, { maxBytes: 50, isHtml });
			expect(result.truncated).toBe(true);
			expect(result.finalBytes).toBe(
				Buffer.byteLength(result.text, "utf8"),
			);
			expect(result.finalBytes).toBeLessThanOrEqual(50);
			expect(result.text).not.toContain("�"); // multi-byte-safe clamp
		}
	});
});
