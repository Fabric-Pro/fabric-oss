/**
 * Jina web search maps each entry of s.jina.ai's JSON `data` array to its own
 * result, so every result carries its own title, snippet and content instead
 * of the opening of the whole response.
 */

import { JinaSearchProvider } from "@repo/search";
import { afterEach, describe, expect, it, vi } from "vitest";

const LONG_BODY = "Paragraph about the first page. ".repeat(40);

function stubJina(body: unknown) {
	const fetchMock = vi.fn(
		async (_input: string | URL, _init?: RequestInit) =>
			new Response(JSON.stringify(body), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
	);
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("JinaSearchProvider.search", () => {
	it("returns one result per data entry with that entry's own fields", async () => {
		const fetchMock = stubJina({
			code: 200,
			status: 20000,
			data: [
				{
					title: "First page",
					url: "https://example.com/first",
					description: "About the first page.",
					content: `${LONG_BODY} See https://example.org/linked-inside`,
					date: "2026-01-02",
				},
				{
					title: "Second page",
					url: "https://example.com/second",
					description: "",
					content: "Second page body.",
				},
			],
		});

		const response = await new JinaSearchProvider("jina-x").search(
			"example query",
		);

		const [url, init] = fetchMock.mock.calls[0];
		expect(String(url)).toBe("https://s.jina.ai/example%20query");
		expect(init?.headers).toMatchObject({ Accept: "application/json" });

		expect(LONG_BODY.length).toBeGreaterThan(500);
		expect(response.results).toHaveLength(2);
		expect(response.results[0]).toMatchObject({
			title: "First page",
			url: "https://example.com/first",
			snippet: "About the first page.",
			content: `${LONG_BODY} See https://example.org/linked-inside`,
			publishedDate: "2026-01-02",
			source: "jina",
		});
		// No description: the snippet comes from this entry's own content.
		expect(response.results[1]).toMatchObject({
			title: "Second page",
			url: "https://example.com/second",
			snippet: "Second page body.",
			content: "Second page body.",
		});
		// A URL mentioned inside page text is not a result of its own.
		expect(response.results.map((r) => r.url)).not.toContain(
			"https://example.org/linked-inside",
		);
	});

	it("stops at maxResults and skips entries without a URL", async () => {
		stubJina({
			data: [
				{ title: "No URL", content: "orphan" },
				{ title: "A", url: "https://example.com/a", content: "a" },
				{ title: "B", url: "https://example.com/b", content: "b" },
				{ title: "C", url: "https://example.com/c", content: "c" },
			],
		});

		const response = await new JinaSearchProvider("jina-x").search("q", {
			maxResults: 2,
		});

		expect(response.results.map((r) => r.url)).toEqual([
			"https://example.com/a",
			"https://example.com/b",
		]);
	});

	it("throws on a response without a data array", async () => {
		stubJina({ code: 200, message: "unexpected" });

		await expect(
			new JinaSearchProvider("jina-x").search("q"),
		).rejects.toThrow(/no data array/);
	});
});
