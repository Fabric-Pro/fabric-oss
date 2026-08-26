import { getAllPosts } from "@marketing/blog/utils/lib/posts";
import { config } from "@repo/config";
import { getBaseUrl } from "@repo/utils";
import { allLegalPages } from "content-collections";
import type { MetadataRoute } from "next";
import { docsSource } from "./docs-source";

const baseUrl = getBaseUrl();
const locales = config.i18n.enabled
	? Object.keys(config.i18n.locales)
	: [config.i18n.defaultLocale];

// Core marketing pages
const staticMarketingPages = ["", "/changelog", "/mcp-registry"];

// Enterprise-focused solution pages (high-priority for SEO)
const enterprisePages = [
	{ path: "", priority: 1.0, changeFrequency: "daily" as const },
	{
		path: "/docs",
		priority: 0.8,
		changeFrequency: "weekly" as const,
	},
];

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
	const posts = await getAllPosts();

	// Static pages use a fixed date to avoid signaling false freshness to crawlers
	const staticLastModified = new Date("2026-03-01");

	return [
		// High-priority enterprise pages with SEO metadata
		...enterprisePages.flatMap((page) =>
			locales.map((locale) => ({
				url: new URL(`/${locale}${page.path}`, baseUrl).href,
				lastModified: staticLastModified,
				changeFrequency: page.changeFrequency,
				priority: page.priority,
			})),
		),
		// Other static marketing pages
		...staticMarketingPages
			.filter((page) => !enterprisePages.some((ep) => ep.path === page))
			.flatMap((page) =>
				locales.map((locale) => ({
					url: new URL(`/${locale}${page}`, baseUrl).href,
					lastModified: staticLastModified,
					changeFrequency: "weekly" as const,
					priority: 0.7,
				})),
			),
		...posts.map((post) => ({
			url: new URL(`/${post.locale}/blog/${post.path}`, baseUrl).href,
			lastModified: post.date ? new Date(post.date) : staticLastModified,
		})),
		...allLegalPages.map((page) => ({
			url: new URL(`/${page.locale}/legal/${page.path}`, baseUrl).href,
			lastModified: staticLastModified,
		})),
		...docsSource.getLanguages().flatMap((locale) =>
			docsSource.getPages(locale.language).map((page) => ({
				url: new URL(
					`/${locale.language}/docs/${page.slugs.join("/")}`,
					baseUrl,
				).href,
				lastModified: new Date(),
			})),
		),
	];
}
