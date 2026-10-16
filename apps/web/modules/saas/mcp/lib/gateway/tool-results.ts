/**
 * The two shapes a platform tool answers with, shared by `platform-tools.ts`,
 * the tool modules under `./tools` and the page-call guard.
 */

import type { ToolCallResult } from "./types";

export function jsonResult(data: unknown): ToolCallResult {
	return {
		content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
	};
}

/**
 * An error a caller can read: what happened, and any `extra` fields to act on,
 * such as a `reason` to branch on or when to retry.
 */
export function errorResult(
	message: string,
	extra: Record<string, unknown> = {},
): ToolCallResult {
	return {
		content: [
			{
				type: "text",
				text: JSON.stringify({ error: message, ...extra }),
			},
		],
		isError: true,
	};
}
