/**
 * Notion Content Helpers
 *
 * Recursively fetches child blocks for Notion pages and parses them into plain text / markdown.
 */

import { ORPCError } from "@orpc/client";

export type NotionRawBlock = Record<string, unknown> & {
	id?: string;
	type?: string;
	has_children?: boolean;
	children?: NotionRawBlock[];
};

async function fetchNotionChildBlocks(
	blockId: string,
	accessToken: string,
): Promise<NotionRawBlock[]> {
	const headers = {
		Authorization: `Bearer ${accessToken}`,
		"Notion-Version": "2022-06-28",
		"Content-Type": "application/json",
	};

	const collected: NotionRawBlock[] = [];
	let cursor: string | undefined;

	do {
		const url = new URL(
			`https://api.notion.com/v1/blocks/${blockId}/children`,
		);
		url.searchParams.set("page_size", "100");
		if (cursor) {
			url.searchParams.set("start_cursor", cursor);
		}

		const response = await fetch(url.toString(), { headers });
		if (!response.ok) {
			if (response.status === 401) {
				throw new ORPCError("UNAUTHORIZED", {
					message: "Notion connection expired. Reconnect Notion.",
				});
			}
			if (response.status === 404) {
				throw new ORPCError("NOT_FOUND", {
					message: "Page not shared with Fabric",
				});
			}
			const errorText = await response.text().catch(() => "unknown");
			throw new ORPCError("BAD_REQUEST", {
				message: `Notion API error ${response.status}: ${errorText}`,
			});
		}

		const data = (await response.json()) as {
			results: NotionRawBlock[];
			has_more: boolean;
			next_cursor: string | null;
		};

		for (const block of data.results) {
			// Recursively fetch children for nested blocks (toggles, columns, etc.)
			if (block.has_children && typeof block.id === "string") {
				block.children = await fetchNotionChildBlocks(
					block.id,
					accessToken,
				);
			}
			collected.push(block);
		}

		cursor = data.has_more ? (data.next_cursor ?? undefined) : undefined;
	} while (cursor);

	return collected;
}

export function parseBlocksToText(blocks: NotionRawBlock[], level = 0): string {
	const parts: string[] = [];

	for (const block of blocks) {
		const blockType = typeof block.type === "string" ? block.type : "";
		const payload =
			blockType &&
			block[blockType] &&
			typeof block[blockType] === "object"
				? (block[blockType] as Record<string, unknown>)
				: {};
		const richText = Array.isArray(payload.rich_text)
			? (payload.rich_text as Array<{ plain_text?: string }>)
			: [];
		const text = richText
			.map((t) => t.plain_text ?? "")
			.join("")
			.trim();

		switch (blockType) {
			case "heading_1":
				if (text) {
					parts.push(`# ${text}`);
				}
				break;
			case "heading_2":
				if (text) {
					parts.push(`## ${text}`);
				}
				break;
			case "heading_3":
				if (text) {
					parts.push(`### ${text}`);
				}
				break;
			case "bulleted_list_item":
				if (text) {
					parts.push(`${"  ".repeat(level)}- ${text}`);
				}
				break;
			case "numbered_list_item":
				if (text) {
					parts.push(`${"  ".repeat(level)}1. ${text}`);
				}
				break;
			case "to_do":
				if (text) {
					parts.push(
						`${"  ".repeat(level)}- [${payload.checked ? "x" : " "}] ${text}`,
					);
				}
				break;
			case "code":
				if (text) {
					parts.push(`\`\`\`\n${text}\n\`\`\``);
				}
				break;
			case "quote":
			case "callout":
				if (text) {
					parts.push(`> ${text}`);
				}
				break;
			default:
				if (text) {
					parts.push(text);
				}
				break;
		}

		// Recurse into children (toggles, columns, synced blocks, etc.)
		const children = Array.isArray(block.children)
			? (block.children as NotionRawBlock[])
			: [];
		if (children.length > 0) {
			const childText = parseBlocksToText(children, level + 1);
			if (childText) {
				parts.push(childText);
			}
		}
	}

	return parts.filter(Boolean).join("\n\n");
}

export async function fetchNotionBlocksAsText(
	pageId: string,
	accessToken: string,
): Promise<string> {
	const blocks = await fetchNotionChildBlocks(pageId, accessToken);
	return parseBlocksToText(blocks);
}
