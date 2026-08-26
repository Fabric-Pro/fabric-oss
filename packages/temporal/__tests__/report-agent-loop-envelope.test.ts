import { describe, expect, it, vi } from "vitest";

// The helpers under test are pure, but importing report-agent-loop pulls in
// @repo/ai / @repo/mcp / @repo/database at module load. Mock those boundaries
// the same way report-agent-loop-salvage.test.ts does.
vi.mock("@repo/mcp", () => ({ getCachedMcpClientForConfig: vi.fn() }));
vi.mock("@temporalio/activity", () => ({ heartbeat: vi.fn() }));
vi.mock("@repo/database", () => ({
	db: {},
	resolveReportMcpConfig: vi.fn(async (id: string) => ({ id, name: id })),
	setAiUsageRecorder: vi.fn(),
	GATEWAY_PROVIDERS: [
		"VERCEL_GATEWAY",
		"OPENROUTER",
		"CLOUDFLARE_AI",
	] as const,
	DIRECT_PROVIDERS: ["OPENAI_DIRECT", "ANTHROPIC_DIRECT", "GROQ"] as const,
	AI_PROVIDER_METADATA: {},
	isGatewayProvider: () => false,
	isDirectProvider: () => false,
	getProviderDisplayName: (p: string) => p,
	getProviderMetadata: () => undefined,
}));

import {
	applyBoardPreFilter,
	coerceToolArgs,
	consolidateIndividualCards,
	extractPageMeta,
	mergeToolResult,
	projectCardForContext,
} from "../src/activities/template-instance/report-agent-loop";

type Coverage = {
	total_count: unknown;
	pages_fetched: number[];
	has_more_at_last_page: unknown;
};

const coverageFor = (
	gatheredData: Record<string, unknown>,
	toolName: string,
): Coverage => (gatheredData._coverage as Record<string, Coverage>)[toolName];

describe("coerceToolArgs", () => {
	/** Mirrors the AI SDK `jsonSchema(...)` container: raw schema behind a getter. */
	const wrapped = (raw: Record<string, unknown>) => ({
		_type: undefined,
		get jsonSchema() {
			return raw;
		},
	});

	const fizzyGetCardsSchema = wrapped({
		type: "object",
		properties: {
			account_slug: { type: "string" },
			board_id: { type: "string" },
			page: { type: "integer" },
		},
	});

	it("keeps a numeric page the schema declares as an integer", () => {
		expect(
			coerceToolArgs(
				{ account_slug: "acme", board_id: "b1", page: 2 },
				fizzyGetCardsSchema,
			),
		).toEqual({ account_slug: "acme", board_id: "b1", page: 2 });
	});

	it("stringifies a numeric value the schema declares as a string", () => {
		expect(
			coerceToolArgs({ account_slug: 123456 }, fizzyGetCardsSchema),
		).toEqual({ account_slug: "123456" });
	});

	it("stringifies every number when no schema is available", () => {
		expect(coerceToolArgs({ account_slug: 123456, page: 2 })).toEqual({
			account_slug: "123456",
			page: "2",
		});
		expect(
			coerceToolArgs({ page: 2 }, { type: "object" } as unknown),
		).toEqual({ page: "2" });
	});

	it("honors a nullable numeric declared as a `type` array", () => {
		expect(
			coerceToolArgs(
				{ page: 3, limit: 50 },
				wrapped({
					properties: {
						page: { type: ["integer", "null"] },
						limit: { type: ["string", "null"] },
					},
				}),
			),
		).toEqual({ page: 3, limit: "50" });
	});

	it("accepts a bare JSON Schema (no jsonSchema wrapper)", () => {
		expect(
			coerceToolArgs(
				{ page: 2, account_slug: 1 },
				{
					type: "object",
					properties: {
						page: { type: "number" },
						account_slug: { type: "string" },
					},
				},
			),
		).toEqual({ page: 2, account_slug: "1" });
	});

	it("passes non-numeric values through untouched", () => {
		const nested = { a: 1 };
		const out = coerceToolArgs(
			{
				s: "x",
				b: true,
				n: null,
				arr: [1, 2],
				nested,
				u: undefined,
			},
			fizzyGetCardsSchema,
		);
		expect(out).toEqual({
			s: "x",
			b: true,
			n: null,
			arr: [1, 2],
			nested,
			u: undefined,
		});
		// Nested numbers are not walked — only top-level args are coerced.
		expect(out.nested).toBe(nested);
	});

	it("stringifies a number whose property is absent from the schema", () => {
		expect(
			coerceToolArgs({ unknown_param: 7 }, fizzyGetCardsSchema),
		).toEqual({ unknown_param: "7" });
	});
});

