/**
 * Whether a person's own connection can see a board the project chose through
 * another person's. A connection to the same tool can sign in to a different
 * account, so a report on that board would find nothing. The create dialog
 * learns this from the board list it shows; the one-click path asks here.
 */

import { getCachedMcpClientForConfig } from "@repo/mcp";

const BOARD_LIST_TOOL = /(^|_)(get|list)_boards$/i;
const BOARD_LIST_TIMEOUT_MS = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The `id` of every object in a board listing, however the tool wraps it. */
function collectIds(value: unknown, ids: Set<string>): void {
	if (Array.isArray(value)) {
		for (const entry of value) {
			collectIds(entry, ids);
		}
		return;
	}
	if (!isRecord(value)) {
		return;
	}
	if (typeof value.id === "string" || typeof value.id === "number") {
		ids.add(String(value.id));
	}
	for (const entry of Object.values(value)) {
		collectIds(entry, ids);
	}
}

/** An MCP result carries its JSON as text in `content`; a typed tool returns it bare. */
function listedBoardIds(result: unknown): Set<string> {
	const ids = new Set<string>();
	const content = isRecord(result) ? result.content : undefined;
	if (!Array.isArray(content)) {
		collectIds(result, ids);
		return ids;
	}
	for (const part of content) {
		if (!isRecord(part) || typeof part.text !== "string") {
			continue;
		}
		try {
			collectIds(JSON.parse(part.text), ids);
		} catch {
			// A part that is not JSON lists no boards.
		}
	}
	return ids;
}

/**
 * `false` when the board is not listed or the listing could not be read: the
 * report then starts without the board and the person picks one on the form.
 */
export async function boardIsListedForConfig({
	configId,
	userId,
	organizationId,
	boardId,
	accountSlug,
}: {
	configId: string;
	userId: string;
	organizationId: string;
	boardId: string;
	accountSlug: string;
}): Promise<boolean> {
	try {
		const { client } = await getCachedMcpClientForConfig({
			configId,
			userId,
			organizationId,
			// Only lists the boards.
			access: "read",
		});
		const tools = await client.tools();
		const name = Object.keys(tools).find((tool) =>
			BOARD_LIST_TOOL.test(tool),
		);
		const execute = name ? tools[name]?.execute : undefined;
		if (!execute) {
			return false;
		}
		const result = await execute(
			accountSlug ? { account_slug: accountSlug } : {},
			{
				toolCallId: "report-board-check",
				messages: [],
				context: {},
				abortSignal: AbortSignal.timeout(BOARD_LIST_TIMEOUT_MS),
			},
		);
		return listedBoardIds(result).has(boardId);
	} catch {
		return false;
	}
}
