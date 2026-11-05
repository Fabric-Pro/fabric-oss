import { describe, expect, it, vi } from "vitest";
import {
	cardMinimalFields,
	cardSteeringFields,
	fitListToContext,
	isSingleCardTool,
	listingCoverageKey,
	MAX_LISTING_PAGES,
	planBoardSweep,
	projectCardForContext,
	shrinkCardForStorage,
	shrinkToolResultForStorage,
	slimCardForBudget,
	walkCardPages,
	withSummaryProjection,
} from "../report-card-pages";

const envelope = (
	cards: unknown[],
	page: number,
	hasMore: boolean,
	nextPage: number | null = hasMore ? page + 1 : null,
) => ({
	cards,
	page,
	total_count: 100,
	has_more: hasMore,
	next_page: nextPage,
});

describe("walkCardPages", () => {
	const walk = (
		fetchPage: (args: Record<string, unknown>) => Promise<unknown>,
		maxPages?: number,
	) => {
		const onPage = vi.fn();
		const beat = vi.fn();
		return {
			onPage,
			beat,
			result: walkCardPages({
				args: { board_id: "board-1" },
				fetchPage,
				onPage,
				beat,
				maxPages,
			}),
		};
	};

	it("follows next_page until has_more is false, beating before each page", async () => {
		const fetchPage = vi.fn(async (args: Record<string, unknown>) =>
			args.page === undefined
				? envelope([{ id: "a" }], 1, true)
				: envelope([{ id: "b" }], 2, false),
		);
		const { onPage, beat, result } = walk(fetchPage);

		await expect(result).resolves.toEqual({
			status: "complete",
			pages: 2,
			cards: 2,
		});
		expect(fetchPage.mock.calls[0][0]).toEqual({ board_id: "board-1" });
		expect(fetchPage.mock.calls[1][0]).toEqual({
			board_id: "board-1",
			page: 2,
		});
		expect(onPage).toHaveBeenCalledTimes(2);
		expect(beat).toHaveBeenCalledTimes(2);
	});

	it("ends on an empty page even though it still reports has_more", async () => {
		const fetchPage = vi.fn(async (args: Record<string, unknown>) =>
			args.page === undefined
				? envelope([{ id: "a" }], 1, true)
				: envelope([], 2, true),
		);

		await expect(walk(fetchPage).result).resolves.toMatchObject({
			status: "complete",
			pages: 2,
		});
	});

	it("records a failed page as partial and keeps what was read", async () => {
		const fetchPage = vi.fn(async (args: Record<string, unknown>) => {
			if (args.page === 3) {
				throw new Error("upstream memory limit");
			}
			const page = args.page === undefined ? 1 : 2;
			return envelope([{ id: `card-${page}` }], page, true);
		});
		const { onPage, result } = walk(fetchPage);

		await expect(result).resolves.toEqual({
			status: "partial",
			pages: 2,
			cards: 2,
			reason: "page 3 could not be read: upstream memory limit",
		});
		expect(onPage).toHaveBeenCalledTimes(2);
	});

	it("stops at the runaway guard and says the listing is partial", async () => {
		let page = 0;
		const fetchPage = vi.fn(async () => {
			page++;
			return envelope([{ id: `card-${page}` }], page, true);
		});

		await expect(walk(fetchPage).result).resolves.toMatchObject({
			status: "partial",
			pages: MAX_LISTING_PAGES,
			reason: expect.stringContaining("more still reported"),
		});
		expect(fetchPage).toHaveBeenCalledTimes(MAX_LISTING_PAGES);
	});

	it("treats a cursor that does not advance as partial, not as an endless walk", async () => {
		const fetchPage = vi.fn(async () =>
			envelope([{ id: "a" }], 1, true, 2),
		);

		await expect(walk(fetchPage).result).resolves.toMatchObject({
			status: "partial",
			pages: 2,
		});
		expect(fetchPage).toHaveBeenCalledTimes(2);
	});

	it("moves to the next page when the source omits next_page", async () => {
		const fetchPage = vi.fn(async (args: Record<string, unknown>) =>
			args.page === undefined
				? { cards: [{ id: "a" }], has_more: true }
				: { cards: [{ id: "b" }], has_more: false },
		);

		await expect(walk(fetchPage).result).resolves.toMatchObject({
			status: "complete",
			pages: 2,
		});
		expect(fetchPage.mock.calls[1][0]).toMatchObject({ page: 2 });
	});

	it("reports a bare array as unpaginated after one page", async () => {
		const fetchPage = vi.fn(async () => [{ id: "a" }, { id: "b" }]);

		await expect(walk(fetchPage).result).resolves.toEqual({
			status: "unpaginated",
			pages: 1,
			cards: 2,
		});
		expect(fetchPage).toHaveBeenCalledTimes(1);
	});

	it("reports a first page that failed with no pages read", async () => {
		const fetchPage = vi.fn(async () => {
			throw new Error("unauthorized");
		});

		await expect(walk(fetchPage).result).resolves.toEqual({
			status: "partial",
			pages: 0,
			cards: 0,
			reason: "page 1 could not be read: unauthorized",
		});
	});
});