describe("mergeToolResult — fizzy-mcp 1.1.0 page envelopes", () => {
	it("stores the bare card array and records page coverage", () => {
		const gatheredData: Record<string, unknown> = {};
		mergeToolResult(gatheredData, "fizzy_get_cards", {
			cards: [{ id: "a" }, { id: "b" }],
			page: 1,
			total_count: 611,
			has_more: true,
			next_page: 2,
		});

		expect(gatheredData.fizzy_get_cards).toEqual([
			{ id: "a" },
			{ id: "b" },
		]);
		expect(coverageFor(gatheredData, "fizzy_get_cards")).toEqual({
			total_count: 611,
			pages_fetched: [1],
			has_more_at_last_page: true,
		});
		// No numbered-suffix key: the envelope was merged, not sidelined.
		expect(gatheredData.fizzy_get_cards_2).toBeUndefined();
	});

	it("merges two pages, dedupes by id, and accumulates coverage", () => {
		const gatheredData: Record<string, unknown> = {};
		mergeToolResult(gatheredData, "fizzy_get_cards", {
			cards: [{ id: "a" }, { id: "b" }],
			page: 1,
			total_count: 611,
			has_more: true,
			next_page: 2,
		});
		mergeToolResult(gatheredData, "fizzy_get_cards", {
			cards: [{ id: "b" }, { id: "c" }],
			page: 2,
			total_count: null,
			has_more: false,
			next_page: null,
		});

		expect(gatheredData.fizzy_get_cards).toEqual([
			{ id: "a" },
			{ id: "b" },
			{ id: "c" },
		]);
		expect(coverageFor(gatheredData, "fizzy_get_cards")).toEqual({
			// page 2's null total_count must not erase page 1's real total
			total_count: 611,
			pages_fetched: [1, 2],
			has_more_at_last_page: false,
		});
	});

	it("merges a bare array with a later envelope", () => {
		const gatheredData: Record<string, unknown> = {};
		mergeToolResult(gatheredData, "fizzy_get_cards", [
			{ id: "a" },
			{ id: "b" },
		]);
		mergeToolResult(gatheredData, "fizzy_get_cards", {
			cards: [{ id: "b" }, { id: "c" }],
			page: 2,
			total_count: 3,
			has_more: false,
			next_page: null,
		});

		expect(gatheredData.fizzy_get_cards).toEqual([
			{ id: "a" },
			{ id: "b" },
			{ id: "c" },
		]);
		expect(
			coverageFor(gatheredData, "fizzy_get_cards").pages_fetched,
		).toEqual([2]);
	});

	it("does not unwrap `cards` for tools outside the card-list name scope", () => {
		const gatheredData: Record<string, unknown> = {};
		const value = { cards: [{ id: "a" }], page: 1 };
		mergeToolResult(gatheredData, "some_other_tool", value);

		expect(gatheredData.some_other_tool).toEqual(value);
		expect(gatheredData._coverage).toBeUndefined();
	});
});

describe("consolidateIndividualCards after envelope normalization", () => {
	it("merges individual cards into the normalized bulk array without overwriting it", () => {
		const gatheredData: Record<string, unknown> = {};
		mergeToolResult(gatheredData, "fizzy_get_cards", {
			cards: [{ id: "a" }, { id: "b" }],
			page: 1,
			total_count: 3,
			has_more: false,
			next_page: null,
		});
		mergeToolResult(gatheredData, "fizzy_get_card", { id: "b", extra: 1 });
		mergeToolResult(gatheredData, "fizzy_get_card", { id: "c" });

		expect(gatheredData.fizzy_get_card_2).toBeDefined();

		consolidateIndividualCards(gatheredData);

		expect(gatheredData.fizzy_get_cards).toEqual([
			{ id: "a" },
			{ id: "b" },
			{ id: "c" },
		]);
		expect(gatheredData.fizzy_get_card).toBeUndefined();
		expect(gatheredData.fizzy_get_card_2).toBeUndefined();
	});
});

