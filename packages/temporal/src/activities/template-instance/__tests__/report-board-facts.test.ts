import { describe, expect, it } from "vitest";
import {
	attachBoardFacts,
	buildBoardFactsHeader,
	computeBoardFacts,
	hasIncompleteListing,
	isBoardFullyRead,
	isSettledCard,
} from "../report-board-facts";

const NOW = new Date("2026-11-05T12:00:00.000Z");

const card = (overrides: Record<string, unknown> = {}) => ({
	id: "card-1",
	status: "published",
	closed: false,
	postponed: false,
	created_at: "2026-11-02T10:00:00.000Z",
	last_active_at: "2026-11-04T10:00:00.000Z",
	column: { id: "column-1", name: "In progress" },
	assignees: [{ id: "user-1", name: "Example Person" }],
	tags: ["example-tag"],
	...overrides,
});

describe("computeBoardFacts", () => {
	it("splits every card into open, closed and postponed", () => {
		const facts = computeBoardFacts(
			[
				card({ id: "a" }),
				card({ id: "b", closed: true }),
				card({ id: "c", postponed: true }),
			],
			NOW,
		);

		expect(facts).toMatchObject({
			total: 3,
			open: 1,
			closed: 1,
			postponed: 1,
		});
		expect(facts.byStatus).toEqual({ published: 3 });
	});

	it("counts columns over open cards only, naming cards with no column", () => {
		const facts = computeBoardFacts(
			[
				card({ id: "a" }),
				card({ id: "b", column: undefined }),
				// A closed card keeps the column it left from.
				card({ id: "c", closed: true }),
			],
			NOW,
		);

		expect(facts.byColumn).toEqual({
			"(no column)": 1,
			"In progress": 1,
		});
	});

	it("counts assignees and tags as open and closed workload", () => {
		const facts = computeBoardFacts(
			[
				card({ id: "a", tags: [{ id: "t1", name: "object-tag" }] }),
				card({ id: "b", closed: true }),
				card({ id: "c", assignees: [] }),
			],
			NOW,
		);

		expect(facts.byAssignee).toEqual({
			"Example Person": { open: 1, closed: 1 },
		});
		expect(facts.byTag).toEqual({
			"example-tag": { open: 1, closed: 1 },
			"object-tag": { open: 1, closed: 0 },
		});
		expect(facts.unassigned).toBe(1);
	});

	it("flags cards whose assignee list the source cut short", () => {
		const facts = computeBoardFacts(
			[card({ has_more_assignees: true })],
			NOW,
		);

		expect(facts.assigneeListsCut).toBe(1);
	});

	it("counts stale open cards only", () => {
		const old = "2026-09-01T00:00:00.000Z";
		const facts = computeBoardFacts(
			[
				card({ id: "a", last_active_at: old }),
				card({ id: "b" }),
				card({ id: "c", closed: true, last_active_at: old }),
			],
			NOW,
		);

		expect(facts.stale).toEqual({ afterDays: 30, count: 1 });
	});

	it("counts overdue open cards, treating a date-only due value as the whole day", () => {
		const facts = computeBoardFacts(
			[
				card({ id: "a", due_on: "2026-11-04" }),
				card({ id: "today", due_on: "2026-11-05" }),
				card({ id: "b", due_on: "2026-12-01" }),
				card({ id: "c", closed: true, due_on: "2026-01-01" }),
			],
			NOW,
		);

		expect(facts.overdue).toBe(1);
	});

	it("reports a field no card carries as null, not zero", () => {
		const facts = computeBoardFacts([{ id: "bare", title: "Bare" }], NOW);

		expect(facts.overdue).toBeNull();
		expect(facts.stale).toBeNull();
		expect(facts.unassigned).toBeNull();
		expect(facts.closedPerPeriod).toBeNull();
		expect(facts.createdPerPeriod).toBeNull();
	});

	it("reports zero, not null, when every card carrying the field is closed", () => {
		const facts = computeBoardFacts(
			[card({ closed: true, due_on: "2026-01-01" })],
			NOW,
		);

		expect(facts.overdue).toBe(0);
		expect(facts.unassigned).toBe(0);
	});

	it("groups closed cards by close date, by month and by the Monday of the week", () => {
		const facts = computeBoardFacts(
			[
				// 2026-11-04 is a Wednesday; its week starts on Monday 2026-11-02.
				card({ id: "a", closed_at: "2026-11-04T10:00:00.000Z" }),
				card({ id: "b", closed_at: "2026-10-30T10:00:00.000Z" }),
			],
			NOW,
		);

		expect(facts.closedPerPeriod).toEqual({
			basis: "closed_at",
			byMonth: { "2026-10": 1, "2026-11": 1 },
			byWeek: { "2026-10-26": 1, "2026-11-02": 1 },
		});
	});

	it("falls back to last activity and names that basis when no close date exists", () => {
		const facts = computeBoardFacts([card({ closed: true })], NOW);

		expect(facts.closedPerPeriod).toEqual({
			basis: "last_active_at",
			byMonth: { "2026-11": 1 },
			byWeek: { "2026-11-02": 1 },
		});
	});

	it("groups created cards by period", () => {
		const facts = computeBoardFacts([card()], NOW);

		expect(facts.createdPerPeriod).toEqual({
			byMonth: { "2026-11": 1 },
			byWeek: { "2026-11-02": 1 },
		});
	});

	it("ignores values that are not cards and is stable across input order", () => {
		const cards = [
			card({ id: "a", column: { name: "Zeta" } }),
			card({ id: "b", column: { name: "Alpha" } }),
			"not a card",
		];

		const forward = computeBoardFacts(cards, NOW);
		const backward = computeBoardFacts([...cards].reverse(), NOW);

		expect(forward.total).toBe(2);
		expect(JSON.stringify(forward)).toBe(JSON.stringify(backward));
	});
});