describe("planBoardSweep", () => {
	const schema = (
		properties: Record<string, unknown>,
		required: string[] = [],
	) => ({
		inputSchema: {
			get jsonSchema() {
				return { type: "object", properties, required };
			},
		},
	});
	const fizzyCards = schema(
		{
			account_slug: { type: "string" },
			board_id: { type: "string" },
			page: { type: "integer" },
			fields: { enum: ["summary", "full"] },
			indexed_by: { enum: ["all", "closed", "not_now", "stalled"] },
		},
		["account_slug"],
	);
	const context = { boardId: "board-1", accountSlug: "/000000" };

	it("plans open, closed and not-now listings in summary mode", () => {
		const base = {
			board_id: "board-1",
			account_slug: "/000000",
			fields: "summary",
		};

		expect(
			planBoardSweep({
				tools: { fizzy_get_cards: fizzyCards },
				context,
			}),
		).toEqual({
			toolName: "fizzy_get_cards",
			listings: [
				base,
				{ ...base, indexed_by: "closed" },
				{ ...base, indexed_by: "not_now" },
			],
		});
	});

	it("does not plan without a board in context", () => {
		expect(
			planBoardSweep({
				tools: { fizzy_get_cards: fizzyCards },
				context: { accountSlug: "/000000", boardName: "Example" },
			}),
		).toBeNull();
	});

	it("does not plan when a required argument is not in context", () => {
		expect(
			planBoardSweep({
				tools: { fizzy_get_cards: fizzyCards },
				context: { boardId: "board-1" },
			}),
		).toBeNull();
	});

	it("leaves other tool shapes on today's model-driven path", () => {
		const noPaging = schema({ board_id: { type: "string" } });
		const noBoard = schema({ page: { type: "integer" } });

		expect(
			planBoardSweep({
				tools: {
					trello_list_cards: noPaging,
					other_get_cards: noBoard,
					fizzy_get_boards: fizzyCards,
					jira_search_issues: fizzyCards,
				},
				context,
			}),
		).toBeNull();
	});

	it("sweeps another provider whose tool has the same shape", () => {
		const plan = planBoardSweep({
			tools: {
				other_list_cards: schema({
					board_id: { type: "string" },
					page: { type: "integer" },
				}),
			},
			context,
		});

		expect(plan).toEqual({
			toolName: "other_list_cards",
			listings: [{ board_id: "board-1" }],
		});
	});
});

describe("withSummaryProjection", () => {
	it("asks for summary only when the tool declares it", () => {
		const declared = {
			properties: { fields: { enum: ["summary", "full"] } },
		};

		expect(withSummaryProjection({ a: 1 }, declared)).toEqual({
			a: 1,
			fields: "summary",
		});
		expect(withSummaryProjection({ a: 1 }, { properties: {} })).toEqual({
			a: 1,
		});
		expect(withSummaryProjection({ fields: "full" }, declared)).toEqual({
			fields: "full",
		});
	});
});

