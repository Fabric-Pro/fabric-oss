import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	fetchNotionBlocksAsText,
	type NotionRawBlock,
	parseBlocksToText,
} from "../notion-content";

describe("notion-content", () => {
	describe("parseBlocksToText", () => {
		it("parses headings, lists, to-dos, code and quotes into markdown", () => {
			const blocks: NotionRawBlock[] = [
				{
					type: "heading_1",
					heading_1: {
						rich_text: [{ plain_text: "Title Heading" }],
					},
				},
				{
					type: "heading_2",
					heading_2: {
						rich_text: [{ plain_text: "Sub Heading" }],
					},
				},
				{
					type: "heading_3",
					heading_3: {
						rich_text: [{ plain_text: "Section Heading" }],
					},
				},
				{
					type: "bulleted_list_item",
					bulleted_list_item: {
						rich_text: [{ plain_text: "Bullet item" }],
					},
				},
				{
					type: "numbered_list_item",
					numbered_list_item: {
						rich_text: [{ plain_text: "Numbered item" }],
					},
				},
				{
					type: "to_do",
					to_do: {
						checked: false,
						rich_text: [{ plain_text: "Pending task" }],
					},
				},
				{
					type: "to_do",
					to_do: {
						checked: true,
						rich_text: [{ plain_text: "Done task" }],
					},
				},
				{
					type: "code",
					code: {
						rich_text: [{ plain_text: "const x = 1;" }],
					},
				},
				{
					type: "quote",
					quote: {
						rich_text: [{ plain_text: "A famous quote" }],
					},
				},
				{
					type: "callout",
					callout: {
						rich_text: [{ plain_text: "Important note" }],
					},
				},
			];

			const text = parseBlocksToText(blocks);
			expect(text).toContain("# Title Heading");
			expect(text).toContain("## Sub Heading");
			expect(text).toContain("### Section Heading");
			expect(text).toContain("- Bullet item");
			expect(text).toContain("1. Numbered item");
			expect(text).toContain("- [ ] Pending task");
			expect(text).toContain("- [x] Done task");
			expect(text).toContain("```\nconst x = 1;\n```");
			expect(text).toContain("> A famous quote");
			expect(text).toContain("> Important note");
		});

		it("recursively parses nested child blocks with indentation", () => {
			const blocks: NotionRawBlock[] = [
				{
					type: "bulleted_list_item",
					bulleted_list_item: {
						rich_text: [{ plain_text: "Parent bullet" }],
					},
					children: [
						{
							type: "bulleted_list_item",
							bulleted_list_item: {
								rich_text: [{ plain_text: "Child bullet" }],
							},
						},
					],
				},
			];

			const text = parseBlocksToText(blocks);
			expect(text).toContain("- Parent bullet");
			expect(text).toContain("  - Child bullet");
		});
	});

	describe("fetchNotionChildBlocks & fetchNotionBlocksAsText", () => {
		const originalFetch = global.fetch;

		beforeEach(() => {
			vi.clearAllMocks();
		});

		afterEach(() => {
			global.fetch = originalFetch;
		});

		it("fetches child blocks with pagination and converts to text", async () => {
			global.fetch = vi
				.fn()
				.mockResolvedValueOnce({
					ok: true,
					json: async () => ({
						results: [
							{
								id: "b1",
								type: "heading_1",
								heading_1: {
									rich_text: [
										{ plain_text: "Page 1 Content" },
									],
								},
								has_children: false,
							},
						],
						has_more: true,
						next_cursor: "cursor-2",
					}),
				} as any)
				.mockResolvedValueOnce({
					ok: true,
					json: async () => ({
						results: [
							{
								id: "b2",
								type: "paragraph",
								paragraph: {
									rich_text: [
										{ plain_text: "Page 2 Content" },
									],
								},
								has_children: false,
							},
						],
						has_more: false,
						next_cursor: null,
					}),
				} as any);

			const content = await fetchNotionBlocksAsText(
				"page-123",
				"secret-token",
			);
			expect(content).toBe("# Page 1 Content\n\nPage 2 Content");
		});

		it("translates Notion 401 error into UNAUTHORIZED ORPCError", async () => {
			global.fetch = vi.fn().mockResolvedValue({
				ok: false,
				status: 401,
				text: async () => "Unauthorized",
			} as any);

			await expect(
				fetchNotionBlocksAsText("page-123", "invalid-token"),
			).rejects.toMatchObject({
				code: "UNAUTHORIZED",
				message: "Notion connection expired. Reconnect Notion.",
			});
		});

		it("translates Notion 404 error into NOT_FOUND ORPCError", async () => {
			global.fetch = vi.fn().mockResolvedValue({
				ok: false,
				status: 404,
				text: async () => "Not Found",
			} as any);

			await expect(
				fetchNotionBlocksAsText("page-123", "secret-token"),
			).rejects.toMatchObject({
				code: "NOT_FOUND",
				message: "Page not shared with Fabric",
			});
		});

		it("translates other Notion errors into BAD_REQUEST ORPCError", async () => {
			global.fetch = vi.fn().mockResolvedValue({
				ok: false,
				status: 500,
				text: async () => "Internal Error",
			} as any);

			await expect(
				fetchNotionBlocksAsText("page-123", "secret-token"),
			).rejects.toMatchObject({
				code: "BAD_REQUEST",
			});
		});
	});
});