describe("attachBoardFacts", () => {
	const covered = (complete: boolean, reason?: string) => ({
		fizzy_get_cards: {
			total_count: 2,
			complete,
			...(reason ? { reason } : {}),
		},
	});

	it("counts across listings once each and marks complete coverage", () => {
		const gatheredData: Record<string, unknown> = {
			fizzy_get_cards: [card({ id: "a" }), card({ id: "b" })],
			trello_list_cards: [card({ id: "b" }), card({ id: "c" })],
			_coverage: covered(true),
		};

		attachBoardFacts(gatheredData, NOW);

		expect(gatheredData._board_facts).toMatchObject({
			total: 3,
			complete: true,
			gaps: [],
		});
	});

	it("marks partial coverage with the listing and reason", () => {
		const gatheredData: Record<string, unknown> = {
			fizzy_get_cards: [card()],
			_coverage: covered(false, "page 7 could not be read: timeout"),
		};

		attachBoardFacts(gatheredData, NOW);

		expect(gatheredData._board_facts).toMatchObject({
			complete: false,
			gaps: ["fizzy_get_cards: page 7 could not be read: timeout"],
		});
	});

	it("does not call a list with no pagination data complete", () => {
		const gatheredData: Record<string, unknown> = {
			fizzy_get_cards: [card()],
		};

		attachBoardFacts(gatheredData, NOW);

		expect(gatheredData._board_facts).toMatchObject({ complete: false });
	});

	it("does not call a run complete after the per-column repair", () => {
		const gatheredData: Record<string, unknown> = {
			fizzy_get_cards: [card()],
			_coverage: covered(true),
			_board_fix: { partial: true, coverage: "unknown" },
		};

		attachBoardFacts(gatheredData, NOW);

		expect(gatheredData._board_facts).toMatchObject({ complete: false });
	});

	describe("which listings a run read", () => {
		const complete = { complete: true };
		const closedListing = new Set(["fizzy_get_cards"]);
		const factsFor = (
			listings: string[],
			closedListingTools: ReadonlySet<string> = closedListing,
		) => {
			const gatheredData: Record<string, unknown> = {
				fizzy_get_cards: [card()],
				_coverage: Object.fromEntries(
					listings.map((listing) => [listing, complete]),
				),
			};
			attachBoardFacts(gatheredData, NOW, closedListingTools);
			return gatheredData._board_facts as {
				complete: boolean;
				gaps: string[];
			};
		};

		it("is not complete after only one column's listing", () => {
			const facts = factsFor(
				["fizzy_get_cards[column_id=column-1]"],
				new Set(),
			);

			expect(facts.complete).toBe(false);
			expect(facts.gaps).toEqual([
				"fizzy_get_cards: only filtered listings were read, not the whole listing",
			]);
		});

		it("is not complete after only the closed listing", () => {
			const facts = factsFor(["fizzy_get_cards[indexed_by=closed]"]);

			expect(facts.complete).toBe(false);
			expect(facts.gaps.join()).toContain("only filtered listings");
		});

		it("is not complete when a tool lists closed cards apart and they went unread", () => {
			const facts = factsFor(["fizzy_get_cards"]);

			expect(facts.complete).toBe(false);
			expect(facts.gaps).toEqual([
				"fizzy_get_cards: closed cards were not read",
			]);
		});

		it("does not count a filtered closed listing as the closed cards", () => {
			const facts = factsFor([
				"fizzy_get_cards",
				"fizzy_get_cards[column_id=column-1,indexed_by=closed]",
			]);

			expect(facts.gaps).toEqual([
				"fizzy_get_cards: closed cards were not read",
			]);
		});

		it("stays complete for the listings a sweep reads", () => {
			const facts = factsFor([
				"fizzy_get_cards",
				"fizzy_get_cards[indexed_by=closed]",
				"fizzy_get_cards[indexed_by=not_now]",
			]);

			expect(facts).toMatchObject({ complete: true, gaps: [] });
		});

		it("stays complete when both listings are scoped to one board", () => {
			const facts = factsFor([
				"fizzy_get_cards[board_id=example-board]",
				"fizzy_get_cards[board_id=example-board,indexed_by=closed]",
			]);

			expect(facts).toMatchObject({ complete: true, gaps: [] });
		});

		it("needs no closed listing from a tool that has none", () => {
			expect(factsFor(["fizzy_get_cards"], new Set()).complete).toBe(
				true,
			);
		});

		it("gives the header a partial statement that names the gap", () => {
			const header = buildBoardFactsHeader(factsFor(["fizzy_get_cards"]));

			expect(header).toContain("Coverage is partial");
			expect(header).toContain("closed cards were not read");
			expect(header).not.toContain("Coverage is complete");
		});
	});

	it("adds nothing when the run read no card list", () => {
		const gatheredData: Record<string, unknown> = {
			fizzy_get_boards: [{ id: "board-1" }],
		};

		attachBoardFacts(gatheredData, NOW);

		expect(gatheredData._board_facts).toBeUndefined();
	});

	it("counts an empty board as an empty board", () => {
		const gatheredData: Record<string, unknown> = {
			fizzy_get_cards: [],
			_coverage: covered(true),
		};

		attachBoardFacts(gatheredData, NOW);

		expect(gatheredData._board_facts).toMatchObject({
			total: 0,
			complete: true,
		});
	});
});

