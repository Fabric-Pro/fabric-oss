/**
 * Unit tests for confluence-content-fetcher.ts
 *
 * Tests normalizeConfluenceContent (pure function, all precedence branches) and
 * fetchConfluencePageContent (with fetch mocked).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	fetchConfluencePageContent,
	normalizeConfluenceContent,
} from "../confluence-content-fetcher";

// ── normalizeConfluenceContent ──────────────────────────────────────────────

describe("normalizeConfluenceContent", () => {
	it("flattens an ADF document to plain text (no raw JSON surfacing)", () => {
		const adf = {
			type: "doc",
			version: 1,
			content: [
				{
					type: "heading",
					content: [{ type: "text", text: "Title" }],
				},
				{
					type: "paragraph",
					content: [{ type: "text", text: "Hello world" }],
				},
			],
		};
		const out = normalizeConfluenceContent(adf);
		expect(out).toBe("Title\n\nHello world");
		expect(out).not.toContain("{");
	});

	it("strips HTML/XHTML storage format, decodes entities, preserves block boundaries", () => {
		const html =
			"<p>First paragraph &amp; more</p><p>Second&nbsp;paragraph</p><ul><li>Item</li></ul>";
		const out = normalizeConfluenceContent(html);
		expect(out).toContain("First paragraph & more");
		expect(out).toContain("Second paragraph");
		expect(out).toContain("Item");
		expect(out).not.toContain("<");
		expect(out).not.toContain(">");
		// Block boundaries become newlines.
		expect(out).toContain("\n");
	});

	it("strips Confluence <ac:*> macro tags", () => {
		const html =
			'<ac:structured-macro ac:name="info"><ac:rich-text-body><p>Note text</p></ac:rich-text-body></ac:structured-macro>';
		const out = normalizeConfluenceContent(html);
		expect(out).toContain("Note text");
		expect(out).not.toContain("ac:");
	});

	it("returns a plain string / Markdown unchanged", () => {
		expect(normalizeConfluenceContent("# Heading\n\nBody text")).toBe(
			"# Heading\n\nBody text",
		);
		expect(normalizeConfluenceContent("just plain text")).toBe(
			"just plain text",
		);
	});

	it("unwraps an MCP text-content-array envelope", () => {
		const envelope = [
			{ type: "text", text: "Block A" },
			{ type: "text", text: "Block B" },
		];
		expect(normalizeConfluenceContent(envelope)).toBe("Block A\n\nBlock B");
	});

	it("unwraps a { content: [...] } MCP envelope", () => {
		const result = {
			content: [{ type: "text", text: "Enveloped body" }],
		};
		expect(normalizeConfluenceContent(result)).toBe("Enveloped body");
	});

	it("extracts Confluence body.storage.value HTML", () => {
		const result = {
			title: "Page",
			body: { storage: { value: "<p>Storage body</p>" } },
		};
		expect(normalizeConfluenceContent(result)).toBe("Storage body");
	});

	it("flattens ADF delivered as body.atlas_doc_format.value JSON string", () => {
		const adf = JSON.stringify({
			type: "doc",
			version: 1,
			content: [
				{
					type: "paragraph",
					content: [{ type: "text", text: "Atlas body" }],
				},
			],
		});
		const result = { body: { atlas_doc_format: { value: adf } } };
		expect(normalizeConfluenceContent(result)).toBe("Atlas body");
	});

	it("falls back to JSON.stringify for an unrecognized object", () => {
		const result = { someUnknownField: 123 };
		expect(normalizeConfluenceContent(result)).toBe(JSON.stringify(result));
	});

	it("returns empty string for null / undefined / empty string", () => {
		expect(normalizeConfluenceContent(null)).toBe("");
		expect(normalizeConfluenceContent(undefined)).toBe("");
		expect(normalizeConfluenceContent("")).toBe("");
		expect(normalizeConfluenceContent("   ")).toBe("");
	});
});

// ── fetchConfluencePageContent ──────────────────────────────────────────────

describe("fetchConfluencePageContent", () => {
	const mockFetch = vi.fn();

	beforeEach(() => {
		mockFetch.mockReset();
		global.fetch = mockFetch;
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	const baseParams = {
		pageId: "page-123",
		mcpConfigId: "config-456",
	};

	function mockToolsResponse(tools: string[]) {
		return { ok: true, json: async () => ({ tools }) };
	}

	function mockContentResponse(result: unknown, error?: string) {
		return {
			ok: true,
			json: async () => (error ? { error } : { result }),
		};
	}

	it("returns contentFetchFailed when no get-page tool found", async () => {
		mockFetch
			.mockResolvedValueOnce(
				mockToolsResponse(["confluence_search", "list_spaces"]),
			)
			.mockResolvedValueOnce({ ok: true, json: async () => ({}) });

		const result = await fetchConfluencePageContent(baseParams);

		expect(result.contentFetchFailed).toBe(true);
		expect(result.content).toBe("");
		// No content call is made when no tool is found.
		expect(mockFetch).toHaveBeenCalledTimes(1);
	});

	it("returns contentFetchFailed when MCP returns an error", async () => {
		mockFetch
			.mockResolvedValueOnce(mockToolsResponse(["confluence_get_page"]))
			.mockResolvedValueOnce(
				mockContentResponse(null, "Tool execution failed"),
			);

		const result = await fetchConfluencePageContent(baseParams);
		expect(result.contentFetchFailed).toBe(true);
		expect(result.content).toBe("");
	});

	it("returns contentFetchFailed for an empty page body", async () => {
		mockFetch
			.mockResolvedValueOnce(mockToolsResponse(["get_page"]))
			.mockResolvedValueOnce(
				mockContentResponse({ body: { storage: { value: "" } } }),
			);

		const result = await fetchConfluencePageContent(baseParams);
		expect(result.contentFetchFailed).toBe(true);
		expect(result.content).toBe("");
	});

	it.each([["confluence_get_page"], ["get_page_content"], ["getPage"]])(
		"resolves a successful fetch with tool-name variant %s",
		async (toolName) => {
			mockFetch
				.mockResolvedValueOnce(
					mockToolsResponse(["confluence_search", toolName]),
				)
				.mockResolvedValueOnce(
					mockContentResponse({
						title: "Release Notes",
						body: { storage: { value: "<p>Body content</p>" } },
					}),
				);

			const result = await fetchConfluencePageContent(baseParams);

			expect(result.contentFetchFailed).toBe(false);
			expect(result.content).toBe("Body content");
			expect(result.title).toBe("Release Notes");
			expect(mockFetch).toHaveBeenCalledTimes(2);
		},
	);

	it("prefers the MCP response title over the fallback title", async () => {
		mockFetch
			.mockResolvedValueOnce(mockToolsResponse(["confluence_get_page"]))
			.mockResolvedValueOnce(
				mockContentResponse({
					title: "Canonical Title",
					body: { storage: { value: "<p>x</p>" } },
				}),
			);

		const result = await fetchConfluencePageContent({
			...baseParams,
			fallbackTitle: "Selector Title",
		});
		expect(result.title).toBe("Canonical Title");
	});

	it("falls back to the selector title when MCP omits a title", async () => {
		mockFetch
			.mockResolvedValueOnce(mockToolsResponse(["confluence_get_page"]))
			.mockResolvedValueOnce(
				mockContentResponse({
					body: { storage: { value: "<p>body</p>" } },
				}),
			);

		const result = await fetchConfluencePageContent({
			...baseParams,
			fallbackTitle: "Selector Title",
		});
		expect(result.title).toBe("Selector Title");
	});

	// ── Atlassian Rovo get-page tool selection ──────────────────────────────

	it("picks getConfluencePage (not comments/pages-in-space) and sends only { pageId }", async () => {
		mockFetch
			.mockResolvedValueOnce(
				mockToolsResponse([
					"getPagesInConfluenceSpace",
					"getConfluencePageFooterComments",
					"getConfluencePageDescendants",
					"getConfluencePage",
				]),
			)
			.mockResolvedValueOnce(
				mockContentResponse({
					title: "Rovo Page",
					body: { storage: { value: "<p>Rovo body</p>" } },
				}),
			);

		const result = await fetchConfluencePageContent(baseParams);

		expect(result.content).toBe("Rovo body");
		// The content call targeted getConfluencePage with the minimal Rovo shape
		// (cloudId is injected server-side; extra params risk schema rejection).
		const contentBody = JSON.parse(
			(mockFetch.mock.calls[1][1] as RequestInit).body as string,
		);
		expect(contentBody.toolName).toBe("getConfluencePage");
		expect(contentBody.params).toEqual({ pageId: "page-123" });
	});

	it("fails cleanly when only non-content page tools exist (no get-page tool)", async () => {
		mockFetch
			.mockResolvedValueOnce(
				mockToolsResponse([
					"getPagesInConfluenceSpace",
					"getConfluencePageFooterComments",
					"getConfluencePageInlineComments",
				]),
			)
			.mockResolvedValueOnce({ ok: true, json: async () => ({}) });

		const result = await fetchConfluencePageContent(baseParams);

		expect(result.contentFetchFailed).toBe(true);
		// No content call is made when no real get-page tool is found.
		expect(mockFetch).toHaveBeenCalledTimes(1);
	});
});
