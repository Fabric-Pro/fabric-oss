/**
 * `fizzy_get_cards` returns ONE page per call — since fizzy-mcp 1.1.0 a
 * `{cards, page, total_count, has_more, next_page}` envelope with a
 * server-controlled, variable page size. `listAllFizzyCards` fans out one
 * call per column, so before this walk existed every column holding more
 * than a first page silently lost its remaining cards.
 *
 * That loss is not cosmetic: the pull-only sync deletes every Fabric story
 * whose card is absent from the listing, so a short column deletes the
 * stories of cards that still exist in Fizzy. The rule is the same one the
 * parse-failure path already enforces — a failed listing is safe (the caller
 * falls back to the generic paged path), a short one is not.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { executeMcpToolMock } = vi.hoisted(() => ({
	executeMcpToolMock: vi.fn(),
}));

vi.mock("../../orchestrator/execution/execute-mcp-tool", () => ({
	executeMcpTool: executeMcpToolMock,
}));

import { listAllFizzyCards } from "../story-sync";

/** Mirrors `FIZZY_COLUMN_PAGE_CAP` in story-sync.ts. */
const PAGE_CAP = 50;

const CAPABILITIES = {
	detectedType: "fizzy",
	availableTools: ["fizzy_get_columns", "fizzy_get_cards"],
	taskList: {
		toolName: "fizzy_get_cards",
		containerParam: "board_id",
		allParams: [],
		filterParams: [],
		additionalRequiredParams: [],
		paginationInfo: { style: "none" as const },
	},
} as unknown as Parameters<typeof listAllFizzyCards>[0]["capabilities"];

const INPUT = {
	mcpConfigId: "mcp-1",
	containerId: "board-1",
	additionalContext: { account_slug: "example-org" },
	userId: "user-1",
	organizationId: "org-1",
	capabilities: CAPABILITIES,
};

/** MCP envelope: a text block carrying a JSON document. */
const jsonBlock = (value: unknown) => ({
	success: true,
	output: { content: [{ type: "text", text: JSON.stringify(value) }] },
});

const oneColumn = [{ id: "col-1", name: "To do" }];

/** Every `fizzy_get_cards` call the mock saw, in order. */
const cardCalls = () =>
	executeMcpToolMock.mock.calls
		.map(
			([arg]) =>
				arg as { toolName: string; args: Record<string, unknown> },
		)
		.filter((call) => call.toolName === "fizzy_get_cards");

beforeEach(() => {
	executeMcpToolMock.mockReset();
});