describe("hasIncompleteListing", () => {
	it("is true only for a listing known to have stopped early", () => {
		const coverage = (complete: unknown) => ({
			_coverage: { fizzy_get_cards: { complete } },
		});

		expect(hasIncompleteListing(coverage(false))).toBe(true);
		expect(hasIncompleteListing(coverage(true))).toBe(false);
		expect(hasIncompleteListing(coverage(null))).toBe(false);
		expect(hasIncompleteListing({})).toBe(false);
	});
});

describe("isBoardFullyRead", () => {
	it("is true only when the facts say every listing was confirmed", () => {
		const read = (complete: boolean) => {
			const data: Record<string, unknown> = {
				fizzy_get_cards: [card()],
				_coverage: { fizzy_get_cards: { complete } },
			};
			attachBoardFacts(data, NOW);
			return isBoardFullyRead(data);
		};

		expect(read(true)).toBe(true);
		expect(read(false)).toBe(false);
		expect(isBoardFullyRead({ fizzy_get_cards: [card()] })).toBe(false);
	});

	it("is false when the source reported no pagination", () => {
		const data: Record<string, unknown> = { fizzy_get_cards: [card()] };
		attachBoardFacts(data, NOW);

		expect(isBoardFullyRead(data)).toBe(false);
	});
});

describe("isSettledCard", () => {
	it("is true for closed and not-now cards, and false for open ones", () => {
		expect(isSettledCard(card({ closed: true }))).toBe(true);
		expect(isSettledCard(card({ postponed: true }))).toBe(true);
		expect(isSettledCard(card({ closed_at: "2026-11-01" }))).toBe(true);
		expect(isSettledCard(card())).toBe(false);
		expect(isSettledCard("text")).toBe(false);
	});
});

describe("buildBoardFactsHeader", () => {
	const facts = (overrides: Record<string, unknown> = {}) => ({
		total: 2339,
		open: 659,
		complete: true,
		gaps: [],
		closedPerPeriod: { basis: "closed_at", byMonth: {}, byWeek: {} },
		...overrides,
	});

	it("is empty when there are no facts", () => {
		expect(buildBoardFactsHeader(undefined)).toBe("");
		expect(buildBoardFactsHeader(null)).toBe("");
	});

	it("takes precedence over a stored instruction that calls the cards a sample", () => {
		const header = buildBoardFactsHeader(facts());

		expect(header).toContain("override any instruction");
		expect(header).toContain("sample");
		expect(header).toContain("`total_count`");
	});

	it("states complete coverage and carries the numbers", () => {
		const header = buildBoardFactsHeader(facts());

		expect(header).toContain("Coverage is complete: all 2339 cards");
		expect(header).toContain('"open":659');
		expect(header).not.toContain("Coverage is partial");
	});

	it("states partial coverage and names what is missing", () => {
		const header = buildBoardFactsHeader(
			facts({
				total: 900,
				complete: false,
				gaps: ["fizzy_get_cards: page 7 could not be read"],
			}),
		);

		expect(header).toContain("Coverage is partial");
		expect(header).toContain("only the 900 cards");
		expect(header).toContain("page 7 could not be read");
		expect(header).not.toContain("Coverage is complete");
	});

	it("says a period count built on last activity is approximate", () => {
		const header = buildBoardFactsHeader(
			facts({
				closedPerPeriod: {
					basis: "last_active_at",
					byMonth: {},
					byWeek: {},
				},
			}),
		);

		expect(header).toContain("approximate");
		expect(buildBoardFactsHeader(facts())).not.toContain("approximate");
	});
});
