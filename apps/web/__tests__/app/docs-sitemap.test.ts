// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/utils", () => ({ getBaseUrl: () => "https://example.com" }));
vi.mock("content-collections", () => ({ allLegalPages: [] }));
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

vi.mock("@marketing/blog/utils/lib/posts", () => ({
	getAllPosts: async () => [],
}));

it("gives docs pages the fixed last-modified date in the main sitemap", async () => {
	const { default: sitemap } = await import("../../app/sitemap");
	const entries = await sitemap();
	expect(
		entries.find(
			({ url }) =>
				url === "https://example.com/en/docs/features/libraries",
		)?.lastModified,
	).toEqual(new Date("2026-03-01"));
});
