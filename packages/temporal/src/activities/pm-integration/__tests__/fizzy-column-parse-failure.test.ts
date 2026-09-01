/**
 * A Fizzy column whose card listing cannot be parsed must NOT be treated as
 * an empty column (Fizzy #1997, post-ship review finding).
 *
 * `listAllFizzyCards` fans out one `fizzy_get_cards` call per column and
 * concatenates the results. If one column's response comes back as
 * unparseable text (rate-limit notice, HTML error page, truncated body) and
 * that column is silently skipped, the board listing is short but still
 * non-empty — so the workflow's "board is empty" guard does not fire, and
 * the full pull's orphan cleanup deletes the Fabric stories of cards that
 * still exist in Fizzy.
 *
 * The listing must fail instead, which makes the caller fall back to the
 * generic paged path (itself hardened the same way).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { executeMcpToolMock } = vi.hoisted(() => ({
	executeMcpToolMock: vi.fn(),
}));

vi.mock("../../orchestrator/execution/execute-mcp-tool", () => ({
	executeMcpTool: executeMcpToolMock,
}));

import { listAllFizzyCards } from "../story-sync";

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

/** MCP envelope whose text block is NOT JSON — the failure under test. */
const brokenBlock = () => ({
	success: true,
	output: {
		content: [{ type: "text", text: "Rate limit exceeded, try later" }],
	},
});

const columns = [
	{ id: "col-1", name: "To do" },
	{ id: "col-2", name: "In progress" },
];

beforeEach(() => {
	executeMcpToolMock.mockReset();
});

describe("listAllFizzyCards — unparseable column", () => {
	it("returns null (caller falls back) instead of a short board", async () => {
		executeMcpToolMock.mockImplementation(
			async ({
				toolName,
				args,
			}: {
				toolName: string;
				args: Record<string, unknown>;
			}) => {
				if (toolName === "fizzy_get_columns") {
					return jsonBlock(columns);
				}
				// First column parses; second is unreadable.
				return args.column_id === "col-1"
					? jsonBlock({ cards: [{ id: "c1", title: "Real card" }] })
					: brokenBlock();
			},
		);

		const result = await listAllFizzyCards(INPUT);

		// Falling back is the safe outcome: a partial board would let the
		// pull's orphan cleanup delete the missing column's stories.
		expect(result).toBeNull();
	});

	it("still returns every card when all columns parse", async () => {
		executeMcpToolMock.mockImplementation(
			async ({
				toolName,
				args,
			}: {
				toolName: string;
				args: Record<string, unknown>;
			}) => {
				if (toolName === "fizzy_get_columns") {
					return jsonBlock(columns);
				}
				return args.column_id === "col-1"
					? jsonBlock({ cards: [{ id: "c1", title: "First" }] })
					: jsonBlock({ cards: [{ id: "c2", title: "Second" }] });
			},
		);

		const result = await listAllFizzyCards(INPUT);

		expect(result).not.toBeNull();
		expect(result?.items.map((i) => i.id).sort()).toEqual(["c1", "c2"]);
	});

	it("treats a genuinely empty column as empty, not as a failure", async () => {
		executeMcpToolMock.mockImplementation(
			async ({
				toolName,
				args,
			}: {
				toolName: string;
				args: Record<string, unknown>;
			}) => {
				if (toolName === "fizzy_get_columns") {
					return jsonBlock(columns);
				}
				return args.column_id === "col-1"
					? jsonBlock({ cards: [{ id: "c1", title: "Only card" }] })
					: jsonBlock({ cards: [] });
			},
		);

		const result = await listAllFizzyCards(INPUT);

		expect(result).not.toBeNull();
		expect(result?.items.map((i) => i.id)).toEqual(["c1"]);
	});
});