describe("extractPageMeta", () => {
	it("reads the four pagination fields from an envelope", () => {
		expect(
			extractPageMeta({
				cards: [],
				page: 2,
				total_count: 611,
				has_more: true,
				next_page: 3,
			}),
		).toEqual({
			page: 2,
			total_count: 611,
			has_more: true,
			next_page: 3,
		});
	});

	it("returns null for a bare array", () => {
		expect(extractPageMeta([{ id: "a" }])).toBeNull();
	});

	it("returns null for an object without a cards array", () => {
		expect(extractPageMeta({ page: 1, total_count: 5 })).toBeNull();
	});
});

describe("projectCardForContext", () => {
	it("keeps report-relevant fields and drops heavy ones", () => {
		const projected = projectCardForContext({
			id: "a",
			number: 1101,
			title: "Card title",
			closed: false,
			url: "https://app.fizzy.do/000000/cards/1101",
			description: "short",
			description_html: "<p>".repeat(5000),
			creator: { id: "u1", avatar_url: "https://…/huge.png", bio: "x" },
			board: { id: "b1", name: "Board A", extra: "drop me" },
			column: { id: "c1", name: "In Progress", extra: "drop me" },
			assignees: [
				{ id: "u2", name: "Dev", avatar_url: "https://…/a.png" },
			],
			tags: ["bug", "p1"],
		}) as Record<string, unknown>;

		expect(projected).toEqual({
			id: "a",
			number: 1101,
			title: "Card title",
			closed: false,
			url: "https://app.fizzy.do/000000/cards/1101",
			description: "short",
			board: { id: "b1", name: "Board A" },
			column: { id: "c1", name: "In Progress" },
			assignees: [{ id: "u2", name: "Dev" }],
			tags: ["bug", "p1"],
		});
		expect(projected.description_html).toBeUndefined();
		expect(projected.creator).toBeUndefined();
	});

	it("truncates a long description to 280 chars plus an ellipsis", () => {
		const projected = projectCardForContext({
			id: "a",
			description: "x".repeat(500),
		}) as { description: string };

		expect(projected.description).toBe(`${"x".repeat(280)}…`);
		expect(projected.description.length).toBe(281);
	});

	it("passes through non-object values unchanged", () => {
		expect(projectCardForContext("not a card")).toBe("not a card");
		expect(projectCardForContext(null)).toBeNull();
	});

	it("truncates on code points, never splitting a surrogate pair", () => {
		// 280 ASCII chars then an emoji at index 280 — a UTF-16 `slice(0, 280)`
		// on the 281-code-point string would land inside the emoji's pair.
		const description = `${"x".repeat(280)}🚀`;
		const projected = projectCardForContext({
			id: "a",
			description,
		}) as { description: string };

		expect(projected.description).toBe(`${"x".repeat(280)}…`);
		// No lone surrogate survived: a round-trip through JSON is lossless.
		expect(JSON.parse(JSON.stringify(projected)).description).toBe(
			projected.description,
		);
		expect(/[\uD800-\uDFFF]/.test(projected.description)).toBe(false);
	});

	it("keeps a whole emoji when it fits inside the code-point budget", () => {
		const description = `${"x".repeat(279)}🚀${"y".repeat(50)}`;
		const projected = projectCardForContext({
			id: "a",
			description,
		}) as { description: string };

		expect(projected.description).toBe(`${"x".repeat(279)}🚀…`);
		expect(/[\uD800-\uDFFF]/.test(projected.description.slice(0, -1))).toBe(
			true,
		);
		expect(Array.from(projected.description)).toHaveLength(281);
	});
});

