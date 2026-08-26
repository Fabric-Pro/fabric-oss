/**
 * Unit tests for google-drive-content-fetcher.ts
 *
 * Tests parseGoogleDriveMcpContent (pure function) and
 * fetchGoogleDriveFileContent (with fetch mocked).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	fetchGoogleDriveFileContent,
	parseGoogleDriveMcpContent,
} from "../google-drive-content-fetcher";

// ── parseGoogleDriveMcpContent ──────────────────────────────────────────

describe("parseGoogleDriveMcpContent", () => {
	it("returns string input directly", () => {
		expect(parseGoogleDriveMcpContent("hello world")).toBe("hello world");
	});

	it("returns empty string for null", () => {
		expect(parseGoogleDriveMcpContent(null)).toBe("");
	});

	it("returns empty string for undefined", () => {
		expect(parseGoogleDriveMcpContent(undefined)).toBe("");
	});

	it("returns empty string for non-object primitives", () => {
		expect(parseGoogleDriveMcpContent(42)).toBe("");
		expect(parseGoogleDriveMcpContent(true)).toBe("");
	});

	it("joins text content blocks from result.content array", () => {
		const result = {
			content: [
				{ type: "text", text: "First block" },
				{ type: "text", text: "Second block" },
			],
		};
		expect(parseGoogleDriveMcpContent(result)).toBe(
			"First block\n\nSecond block",
		);
	});

	it("filters out non-text content blocks", () => {
		const result = {
			content: [
				{ type: "text", text: "Keep this" },
				{ type: "image", url: "http://example.com/img.png" },
				{ type: "text", text: "And this" },
			],
		};
		expect(parseGoogleDriveMcpContent(result)).toBe(
			"Keep this\n\nAnd this",
		);
	});

	it("returns empty string when content array has no text blocks", () => {
		const result = {
			content: [{ type: "image", url: "http://example.com" }],
		};
		expect(parseGoogleDriveMcpContent(result)).toBe("");
	});

	it("returns result.content when it is a plain string", () => {
		const result = { content: "plain content string" };
		expect(parseGoogleDriveMcpContent(result)).toBe("plain content string");
	});

	it("stringifies result.content when it is a nested object", () => {
		const nested = { key: "value", nested: true };
		const result = { content: nested };
		expect(parseGoogleDriveMcpContent(result)).toBe(JSON.stringify(nested));
	});

	it("returns result.text when it is a string", () => {
		const result = { text: "text field content" };
		expect(parseGoogleDriveMcpContent(result)).toBe("text field content");
	});

	it("stringifies result.text when it is not a string", () => {
		const result = { text: { nested: true } };
		expect(parseGoogleDriveMcpContent(result)).toBe(
			JSON.stringify({ nested: true }),
		);
	});

	it("returns result.markdown when it is a string", () => {
		const result = { markdown: "# Heading\n\nBody" };
		expect(parseGoogleDriveMcpContent(result)).toBe("# Heading\n\nBody");
	});

	it("stringifies result.markdown when it is not a string", () => {
		const result = { markdown: { md: true } };
		expect(parseGoogleDriveMcpContent(result)).toBe(
			JSON.stringify({ md: true }),
		);
	});

	it("joins top-level text content array", () => {
		const result = [
			{ type: "text", text: "Block A" },
			{ type: "text", text: "Block B" },
		];
		expect(parseGoogleDriveMcpContent(result)).toBe("Block A\n\nBlock B");
	});

	it("stringifies unknown object structure as last resort", () => {
		const result = { someUnknownField: 123 };
		expect(parseGoogleDriveMcpContent(result)).toBe(JSON.stringify(result));
	});

	it("prioritizes content array over text/markdown fields", () => {
		const result = {
			content: [{ type: "text", text: "from content" }],
			text: "from text",
			markdown: "from markdown",
		};
		expect(parseGoogleDriveMcpContent(result)).toBe("from content");
	});
});

// ── fetchGoogleDriveFileContent ─────────────────────────────────────────

describe("fetchGoogleDriveFileContent", () => {
	const mockFetch = vi.fn();

	beforeEach(() => {
		// Vitest 4: mock call history and the mockResolvedValueOnce queue are no
		// longer auto-reset between tests, and vi.restoreAllMocks() does not clear
		// a manually-created vi.fn(). Without this, calls accumulate across tests
		// (call-count assertions fail) and mock.calls[0] reads a stale leaked call
		// from a previous test. mockReset() restores per-test isolation.
		mockFetch.mockReset();
		global.fetch = mockFetch;
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	const baseParams = {
		fileId: "file-123",
		mcpConfigId: "config-456",
	};

	function mockToolsResponse(tools: string[]) {
		return {
			ok: true,
			json: async () => ({ tools }),
		};
	}

	function mockContentResponse(result: unknown, error?: string) {
		return {
			ok: true,
			json: async () => (error ? { error } : { result }),
		};
	}

	it("happy path: discovers tools, fetches content, extracts title", async () => {
		mockFetch
			.mockResolvedValueOnce(
				mockToolsResponse(["list_files", "get_document"]),
			)
			.mockResolvedValueOnce(
				mockContentResponse({
					content: [
						{ type: "text", text: "# My Document\n\nBody text" },
					],
				}),
			);

		const result = await fetchGoogleDriveFileContent(baseParams);

		expect(result.content).toBe("# My Document\n\nBody text");
		expect(result.title).toBe("My Document");
		expect(result.contentFetchFailed).toBe(false);
	});

	it("returns contentFetchFailed when no read tool found", async () => {
		mockFetch
			.mockResolvedValueOnce(
				mockToolsResponse(["list_files", "search_files"]),
			)
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({}),
			});

		const result = await fetchGoogleDriveFileContent(baseParams);

		expect(result.contentFetchFailed).toBe(true);
		expect(result.content).toBe("");
		expect(mockFetch).toHaveBeenCalledTimes(2);
	});

	it("propagates error when tool discovery fetch fails (network error)", async () => {
		mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
		await expect(fetchGoogleDriveFileContent(baseParams)).rejects.toThrow();
	});

	it("returns contentFetchFailed when MCP returns error", async () => {
		mockFetch
			.mockResolvedValueOnce(mockToolsResponse(["get_document"]))
			.mockResolvedValueOnce(
				mockContentResponse(null, "Tool execution failed"),
			);

		const result = await fetchGoogleDriveFileContent(baseParams);

		expect(result.contentFetchFailed).toBe(true);
		expect(result.content).toBe("");
	});

	it("returns contentFetchFailed when result is missing", async () => {
		mockFetch
			.mockResolvedValueOnce(mockToolsResponse(["read_file"]))
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({}),
			});

		const result = await fetchGoogleDriveFileContent(baseParams);

		expect(result.contentFetchFailed).toBe(true);
	});

	it("returns contentFetchFailed when content is empty", async () => {
		mockFetch
			.mockResolvedValueOnce(mockToolsResponse(["get_document"]))
			.mockResolvedValueOnce(mockContentResponse({ content: "" }));

		const result = await fetchGoogleDriveFileContent(baseParams);

		expect(result.contentFetchFailed).toBe(true);
		expect(result.content).toBe("");
	});

	it("uses fallbackTitle when no # heading found", async () => {
		mockFetch
			.mockResolvedValueOnce(mockToolsResponse(["get_document"]))
			.mockResolvedValueOnce(
				mockContentResponse({
					content: [{ type: "text", text: "No heading here" }],
				}),
			);

		const result = await fetchGoogleDriveFileContent({
			...baseParams,
			fallbackTitle: "My Fallback Title",
		});

		expect(result.title).toBe("My Fallback Title");
		expect(result.contentFetchFailed).toBe(false);
	});

	it("defaults title to 'Google Drive File' when no fallback", async () => {
		mockFetch
			.mockResolvedValueOnce(mockToolsResponse(["read_file"]))
			.mockResolvedValueOnce(
				mockContentResponse({
					content: [{ type: "text", text: "body" }],
				}),
			);

		const result = await fetchGoogleDriveFileContent(baseParams);

		expect(result.title).toBe("Google Drive File");
	});

	it("passes organizationId to tool discovery call", async () => {
		mockFetch
			.mockResolvedValueOnce(mockToolsResponse(["get_document"]))
			.mockResolvedValueOnce(
				mockContentResponse({
					content: [{ type: "text", text: "ok" }],
				}),
			);

		await fetchGoogleDriveFileContent({
			...baseParams,
			organizationId: "org-789",
		});

		const toolsCallBody = JSON.parse(mockFetch.mock.calls[0][1].body);
		expect(toolsCallBody.organizationId).toBe("org-789");

		const contentCallBody = JSON.parse(mockFetch.mock.calls[1][1].body);
		expect(contentCallBody.organizationId).toBe("org-789");
	});

	it("passes undefined organizationId when null", async () => {
		mockFetch
			.mockResolvedValueOnce(mockToolsResponse(["get_document"]))
			.mockResolvedValueOnce(
				mockContentResponse({
					content: [{ type: "text", text: "ok" }],
				}),
			);

		await fetchGoogleDriveFileContent({
			...baseParams,
			organizationId: null,
		});

		const toolsCallBody = JSON.parse(mockFetch.mock.calls[0][1].body);
		expect(toolsCallBody.organizationId).toBeUndefined();
	});

	it("matches various read tool name patterns", async () => {
		const toolPatterns = [
			"get_document",
			"read_file",
			"get_file",
			"get_file_content",
			"read_document",
			"google_drive_read",
			"drive_get_file",
		];

		for (const tool of toolPatterns) {
			mockFetch.mockReset();
			mockFetch
				.mockResolvedValueOnce(mockToolsResponse([tool]))
				.mockResolvedValueOnce(
					mockContentResponse({
						content: [{ type: "text", text: "content" }],
					}),
				);

			const result = await fetchGoogleDriveFileContent(baseParams);
			expect(result.contentFetchFailed).toBe(false);
		}
	});

	it("handles fallbackMimeType", async () => {
		mockFetch
			.mockResolvedValueOnce(mockToolsResponse(["get_document"]))
			.mockResolvedValueOnce(
				mockContentResponse({
					content: [{ type: "text", text: "data" }],
				}),
			);

		const result = await fetchGoogleDriveFileContent({
			...baseParams,
			fallbackMimeType: "application/pdf",
		});

		expect(result.mimeType).toBe("application/pdf");
	});
});
