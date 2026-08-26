/**
 * Unit tests for parseFilesResult from GoogleDocsSelector.
 *
 * Tests the various MCP response formats that Google Drive servers may return.
 */

import { describe, expect, it } from "vitest";
import { parseFilesResult } from "../../components/GoogleDocsSelector";

describe("parseFilesResult", () => {
	it("parses a standard array of file objects", () => {
		const result = [
			{
				id: "f1",
				name: "Doc 1",
				mimeType: "application/vnd.google-apps.document",
				webViewLink: "https://docs.google.com/doc1",
			},
			{
				id: "f2",
				name: "Sheet 1",
				mimeType: "application/vnd.google-apps.spreadsheet",
			},
		];

		const parsed = parseFilesResult(result);

		expect(parsed).toHaveLength(2);
		expect(parsed[0].id).toBe("f1");
		expect(parsed[0].title).toBe("Doc 1");
		expect(parsed[0].url).toBe("https://docs.google.com/doc1");
		expect(parsed[1].id).toBe("f2");
		expect(parsed[1].title).toBe("Sheet 1");
	});

	it("unwraps MCP text content array wrapper", () => {
		const files = [{ id: "f1", name: "File", mimeType: "text/plain" }];
		const result = [{ type: "text", text: JSON.stringify(files) }];

		const parsed = parseFilesResult(result);

		expect(parsed).toHaveLength(1);
		expect(parsed[0].id).toBe("f1");
	});

	it("extracts from nested data.files array", () => {
		const result = {
			files: [{ id: "f1", name: "Nested File", mimeType: "text/plain" }],
		};

		const parsed = parseFilesResult(result);

		expect(parsed).toHaveLength(1);
		expect(parsed[0].title).toBe("Nested File");
	});

	it("extracts from nested data.items array", () => {
		const result = {
			items: [{ id: "f1", name: "Item File", mimeType: "text/csv" }],
		};

		const parsed = parseFilesResult(result);

		expect(parsed).toHaveLength(1);
		expect(parsed[0].title).toBe("Item File");
	});

	it("filters out files with missing id", () => {
		const result = [
			{ id: "f1", name: "Valid", mimeType: "text/plain" },
			{ name: "No ID", mimeType: "text/plain" },
			{ id: "", name: "Empty ID", mimeType: "text/plain" },
		];

		const parsed = parseFilesResult(result);

		expect(parsed).toHaveLength(1);
		expect(parsed[0].id).toBe("f1");
	});

	it("filters out files with missing title", () => {
		const result = [
			{ id: "f1", name: "Has Name", mimeType: "text/plain" },
			{ id: "f2", mimeType: "text/plain" },
			{ id: "f3", name: "", mimeType: "text/plain" },
		];

		const parsed = parseFilesResult(result);

		expect(parsed).toHaveLength(1);
		expect(parsed[0].title).toBe("Has Name");
	});

	it("maps fileId to id", () => {
		const result = [
			{ fileId: "fid-1", name: "Alt ID", mimeType: "text/plain" },
		];

		const parsed = parseFilesResult(result);

		expect(parsed[0].id).toBe("fid-1");
	});

	it("maps title field to title", () => {
		const result = [
			{ id: "f1", title: "Title Field", mimeType: "text/plain" },
		];

		const parsed = parseFilesResult(result);

		expect(parsed[0].title).toBe("Title Field");
	});

	it("maps mime_type to mimeType", () => {
		const result = [
			{ id: "f1", name: "File", mime_type: "application/pdf" },
		];

		const parsed = parseFilesResult(result);

		expect(parsed[0].mimeType).toBe("application/pdf");
	});

	it("extracts URL with priority: webViewLink > url > webContentLink", () => {
		const withAll = [
			{
				id: "f1",
				name: "F",
				mimeType: "text/plain",
				webViewLink: "https://view",
				url: "https://url",
				webContentLink: "https://content",
			},
		];
		expect(parseFilesResult(withAll)[0].url).toBe("https://view");

		const withUrlOnly = [
			{
				id: "f2",
				name: "F",
				mimeType: "text/plain",
				url: "https://url",
				webContentLink: "https://content",
			},
		];
		expect(parseFilesResult(withUrlOnly)[0].url).toBe("https://url");

		const withContentOnly = [
			{
				id: "f3",
				name: "F",
				mimeType: "text/plain",
				webContentLink: "https://content",
			},
		];
		expect(parseFilesResult(withContentOnly)[0].url).toBe(
			"https://content",
		);

		const withNone = [{ id: "f4", name: "F", mimeType: "text/plain" }];
		expect(parseFilesResult(withNone)[0].url).toBeUndefined();
	});

	it("includes folder MIME type files", () => {
		const result = [
			{
				id: "folder-1",
				name: "My Folder",
				mimeType: "application/vnd.google-apps.folder",
			},
		];

		const parsed = parseFilesResult(result);

		expect(parsed).toHaveLength(1);
		expect(parsed[0].mimeType).toBe("application/vnd.google-apps.folder");
	});

	it("returns empty array for invalid JSON string", () => {
		const parsed = parseFilesResult("not valid json{{{");

		expect(parsed).toEqual([]);
	});

	it("returns empty array for empty array input", () => {
		expect(parseFilesResult([])).toEqual([]);
	});

	it("parses modifiedTime from various field names", () => {
		const result = [
			{
				id: "f1",
				name: "A",
				mimeType: "text/plain",
				modifiedTime: "2024-01-01",
			},
			{
				id: "f2",
				name: "B",
				mimeType: "text/plain",
				modified_time: "2024-02-01",
			},
			{
				id: "f3",
				name: "C",
				mimeType: "text/plain",
				updatedAt: "2024-03-01",
			},
		];

		const parsed = parseFilesResult(result);

		expect(parsed[0].modifiedTime).toBe("2024-01-01");
		expect(parsed[1].modifiedTime).toBe("2024-02-01");
		expect(parsed[2].modifiedTime).toBe("2024-03-01");
	});

	it("parses size as number", () => {
		const result = [
			{ id: "f1", name: "A", mimeType: "text/plain", size: 1024 },
		];

		expect(parseFilesResult(result)[0].size).toBe(1024);
	});

	it("parses size as string", () => {
		const result = [
			{ id: "f1", name: "A", mimeType: "text/plain", size: "2048" },
		];

		expect(parseFilesResult(result)[0].size).toBe(2048);
	});

	it("handles JSON string input", () => {
		const files = [{ id: "f1", name: "From JSON", mimeType: "text/plain" }];
		const parsed = parseFilesResult(JSON.stringify(files));

		expect(parsed).toHaveLength(1);
		expect(parsed[0].title).toBe("From JSON");
	});

	it("handles MCP text wrapper with object text (not string)", () => {
		const files = [{ id: "f1", name: "ObjText", mimeType: "text/plain" }];
		const result = [{ type: "text", text: files }];

		const parsed = parseFilesResult(result);

		expect(parsed).toHaveLength(1);
		expect(parsed[0].title).toBe("ObjText");
	});
});
