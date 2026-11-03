import { getBaseUrl } from "@repo/utils";
import { docsSource } from "../docs-source";

/**
 * The sitemap for the pages this app still serves on fabric.pro: the docs in
 * every language, the changelog and the MCP registry.
 *
 * With the marketing-on-fabric-web flag on, /sitemap.xml and /robots.txt are
 * the marketing site's (microfrontends.json), so app/sitemap.ts no longer
 * reaches a crawler. The marketing site's robots.txt names this file as a
 * second sitemap. The proxy matcher skips this path, so the locale middleware
 * never rewrites it.
 */
export const dynamic = "force-static";

const escapeXml = (s: string) =>
	s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");

export function docsSitemapUrls(baseUrl: string): string[] {
	const docs = docsSource
		.getLanguages()
		.flatMap((locale) =>
			docsSource
				.getPages(locale.language)
				.map((page) =>
					new URL(
						`/${locale.language}/docs/${page.slugs.join("/")}`,
						baseUrl,
					).href.replace(/\/$/, ""),
				),
		);
	const app = ["/changelog", "/mcp-registry"].map(
		(path) => new URL(path, baseUrl).href,
	);
	return [...new Set([...docs, ...app])];
}

export function GET() {
	const urls = docsSitemapUrls(getBaseUrl());
	const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
		.map((u) => `<url><loc>${escapeXml(u)}</loc></url>`)
		.join("\n")}\n</urlset>\n`;
	return new Response(body, {
		headers: {
			"Content-Type": "application/xml; charset=utf-8",
			"Cache-Control": "public, max-age=3600",
		},
	});
}
