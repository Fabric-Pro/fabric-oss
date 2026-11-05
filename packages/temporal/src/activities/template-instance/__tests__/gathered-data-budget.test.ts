import { describe, expect, it } from "vitest";
import {
	boundGatheredData,
	capRenderedReport,
	DEFAULT_GATHERED_DATA_MAX_BYTES,
	FETCHED_CARD_TEXT_MAX_BYTES,
	MIN_GATHERED_DATA_BUDGET_BYTES,
	REPORT_CARD_PAYLOAD_MAX_BYTES,
} from "../gathered-data-budget";
import { attachBoardFacts } from "../report-board-facts";
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

	it("Stage C: drops other `_`-prefixed metadata before the data it describes", () => {
		const bigObj: Record<string, string> = {};
		for (let i = 0; i < 300; i++) {
			bigObj[`f${i}`] = "shortval";
		}
		const data = {
			some_tool: bigObj,
			_board_fix: { partial: true, coverage: "unknown" },
		};
		const result = boundGatheredData(data, {
			maxBytes: 1_500,
			maxFieldChars: 1000,
		});

		expect(result.finalBytes).toBeLessThanOrEqual(1_500);
		expect(result.data._board_fix).toBeUndefined();
		expect(result.notes.join(" ")).toMatch(/dropped key _board_fix/);
	});

	describe("reserved board metadata", () => {
		const reserved = {
			_board_facts: { total: 5000, open: 1000, closed: 4000 },
			_coverage: {
				fizzy_get_cards: { total_count: 5000, complete: true },
			},
		};

		it("keeps `_board_facts` and `_coverage` while card tail items are dropped", () => {
			const data = {
				fizzy_get_cards: Array.from({ length: 5000 }, (_, i) => ({
					id: `c${i}`,
					status: "Done",
				})),
				...reserved,
			};
			const result = boundGatheredData(data, { maxBytes: 8_000 });

			expect(result.finalBytes).toBeLessThanOrEqual(8_000);
			expect(result.data._board_facts).toEqual(reserved._board_facts);
			expect(result.data._coverage).toEqual(reserved._coverage);
			expect(result.recordsDropped).toBe(true);
		});

		it("keeps them even when every data key has to go", () => {
			const bigObj: Record<string, string> = {};
			for (let i = 0; i < 2000; i++) {
				bigObj[`f${i}`] = "shortval";
			}
			const result = boundGatheredData(
				{
					fizzy_get_cards: bigObj,
					fizzy_get_boards: bigObj,
					...reserved,
				},
				{ maxBytes: 2_000, maxFieldChars: 1000 },
			);

			expect(result.finalBytes).toBeLessThanOrEqual(2_000);
			expect(result.data._board_facts).toEqual(reserved._board_facts);
			expect(result.data._coverage).toEqual(reserved._coverage);
			expect(result.data.fizzy_get_boards).toBeUndefined();
			expect(
				(result.data.fizzy_get_cards as { _truncated?: boolean })
					._truncated,
			).toBe(true);
		});

		it("gives them up only when they alone exceed the budget", () => {
			const huge = "x".repeat(5_000);
			const result = boundGatheredData(
				{
					fizzy_get_cards: [{ id: "c1" }],
					_board_facts: { byTag: huge },
					_coverage: { note: huge },
				},
				{ maxBytes: 1_000 },
			);

			expect(result.finalBytes).toBeLessThanOrEqual(1_000);
			expect(Object.keys(result.data).length).toBeGreaterThanOrEqual(1);
		});
	});

	describe("card ladder", () => {
		const fullCard = (i: number) => ({
			id: `card-${i}`,
			number: i,
			title: `Card ${i}`,
			status: "published",
			closed: false,
			created_at: "2026-01-01T00:00:00.000Z",
			last_active_at: "2026-01-02T00:00:00.000Z",
			url: `https://example.com/cards/${i}`,
			description_preview: "p".repeat(200),
			has_attachments: false,
			creator: { id: "user-1", name: "Example Person" },
			board: { id: "board-1", name: "Example board" },
			column: { id: "column-1", name: "In progress" },
			assignees: [{ id: "user-2", name: "Example Assignee" }],
			tags: ["example"],
		});
		const cards = Array.from({ length: 200 }, (_, i) => fullCard(i));
		const fullBytes = jsonBytes({ fizzy_get_cards: cards });

		const bound = (maxBytes: number) => {
			const result = boundGatheredData(
				{ fizzy_get_cards: cards },
				{ maxBytes },
			);
			return {
				result,
				kept: result.data.fizzy_get_cards as Array<
					Record<string, unknown>
				>,
			};
		};

		it("projects cards first and keeps every card", () => {
			const { result, kept } = bound(Math.floor(fullBytes * 0.9));

			expect(kept).toHaveLength(200);
			expect(kept[0].creator).toBeUndefined();
			expect(kept[0].description_preview).toBe("p".repeat(200));
			expect(result.recordsDropped).toBe(false);
			expect(result.trimmed).toBe(true);
			expect(result.notes.join(" ")).toMatch(/projected/);
		});

		it("then drops text and links, keeping what a report counts by", () => {
			const { result, kept } = bound(Math.floor(fullBytes * 0.5));

			expect(kept).toHaveLength(200);
			expect(kept[0]).toMatchObject({
				id: "card-0",
				closed: false,
				last_active_at: "2026-01-02T00:00:00.000Z",
				column: { name: "In progress" },
				assignees: [{ name: "Example Assignee" }],
				tags: ["example"],
			});
			expect(kept[0].description_preview).toBeUndefined();
			expect(kept[0].url).toBeUndefined();
			expect(result.recordsDropped).toBe(false);
		});

		it("then cuts to the steering fields", () => {
			const { result, kept } = bound(Math.floor(fullBytes * 0.2));

			expect(kept).toHaveLength(200);
			expect(kept[0]).toEqual({
				id: "card-0",
				number: 0,
				title: "Card 0",
				status: "published",
				column: "In progress",
			});
			expect(result.recordsDropped).toBe(false);
		});

		it("then keeps only what names a card", () => {
			const { result, kept } = bound(Math.floor(fullBytes * 0.05));

			expect(kept).toHaveLength(200);
			expect(kept[0]).toEqual({ number: 0, title: "Card 0" });
			expect(result.recordsDropped).toBe(false);
		});

		it("drops cards only after the last rung, and says so", () => {
			const { result, kept } = bound(Math.floor(fullBytes * 0.03));

			expect(kept.length).toBeLessThan(200);
			expect(result.recordsDropped).toBe(true);
		});

		it("leaves lists from other tools out of the ladder", () => {
			const result = boundGatheredData(
				{
					fizzy_get_users: Array.from({ length: 200 }, (_, i) => ({
						id: `user-${i}`,
						email_address: `person-${i}@example.com`,
					})),
				},
				{ maxBytes: 4_000 },
			);
			const users = result.data.fizzy_get_users as Array<
				Record<string, unknown>
			>;

			expect(users[0].email_address).toBe("person-0@example.com");
			expect(result.recordsDropped).toBe(true);
		});
	});

	describe("report card payload", () => {
		type Card = Record<string, unknown>;
		const OPEN = 659;
		const CLOSED = 1548;
		const NOT_NOW = 132;
		const TOTAL = OPEN + CLOSED + NOT_NOW;

		// Shaped like a real summary-projection listing page, about 900 bytes a card.
		const summaryCard = (i: number): Card => ({
			id: `example${String(i).padStart(18, "0")}`,
			number: 1000 + i,
			title: `Example card title ${String(i).padStart(4, "0")} ${"t".repeat(50)}`,
			status: "published",
			golden: false,
			closed: i >= OPEN && i < OPEN + CLOSED,
			postponed: i >= OPEN + CLOSED,
			last_active_at: "2026-10-01T00:00:00.000Z",
			created_at: "2026-01-01T00:00:00.000Z",
			url: `https://example.com/example-account/cards/${1000 + i}`,
			description_preview: "p".repeat(200),
			has_attachments: false,
			has_more_assignees: false,
			tags: ["example-tag"],
			board: { id: "example-board-id-000000000", name: "Example board" },
			creator: {
				id: "example-user-id-0000000000",
				name: "Example Person",
			},
			column: { id: "example-column-id-00000000", name: "In progress" },
			assignees: [
				{ id: "example-user-id-0000000000", name: "Example Person" },
			],
		});

		const largeBoard = (): Record<string, unknown> => {
			const data: Record<string, unknown> = {
				fizzy_get_cards: Array.from({ length: TOTAL }, (_, i) =>
					summaryCard(i),
				),
				_coverage: {
					fizzy_get_cards: { complete: true },
					"fizzy_get_cards[indexed_by=closed]": { complete: true },
					"fizzy_get_cards[indexed_by=not_now]": { complete: true },
				},
			};
			attachBoardFacts(data, new Date("2026-11-05T00:00:00.000Z"));
			return data;
		};
		const board = largeBoard();
		const allCards = board.fizzy_get_cards as Card[];

		const boundBoard = (
			maxCardBytes: number,
			extra: { fetchedCardIds?: ReadonlySet<string> } = {},
			data: Record<string, unknown> = board,
		) => {
			const result = boundGatheredData(data, { maxCardBytes, ...extra });
			return {
				result,
				cards: result.data.fizzy_get_cards as Card[],
			};
		};

		const steeringOf = (i: number) => ({
			id: allCards[i].id,
			number: allCards[i].number,
			title: allCards[i].title,
			column: "In progress",
			...(allCards[i].closed === true
				? { closed: true }
				: allCards[i].postponed === true
					? { postponed: true }
					: { status: "published" }),
		});

		it("keeps every card of a large board and its facts, under the budget", () => {
			const { result, cards } = boundBoard(REPORT_CARD_PAYLOAD_MAX_BYTES);

			expect(jsonBytes(board.fizzy_get_cards)).toBeGreaterThan(
				DEFAULT_GATHERED_DATA_MAX_BYTES,
			);
			expect(new Set(cards.map((card) => card.id)).size).toBe(TOTAL);
			expect(cards).toHaveLength(TOTAL);
			expect(jsonBytes(cards)).toBeLessThanOrEqual(
				REPORT_CARD_PAYLOAD_MAX_BYTES,
			);
			expect(result.recordsDropped).toBe(false);
			expect(result.data._board_facts).toEqual(board._board_facts);
			expect(result.data._board_facts).toMatchObject({
				total: TOTAL,
				open: OPEN,
				closed: CLOSED,
				postponed: NOT_NOW,
				complete: true,
			});
		});

		it("keeps open cards slim and cuts closed and not-now cards first", () => {
			const { cards } = boundBoard(REPORT_CARD_PAYLOAD_MAX_BYTES);

			expect(cards[0]).toMatchObject({
				closed: false,
				postponed: false,
				last_active_at: "2026-10-01T00:00:00.000Z",
				tags: ["example-tag"],
				column: { name: "In progress" },
				assignees: [{ name: "Example Person" }],
			});
			expect(cards[0].url).toBeUndefined();
			expect(cards[0].description_preview).toBeUndefined();
			expect(cards[OPEN]).toEqual(steeringOf(OPEN));
			expect(cards[OPEN + CLOSED]).toEqual(steeringOf(OPEN + CLOSED));
		});

		it("cuts open cards to steering only after the settled ones", () => {
			const { result, cards } = boundBoard(450_000);

			expect(cards).toHaveLength(TOTAL);
			expect(cards[0]).toEqual(steeringOf(0));
			expect(cards[OPEN]).toEqual(steeringOf(OPEN));
			expect(result.recordsDropped).toBe(false);
		});

		it("goes to the minimal rung before giving up a card", () => {
			const { result, cards } = boundBoard(300_000);

			expect(cards).toHaveLength(TOTAL);
			expect(cards[0]).toEqual({
				number: allCards[0].number,
				title: allCards[0].title,
			});
			expect(result.recordsDropped).toBe(false);
		});

		it("drops tail cards only past the last rung, keeping the facts", () => {
			const { result, cards } = boundBoard(200_000);

			expect(cards.length).toBeLessThan(TOTAL);
			expect(cards[0].number).toBe(allCards[0].number);
			expect(jsonBytes(cards)).toBeLessThanOrEqual(200_000);
			expect(result.recordsDropped).toBe(true);
			expect(result.data._board_facts).toEqual(board._board_facts);
		});

		it("leaves a small board in full detail", () => {
			const small = { fizzy_get_cards: allCards.slice(0, 50) };
			const { result } = boundBoard(
				REPORT_CARD_PAYLOAD_MAX_BYTES,
				{},
				small,
			);

			expect(result.trimmed).toBe(false);
			expect(result.data).toBe(small);
		});

		it("applies no card budget unless the caller asks for one", () => {
			const result = boundGatheredData(board, { maxBytes: 3_000_000 });

			expect(result.trimmed).toBe(false);
			expect(result.data).toBe(board);
		});

		it("keeps a fetched card's description on every rung", () => {
			const text = "d".repeat(2000);
			const fetchedIds = [0, OPEN, OPEN + CLOSED].map((i) =>
				String(allCards[i].id),
			);
			const withText = {
				...board,
				fizzy_get_cards: allCards.map((card) =>
					fetchedIds.includes(String(card.id)) || card.number === 1500
						? { ...card, description: text }
						: card,
				),
			};
			const fetchedCardIds = new Set(fetchedIds);

			// Open cards end up slim, at steering and at minimal.
			for (const maxCardBytes of [
				REPORT_CARD_PAYLOAD_MAX_BYTES,
				450_000,
				300_000,
			]) {
				const { result, cards } = boundBoard(
					maxCardBytes,
					{ fetchedCardIds },
					withText,
				);

				expect(cards).toHaveLength(TOTAL);
				expect(result.recordsDropped).toBe(false);
				for (const i of [0, OPEN, OPEN + CLOSED]) {
					expect(cards[i].description).toBe(text);
				}
				// A listed card with a description is not a fetched one.
				expect(cards[500].description).toBeUndefined();
			}
		});

		it("keeps open cards slim with 20 fetched cards on a large board", () => {
			const text = "d".repeat(2000);
			const fetched = allCards.slice(0, 20);
			const withText = {
				...board,
				fizzy_get_cards: allCards.map((card, i) =>
					i < 20 ? { ...card, description: text } : card,
				),
			};

			const { result, cards } = boundBoard(
				REPORT_CARD_PAYLOAD_MAX_BYTES,
				{ fetchedCardIds: new Set(fetched.map((c) => String(c.id))) },
				withText,
			);

			expect(cards[19].description).toBe(text);
			expect(cards[20].closed).toBe(false);
			expect(cards[OPEN]).toEqual(steeringOf(OPEN));
			expect(jsonBytes(cards)).toBeLessThanOrEqual(
				REPORT_CARD_PAYLOAD_MAX_BYTES,
			);
			expect(result.recordsDropped).toBe(false);
		});

		it("bounds the total fetched text", () => {
			const text = "d".repeat(2000);
			const fetched = Array.from({ length: 30 }, (_, i) => ({
				id: `card-${i}`,
				title: `Card ${i}`,
				description: text,
			}));
			expect(fetched.length * text.length).toBeGreaterThan(
				FETCHED_CARD_TEXT_MAX_BYTES,
			);

			const { cards } = boundBoard(
				50_000,
				{ fetchedCardIds: new Set(fetched.map((card) => card.id)) },
				{ fizzy_get_cards: fetched },
			);

			expect(cards).toHaveLength(30);
			expect(cards[19].description).toBe(text);
			expect(String(cards[20].description).length).toBeLessThan(300);
		});
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