describe("listingCoverageKey", () => {
	it("names the plain listing of the target board after the tool", () => {
		expect(
			listingCoverageKey(
				"fizzy_get_cards",
				{
					account_slug: "/1",
					board_id: "b1",
					fields: "summary",
					page: 3,
				},
				"b1",
			),
		).toBe("fizzy_get_cards");
	});

	it("gives each filtered listing its own key, whatever the argument order", () => {
		expect(
			listingCoverageKey(
				"fizzy_get_cards",
				{ board_id: "b1", indexed_by: "closed" },
				"b1",
			),
		).toBe("fizzy_get_cards[indexed_by=closed]");
		expect(
			listingCoverageKey(
				"fizzy_get_cards",
				{ column_id: "c1", indexed_by: "closed" },
				"b1",
			),
		).toBe(
			listingCoverageKey(
				"fizzy_get_cards",
				{ indexed_by: "closed", column_id: "c1" },
				"b1",
			),
		);
	});

	it("keeps the board in the key when the run has no target board", () => {
		expect(
			listingCoverageKey(
				"fizzy_get_cards",
				{ board_id: "b1" },
				undefined,
			),
		).toBe("fizzy_get_cards[board_id=b1]");
	});
});

describe("shrinkCardForStorage", () => {
	it("drops HTML and link fields and reduces nested records, keeping the rest", () => {
		expect(
			shrinkCardForStorage({
				id: "a",
				url: "https://example.com/cards/1",
				description_html: "<p>body</p>",
				comments_url: "https://example.com/cards/1/comments",
				unknown_provider_field: 7,
				creator: {
					id: "u1",
					name: "Example Person",
					email_address: "person@example.com",
					avatar_url: "https://example.com/a.png",
				},
				assignees: [{ id: "u2", name: "Example", role: "member" }],
				tags: ["example"],
				settings: { theme: "dark" },
			}),
		).toEqual({
			id: "a",
			url: "https://example.com/cards/1",
			unknown_provider_field: 7,
			creator: { id: "u1", name: "Example Person" },
			assignees: [{ id: "u2", name: "Example" }],
			tags: ["example"],
			settings: { theme: "dark" },
		});
	});

	it("clips long text without splitting a surrogate pair", () => {
		const shrunk = shrinkCardForStorage({
			description: `${"x".repeat(999)}🚀🚀${"y".repeat(50)}`,
		}) as { description: string };

		expect(shrunk.description).toBe(`${"x".repeat(999)}🚀…`);
		expect(JSON.parse(JSON.stringify(shrunk)).description).toBe(
			shrunk.description,
		);
	});

	it("leaves non-card values alone", () => {
		expect(shrinkCardForStorage("text")).toBe("text");
		expect(shrinkCardForStorage(null)).toBeNull();
	});
});

describe("shrinkToolResultForStorage", () => {
	const heavy = { id: "a", description_html: "<p>body</p>" };

	it("shrinks an envelope's cards and keeps its pagination", () => {
		expect(
			shrinkToolResultForStorage("fizzy_get_cards", {
				cards: [heavy],
				page: 1,
				has_more: true,
			}),
		).toEqual({ cards: [{ id: "a" }], page: 1, has_more: true });
	});

	it("shrinks a bare card list and a single card", () => {
		expect(shrinkToolResultForStorage("fizzy_get_cards", [heavy])).toEqual([
			{ id: "a" },
		]);
		expect(shrinkToolResultForStorage("fizzy_get_card", heavy)).toEqual({
			id: "a",
		});
	});

	it("leaves other tools' results alone", () => {
		expect(shrinkToolResultForStorage("fizzy_get_tags", [heavy])).toEqual([
			heavy,
		]);
	});

	it("keeps more of a fetched card's text than a listed card's", () => {
		const description = "x".repeat(5000);
		const fetched = shrinkToolResultForStorage("fizzy_get_card", {
			id: "a",
			description,
		}) as { description: string };
		const listed = shrinkToolResultForStorage("fizzy_get_cards", [
			{ id: "a", description },
		]) as Array<{ description: string }>;

		expect(fetched.description).toBe(`${"x".repeat(4000)}…`);
		expect(listed[0].description).toBe(`${"x".repeat(1000)}…`);
	});
});

describe("isSingleCardTool", () => {
	it("matches single-card tools and nothing nearby", () => {
		expect(isSingleCardTool("fizzy_get_card")).toBe(true);
		expect(isSingleCardTool("fizzy_get_cards")).toBe(false);
		expect(isSingleCardTool("fizzy_get_card_comments")).toBe(false);
	});
});