describe("applyBoardPreFilter", () => {
	const card = (id: string, boardId: string | null) => ({
		id,
		...(boardId === null ? {} : { board: { id: boardId } }),
	});
	const envelope = (cards: unknown[]) => ({
		cards,
		page: 1,
		total_count: 611,
		has_more: true,
		next_page: 2,
	});

	it("nulls total_count on an unscoped call even when nothing was dropped", () => {
		// Every card on this page happens to be on the target board, but the
		// query was account-wide — 611 counts the whole account, not the board.
		const input = envelope([card("a", "b1"), card("b", "b1")]);
		const out = applyBoardPreFilter({
			parsedOutput: input,
			toolName: "fizzy_get_cards",
			targetBoardId: "b1",
			serverScoped: false,
		}) as Record<string, unknown>;

		expect(out.total_count).toBeNull();
		expect(out.cards).toHaveLength(2);
		expect(out._board_filtered).toEqual({
			kept: 2,
			dropped: 0,
			board_id: "b1",
		});
	});

	it("rewrites an EMPTY unscoped envelope so its account-wide total cannot leak", () => {
		// An out-of-range page: no cards, but `total_count` still counts the
		// whole account. Left as-is it would win `_coverage`'s last-non-null
		// rule and be cited as the board total.
		const input = { cards: [], page: 7, total_count: 611, has_more: true };
		const out = applyBoardPreFilter({
			parsedOutput: input,
			toolName: "fizzy_get_cards",
			targetBoardId: "b1",
			serverScoped: false,
		}) as Record<string, unknown>;

		expect(out.total_count).toBeNull();
		expect(out.cards).toEqual([]);
		expect(out._board_filtered).toEqual({
			kept: 0,
			dropped: 0,
			board_id: "b1",
		});
		// Untouched pagination fields survive the rewrite.
		expect(out.page).toBe(7);
		expect(out.has_more).toBe(true);
	});

	it("leaves an EMPTY server-scoped envelope untouched", () => {
		const input = { cards: [], page: 7, total_count: 0, has_more: false };
		const out = applyBoardPreFilter({
			parsedOutput: input,
			toolName: "fizzy_get_cards",
			targetBoardId: "b1",
			serverScoped: true,
		});

		expect(out).toBe(input);
		expect((out as Record<string, unknown>).total_count).toBe(0);
		expect(
			(out as Record<string, unknown>)._board_filtered,
		).toBeUndefined();
	});

	it("leaves a server-scoped envelope untouched when nothing was dropped", () => {
		const input = envelope([card("a", "b1")]);
		const out = applyBoardPreFilter({
			parsedOutput: input,
			toolName: "fizzy_get_cards",
			targetBoardId: "b1",
			serverScoped: true,
		});

		expect(out).toBe(input);
		expect((out as Record<string, unknown>).total_count).toBe(611);
		expect(
			(out as Record<string, unknown>)._board_filtered,
		).toBeUndefined();
	});

	it("filters foreign cards and nulls total_count even when server-scoped", () => {
		const input = envelope([
			card("a", "b1"),
			card("b", "b2"),
			card("c", null),
		]);
		const out = applyBoardPreFilter({
			parsedOutput: input,
			toolName: "fizzy_get_cards",
			targetBoardId: "b1",
			serverScoped: true,
		}) as Record<string, unknown>;

		// Cards with no board info are kept — they can't be ruled out.
		expect(out.cards).toEqual([card("a", "b1"), card("c", null)]);
		expect(out.total_count).toBeNull();
		expect(out._board_filtered).toEqual({
			kept: 2,
			dropped: 1,
			board_id: "b1",
		});
	});

	it("returns a filtered bare array when cards were dropped", () => {
		const input = [card("a", "b1"), card("b", "b2")];
		const out = applyBoardPreFilter({
			parsedOutput: input,
			toolName: "fizzy_get_cards",
			targetBoardId: "b1",
			serverScoped: false,
		});

		expect(out).toEqual([card("a", "b1")]);
	});

	it("returns a bare array unchanged when nothing was dropped", () => {
		const input = [card("a", "b1")];
		expect(
			applyBoardPreFilter({
				parsedOutput: input,
				toolName: "fizzy_get_cards",
				targetBoardId: "b1",
				serverScoped: false,
			}),
		).toBe(input);
	});

	it("ignores tools outside the card-list name scope", () => {
		const input = envelope([card("a", "b2")]);
		expect(
			applyBoardPreFilter({
				parsedOutput: input,
				toolName: "fizzy_get_boards",
				targetBoardId: "b1",
				serverScoped: false,
			}),
		).toBe(input);
	});

	it("is a no-op without a target board id", () => {
		const input = envelope([card("a", "b2")]);
		expect(
			applyBoardPreFilter({
				parsedOutput: input,
				toolName: "fizzy_get_cards",
				targetBoardId: undefined,
				serverScoped: false,
			}),
		).toBe(input);
	});

	it("matches card-list tool names anchored at the end of the name", () => {
		const input = envelope([card("a", "b2")]);
		const run = (toolName: string) =>
			applyBoardPreFilter({
				parsedOutput: input,
				toolName,
				targetBoardId: "b1",
				serverScoped: false,
			});

		// Matches: the name ends in get_cards / list_cards.
		expect(run("fizzy_get_cards")).not.toBe(input);
		expect(run("trello_list_cards")).not.toBe(input);
		// Does not match: a differently-shaped result that merely starts the same.
		expect(run("get_cards_summary")).toBe(input);
	});
});
