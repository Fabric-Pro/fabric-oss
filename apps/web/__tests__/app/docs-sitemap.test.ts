import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/utils", () => ({ getBaseUrl: () => "https://example.com" }));
vi.mock("../../app/docs-source", () => ({
	docsSource: {
		getLanguages: () => [{ language: "en" }, { language: "de" }],
		getPages: (lang: string) => [
			{ slugs: [] },
			{ slugs: ["features", "libraries"] },
			...(lang === "en" ? [{ slugs: ["a&b"] }] : []),
		],
	},
}));

describe("docs sitemap (/docs-sitemap.xml)", () => {
	it("lists every docs page in every language, plus the changelog and MCP registry", async () => {
		const { docsSitemapUrls } = await import(
			"../../app/docs-sitemap.xml/route"
		);
		expect(docsSitemapUrls("https://example.com")).toEqual([
			"https://example.com/en/docs",
			"https://example.com/en/docs/features/libraries",
			"https://example.com/en/docs/a&b",
			"https://example.com/de/docs",
			"https://example.com/de/docs/features/libraries",
			"https://example.com/changelog",
			"https://example.com/mcp-registry",
		]);
	});

	it("serves valid XML with no marketing pages", async () => {
		const { GET } = await import("../../app/docs-sitemap.xml/route");
		const res = GET();
		expect(res.headers.get("content-type")).toContain("application/xml");
		const xml = await res.text();
		expect(xml).toContain("<loc>https://example.com/en/docs/a&amp;b</loc>");
		expect(xml).not.toMatch(
			/<loc>https:\/\/example\.com\/(blog|partners|compare|en)?<\/loc>/,
		);
	});
});