describe("card shape ladder", () => {
	const projected = projectCardForContext({
		id: "a",
		number: 1,
		title: "Example",
		status: "published",
		closed: true,
		postponed: false,
		created_at: "2026-01-01T00:00:00.000Z",
		last_active_at: "2026-01-02T00:00:00.000Z",
		url: "https://example.com/cards/1",
		description_preview: "Preview",
		board: { id: "b1", name: "Example board" },
		column: { id: "c1", name: "Done" },
		assignees: [{ id: "u1", name: "Example Person" }],
		tags: ["example"],
	});

	it("keeps the summary-mode fields a report needs when projected", () => {
		expect(projected).toMatchObject({
			closed: true,
			postponed: false,
			description_preview: "Preview",
		});
	});

	it("slims down to what a report counts by", () => {
		expect(slimCardForBudget(projected)).toEqual({
			id: "a",
			number: 1,
			title: "Example",
			status: "published",
			closed: true,
			postponed: false,
			created_at: "2026-01-01T00:00:00.000Z",
			last_active_at: "2026-01-02T00:00:00.000Z",
			column: { name: "Done" },
			assignees: [{ name: "Example Person" }],
			tags: ["example"],
		});
	});

	it("still reaches the steering fields from a slim card", () => {
		expect(cardSteeringFields(slimCardForBudget(projected))).toEqual({
			id: "a",
			number: 1,
			title: "Example",
			closed: true,
			column: "Done",
		});
	});

	it("keeps the status of a card that is neither closed nor postponed", () => {
		expect(
			cardSteeringFields({
				id: "b",
				title: "Example",
				status: "published",
				closed: false,
				postponed: false,
			}),
		).toEqual({ id: "b", title: "Example", status: "published" });
	});

	it("keeps the column when a shortened card goes down the ladder again", () => {
		const steering = cardSteeringFields(projected);

		expect(cardSteeringFields(steering)).toEqual(steering);
		expect(
			cardSteeringFields(
				slimCardForBudget(projectCardForContext(steering)),
			),
		).toEqual(steering);
	});

	it("cuts to what names a card at the last rung", () => {
		expect(
			cardMinimalFields({
				id: "a",
				number: 7,
				title: "t".repeat(100),
				status: "published",
			}),
		).toEqual({ number: 7, title: `${"t".repeat(80)}…` });
		expect(cardMinimalFields({ id: "a", name: "Example" })).toEqual({
			id: "a",
			title: "Example",
		});
		expect(cardMinimalFields("text")).toBe("text");
	});
});

describe("fitListToContext", () => {
	it("cuts a tag list to what steers the model, under the limit", () => {
		const tags = Array.from({ length: 200 }, (_, i) => ({
			id: `tag-${i}`,
			title: `Tag ${i}`,
			created_at: "2026-01-01T00:00:00.000Z",
			url: `https://example.com/tags/${i}`,
		}));

		const { items, omitted } = fitListToContext(tags, 12000);

		expect(items[0]).toEqual({ id: "tag-0", title: "Tag 0" });
		expect(omitted).toBe(0);
		expect(JSON.stringify(items).length).toBeLessThanOrEqual(12000);
	});

	it("counts what did not fit", () => {
		const list = Array.from({ length: 500 }, (_, i) => ({
			id: `item-${i}`,
			title: "x".repeat(100),
		}));

		const { items, omitted } = fitListToContext(list, 2000);

		expect(items.length + omitted).toBe(500);
		expect(omitted).toBeGreaterThan(0);
		expect(JSON.stringify(items).length).toBeLessThanOrEqual(2000);
	});

	it("reduces a nested record to its label and clips long text", () => {
		const { items } = fitListToContext(
			[
				{
					id: "a",
					note: "n".repeat(500),
					owner: { id: "u1", name: "Example Person" },
					meta: { nothing: "useful" },
				},
			],
			12000,
		);

		expect(items[0]).toEqual({
			id: "a",
			note: `${"n".repeat(200)}…`,
			owner: "Example Person",
		});
	});
});