describe("listAllFizzyCards — per-column pagination", () => {
	it("walks next_page until has_more is false and returns every page's cards", async () => {
		executeMcpToolMock.mockImplementation(
			async ({
				toolName,
				args,
			}: {
				toolName: string;
				args: Record<string, unknown>;
			}) => {
				if (toolName === "fizzy_get_columns") {
					return jsonBlock(oneColumn);
				}
				if (args.page == null) {
					return jsonBlock({
						cards: [{ id: "c1", title: "First" }],
						page: 1,
						total_count: 2,
						has_more: true,
						next_page: 2,
					});
				}
				return jsonBlock({
					cards: [{ id: "c2", title: "Second" }],
					page: 2,
					total_count: 2,
					has_more: false,
					next_page: null,
				});
			},
		);

		const result = await listAllFizzyCards(INPUT);

		expect(result?.items.map((i) => i.id)).toEqual(["c1", "c2"]);
		// Both cards carry the column name as their state.
		expect(result?.items.map((i) => i.state)).toEqual(["To do", "To do"]);

		const calls = cardCalls();
		expect(calls).toHaveLength(2);
		// The first request must stay byte-identical to the pre-pagination one.
		expect(calls[0]?.args).toEqual({
			account_slug: "example-org",
			column_id: "col-1",
		});
		expect(calls[1]?.args.page).toBe(2);
	});

	it("derives the next page number when the envelope omits next_page", async () => {
		executeMcpToolMock.mockImplementation(
			async ({
				toolName,
				args,
			}: {
				toolName: string;
				args: Record<string, unknown>;
			}) => {
				if (toolName === "fizzy_get_columns") {
					return jsonBlock(oneColumn);
				}
				if (args.page == null) {
					return jsonBlock({
						cards: [{ id: "c1", title: "First" }],
						has_more: true,
					});
				}
				return jsonBlock({
					cards: [{ id: "c2", title: "Second" }],
					has_more: false,
				});
			},
		);

		const result = await listAllFizzyCards(INPUT);

		expect(result?.items.map((i) => i.id)).toEqual(["c1", "c2"]);
		expect(cardCalls()[1]?.args.page).toBe(2);
	});

	it("dedupes a card that appears on two pages of the same column", async () => {
		executeMcpToolMock.mockImplementation(
			async ({
				toolName,
				args,
			}: {
				toolName: string;
				args: Record<string, unknown>;
			}) => {
				if (toolName === "fizzy_get_columns") {
					return jsonBlock(oneColumn);
				}
				return args.page == null
					? jsonBlock({
							cards: [
								{ id: "c1", title: "First" },
								{ id: "c2", title: "Second" },
							],
							has_more: true,
							next_page: 2,
						})
					: jsonBlock({
							cards: [
								{ id: "c2", title: "Second" },
								{ id: "c3", title: "Third" },
							],
							has_more: false,
						});
			},
		);

		const result = await listAllFizzyCards(INPUT);

		expect(result?.items.map((i) => i.id)).toEqual(["c1", "c2", "c3"]);
	});

	it("stops on an empty page even when the server still reports has_more", async () => {
		// The tool contract warns that an out-of-range page returns no cards
		// but may still claim has_more — the empty check is what ends the walk.
		executeMcpToolMock.mockImplementation(
			async ({
				toolName,
				args,
			}: {
				toolName: string;
				args: Record<string, unknown>;
			}) => {
				if (toolName === "fizzy_get_columns") {
					return jsonBlock(oneColumn);
				}
				return args.page == null
					? jsonBlock({
							cards: [{ id: "c1", title: "Only card" }],
							has_more: true,
							next_page: 2,
						})
					: jsonBlock({ cards: [], has_more: true, next_page: 3 });
			},
		);

		const result = await listAllFizzyCards(INPUT);

		// No throw, no fallback: the column is simply exhausted.
		expect(result).not.toBeNull();
		expect(result?.items.map((i) => i.id)).toEqual(["c1"]);
		expect(cardCalls()).toHaveLength(2);
	});

	it("keeps paging when a page's entries are unusable but not absent", async () => {
		// Cards without an id are skipped, so the mapped list is empty while
		// the server's page was not. Reading that as the end of the column
		// would drop every later page.
		executeMcpToolMock.mockImplementation(
			async ({
				toolName,
				args,
			}: {
				toolName: string;
				args: Record<string, unknown>;
			}) => {
				if (toolName === "fizzy_get_columns") {
					return jsonBlock(oneColumn);
				}
				return args.page == null
					? jsonBlock({
							cards: [{ title: "No id at all" }],
							has_more: true,
							next_page: 2,
						})
					: jsonBlock({
							cards: [{ id: "c1", title: "Real card" }],
							has_more: false,
						});
			},
		);

		const result = await listAllFizzyCards(INPUT);

		expect(result?.items.map((i) => i.id)).toEqual(["c1"]);
		expect(cardCalls()).toHaveLength(2);
	});

	it("fails the listing rather than truncating when the page cap is hit", async () => {
		// A server that never stops claiming has_more on non-empty pages is a
		// broken cursor. Returning the pages collected so far would be a short
		// board, and the pull deletes the stories of every missing card.
		executeMcpToolMock.mockImplementation(
			async ({
				toolName,
				args,
			}: {
				toolName: string;
				args: Record<string, unknown>;
			}) => {
				if (toolName === "fizzy_get_columns") {
					return jsonBlock(oneColumn);
				}
				const page = typeof args.page === "number" ? args.page : 1;
				return jsonBlock({
					cards: [{ id: `c${page}`, title: `Card ${page}` }],
					has_more: true,
					next_page: page + 1,
				});
			},
		);

		const result = await listAllFizzyCards(INPUT);

		// The throw is caught by the outer handler, which falls back to the
		// generic paged path — the same safe outcome as a parse failure.
		expect(result).toBeNull();
		expect(cardCalls()).toHaveLength(PAGE_CAP);
	});

	it("fails the listing when a page request fails part-way through a column", async () => {
		// Before the walk existed a failed call skipped the whole column, and
		// a failure on page 2 would otherwise keep page 1's cards and drop the
		// rest — both are short boards. Either way the outcome must be the
		// same as any other unreadable column: fail, fall back, never
		// truncate.
		executeMcpToolMock.mockImplementation(
			async ({
				toolName,
				args,
			}: {
				toolName: string;
				args: Record<string, unknown>;
			}) => {
				if (toolName === "fizzy_get_columns") {
					return jsonBlock([
						{ id: "col-1", name: "To do" },
						{ id: "col-2", name: "Done" },
					]);
				}
				if (args.page === 2) {
					return {
						success: false,
						output: { error: "upstream 502" },
					};
				}
				return jsonBlock({
					cards: [{ id: "c1", title: "Card 1" }],
					has_more: true,
					next_page: 2,
				});
			},
		);

		const result = await listAllFizzyCards(INPUT);

		expect(result).toBeNull();
		// The failure stops the listing at the failed column; the second
		// column is never queried.
		expect(cardCalls()).toHaveLength(2);
		expect(cardCalls().every((c) => c.args.column_id === "col-1")).toBe(
			true,
		);
	});

	it("reads string booleans and camelCase envelope fields", async () => {
		// The walk must not stop early because a proxy stringified the flag
		// or a server used camelCase keys.
		executeMcpToolMock.mockImplementation(
			async ({
				toolName,
				args,
			}: {
				toolName: string;
				args: Record<string, unknown>;
			}) => {
				if (toolName === "fizzy_get_columns") {
					return jsonBlock(oneColumn);
				}
				if (args.page === "2" || args.page === 2) {
					return jsonBlock({
						cards: [{ id: "c2", title: "Card 2" }],
						hasMore: "false",
						totalCount: "2",
					});
				}
				return jsonBlock({
					cards: [{ id: "c1", title: "Card 1" }],
					hasMore: "true",
					nextPage: "2",
					totalCount: "2",
				});
			},
		);

		const result = await listAllFizzyCards(INPUT);

		expect(result?.items.map((i) => i.id)).toEqual(["c1", "c2"]);
		expect(cardCalls()).toHaveLength(2);
		expect(cardCalls()[1]?.args.page).toBe(2);
	});

	it("fails the listing when a paginated envelope has no readable has_more", async () => {
		// An envelope that carries a cursor but an unreadable has_more would
		// otherwise read as "no more pages" and end the column early — a
		// short board again. Only a fully undeclared envelope (pre-envelope
		// server) may be treated as a single page.
		for (const badFlag of [undefined, "yes", 1, null]) {
			executeMcpToolMock.mockReset();
			executeMcpToolMock.mockImplementation(
				async ({ toolName }: { toolName: string }) => {
					if (toolName === "fizzy_get_columns") {
						return jsonBlock(oneColumn);
					}
					return jsonBlock({
						cards: [{ id: "c1", title: "Card 1" }],
						...(badFlag === undefined ? {} : { has_more: badFlag }),
						next_page: 2,
					});
				},
			);

			const result = await listAllFizzyCards(INPUT);

			expect(result, `has_more=${String(badFlag)}`).toBeNull();
			expect(cardCalls()).toHaveLength(1);
		}
	});

	it("treats a bare-array response as a single complete page", async () => {
		// A fizzy-mcp predating the page envelope answers with a plain array.
		executeMcpToolMock.mockImplementation(
			async ({ toolName }: { toolName: string }) => {
				if (toolName === "fizzy_get_columns") {
					return jsonBlock(oneColumn);
				}
				return jsonBlock([{ id: "c1", title: "Legacy card" }]);
			},
		);

		const result = await listAllFizzyCards(INPUT);

		expect(result?.items.map((i) => i.id)).toEqual(["c1"]);
		expect(cardCalls()).toHaveLength(1);
	});

	it("keeps paging each column independently", async () => {
		executeMcpToolMock.mockImplementation(
			async ({
				toolName,
				args,
			}: {
				toolName: string;
				args: Record<string, unknown>;
			}) => {
				if (toolName === "fizzy_get_columns") {
					return jsonBlock([
						{ id: "col-1", name: "To do" },
						{ id: "col-2", name: "In progress" },
					]);
				}
				if (args.column_id === "col-1") {
					return args.page == null
						? jsonBlock({
								cards: [{ id: "a1", title: "A1" }],
								has_more: true,
								next_page: 2,
							})
						: jsonBlock({
								cards: [{ id: "a2", title: "A2" }],
								has_more: false,
							});
				}
				return jsonBlock({
					cards: [{ id: "b1", title: "B1" }],
					has_more: false,
				});
			},
		);

		const result = await listAllFizzyCards(INPUT);

		expect(result?.items.map((i) => i.id)).toEqual(["a1", "a2", "b1"]);
		expect(result?.items.map((i) => i.state)).toEqual([
			"To do",
			"To do",
			"In progress",
		]);
		// col-2 must start from the first page, not carry col-1's cursor.
		expect(
			cardCalls().filter((c) => c.args.column_id === "col-2"),
		).toHaveLength(1);
		expect(
			cardCalls().find((c) => c.args.column_id === "col-2")?.args.page,
		).toBeUndefined();
	});
});
